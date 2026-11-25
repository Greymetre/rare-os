// RCH-4: the database side of the visit and its check-out report.
//
// What is stored is only evidence: when the rep arrived, where they were, how far that was from
// the shop's own tagged location, when they left, and what they answered. Nothing about how the
// visit *reads* is written down — the duration is the two timestamps, and whether the report is
// complete is judged against the form as it stands now, by `packages/engines/visit.mjs`.
//
// A check-in is never refused here. The only thing that can stop one is a shop that does not
// exist. Standing 800 metres away is recorded and flagged, because refusing it would lose a real
// visit and teach the salesman to distrust the app.
//
// The report form is the customer form's own machinery: `visit_form_fields` and
// `visit_form_rules` hold the same matrix, and `packages/engines/customer-form.mjs` turns it into
// the same field descriptors, so an answer typed into the field app and an answer read from a
// spreadsheet are judged by exactly the same rule.
//
// Every function receives a pg client already inside a company-scoped (RLS) transaction.
import { countRows, DEFAULT_PAGE_SIZE } from './paging.mjs';
import { reachSettings, validateAnswers } from './customers-db.mjs';
import { customerForm } from '../engines/customer-form.mjs';
import {
  daySummary,
  duplicateOf,
  fenceVerdict,
  fieldDay,
  visitVerdict,
} from '../engines/visit.mjs';

const n = (v) => (v === null || v === undefined ? null : Number(v));

export async function visitSettings(db) {
  return reachSettings(db);
}

// ---------- The report form ----------

// The questions this customer type asks on the way out, already in form order. A field with no
// rule for the type is not asked: the matrix is the whole story.
export async function visitFormFor(db, typeId) {
  const rows = (
    await db.query(
      `SELECT f.field_key,f.name,f.input,f.section,f.display_order,f.options,f.help,
         f.default_value,r.requirement,r.label_override
       FROM visit_form_rules r JOIN visit_form_fields f ON f.id=r.field_id
       WHERE r.type_id=$1 AND r.deleted_at IS NULL AND r.active
         AND f.deleted_at IS NULL AND f.active`,
      [typeId],
    )
  ).rows;
  return customerForm(rows);
}

// ---------- The shop being called on ----------

// What the fence is measured against, and what the type says a real call takes. A customer that
// is not active is still readable, because a visit may be read back long after a shop closed.
export async function callableCustomer(db, customerId) {
  const row = (
    await db.query(
      `SELECT c.id,c.code,c.name,c.town,c.status,c.beat_id,c.latitude,c.longitude,c.type_id,
              t.code AS type,t.name AS type_name,t.checkin_radius_m,t.min_visit_minutes,
              t.kyc_before_order,b.code AS beat
       FROM trade_customers c JOIN customer_types t ON t.id=c.type_id
       LEFT JOIN beats b ON b.id=c.beat_id
       WHERE c.id=$1 AND c.deleted_at IS NULL`,
      [customerId],
    )
  ).rows[0];
  return row
    ? {
        ...row,
        checkin_radius_m: n(row.checkin_radius_m),
        min_visit_minutes: n(row.min_visit_minutes),
      }
    : null;
}

// ---------- Reading visits ----------

const VISIT_COLUMNS = `
  v.id, v.version, v.rep_id, v.customer_id, v.beat_id, v.client_ref, v.report,
  to_char(v.visit_date,'YYYY-MM-DD') AS visit_date,
  v.checked_in_at, v.checked_out_at, v.distance_m, v.out_of_fence, v.note,
  v.latitude, v.longitude, v.accuracy_m, v.source,
  v.out_latitude, v.out_longitude, v.out_accuracy_m, v.out_source,
  r.code AS rep, r.name AS rep_name,
  c.code AS customer, c.name AS customer_name, c.town, c.type_id,
  t.code AS type, t.min_visit_minutes, t.checkin_radius_m,
  coalesce(b.code,'') AS beat`;

const VISIT_FROM = `visits v
  JOIN field_reps r ON r.id=v.rep_id
  JOIN trade_customers c ON c.id=v.customer_id
  JOIN customer_types t ON t.id=c.type_id
  LEFT JOIN beats b ON b.id=v.beat_id`;

const asVisit = (row) => ({
  ...row,
  version: Number(row.version),
  distance_m: n(row.distance_m),
  min_visit_minutes: n(row.min_visit_minutes),
  checkin_radius_m: n(row.checkin_radius_m),
  checked_in_at: row.checked_in_at?.toISOString?.() ?? row.checked_in_at,
  checked_out_at: row.checked_out_at?.toISOString?.() ?? row.checked_out_at ?? null,
});

// One visit, with everything about it that is read rather than stored. The form is fetched per
// customer type, so a report is always judged by the questions that type asks today.
export async function findVisit(db, visitId) {
  const row = (
    await db.query(`SELECT ${VISIT_COLUMNS} FROM ${VISIT_FROM} WHERE v.id=$1`, [visitId])
  ).rows[0];
  if (!row) return null;
  const visit = asVisit(row);
  const form = await visitFormFor(db, visit.type_id);
  return { ...visit, ...visitVerdict({ visit, form, minMinutes: visit.min_visit_minutes }), form };
}

