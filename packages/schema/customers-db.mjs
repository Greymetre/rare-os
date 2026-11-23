// RCH-1: the database side of trade customers, their location tags and their beats.
//
// These are not generic masters: the questions a customer answers depend on its type, so the form
// is read from the company's own configuration and the answers are kept in `attrs`. Everything a
// customer has whatever its type — its code, type, beat, territory, rep, status and location — is
// a column, so it can be searched, filtered and joined.
//
// Every function receives a pg client already inside a company-scoped (RLS) transaction.
import { countRows, DEFAULT_PAGE_SIZE } from './paging.mjs';
import { validateFields } from './masters.mjs';
import { customerForm } from '../engines/customer-form.mjs';
import { geoDecision, metresBetween } from '../engines/geo.mjs';

// What the settings are when a company has never opened the Setup screen. The same numbers as the
// column defaults in the migration, repeated here so a read never depends on a row existing.
export const SETTING_DEFAULTS = {
  gps_verified_m: 50,
  duplicate_within_m: 30,
  retag_approval_m: 100,
  kyc_reminder_days: 7,
  // RCH-2. Attendance shares this row so a company has one Setup screen, not two.
  attendance_fence_m: 200,
  absent_after_minutes: 120,
  selfie_required: true,
  timezone: 'Asia/Kolkata',
  // RCH-3. The numbers the tour plan is judged by: when a month is due, how big a day may be,
  // how much of the month must be field work, and what share of a round reads as Followed.
  plan_due_day: 25,
  plan_max_outlets: 12,
  plan_field_days_pct: 75,
  plan_followed_pct: 60,
  // RCH-4. How long a repeated check-in still counts as the same visit, for a field connection
  // that drops and retries.
  visit_dedupe_minutes: 10,
  // RCH-5. How a company reads its ageing, when its financial year starts, and the window
  // days-sales-outstanding is measured over.
  ageing_buckets: '30,60,90',
  fy_start_month: 4,
  dso_window_days: 90,
  // RCH-6. Whether a claim covers a fortnight or a whole month, and how long after a period
  // closes a rep may still send its claim in. Zero days means no deadline.
  expense_fortnightly: true,
  expense_window_days: 15,
};

export async function reachSettings(db) {
  const row = (
    await db.query(`SELECT ${Object.keys(SETTING_DEFAULTS).join(',')},version FROM reach_settings`)
  ).rows[0];
  return row ? { ...row, version: Number(row.version) } : { ...SETTING_DEFAULTS, version: 0 };
}

// The one row per company, created on first save. version 0 means there was no row.
export async function saveReachSettings(db, tenantId, value) {
  const columns = Object.keys(SETTING_DEFAULTS);
  // One row holds every Reach setting, but a screen only knows its own. Anything the caller did
  // not send keeps the value it already had, so saving the customer settings cannot blank the
  // attendance ones — and the reverse.
  const current = await reachSettings(db);
  const settled = Object.fromEntries(
    columns.map((c) => [c, value[c] === undefined ? current[c] : value[c]]),
  );
  await db.query(
    `INSERT INTO reach_settings(tenant_id,${columns.join(',')})
     VALUES($1,${columns.map((_, i) => '$' + (i + 2)).join(',')})
     ON CONFLICT (tenant_id) DO UPDATE SET ${columns
       .map((c) => `${c}=excluded.${c}`)
       .join(',')},version=reach_settings.version+1,updated_at=now()`,
    [tenantId, ...columns.map((c) => settled[c])],
  );
}

// ---------- The form a type asks ----------

const TYPE_COLUMNS = `t.id,t.code,t.name,t.tier,t.prefix,t.geo_required,t.checkin_radius_m,
  t.min_visit_minutes,t.visit_norm_per_month,t.on_beat_plan,t.needs_approval,t.kyc_before_order,
  t.order_route,t.credit_limit,t.credit_days,t.hold_days,t.loyalty`;

export async function customerType(db, typeId) {
  return (
    (
      await db.query(
        `SELECT ${TYPE_COLUMNS} FROM customer_types t WHERE t.id=$1 AND t.deleted_at IS NULL`,
        [typeId],
      )
    ).rows[0] ?? null
  );
}

