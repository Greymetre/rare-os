// RCH-3: the database side of the tour plan.
//
// What is written here is the intention and the decisions taken about it: the days a rep
// proposed, when the month was submitted, who approved it or sent it back and why, and which
// single day a change request moved afterwards. How the month actually turned out is never
// written. Followed, Partial, Deviated, Missed and Unplanned are read out of the plan, the
// visits and the attendance register by `packages/engines/tour-plan.mjs` every time they are
// asked for, which is what lets leave approved after the plan was built stop a day from counting
// as missed without anybody rewriting history.
//
// Leave, holidays and week-offs are borrowed from Attendance rather than repeated. The holiday
// list and the register come from `attendance-db.mjs`, so there is one answer to "was this a
// working day?" in the system and not two.
//
// Every function receives a pg client already inside a company-scoped (RLS) transaction.
import { countRows, DEFAULT_PAGE_SIZE } from './paging.mjs';
import { reachSettings } from './customers-db.mjs';
import { findRep, holidaysFor, registerFor } from './attendance-db.mjs';
import { autoFill, monthSpan, planAdherence, planChecks } from '../engines/tour-plan.mjs';

const n = (v) => (v === null || v === undefined ? null : Number(v));

// ---------- Settings ----------

// The plan reads the same settings row as the rest of Reach.
export async function planSettings(db) {
  return reachSettings(db);
}

// ---------- One rep's month ----------

const PLAN_COLUMNS = `
  p.id, p.version, p.status, p.note, p.rep_id,
  to_char(p.plan_month,'YYYY-MM') AS month,
  to_char(p.plan_month,'YYYY-MM-DD') AS month_start,
  r.code AS rep, r.name AS rep_name, r.territory_id,
  coalesce(s.week_off,'') AS week_off,
  to_char(p.submitted_at,'YYYY-MM-DD HH24:MI') AS submitted_at,
  to_char(p.decided_at,'YYYY-MM-DD HH24:MI') AS decided_at,
  coalesce(d.name,'') AS decided_by, p.decision_reason`;

const PLAN_FROM = `tour_plans p
  JOIN field_reps r ON r.id=p.rep_id
  LEFT JOIN shifts s ON s.id=r.shift_id
  LEFT JOIN app_users d ON d.id=p.decided_by`;

const asPlan = (row) => (row ? { ...row, version: Number(row.version) } : null);

export async function findPlan(db, { repId, month }) {
  const span = monthSpan(month);
  if (!span) return null;
  return asPlan(
    (
      await db.query(
        `SELECT ${PLAN_COLUMNS} FROM ${PLAN_FROM} WHERE p.rep_id=$1 AND p.plan_month=$2`,
        [repId, span.from],
      )
    ).rows[0] ?? null,
  );
}

export async function findPlanById(db, planId) {
  return asPlan(
    (await db.query(`SELECT ${PLAN_COLUMNS} FROM ${PLAN_FROM} WHERE p.id=$1`, [planId])).rows[0] ??
      null,
  );
}

export async function createPlan(db, tenantId, { id, repId, month, note = '' }) {
  const span = monthSpan(month);
  await db.query(
    'INSERT INTO tour_plans(id,tenant_id,rep_id,plan_month,note) VALUES($1,$2,$3,$4,$5)',
    [id, tenantId, repId, span.from, note],
  );
  return id;
}

// A plan is only editable by the rep while it is being built or after it has been sent back.
// Once it is submitted it belongs to whoever has to decide it; once approved, a day moves by
// request and not by typing.
export const EDITABLE = ['DRAFT', 'SENT_BACK'];

// Optimistic concurrency for the whole month. The days hang off the plan rather than carrying
// versions of their own, so two people editing the same month collide once, on the plan.
export async function touchPlan(db, { id, version }) {
  const done = await db.query(
    'UPDATE tour_plans SET version=version+1,updated_at=now() WHERE id=$1 AND version=$2',
    [id, version],
  );
  return done.rowCount === 1;
}

