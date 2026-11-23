// RCH-2: the database side of attendance, leave and corrections.
//
// Only evidence is stored: when a rep started, when they ended, where they were, what leave was
// approved and what a correction changed. The register itself is never written down — it is read
// out of that evidence by `packages/engines/attendance.mjs` every time it is asked for.
//
// Clock times leave this file as 'HH:MM' in the company's own zone. The conversion happens here,
// in SQL, because Postgres owns the zone database and because the engine must not have to guess
// whose midnight a working day belongs to.
//
// Every function receives a pg client already inside a company-scoped (RLS) transaction.
import { countRows, DEFAULT_PAGE_SIZE } from './paging.mjs';
import { monthlyRegister, datesBetween, minutesOfDay } from '../engines/attendance.mjs';
import { metresBetween } from '../engines/geo.mjs';
import { reachSettings } from './customers-db.mjs';

const n = (v) => (v === null || v === undefined ? null : Number(v));

// A punch read back for the engine: the wall-clock times a rep would recognise, in their own
// company's zone, plus whether the work type counts as attendance at all.
const PUNCH_COLUMNS = (tz) => `
  to_char(a.work_date,'YYYY-MM-DD') AS work_date,
  to_char(a.started_at AT TIME ZONE ${tz},'HH24:MI') AS start_time,
  to_char(a.ended_at AT TIME ZONE ${tz},'HH24:MI') AS end_time,
  w.counts_present, w.code AS work_type, a.start_in_fence, a.note`;

// ---------- Settings ----------

// Attendance reads the same settings row as the rest of Reach.
export async function attendanceSettings(db) {
  return reachSettings(db);
}

// ---------- Who a rep is, and which shift judges their day ----------

const REP_COLUMNS = `
  r.id, r.code, r.name, r.shift_id, r.hq_town, r.grade_id,
  coalesce(s.code,'') AS shift,
  to_char(s.starts_at,'HH24:MI') AS starts_at,
  to_char(s.ends_at,'HH24:MI') AS ends_at,
  s.grace_minutes, s.half_day_minutes, s.min_minutes, s.week_off`;

const shiftOf = (row) =>
  row.shift_id
    ? {
        starts_at: row.starts_at,
        ends_at: row.ends_at,
        grace_minutes: n(row.grace_minutes),
        half_day_minutes: n(row.half_day_minutes),
        min_minutes: n(row.min_minutes),
        week_off: row.week_off ?? '',
      }
    : null;

export async function findRep(db, repId) {
  const row = (
    await db.query(
      `SELECT ${REP_COLUMNS}, r.territory_id FROM field_reps r
       LEFT JOIN shifts s ON s.id=r.shift_id
       WHERE r.id=$1 AND r.deleted_at IS NULL`,
      [repId],
    )
  ).rows[0];
  return row ? { ...row, shift: shiftOf(row), shift_code: row.shift } : null;
}

// The rep a login belongs to. A person marks their own day; nobody marks it for them.
export async function repForUser(db, userId) {
  const row = (
    await db.query(
      `SELECT ${REP_COLUMNS}, r.territory_id FROM field_reps r
       LEFT JOIN shifts s ON s.id=r.shift_id
       WHERE r.user_id=$1 AND r.deleted_at IS NULL AND r.active`,
      [userId],
    )
  ).rows[0];
  return row ? { ...row, shift: shiftOf(row), shift_code: row.shift } : null;
}

// ---------- Starting and ending a day ----------

// Today in the company's own zone, which is the only date a rep may punch.
export async function todayFor(db, settings) {
  return (
    await db.query("SELECT to_char(now() AT TIME ZONE $1,'YYYY-MM-DD') AS d", [settings.timezone])
  ).rows[0].d;
}

export async function findDay(db, repId, workDate, settings) {
  const row = (
    await db.query(
      `SELECT a.id, a.version, a.work_type_id, a.start_file_id,
              a.start_latitude, a.start_longitude, a.start_accuracy_m, a.start_source,
              a.end_latitude, a.end_longitude, a.end_source, ${PUNCH_COLUMNS('$3')}
       FROM attendance_days a JOIN work_types w ON w.id=a.work_type_id
       WHERE a.rep_id=$1 AND a.work_date=$2`,
      [repId, workDate, settings.timezone],
    )
  ).rows[0];
  return row ? { ...row, version: Number(row.version) } : null;
}