export async function customerTypes(db) {
  return (
    await db.query(
      `SELECT ${TYPE_COLUMNS} FROM customer_types t
       WHERE t.deleted_at IS NULL AND t.active ORDER BY t.tier, lower(t.code)`,
    )
  ).rows;
}

// The questions this type asks, already in form order. A field with no rule for the type is not
// asked: the matrix is the whole story, so a new field appears nowhere until someone places it.
export async function formFor(db, typeId) {
  const rows = (
    await db.query(
      `SELECT f.field_key,f.name,f.input,f.section,f.display_order,f.options,f.help,
         f.default_value,r.requirement,r.label_override
       FROM customer_form_rules r JOIN customer_form_fields f ON f.id=r.field_id
       WHERE r.type_id=$1 AND r.deleted_at IS NULL AND r.active
         AND f.deleted_at IS NULL AND f.active`,
      [typeId],
    )
  ).rows;
  return customerForm(rows);
}

// Checks the answers against the form. Unknown keys are refused rather than stored: a stray key
// would sit in attrs for ever, invisible on every screen.
export function validateAnswers(form, raw) {
  const asked = new Set(form.map((f) => f.field_key));
  const errors = [];
  for (const key of Object.keys(raw ?? {}))
    if (!asked.has(key))
      errors.push({ column: key, message: `This customer type is not asked for ${key}.` });
  const checked = validateFields(
    form.map((f) => f.descriptor),
    raw ?? {},
  );
  return { value: checked.value, errors: [...errors, ...checked.errors] };
}

// ---------- Reading customers ----------

const SELECT_CUSTOMER = `SELECT x.id,x.code,x.name,t.code AS type,t.name AS type_name,x.type_id,
    t.on_beat_plan,t.geo_required,t.checkin_radius_m,t.needs_approval,
    x.status,b.code AS beat,x.beat_id,ter.code AS territory,x.territory_id,
    f.code AS buys_from,x.buys_from_id,r.code AS rep,r.name AS rep_name,x.rep_id,
    sc.code AS sales_customer,x.sales_customer_id,
    x.town,x.phone,x.attrs,x.latitude,x.longitude,x.geo_source,x.geo_accuracy_m,x.geo_verified,
    x.geo_tagged_at,x.decision_reason,x.version,x.updated_at,
    o.sequence AS beat_sequence
  FROM trade_customers x
    JOIN customer_types t ON t.id=x.type_id
    JOIN territories ter ON ter.id=x.territory_id
    LEFT JOIN beats b ON b.id=x.beat_id
    LEFT JOIN trade_customers f ON f.id=x.buys_from_id
    LEFT JOIN field_reps r ON r.id=x.rep_id
    LEFT JOIN customers sc ON sc.id=x.sales_customer_id
    LEFT JOIN beat_outlets o ON o.customer_id=x.id`;

// Filters the register the way the screen offers them. Every one is optional; the search matches
// the start of the code or the name, as it does everywhere else in the product.
function customerWhere({ q = '', type = '', status = '', beat = '', territory = '', geo = '' }) {
  const where = ['x.deleted_at IS NULL'];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('$n', '$' + params.length));
  };
  if (q) add('(starts_with(lower(x.code),$n) OR starts_with(lower(x.name),$n))', q);
  if (type) add('lower(t.code)=$n', type.toLowerCase());
  if (status) add('x.status=$n', status);
  if (beat) add('lower(b.code)=$n', beat.toLowerCase());
  if (territory) add('lower(ter.code)=$n', territory.toLowerCase());
  // Tagged, not tagged, or tagged by a device fix close enough to stand as proof.
  if (geo === 'tagged') where.push('x.latitude IS NOT NULL');
  if (geo === 'untagged') where.push('x.latitude IS NULL');
  if (geo === 'verified') where.push('x.geo_verified');
  return { where: where.join(' AND '), params };
}