export async function submitPlan(db, actorId, { id, version }) {
  const done = await db.query(
    `UPDATE tour_plans SET status='SUBMITTED',submitted_at=now(),submitted_by=$3,
       decided_at=NULL,decided_by=NULL,decision_reason='',version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status IN ('DRAFT','SENT_BACK')`,
    [id, version, actorId ?? null],
  );
  return done.rowCount === 1;
}

export async function decidePlan(db, actorId, { id, version, status, reason }) {
  const done = await db.query(
    `UPDATE tour_plans SET status=$4,decided_at=now(),decided_by=$3,decision_reason=$5,
       version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='SUBMITTED'`,
    [id, version, actorId ?? null, status, reason ?? ''],
  );
  return done.rowCount === 1;
}

// ---------- The days on the month ----------

// A planned day, with the stops the round asks for. The stop list is what adherence measures
// against; the typed outlet count is only what the rep promised.
const DAY_COLUMNS = `
  to_char(d.work_date,'YYYY-MM-DD') AS work_date,
  d.beat_id, coalesce(b.code,'') AS beat, coalesce(b.name,'') AS beat_name,
  d.town, d.outlet_count, d.objective, d.source,
  coalesce(o.stops, ARRAY[]::uuid[]) AS outlets`;

const DAY_FROM = `tour_plan_days d
  LEFT JOIN beats b ON b.id=d.beat_id
  LEFT JOIN LATERAL (
    SELECT array_agg(bo.customer_id ORDER BY bo.sequence) AS stops
    FROM beat_outlets bo JOIN trade_customers c ON c.id=bo.customer_id
    WHERE bo.beat_id=d.beat_id AND c.deleted_at IS NULL
  ) o ON true`;

const asDay = (row) => ({
  ...row,
  outlet_count: n(row.outlet_count),
  outlets: (row.outlets ?? []).map(String),
});

export async function planDays(db, planId) {
  return (
    await db.query(
      `SELECT ${DAY_COLUMNS} FROM ${DAY_FROM} WHERE d.plan_id=$1 ORDER BY d.work_date`,
      [planId],
    )
  ).rows.map(asDay);
}

// Every planned day of one rep over a span, whichever months those days belong to. Adherence may
// be asked for a quarter, and a quarter is three plans.
export async function plannedDaysFor(db, { repId, from, to }) {
  return (
    await db.query(
      `SELECT ${DAY_COLUMNS} FROM ${DAY_FROM}
       JOIN tour_plans p ON p.id=d.plan_id
       WHERE p.rep_id=$1 AND d.work_date BETWEEN $2 AND $3
       ORDER BY d.work_date`,
      [repId, from, to],
    )
  ).rows.map(asDay);
}

// Write one day of a plan. A day is never deleted: taking it off the round leaves the row with
// no beat on it, so the month still reads as a whole month.
export async function savePlanDay(
  db,
  tenantId,
  { planId, workDate, beatId, town = '', outletCount = 0, objective = '', source = 'MANUAL' },
) {
  await db.query(
    `INSERT INTO tour_plan_days(tenant_id,plan_id,work_date,beat_id,town,outlet_count,objective,source)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id,plan_id,work_date) DO UPDATE SET
       beat_id=EXCLUDED.beat_id, town=EXCLUDED.town, outlet_count=EXCLUDED.outlet_count,
       objective=EXCLUDED.objective, source=EXCLUDED.source, changed_at=now()`,
    [
      tenantId,
      planId,
      workDate,
      beatId ?? null,
      town ?? '',
      beatId ? (outletCount ?? 0) : 0,
      objective ?? '',
      source,
    ],
  );
}

// ---------- What the auto-fill has to know ----------