// Was the rep inside the company's attendance fence? Decided once, at punch time, because the
// fence may be moved later and the day should keep what was true when it happened. A day with no
// anchor to measure from is left unknown rather than called a breach.
export function inFence({ anchor, at, settings }) {
  if (!anchor || at.latitude === null || at.latitude === undefined) return null;
  const away = metresBetween(anchor, at);
  return away === null ? null : away <= Number(settings.attendance_fence_m);
}

export async function startDay(
  db,
  tenantId,
  { id, repId, workDate, workTypeId, at, fileId, note },
) {
  await db.query(
    `INSERT INTO attendance_days(id,tenant_id,rep_id,work_date,work_type_id,started_at,
       start_latitude,start_longitude,start_accuracy_m,start_source,start_file_id,start_in_fence,note)
     VALUES($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      tenantId,
      repId,
      workDate,
      workTypeId,
      at.latitude ?? null,
      at.longitude ?? null,
      at.accuracy_m ?? null,
      at.source ?? 'DEVICE',
      fileId ?? null,
      at.in_fence ?? null,
      note ?? '',
    ],
  );
  return id;
}

export async function endDay(db, { dayId, version, at }) {
  const done = await db.query(
    `UPDATE attendance_days SET ended_at=now(),end_latitude=$2,end_longitude=$3,
       end_accuracy_m=$4,end_source=$5,version=version+1,updated_at=now()
     WHERE id=$1 AND version=$6 AND ended_at IS NULL`,
    [
      dayId,
      at.latitude ?? null,
      at.longitude ?? null,
      at.accuracy_m ?? null,
      at.source ?? 'DEVICE',
      version,
    ],
  );
  return done.rowCount === 1;
}

// ---------- The register ----------

// Holidays that apply to a rep: the company-wide ones plus their own territory's.
// Company-wide holidays plus the ones declared for one territory. Exported because the tour
// plan reads the same list: a holiday kept in two places eventually disagrees with itself.
export async function holidaysFor(db, territoryId, from, to) {
  return (
    await db.query(
      `SELECT to_char(holiday_date,'YYYY-MM-DD') AS holiday_date,name
       FROM holidays
       WHERE holiday_date BETWEEN $1 AND $2 AND deleted_at IS NULL AND active
         AND (territory_id IS NULL OR territory_id=$3)
       ORDER BY holiday_date`,
      [from, to, territoryId ?? null],
    )
  ).rows;
}

async function leavesFor(db, repId, from, to) {
  return (
    await db.query(
      `SELECT l.id,to_char(l.from_date,'YYYY-MM-DD') AS from_date,
              to_char(l.to_date,'YYYY-MM-DD') AS to_date,l.status,l.half_day,
              t.code AS leave_type,t.name AS leave_type_name,t.paid
       FROM leave_requests l JOIN leave_types t ON t.id=l.leave_type_id
       WHERE l.rep_id=$1 AND l.from_date<=$3 AND l.to_date>=$2
       ORDER BY l.from_date`,
      [repId, from, to],
    )
  ).rows;
}

// One rep's register over a span. Nothing here is stored; it is read every time.
export async function registerFor(db, { repId, from, to }, settings) {
  const rep = await findRep(db, repId);
  if (!rep) return null;
  const punches = (
    await db.query(
      `SELECT ${PUNCH_COLUMNS('$4')} FROM attendance_days a JOIN work_types w ON w.id=a.work_type_id
       WHERE a.rep_id=$1 AND a.work_date BETWEEN $2 AND $3 ORDER BY a.work_date`,
      [repId, from, to, settings.timezone],
    )
  ).rows;
  const [holidays, leaves] = await Promise.all([
    holidaysFor(db, rep.territory_id, from, to),
    leavesFor(db, repId, from, to),
  ]);
  return {
    rep: { id: rep.id, code: rep.code, name: rep.name, shift: rep.shift_code },
    ...monthlyRegister({ from, to, punches, shift: rep.shift, holidays, leaves }),
  };
}

// ---------- The day board ----------

// Everyone's standing for one date: who started, who is late, who has not come. The reminder
// flag is a proposal, never an action: it says the shift has been over for longer than the
// company allows and nobody has heard from this rep.
export async function dayBoard(db, { date, territoryId = null }, settings) {
  const reps = (
    await db.query(
      `SELECT ${REP_COLUMNS}, r.territory_id, t.code AS territory
       FROM field_reps r LEFT JOIN shifts s ON s.id=r.shift_id
       JOIN territories t ON t.id=r.territory_id
       WHERE r.deleted_at IS NULL AND r.active AND ($1::uuid IS NULL OR r.territory_id=$1)
       ORDER BY lower(r.code)`,
      [territoryId],
    )
  ).rows;
  if (!reps.length) return { date, rows: [], totals: {} };

  const ids = reps.map((r) => r.id);
  const punches = (
    await db.query(
      `SELECT a.rep_id, ${PUNCH_COLUMNS('$3')} FROM attendance_days a
       JOIN work_types w ON w.id=a.work_type_id
       WHERE a.rep_id=ANY($1::uuid[]) AND a.work_date=$2`,
      [ids, date, settings.timezone],
    )
  ).rows;
  const leaves = (
    await db.query(
      `SELECT l.rep_id,to_char(l.from_date,'YYYY-MM-DD') AS from_date,
              to_char(l.to_date,'YYYY-MM-DD') AS to_date,l.status,l.half_day,
              t.code AS leave_type,t.paid
       FROM leave_requests l JOIN leave_types t ON t.id=l.leave_type_id
       WHERE l.rep_id=ANY($1::uuid[]) AND l.from_date<=$2 AND l.to_date>=$2`,
      [ids, date],
    )
  ).rows;
  const holidays = (
    await db.query(
      `SELECT to_char(holiday_date,'YYYY-MM-DD') AS holiday_date,name,territory_id
       FROM holidays WHERE holiday_date=$1 AND deleted_at IS NULL AND active`,
      [date],
    )
  ).rows;
  const nowMinutes = minutesOfDay(
    (await db.query("SELECT to_char(now() AT TIME ZONE $1,'HH24:MI') AS t", [settings.timezone]))
      .rows[0].t,
  );

  const punchOf = new Map(punches.map((p) => [p.rep_id, p]));
  const rows = reps.map((rep) => {
    const holiday =
      holidays.find((h) => h.territory_id === null || h.territory_id === rep.territory_id) ?? null;
    const day = monthlyRegister({
      from: date,
      to: date,
      shift: shiftOf(rep),
      punches: punchOf.has(rep.id) ? [punchOf.get(rep.id)] : [],
      holidays: holiday ? [holiday] : [],
      leaves: leaves.filter((l) => l.rep_id === rep.id),
    }).rows[0];

    // Only a working day with no punch at all can earn a reminder, and only once the shift has
    // been over for longer than the company allows.
    const endsAt = minutesOfDay(rep.ends_at);
    const overdue =
      day.status === 'ABSENT' &&
      !punchOf.has(rep.id) &&
      endsAt !== null &&
      nowMinutes !== null &&
      nowMinutes > endsAt + Number(settings.absent_after_minutes);

    return {
      rep_id: rep.id,
      code: rep.code,
      name: rep.name,
      territory: rep.territory,
      shift: rep.shift,
      ...day,
      start_time: punchOf.get(rep.id)?.start_time ?? null,
      end_time: punchOf.get(rep.id)?.end_time ?? null,
      work_type: punchOf.get(rep.id)?.work_type ?? null,
      in_fence: punchOf.get(rep.id)?.start_in_fence ?? null,
      remind: overdue,
    };
  });

  const totals = {};
  for (const row of rows) totals[row.status] = (totals[row.status] ?? 0) + 1;
  return { date, rows, totals, remind: rows.filter((r) => r.remind).length };
}

// ---------- Leave ----------

export async function leaveBalance(db, repId, year) {
  return (
    await db.query(
      `SELECT t.id,t.code,t.name,t.paid,t.annual_quota,
              coalesce(sum(
                CASE WHEN l.status='APPROVED'
                  THEN CASE WHEN l.half_day THEN 0.5
                            ELSE (least(l.to_date, $3::date) - greatest(l.from_date, $2::date) + 1) END
                  ELSE 0 END
              ),0) AS taken
       FROM leave_types t
       LEFT JOIN leave_requests l ON l.leave_type_id=t.id AND l.rep_id=$1
            AND l.from_date<=$3 AND l.to_date>=$2
       WHERE t.deleted_at IS NULL AND t.active
       GROUP BY t.id,t.code,t.name,t.paid,t.annual_quota
       ORDER BY lower(t.code)`,
      [repId, `${year}-01-01`, `${year}-12-31`],
    )
  ).rows.map((r) => ({
    ...r,
    annual_quota: n(r.annual_quota),
    taken: n(r.taken),
    left: Math.round((n(r.annual_quota) - n(r.taken)) * 2) / 2,
  }));
}

// Two approved spells of leave may not cover the same day.
export async function overlappingLeave(db, { repId, from, to, exceptId = null }) {
  return (
    (
      await db.query(
        `SELECT to_char(from_date,'YYYY-MM-DD') AS from_date,to_char(to_date,'YYYY-MM-DD') AS to_date
       FROM leave_requests
       WHERE rep_id=$1 AND status IN ('PENDING','APPROVED')
         AND daterange(from_date,to_date,'[]') && daterange($2::date,$3::date,'[]')
         AND ($4::uuid IS NULL OR id<>$4)
       LIMIT 1`,
        [repId, from, to, exceptId],
      )
    ).rows[0] ?? null
  );
}

export async function applyLeave(
  db,
  tenantId,
  { id, repId, leaveTypeId, from, to, halfDay, reason },
) {
  await db.query(
    `INSERT INTO leave_requests(id,tenant_id,rep_id,leave_type_id,from_date,to_date,half_day,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, tenantId, repId, leaveTypeId, from, to, !!halfDay, reason ?? ''],
  );
  return id;
}