// The visits one rep could still be inside, or has just left, at this shop today. This is the
// list the de-duplication rule is applied to.
export async function recentVisits(db, { repId, customerId, workDate }) {
  return (
    await db.query(
      `SELECT v.id,v.client_ref,v.checked_in_at,v.checked_out_at
       FROM visits v WHERE v.rep_id=$1 AND v.customer_id=$2 AND v.visit_date=$3
       ORDER BY v.checked_in_at DESC`,
      [repId, customerId, workDate],
    )
  ).rows.map((r) => ({
    ...r,
    checked_in_at: r.checked_in_at?.toISOString?.() ?? r.checked_in_at,
    checked_out_at: r.checked_out_at?.toISOString?.() ?? r.checked_out_at ?? null,
  }));
}

// Adding the verdict to a list of rows costs one form read per customer type, not per row.
async function withVerdicts(db, rows) {
  const forms = new Map();
  const out = [];
  for (const row of rows) {
    const visit = asVisit(row);
    if (!forms.has(visit.type_id)) forms.set(visit.type_id, await visitFormFor(db, visit.type_id));
    out.push({
      ...visit,
      ...visitVerdict({
        visit,
        form: forms.get(visit.type_id),
        minMinutes: visit.min_visit_minutes,
      }),
    });
  }
  return out;
}

const LIST_WHERE = `($1::uuid IS NULL OR v.rep_id=$1)
  AND ($2::uuid IS NULL OR v.customer_id=$2)
  AND ($3::date IS NULL OR v.visit_date >= $3)
  AND ($4::date IS NULL OR v.visit_date <= $4)`;

export async function listVisits(
  db,
  { repId = null, customerId = null, from = null, to = null, limit = DEFAULT_PAGE_SIZE },
) {
  const params = [repId, customerId, from, to];
  const total = await countRows(db, VISIT_FROM, LIST_WHERE, params);
  const rows = (
    await db.query(
      `SELECT ${VISIT_COLUMNS} FROM ${VISIT_FROM} WHERE ${LIST_WHERE}
       ORDER BY v.visit_date DESC, v.checked_in_at DESC LIMIT $5`,
      [...params, limit],
    )
  ).rows;
  const items = await withVerdicts(db, rows);
  return { items, total, summary: daySummary(items) };
}

// ---------- Checking in ----------