// The beats a rep holds over a span, with the pattern each one runs on and what a day on it is
// worth. The window comes from the assignment, so a beat handed over mid-month is only planned
// for the part of the month the rep actually holds it.
export async function beatsForRep(db, repId, from, to) {
  return (
    await db.query(
      `SELECT b.id, b.code, b.name, b.frequency, b.run_days, b.week_parity,
              to_char(a.from_date,'YYYY-MM-DD') AS from_date,
              to_char(a.to_date,'YYYY-MM-DD') AS to_date,
              coalesce(o.stops,0) AS outlet_count, coalesce(o.town,'') AS town
       FROM beat_assignments a
       JOIN beats b ON b.id=a.beat_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS stops,
                (SELECT c2.town FROM beat_outlets bo2 JOIN trade_customers c2 ON c2.id=bo2.customer_id
                  WHERE bo2.beat_id=b.id AND c2.deleted_at IS NULL AND c2.town <> ''
                  GROUP BY c2.town ORDER BY count(*) DESC, c2.town LIMIT 1) AS town
         FROM beat_outlets bo JOIN trade_customers c ON c.id=bo.customer_id
         WHERE bo.beat_id=b.id AND c.deleted_at IS NULL
       ) o ON true
       WHERE a.rep_id=$1 AND a.deleted_at IS NULL AND a.active
         AND b.deleted_at IS NULL AND b.active
         AND a.from_date <= $3 AND (a.to_date IS NULL OR a.to_date >= $2)
       ORDER BY lower(b.code)`,
      [repId, from, to],
    )
  ).rows.map((r) => ({ ...r, outlet_count: n(r.outlet_count) }));
}

// Lay a month out from the beat calendar. Only the rows the auto-fill itself wrote are
// refreshed: a day a rep typed by hand is theirs, and a second run must not quietly undo it.
export async function autoFillPlan(db, tenantId, plan) {
  const span = monthSpan(plan.month);
  const [beats, holidays, existing] = await Promise.all([
    beatsForRep(db, plan.rep_id, span.from, span.to),
    holidaysFor(db, plan.territory_id, span.from, span.to),
    planDays(db, plan.id),
  ]);

  const manual = new Set(
    existing.filter((d) => d.source === 'MANUAL').map((d) => String(d.work_date)),
  );
  const proposal = autoFill({ month: plan.month, beats, holidays, weekOff: plan.week_off });

  let written = 0;
  for (const day of proposal.days) {
    if (manual.has(day.work_date)) continue;
    await savePlanDay(db, tenantId, {
      planId: plan.id,
      workDate: day.work_date,
      beatId: day.beat_id,
      town: day.town,
      outletCount: day.outlet_count,
      objective: day.objective,
      source: 'AUTO',
    });
    written += 1;
  }

  // A day the calendar no longer proposes, and that nobody typed, loses its round rather than
  // its row: the month keeps its shape and the change stays visible.
  const proposed = new Set(proposal.days.map((d) => d.work_date));
  for (const day of existing) {
    if (day.source !== 'AUTO' || proposed.has(String(day.work_date))) continue;
    if (!day.beat_id) continue;
    await savePlanDay(db, tenantId, {
      planId: plan.id,
      workDate: day.work_date,
      beatId: null,
      source: 'AUTO',
    });
  }

  return { written, kept: manual.size, clashes: proposal.clashes, skipped: proposal.skipped };
}

// Does this month pass what the company asks of it? Holidays and the rep's week-off come from
// Attendance, so a month is judged against the days the company actually works.
export async function checksFor(db, plan, settings) {
  const span = monthSpan(plan.month);
  const [days, holidays] = await Promise.all([
    planDays(db, plan.id),
    holidaysFor(db, plan.territory_id, span.from, span.to),
  ]);
  return {
    days,
    holidays,
    ...planChecks({ month: plan.month, days, holidays, weekOff: plan.week_off, settings }),
  };
}

// ---------- Moving one day of an approved month ----------