export async function decideLeave(db, actorId, { id, version, status, reason }) {
  const done = await db.query(
    `UPDATE leave_requests SET status=$3,decided_by=$4,decided_at=now(),decision_reason=$5,
       version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='PENDING'`,
    [id, version, status, actorId, reason ?? ''],
  );
  return done.rowCount === 1;
}

// A rep withdrawing their own request. Cancelled, never deleted.
export async function cancelLeave(db, { id, version }) {
  const done = await db.query(
    `UPDATE leave_requests SET status='CANCELLED',version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='PENDING'`,
    [id, version],
  );
  return done.rowCount === 1;
}

const LEAVE_FROM = `leave_requests l
       JOIN field_reps r ON r.id=l.rep_id JOIN leave_types t ON t.id=l.leave_type_id
       LEFT JOIN app_users u ON u.id=l.decided_by`;
const LEAVE_WHERE = '($1::uuid IS NULL OR l.rep_id=$1) AND ($2::text IS NULL OR l.status=$2)';

export async function listLeave(db, { repId = null, status = null, limit = DEFAULT_PAGE_SIZE }) {
  const params = [repId, status];
  const total = await countRows(db, LEAVE_FROM, LEAVE_WHERE, params);
  const rows = (
    await db.query(
      `SELECT l.id,l.version,r.code AS rep,r.name AS rep_name,t.code AS leave_type,t.name AS leave_type_name,
              t.paid,to_char(l.from_date,'YYYY-MM-DD') AS from_date,
              to_char(l.to_date,'YYYY-MM-DD') AS to_date,l.half_day,l.reason,l.status,
              coalesce(u.name,'') AS decided_by,l.decision_reason,
              (l.to_date - l.from_date + 1) AS days
       FROM ${LEAVE_FROM}
       WHERE ${LEAVE_WHERE}
       ORDER BY l.from_date DESC, lower(r.code) LIMIT $3`,
      [...params, limit],
    )
  ).rows;
  return {
    items: rows.map((r) => ({
      ...r,
      version: Number(r.version),
      days: r.half_day ? 0.5 : n(r.days),
    })),
    total,
  };
}