// Record the arrival. The fence is judged once, now, because a shop may be re-tagged later and
// this visit should keep what was true when it happened.
export async function checkIn(
  db,
  tenantId,
  { id, repId, customer, workDate, at, clientRef = '', note = '', beatId = null, fileId = null },
) {
  const fence = fenceVerdict({ customer, at, radius: customer.checkin_radius_m });
  await db.query(
    `INSERT INTO visits(id,tenant_id,rep_id,customer_id,visit_date,checked_in_at,
       latitude,longitude,accuracy_m,source,distance_m,out_of_fence,note,client_ref,beat_id,file_id)
     VALUES($1,$2,$3,$4,$5,now(),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      tenantId,
      repId,
      customer.id,
      workDate,
      at.latitude ?? null,
      at.longitude ?? null,
      at.accuracy_m ?? null,
      at.latitude === null || at.latitude === undefined ? null : (at.source ?? 'DEVICE'),
      fence.distance_m,
      fence.out_of_fence,
      note ?? '',
      clientRef ?? '',
      beatId ?? customer.beat_id ?? null,
      fileId ?? null,
    ],
  );
  return { id, ...fence };
}

// Which visit a check-in belongs to: the one already open or just closed, or none, in which case
// the caller makes a new one.
export async function existingVisit(db, { repId, customerId, workDate, clientRef, settings }) {
  const candidates = await recentVisits(db, { repId, customerId, workDate });
  const found = duplicateOf({
    candidates,
    clientRef,
    at: new Date().toISOString(),
    withinMinutes: settings.visit_dedupe_minutes,
  });
  return found ? findVisit(db, found.id) : null;
}

// ---------- Checking out ----------

// The answers, checked against the type's own form. Unknown keys are refused rather than stored:
// a stray key would sit in the report for ever, invisible on every screen.
export async function checkReport(db, typeId, raw) {
  const form = await visitFormFor(db, typeId);
  return { form, ...validateAnswers(form, raw) };
}

export async function checkOut(db, { visitId, version, at, report }) {
  const done = await db.query(
    `UPDATE visits SET checked_out_at=now(),out_latitude=$3,out_longitude=$4,out_accuracy_m=$5,
       out_source=$6,report=$7,version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND checked_out_at IS NULL`,
    [
      visitId,
      version,
      at.latitude ?? null,
      at.longitude ?? null,
      at.accuracy_m ?? null,
      at.latitude === null || at.latitude === undefined ? null : (at.source ?? 'DEVICE'),
      JSON.stringify(report ?? {}),
    ],
  );
  return done.rowCount === 1;
}

// A report may be corrected after the visit has ended. The visit itself is never reopened: when
// the rep left is what happened, and that stands.
export async function amendReport(db, { visitId, version, report }) {
  const done = await db.query(
    `UPDATE visits SET report=$3,version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND checked_out_at IS NOT NULL`,
    [visitId, version, JSON.stringify(report ?? {})],
  );
  return done.rowCount === 1;
}

// ---------- The rep's day ----------

// The stops the tour plan asked for on this date, in walking order. A rep with no plan for the
// month, or no round that day, simply has no planned stops — the field app still works, and
// anything they call on reads as unplanned.
export async function plannedStops(db, { repId, workDate }) {
  return (
    await db.query(
      `SELECT o.customer_id, o.sequence, c.code, c.name, c.town, c.status,
              c.latitude, c.longitude, t.code AS type, t.checkin_radius_m, d.beat_id,
              coalesce(b.code,'') AS beat
       FROM tour_plan_days d
       JOIN tour_plans p ON p.id=d.plan_id
       JOIN beats b ON b.id=d.beat_id
       JOIN beat_outlets o ON o.beat_id=d.beat_id
       JOIN trade_customers c ON c.id=o.customer_id
       JOIN customer_types t ON t.id=c.type_id
       WHERE p.rep_id=$1 AND d.work_date=$2 AND c.deleted_at IS NULL
       ORDER BY o.sequence`,
      [repId, workDate],
    )
  ).rows.map((r) => ({ ...r, checkin_radius_m: n(r.checkin_radius_m) }));
}

// Everything the field app draws: the round, what has happened at each stop, the visit still
// open if there is one, and the day's totals.
export async function repDay(db, { repId, workDate }) {
  const rows = (
    await db.query(
      `SELECT ${VISIT_COLUMNS} FROM ${VISIT_FROM}
       WHERE v.rep_id=$1 AND v.visit_date=$2 ORDER BY v.checked_in_at`,
      [repId, workDate],
    )
  ).rows;
  const visits = await withVerdicts(db, rows);
  const stops = await plannedStops(db, { repId, workDate });
  return {
    date: workDate,
    ...fieldDay({ stops, visits }),
    visits,
    summary: daySummary(visits),
  };
}

// ---------- What a manager reads ----------

// One date across a territory: who called on whom, how long they stayed, how far from the shop
// they were, and which reports are still unfinished.
export async function visitBoard(db, { workDate, territoryId = null }) {
  const rows = (
    await db.query(
      `SELECT ${VISIT_COLUMNS} FROM ${VISIT_FROM}
       WHERE v.visit_date=$1 AND ($2::uuid IS NULL OR r.territory_id=$2)
       ORDER BY lower(r.code), v.checked_in_at`,
      [workDate, territoryId],
    )
  ).rows;
  const visits = await withVerdicts(db, rows);

  // Grouped by rep, because the question this screen answers is "how did each rep's day go?".
  const byRep = new Map();
  for (const visit of visits) {
    if (!byRep.has(visit.rep_id))
      byRep.set(visit.rep_id, {
        rep_id: visit.rep_id,
        rep: visit.rep,
        rep_name: visit.rep_name,
        visits: [],
      });
    byRep.get(visit.rep_id).visits.push(visit);
  }
  // The summary goes under its own key rather than being spread: `daySummary` reports a count
  // called `visits`, and spreading it would quietly replace the rep's list of visits with a
  // number.
  const reps = [...byRep.values()].map((row) => ({ ...row, summary: daySummary(row.visits) }));
  return { date: workDate, reps, summary: daySummary(visits) };
}

export const VISIT_COLUMNS_CSV = [
  'visit_date',
  'rep',
  'rep_name',
  'customer',
  'customer_name',
  'type',
  'beat',
  'town',
  'checked_in_at',
  'checked_out_at',
  'minutes',
  'distance_m',
  'out_of_fence',
  'status',
  'report_complete',
];

export async function visitCsvRows(db, filters) {
  const { items } = await listVisits(db, { ...filters, limit: 5000 });
  return items.map((v) => ({
    visit_date: v.visit_date,
    rep: v.rep,
    rep_name: v.rep_name,
    customer: v.customer,
    customer_name: v.customer_name,
    type: v.type,
    beat: v.beat,
    town: v.town,
    checked_in_at: v.checked_in_at ?? '',
    checked_out_at: v.checked_out_at ?? '',
    minutes: v.minutes ?? '',
    distance_m: v.distance_m ?? '',
    out_of_fence: v.out_of_fence ? 'yes' : 'no',
    status: v.status,
    report_complete: v.report_complete ? 'yes' : 'no',
  }));
}