const CHANGE_COLUMNS = `
  c.id, c.version, c.status, c.reason, c.decision_reason,
  to_char(c.work_date,'YYYY-MM-DD') AS work_date,
  to_char(p.plan_month,'YYYY-MM') AS month,
  c.plan_id, c.rep_id, r.code AS rep, r.name AS rep_name,
  c.beat_id, coalesce(b.code,'') AS beat, c.town, c.outlet_count, c.objective,
  c.previous_beat_id, coalesce(pb.code,'') AS previous_beat,
  c.previous_town, c.previous_outlet_count, c.previous_objective,
  coalesce(u.name,'') AS decided_by,
  to_char(c.decided_at,'YYYY-MM-DD HH24:MI') AS decided_at`;

const CHANGE_FROM = `tour_plan_changes c
  JOIN tour_plans p ON p.id=c.plan_id
  JOIN field_reps r ON r.id=c.rep_id
  LEFT JOIN beats b ON b.id=c.beat_id
  LEFT JOIN beats pb ON pb.id=c.previous_beat_id
  LEFT JOIN app_users u ON u.id=c.decided_by`;

const CHANGE_WHERE = `($1::uuid IS NULL OR c.rep_id=$1) AND ($2::text IS NULL OR c.status=$2)`;

const asChange = (row) => ({
  ...row,
  version: Number(row.version),
  outlet_count: n(row.outlet_count),
  previous_outlet_count: n(row.previous_outlet_count),
});

export async function findChange(db, id) {
  const row = (await db.query(`SELECT ${CHANGE_COLUMNS} FROM ${CHANGE_FROM} WHERE c.id=$1`, [id]))
    .rows[0];
  return row ? asChange(row) : null;
}

export async function listChanges(db, { repId = null, status = null, limit = DEFAULT_PAGE_SIZE }) {
  const params = [repId, status];
  const total = await countRows(db, CHANGE_FROM, CHANGE_WHERE, params);
  const rows = (
    await db.query(
      `SELECT ${CHANGE_COLUMNS} FROM ${CHANGE_FROM} WHERE ${CHANGE_WHERE}
       ORDER BY c.work_date DESC, lower(r.code) LIMIT $3`,
      [...params, limit],
    )
  ).rows.map(asChange);
  return { items: rows, total };
}