export async function listCustomers(db, filters = {}) {
  const { where, params } = customerWhere(filters);
  const limit = filters.limit ?? DEFAULT_PAGE_SIZE;
  const from = SELECT_CUSTOMER.slice(SELECT_CUSTOMER.indexOf(' FROM ') + 6);
  const total = await countRows(db, from, where, params);
  const args = [...params];
  let cursorWhere = '';
  if (filters.cursor) {
    args.push(filters.cursor[0], filters.cursor[1]);
    cursorWhere = ` AND (lower(x.code),x.id::text) > ($${args.length - 1}::text,$${args.length}::text)`;
  }
  args.push(limit + 1);
  const rows = (
    await db.query(
      `${SELECT_CUSTOMER} WHERE ${where}${cursorWhere}
       ORDER BY lower(x.code), x.id::text LIMIT $${args.length}`,
      args,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    total,
    nextCursor: rows.length > limit ? [String(last.code).toLowerCase(), String(last.id)] : null,
  };
}

export async function findCustomer(db, id) {
  return (
    (await db.query(`${SELECT_CUSTOMER} WHERE x.id=$1 AND x.deleted_at IS NULL`, [id])).rows[0] ??
    null
  );
}

// The numbers above the register: what the reader should look at first.
export async function customerTiles(db) {
  return (
    await db.query(
      `SELECT count(*)::int AS total,
         count(*) FILTER (WHERE status='ACTIVE')::int AS active,
         count(*) FILTER (WHERE status='DORMANT')::int AS dormant,
         count(*) FILTER (WHERE status='AWAITING_APPROVAL')::int AS awaiting,
         count(*) FILTER (WHERE status='REJECTED')::int AS rejected,
         count(*) FILTER (WHERE latitude IS NOT NULL)::int AS tagged,
         count(*) FILTER (WHERE geo_verified)::int AS verified,
         count(*) FILTER (WHERE rep_id IS NULL)::int AS unassigned
       FROM trade_customers WHERE deleted_at IS NULL`,
    )
  ).rows[0];
}

// ---------- Writing customers ----------

const WRITE_COLUMNS = [
  'code',
  'name',
  'type_id',
  'status',
  'beat_id',
  'territory_id',
  'buys_from_id',
  'rep_id',
  'sales_customer_id',
  'town',
  'phone',
  'attrs',
];

export async function createCustomer(db, tenantId, value) {
  const row = (
    await db.query(
      `INSERT INTO trade_customers(id,tenant_id,${WRITE_COLUMNS.join(',')})
       VALUES(gen_random_uuid(),$1,${WRITE_COLUMNS.map((_, i) => '$' + (i + 2)).join(',')})
       RETURNING id`,
      [
        tenantId,
        ...WRITE_COLUMNS.map((c) =>
          c === 'attrs' ? JSON.stringify(value.attrs ?? {}) : (value[c] ?? null),
        ),
      ],
    )
  ).rows[0];
  return row.id;
}

// The code and the type never change: answers already stored belong to that type's questions, and
// other records point at the code.
const EDIT_COLUMNS = [
  'name',
  'beat_id',
  'territory_id',
  'buys_from_id',
  'rep_id',
  'sales_customer_id',
  'town',
  'phone',
  'attrs',
];

export async function updateCustomer(db, id, value) {
  await db.query(
    `UPDATE trade_customers SET ${EDIT_COLUMNS.map((c, i) => `${c}=$${i + 2}`).join(',')},
       version=version+1,updated_at=now() WHERE id=$1`,
    [
      id,
      ...EDIT_COLUMNS.map((c) =>
        c === 'attrs' ? JSON.stringify(value.attrs ?? {}) : (value[c] ?? null),
      ),
    ],
  );
}

export async function setCustomerStatus(db, id, status, { actorId = null, reason = '' } = {}) {
  await db.query(
    `UPDATE trade_customers SET status=$2,decision_reason=$3,
       approved_by=CASE WHEN $2 IN ('ACTIVE','REJECTED') THEN $4 ELSE approved_by END,
       approved_at=CASE WHEN $2 IN ('ACTIVE','REJECTED') THEN now() ELSE approved_at END,
       version=version+1,updated_at=now() WHERE id=$1`,
    [id, status, reason, actorId],
  );
}

export async function removeCustomer(db, id, actorId, reason) {
  const r = await db.query(
    `UPDATE trade_customers SET deleted_at=now(),deleted_by=$2,delete_reason=$3,
       version=version+1,updated_at=now() WHERE id=$1 AND deleted_at IS NULL`,
    [id, actorId, reason],
  );
  return r.rowCount === 1;
}

// What still points at a customer. A distributor with dealers under it is not removed by accident,
// and neither is a shop somebody has already been recorded as visiting.
export async function customerBlockers(db, id) {
  const blockers = [];
  const n = (
    await db.query(
      'SELECT count(*)::int AS n FROM trade_customers WHERE buys_from_id=$1 AND deleted_at IS NULL',
      [id],
    )
  ).rows[0].n;
  if (n) blockers.push(`${n} customer${n === 1 ? '' : 's'} buy${n === 1 ? 's' : ''} from it`);
  // Visits are records of what happened and carry no deleted_at, so the count asks whether the
  // shop was ever called on at all.
  const visits = (
    await db.query('SELECT count(*)::int AS n FROM visits WHERE customer_id=$1', [id])
  ).rows[0].n;
  if (visits)
    blockers.push(
      `${visits} visit${visits === 1 ? '' : 's'} to it ${visits === 1 ? 'is' : 'are'} on record`,
    );
  return blockers;
}

// ---------- Beats ----------

export async function beatOutlets(db, beatId) {
  return (
    await db.query(
      `SELECT o.sequence,o.customer_id,c.code,c.name,c.status,c.town,c.latitude,c.longitude,
         t.code AS type
       FROM beat_outlets o JOIN trade_customers c ON c.id=o.customer_id
         JOIN customer_types t ON t.id=c.type_id
       WHERE o.beat_id=$1 AND c.deleted_at IS NULL ORDER BY o.sequence`,
      [beatId],
    )
  ).rows;
}

// An active customer of a type that walks a beat becomes the next stop on it. Called whenever a
// customer is created, approved or moved, so the round is never out of step with the register.
export async function syncBeatMembership(db, tenantId, customer) {
  const belongs =
    customer.status === 'ACTIVE' && customer.on_beat_plan && customer.beat_id !== null;
  const current = (
    await db.query('SELECT beat_id,sequence FROM beat_outlets WHERE customer_id=$1', [customer.id])
  ).rows[0];
  if (!belongs) {
    if (current) await db.query('DELETE FROM beat_outlets WHERE customer_id=$1', [customer.id]);
    return belongs ? 'kept' : current ? 'removed' : 'absent';
  }
  if (current && current.beat_id === customer.beat_id) return 'kept';
  if (current) await db.query('DELETE FROM beat_outlets WHERE customer_id=$1', [customer.id]);
  const next = (
    await db.query('SELECT coalesce(max(sequence),0)+1 AS n FROM beat_outlets WHERE beat_id=$1', [
      customer.beat_id,
    ])
  ).rows[0].n;
  await db.query(
    'INSERT INTO beat_outlets(tenant_id,beat_id,customer_id,sequence) VALUES($1,$2,$3,$4)',
    [tenantId, customer.beat_id, customer.id, next],
  );
  return current ? 'moved' : 'added';
}

// Rewrites the walking order as the reader arranged it. The positions swap past each other on the
// way, so the uniqueness check waits until the whole new order is in place.
export async function reorderBeat(db, beatId, customerIds) {
  await db.query('SET CONSTRAINTS beat_outlets_order_uniq DEFERRED');
  for (const [index, customerId] of customerIds.entries())
    await db.query('UPDATE beat_outlets SET sequence=$3 WHERE beat_id=$1 AND customer_id=$2', [
      beatId,
      customerId,
      index + 1,
    ]);
}

// ---------- Location tags ----------

// Customers already tagged within `within` metres of a point: the same shop entered twice looks
// exactly like this. Filtered first by a box, so only the handful nearby are measured.
export async function nearbyCustomers(db, point, within, excludeId = null) {
  const degrees = within / 111320 + 0.00001;
  const rows = (
    await db.query(
      `SELECT x.id,x.code,x.name,x.latitude,x.longitude FROM trade_customers x
       WHERE x.deleted_at IS NULL AND x.latitude IS NOT NULL
         AND ($4::uuid IS NULL OR x.id <> $4::uuid)
         AND x.latitude BETWEEN $1::numeric - $3 AND $1::numeric + $3
         AND x.longitude BETWEEN $2::numeric - $3 AND $2::numeric + $3`,
      [point.latitude, point.longitude, degrees, excludeId],
    )
  ).rows;
  return rows
    .map((row) => ({ ...row, metres: metresBetween(point, row) }))
    .filter((row) => row.metres !== null && row.metres <= within)
    .sort((a, b) => a.metres - b.metres);
}

// Tags or re-tags a shop. A first tag and a small correction take effect at once; a move further
// than the company allows is written as a request and the tag on the customer is left alone.
export async function tagCustomer(db, tenantId, actor, customer, next, settings) {
  const previous =
    customer.latitude === null || customer.latitude === undefined
      ? null
      : { latitude: customer.latitude, longitude: customer.longitude };
  const decision = geoDecision({ previous, next, settings });
  const status = decision.needsApproval ? 'PENDING' : 'APPLIED';
  const logId = (
    await db.query(
      `INSERT INTO customer_geo_log(id,tenant_id,customer_id,latitude,longitude,source,accuracy_m,
         moved_m,status,reason,requested_by,requested_by_subject)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        tenantId,
        customer.id,
        next.latitude,
        next.longitude,
        next.source,
        next.accuracy_m ?? null,
        decision.moved,
        status,
        next.reason ?? '',
        actor.id,
        actor.actor_subject ?? null,
      ],
    )
  ).rows[0].id;
  if (status === 'APPLIED') await applyTag(db, customer.id, next, decision.verified);
  return { ...decision, status, logId };
}

async function applyTag(db, customerId, next, verified) {
  await db.query(
    `UPDATE trade_customers SET latitude=$2,longitude=$3,geo_source=$4,geo_accuracy_m=$5,
       geo_verified=$6,geo_tagged_at=now(),version=version+1,updated_at=now() WHERE id=$1`,
    [customerId, next.latitude, next.longitude, next.source, next.accuracy_m ?? null, verified],
  );
}

export async function pendingTag(db, customerId) {
  return (
    (
      await db.query(
        `SELECT id,latitude,longitude,source,accuracy_m,moved_m,reason,created_at
         FROM customer_geo_log WHERE customer_id=$1 AND status='PENDING'`,
        [customerId],
      )
    ).rows[0] ?? null
  );
}

export async function geoHistory(db, customerId, limit = 20) {
  return (
    await db.query(
      `SELECT g.id,g.latitude,g.longitude,g.source,g.accuracy_m,g.moved_m,g.status,g.reason,
         g.decision_reason,g.created_at,g.decided_at,
         coalesce(u.name,'') AS requested_by,coalesce(d.name,'') AS decided_by
       FROM customer_geo_log g
         LEFT JOIN app_users u ON u.id=g.requested_by
         LEFT JOIN app_users d ON d.id=g.decided_by
       WHERE g.customer_id=$1 ORDER BY g.created_at DESC LIMIT $2`,
      [customerId, limit],
    )
  ).rows;
}

// Approving a request moves the tag; rejecting leaves it where it was. Either way the request is
// closed with who decided it and why, so the history reads as a sequence of decisions.
export async function decideTag(db, actor, request, customer, approve, reason, settings) {
  await db.query(
    `UPDATE customer_geo_log SET status=$2,decided_by=$3,decided_at=now(),decision_reason=$4
     WHERE id=$1 AND status='PENDING'`,
    [request.id, approve ? 'APPROVED' : 'REJECTED', actor.id, reason],
  );
  if (!approve) return;
  const verified = geoDecision({
    previous: null,
    next: { ...request, source: request.source },
    settings,
  }).verified;
  await applyTag(db, customer.id, request, verified);
}

// ---------- The approvals queue ----------

export async function pendingApprovals(db) {
  const accounts = (
    await db.query(
      `SELECT x.id,x.code,x.name,t.code AS type,ter.code AS territory,x.town,x.created_at
       FROM trade_customers x JOIN customer_types t ON t.id=x.type_id
         JOIN territories ter ON ter.id=x.territory_id
       WHERE x.status='AWAITING_APPROVAL' AND x.deleted_at IS NULL
       ORDER BY x.created_at LIMIT 200`,
    )
  ).rows;
  const retags = (
    await db.query(
      `SELECT g.id,g.customer_id,c.code,c.name,g.latitude,g.longitude,g.source,g.accuracy_m,
         g.moved_m,g.reason,g.created_at,coalesce(u.name,'') AS requested_by
       FROM customer_geo_log g JOIN trade_customers c ON c.id=g.customer_id
         LEFT JOIN app_users u ON u.id=g.requested_by
       WHERE g.status='PENDING' AND c.deleted_at IS NULL
       ORDER BY g.created_at LIMIT 200`,
    )
  ).rows;
  return { accounts, retags };
}