// ---------- Regularisation ----------

// A correction carries the values it is replacing, so the register can be explained later
// without reading the audit log back.
export async function requestEdit(
  db,
  tenantId,
  { id, repId, workDate, startAt, endAt, reason, previous },
) {
  await db.query(
    `INSERT INTO attendance_edits(id,tenant_id,rep_id,work_date,requested_start_at,requested_end_at,
       previous_start_at,previous_end_at,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      id,
      tenantId,
      repId,
      workDate,
      startAt ?? null,
      endAt ?? null,
      previous?.started_at ?? null,
      previous?.ended_at ?? null,
      reason,
    ],
  );
  return id;
}

// Approving a correction writes the punch it asked for, creating the day if the rep never
// punched at all. The edit row keeps what was there before either way.
export async function decideEdit(db, actorId, tenantId, { edit, status, reason, workTypeId }) {
  const done = await db.query(
    `UPDATE attendance_edits SET status=$2,decided_by=$3,decided_at=now(),decision_reason=$4
     WHERE id=$1 AND status='PENDING'`,
    [edit.id, status, actorId, reason ?? ''],
  );
  if (done.rowCount !== 1) return false;
  if (status !== 'APPROVED') return true;

  await db.query(
    `INSERT INTO attendance_days(id,tenant_id,rep_id,work_date,work_type_id,started_at,ended_at,start_source,end_source)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,coalesce($5,now()),$6,'TYPED','TYPED')
     ON CONFLICT (tenant_id,rep_id,work_date) DO UPDATE SET
       started_at=coalesce(excluded.started_at,attendance_days.started_at),
       ended_at=coalesce($6,attendance_days.ended_at),
       start_source=CASE WHEN $5 IS NULL THEN attendance_days.start_source ELSE 'TYPED' END,
       end_source=CASE WHEN $6 IS NULL THEN attendance_days.end_source ELSE 'TYPED' END,
       version=attendance_days.version+1,updated_at=now()`,
    [
      tenantId,
      edit.rep_id,
      edit.work_date,
      workTypeId,
      edit.requested_start_at,
      edit.requested_end_at,
    ],
  );
  return true;
}

export async function findEdit(db, id) {
  const row = (
    await db.query(
      `SELECT e.id,e.rep_id,to_char(e.work_date,'YYYY-MM-DD') AS work_date,
              e.requested_start_at,e.requested_end_at,e.status,e.reason,r.code AS rep
       FROM attendance_edits e JOIN field_reps r ON r.id=e.rep_id WHERE e.id=$1`,
      [id],
    )
  ).rows[0];
  return row ?? null;
}

const EDIT_FROM = `attendance_edits e JOIN field_reps r ON r.id=e.rep_id
       LEFT JOIN app_users u ON u.id=e.decided_by`;
const EDIT_WHERE = '($1::uuid IS NULL OR e.rep_id=$1) AND ($2::text IS NULL OR e.status=$2)';

export async function listEdits(
  db,
  { repId = null, status = 'PENDING', limit = DEFAULT_PAGE_SIZE },
  settings,
) {
  const total = await countRows(db, EDIT_FROM, EDIT_WHERE, [repId, status]);
  const rows = (
    await db.query(
      `SELECT e.id,r.code AS rep,r.name AS rep_name,to_char(e.work_date,'YYYY-MM-DD') AS work_date,
              to_char(e.requested_start_at AT TIME ZONE $3,'HH24:MI') AS requested_start,
              to_char(e.requested_end_at AT TIME ZONE $3,'HH24:MI') AS requested_end,
              to_char(e.previous_start_at AT TIME ZONE $3,'HH24:MI') AS previous_start,
              to_char(e.previous_end_at AT TIME ZONE $3,'HH24:MI') AS previous_end,
              e.reason,e.status,coalesce(u.name,'') AS decided_by,e.decision_reason
       FROM ${EDIT_FROM}
       WHERE ${EDIT_WHERE}
       ORDER BY e.work_date DESC, lower(r.code) LIMIT $4`,
      [repId, status, settings.timezone, limit],
    )
  ).rows;
  return { items: rows, total };
}

// ---------- Payroll ----------

// One row per rep for the span, with the counts a payroll run needs. Built from the same engine
// the register uses, so the export can never disagree with the screen.
export async function payrollRows(db, { from, to, territoryId = null }, settings) {
  const reps = (
    await db.query(
      `SELECT r.id,r.code,r.name FROM field_reps r
       WHERE r.deleted_at IS NULL AND ($1::uuid IS NULL OR r.territory_id=$1)
       ORDER BY lower(r.code)`,
      [territoryId],
    )
  ).rows;
  const out = [];
  for (const rep of reps) {
    const register = await registerFor(db, { repId: rep.id, from, to }, settings);
    if (!register) continue;
    out.push({
      code: rep.code,
      name: rep.name,
      days: datesBetween(from, to).length,
      present: register.totals.PRESENT,
      late: register.totals.LATE,
      half_day: register.totals.HALF_DAY,
      leave: register.totals.LEAVE,
      absent: register.totals.ABSENT,
      week_off: register.totals.WEEK_OFF,
      holiday: register.totals.HOLIDAY,
      open: register.totals.OPEN,
      paid_days: register.paidDays,
    });
  }
  return out;
}

export const PAYROLL_COLUMNS = [
  'code',
  'name',
  'days',
  'present',
  'late',
  'half_day',
  'leave',
  'absent',
  'week_off',
  'holiday',
  'open',
  'paid_days',
];