export async function requestDayChange(
  db,
  tenantId,
  { id, planId, repId, workDate, beatId, town, outletCount, objective, reason, previous },
) {
  await db.query(
    `INSERT INTO tour_plan_changes(id,tenant_id,plan_id,rep_id,work_date,beat_id,town,outlet_count,
       objective,previous_beat_id,previous_town,previous_outlet_count,previous_objective,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      id,
      tenantId,
      planId,
      repId,
      workDate,
      beatId ?? null,
      town ?? '',
      beatId ? (outletCount ?? 0) : 0,
      objective ?? '',
      previous?.beat_id ?? null,
      previous?.town ?? '',
      previous?.outlet_count ?? 0,
      previous?.objective ?? '',
      reason,
    ],
  );
  return id;
}

// Approving a change moves that one day and nothing else. What the day said before is already on
// the request, so the old record survives the change that replaced it.
export async function decideDayChange(db, actorId, tenantId, { change, status, reason }) {
  const done = await db.query(
    `UPDATE tour_plan_changes SET status=$4,decided_at=now(),decided_by=$3,decision_reason=$5,
       version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='PENDING'`,
    [change.id, change.version, actorId ?? null, status, reason ?? ''],
  );
  if (done.rowCount !== 1) return false;
  if (status === 'APPROVED')
    await savePlanDay(db, tenantId, {
      planId: change.plan_id,
      workDate: change.work_date,
      beatId: change.beat_id,
      town: change.town,
      outletCount: change.outlet_count,
      objective: change.objective,
      source: 'MANUAL',
    });
  return true;
}

// ---------- Plan vs actual ----------

export async function visitsFor(db, { repId, from, to }) {
  return (
    await db.query(
      `SELECT v.id, v.customer_id, v.rep_id, v.out_of_fence, v.distance_m,
              to_char(v.visit_date,'YYYY-MM-DD') AS visit_date,
              coalesce(c.code,'') AS customer, coalesce(c.name,'') AS customer_name
       FROM visits v LEFT JOIN trade_customers c ON c.id=v.customer_id
       WHERE v.rep_id=$1 AND v.visit_date BETWEEN $2 AND $3
       ORDER BY v.visit_date, v.checked_in_at`,
      [repId, from, to],
    )
  ).rows.map((r) => ({ ...r, distance_m: n(r.distance_m) }));
}

// How a span read against what was planned for it. The attendance register is asked first, so a
// holiday, a week-off or leave approved at any time — including after the plan was built — takes
// the day out of the count instead of reading as a day the rep missed.
export async function adherenceFor(db, { repId, from, to }, settings) {
  const rep = await findRep(db, repId);
  if (!rep) return null;
  const [days, visits, register] = await Promise.all([
    plannedDaysFor(db, { repId, from, to }),
    visitsFor(db, { repId, from, to }),
    registerFor(db, { repId, from, to }, settings),
  ]);
  return {
    rep: { id: rep.id, code: rep.code, name: rep.name, shift: rep.shift_code },
    ...planAdherence({
      from,
      to,
      days,
      visits,
      register: register?.rows ?? [],
      followedPct: settings.plan_followed_pct,
    }),
  };
}

// ---------- Everyone's month at a glance ----------

const PLANS_FROM = `tour_plans p JOIN field_reps r ON r.id=p.rep_id`;
const PLANS_WHERE = `p.plan_month=$1 AND ($2::uuid IS NULL OR r.territory_id=$2)
  AND ($3::text IS NULL OR p.status=$3) AND r.deleted_at IS NULL`;

// Which reps have a month in, and where each one stands. The reps with no plan at all are the
// point of the screen, so they are listed too rather than left out.
export async function planBoard(db, { month, territoryId = null, status = null }) {
  const span = monthSpan(month);
  if (!span) return { month, rows: [], totals: {}, missing: [] };
  const params = [span.from, territoryId, status];

  const rows = (
    await db.query(
      `SELECT p.id, p.version, p.status, r.id AS rep_id, r.code AS rep, r.name AS rep_name,
              coalesce(t.code,'') AS territory,
              to_char(p.submitted_at,'YYYY-MM-DD HH24:MI') AS submitted_at,
              to_char(p.decided_at,'YYYY-MM-DD HH24:MI') AS decided_at,
              p.decision_reason,
              coalesce(d.field_days,0) AS field_days,
              coalesce(d.outlets,0) AS outlets
       FROM ${PLANS_FROM}
       LEFT JOIN territories t ON t.id=r.territory_id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS field_days, coalesce(sum(outlet_count),0)::int AS outlets
         FROM tour_plan_days WHERE plan_id=p.id AND beat_id IS NOT NULL
       ) d ON true
       WHERE ${PLANS_WHERE}
       ORDER BY lower(r.code)`,
      params,
    )
  ).rows.map((r) => ({
    ...r,
    version: Number(r.version),
    field_days: n(r.field_days),
    outlets: n(r.outlets),
  }));

  // Reps who owe a plan for this month and have not started one.
  const missing = (
    await db.query(
      `SELECT r.id AS rep_id, r.code AS rep, r.name AS rep_name, coalesce(t.code,'') AS territory
       FROM field_reps r LEFT JOIN territories t ON t.id=r.territory_id
       WHERE r.deleted_at IS NULL AND r.active
         AND ($2::uuid IS NULL OR r.territory_id=$2)
         AND NOT EXISTS (SELECT 1 FROM tour_plans p WHERE p.rep_id=r.id AND p.plan_month=$1)
       ORDER BY lower(r.code)`,
      [span.from, territoryId],
    )
  ).rows;

  const totals = { DRAFT: 0, SUBMITTED: 0, APPROVED: 0, SENT_BACK: 0, NONE: missing.length };
  for (const row of rows) totals[row.status] += 1;
  return { month, rows, totals, missing };
}
