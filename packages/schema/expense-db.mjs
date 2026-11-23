// RCH-6: reading and writing expense claims.
//
// The one thing to understand before changing anything here: **no amount is stored.** A claim
// line keeps what the rep said and `priceClaim` works out what the policy makes of it, every
// time, from the policy version in force on each line's own spend date. That is safe because a
// version can only start in the future and is frozen once it has, so re-reading a claim that was
// approved last fortnight always gives the number it was approved at.
//
// Two other modules have the last word here, and are asked rather than copied. The attendance
// register says whether a day was worked, which decides the daily allowance. The tour plan says
// which town the rep was sent to, which decides the rate. Neither is duplicated into this
// module's tables, so a correction over there changes the answer over here with nothing to
// rewrite — the same shape as every other Reach milestone.
import crypto from 'node:crypto';
import {
  claimTotals,
  lineAmount,
  periodOf,
  placeClass,
  policyFor,
  rateFor,
  rateKeyFor,
} from '../engines/expense.mjs';
import { SETTING_DEFAULTS, reachSettings } from './customers-db.mjs';
import { findRep, registerFor } from './attendance-db.mjs';
import { plannedDaysFor } from './tour-db.mjs';

const DEFAULT_PAGE_SIZE = 25;

const num = (v) => (v === null || v === undefined ? null : Number(v));

export async function expenseSettings(db) {
  return reachSettings(db);
}

export function fortnightlyFrom(settings) {
  return settings?.expense_fortnightly !== false;
}

// The period a date belongs to, under this company's own rule.
export function periodFor(date, settings) {
  return periodOf(date, { fortnightly: fortnightlyFrom(settings) });
}

// ---------- Categories ----------

export async function categories(db, { includeInactive = false } = {}) {
  return (
    await db.query(
      `SELECT id,code,name,basis,receipt_above,active FROM expense_categories
       WHERE deleted_at IS NULL ${includeInactive ? '' : 'AND active'}
       ORDER BY lower(code)`,
    )
  ).rows.map((r) => ({ ...r, receipt_above: num(r.receipt_above) }));
}

export async function findCategory(db, id) {
  const row = (
    await db.query(
      `SELECT id,code,name,basis,receipt_above,active FROM expense_categories
       WHERE id=$1 AND deleted_at IS NULL`,
      [id],
    )
  ).rows[0];
  return row ? { ...row, receipt_above: num(row.receipt_above) } : null;
}

// ---------- Policy versions ----------

export async function policies(db) {
  return (
    await db.query(
      `SELECT p.id,p.code,p.name,p.note,p.active,p.version,
              to_char(p.effective_from,'YYYY-MM-DD') AS effective_from,
              (SELECT count(*)::int FROM expense_policy_rates r
                 WHERE r.policy_id=p.id AND r.deleted_at IS NULL) AS rates
       FROM expense_policies p ORDER BY p.effective_from DESC`,
    )
  ).rows.map((r) => ({ ...r, version: Number(r.version) }));
}

export async function findPolicy(db, id) {
  const row = (
    await db.query(
      `SELECT id,code,name,note,active,version,
              to_char(effective_from,'YYYY-MM-DD') AS effective_from
       FROM expense_policies WHERE id=$1`,
      [id],
    )
  ).rows[0];
  return row ? { ...row, version: Number(row.version) } : null;
}

export async function policyRates(db, policyId) {
  return (
    await db.query(
      `SELECT r.policy_id,r.category_id,r.key,r.rate,r.cap,r.period_cap,
              c.code AS category,c.name AS category_name,c.basis
       FROM expense_policy_rates r JOIN expense_categories c ON c.id=r.category_id
       WHERE r.policy_id=$1 AND r.deleted_at IS NULL ORDER BY lower(c.code), r.key`,
      [policyId],
    )
  ).rows.map((r) => ({
    ...r,
    rate: num(r.rate),
    cap: num(r.cap),
    period_cap: num(r.period_cap),
  }));
}

export async function createPolicy(db, tenantId, { id, code, name, effectiveFrom, note, actorId }) {
  await db.query(
    `INSERT INTO expense_policies(id,tenant_id,code,name,effective_from,note,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, tenantId, code, name, effectiveFrom, note ?? '', actorId ?? null],
  );
  return id;
}

export async function updatePolicy(db, { id, version, name, effectiveFrom, note, active }) {
  const r = await db.query(
    `UPDATE expense_policies SET name=$3, effective_from=$4, note=$5, active=$6,
            version=version+1, updated_at=now()
     WHERE id=$1 AND version=$2`,
    [id, version, name, effectiveFrom, note ?? '', active !== false],
  );
  return r.rowCount === 1;
}

// Replace a version's rates wholesale. A version is edited as a set — a company changes "the
// rates" rather than one row of them — and this only ever runs on a version that has not started.
//
// Nothing is deleted, because this table also holds the rates of versions that already governed
// real claims. A row the new set mentions is written over and brought back if it had been taken
// off; a row it does not mention is marked gone. The database refuses a DELETE here outright, so
// this is the only shape that works — which is the grant doing its job.
export async function savePolicyRates(db, tenantId, policyId, rows) {
  const keys = [];
  for (const row of rows) {
    const key = String(row.key ?? '').toUpperCase();
    keys.push(`${row.category_id}|${key}`);
    await db.query(
      `INSERT INTO expense_policy_rates(tenant_id,policy_id,category_id,key,rate,cap,period_cap)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id,policy_id,category_id,key) DO UPDATE
         SET rate=EXCLUDED.rate, cap=EXCLUDED.cap, period_cap=EXCLUDED.period_cap,
             deleted_at=NULL, updated_at=now()`,
      [
        tenantId,
        policyId,
        row.category_id,
        key,
        row.rate ?? null,
        row.cap ?? null,
        row.period_cap ?? null,
      ],
    );
  }
  await db.query(
    `UPDATE expense_policy_rates SET deleted_at=now(), updated_at=now()
     WHERE policy_id=$1 AND deleted_at IS NULL AND (category_id::text || '|' || key) <> ALL($2::text[])`,
    [policyId, keys],
  );
  await db.query('UPDATE expense_policies SET updated_at=now() WHERE id=$1', [policyId]);
  return rows.length;
}

// The version that governs a date, with its rates. Read once and handed to the engine.
export async function policyInForce(db, date) {
  const all = await policies(db);
  const chosen = policyFor({ policies: all, date });
  if (!chosen) return { policy: null, rates: [] };
  return { policy: chosen, rates: await policyRates(db, chosen.id) };
}

// ---------- Claims ----------

const CLAIM_COLUMNS = `
  c.id, c.version, c.status, c.rep_id,
  to_char(c.period_from,'YYYY-MM-DD') AS period_from,
  to_char(c.period_to,'YYYY-MM-DD') AS period_to,
  c.submitted_at, c.manager_by, c.manager_at, c.manager_note,
  c.finance_by, c.finance_at, c.finance_note, c.reject_reason,
  r.code AS rep, r.name AS rep_name, r.hq_town, r.user_id AS rep_user_id,
  coalesce(g.code,'') AS grade,
  coalesce(mu.name,'') AS manager_name, coalesce(fu.name,'') AS finance_name`;

const CLAIM_FROM = `
  expense_claims c
  JOIN field_reps r ON r.id=c.rep_id
  LEFT JOIN rep_grades g ON g.id=r.grade_id
  LEFT JOIN app_users mu ON mu.id=c.manager_by
  LEFT JOIN app_users fu ON fu.id=c.finance_by`;

const asClaim = (r) => (r ? { ...r, version: Number(r.version) } : null);

export async function findClaim(db, id) {
  return asClaim(
    (await db.query(`SELECT ${CLAIM_COLUMNS} FROM ${CLAIM_FROM} WHERE c.id=$1`, [id])).rows[0],
  );
}

export async function claimForPeriod(db, repId, periodFrom) {
  return asClaim(
    (
      await db.query(
        `SELECT ${CLAIM_COLUMNS} FROM ${CLAIM_FROM} WHERE c.rep_id=$1 AND c.period_from=$2`,
        [repId, periodFrom],
      )
    ).rows[0],
  );
}

export async function createClaim(db, tenantId, { id, repId, from, to }) {
  await db.query(
    `INSERT INTO expense_claims(id,tenant_id,rep_id,period_from,period_to)
     VALUES($1,$2,$3,$4,$5)`,
    [id, tenantId, repId, from, to],
  );
  return id;
}

// The claim a rep is filling in for a date, made if it is not there yet. A rep opening their
// expenses screen should not have to press "create" before they can type a line.
export async function openClaim(db, tenantId, { repId, date, settings }) {
  const period = periodFor(date, settings);
  if (!period) return null;
  const existing = await claimForPeriod(db, repId, period.from);
  if (existing) return existing;
  await createClaim(db, tenantId, {
    id: crypto.randomUUID(),
    repId,
    from: period.from,
    to: period.to,
  });
  return claimForPeriod(db, repId, period.from);
}

export async function claimLines(db, claimId) {
  return (
    await db.query(
      `SELECT l.id,l.version,l.category_id,l.km,l.vehicle,l.nights,l.town,l.claimed_amount,
              l.file_id,l.note,to_char(l.spend_date,'YYYY-MM-DD') AS spend_date,
              c.code AS category,c.name AS category_name,c.basis,c.receipt_above
       FROM expense_lines l JOIN expense_categories c ON c.id=l.category_id
       WHERE l.claim_id=$1 AND l.deleted_at IS NULL
       ORDER BY l.spend_date, lower(c.code), l.created_at`,
      [claimId],
    )
  ).rows.map((r) => ({
    ...r,
    version: Number(r.version),
    km: Number(r.km),
    nights: Number(r.nights),
    claimed_amount: Number(r.claimed_amount),
    receipt_above: num(r.receipt_above),
  }));
}

export async function addLine(db, tenantId, input) {
  await db.query(
    `INSERT INTO expense_lines(id,tenant_id,claim_id,category_id,spend_date,km,vehicle,nights,
       town,claimed_amount,file_id,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      input.id,
      tenantId,
      input.claimId,
      input.categoryId,
      input.spendDate,
      input.km ?? 0,
      String(input.vehicle ?? '').toUpperCase(),
      input.nights ?? 0,
      input.town ?? '',
      input.claimedAmount ?? 0,
      input.fileId ?? null,
      input.note ?? '',
    ],
  );
  return input.id;
}

export async function editLine(db, input) {
  const r = await db.query(
    `UPDATE expense_lines SET category_id=$3, spend_date=$4, km=$5, vehicle=$6, nights=$7,
            town=$8, claimed_amount=$9, file_id=$10, note=$11, version=version+1, updated_at=now()
     WHERE id=$1 AND version=$2 AND deleted_at IS NULL`,
    [
      input.id,
      input.version,
      input.categoryId,
      input.spendDate,
      input.km ?? 0,
      String(input.vehicle ?? '').toUpperCase(),
      input.nights ?? 0,
      input.town ?? '',
      input.claimedAmount ?? 0,
      input.fileId ?? null,
      input.note ?? '',
    ],
  );
  return r.rowCount === 1;
}

// A line taken off a draft keeps its row. "Claimed and then withdrawn" is worth being able to see.
export async function removeLine(db, { id, version, reason }) {
  const r = await db.query(
    `UPDATE expense_lines SET deleted_at=now(), deleted_reason=$3, version=version+1,
            updated_at=now()
     WHERE id=$1 AND version=$2 AND deleted_at IS NULL`,
    [id, version, reason ?? ''],
  );
  return r.rowCount === 1;
}

export async function findLine(db, id) {
  const row = (
    await db.query(
      `SELECT l.id,l.version,l.claim_id,l.category_id,
              to_char(l.spend_date,'YYYY-MM-DD') AS spend_date,
              c.code AS category
       FROM expense_lines l JOIN expense_categories c ON c.id=l.category_id
       WHERE l.id=$1 AND l.deleted_at IS NULL`,
      [id],
    )
  ).rows[0];
  return row ? { ...row, version: Number(row.version) } : null;
}

// ---------- Pricing a whole claim ----------

// What the claim comes to, worked out now.
//
// Each line is measured against the policy version that governed **its own** spend date, not the
// claim's. A fortnight that straddles the day a new version starts is priced correctly line by
// line, which is the whole reason the version is dated rather than simply current.
export async function priceClaim(db, claim, settings) {
  const rep = await findRep(db, claim.rep_id);
  const [lines, register, planned, cats] = await Promise.all([
    claimLines(db, claim.id),
    registerFor(
      db,
      { repId: claim.rep_id, from: claim.period_from, to: claim.period_to },
      settings,
    ),
    plannedDaysFor(db, { repId: claim.rep_id, from: claim.period_from, to: claim.period_to }),
    categories(db, { includeInactive: true }),
  ]);

  const statusOn = new Map((register?.rows ?? []).map((r) => [r.date, r.status]));
  const townOn = new Map(planned.filter((d) => d.town).map((d) => [d.work_date, d.town]));
  const categoryOf = new Map(cats.map((c) => [String(c.id), c]));

  // One policy read per distinct date. A fortnight has at most two versions in it, but asking
  // per date keeps the rule honest without the code having to know that.
  const dates = [...new Set(lines.map((l) => l.spend_date))];
  const inForce = new Map();
  for (const date of dates) inForce.set(date, await policyInForce(db, date));

  const periodCaps = {};
  const priced = lines.map((line) => {
    const category = categoryOf.get(String(line.category_id)) ?? null;
    const { policy, rates } = inForce.get(line.spend_date) ?? { policy: null, rates: [] };
    const place =
      category?.basis === 'DAILY' || category?.basis === 'NIGHTLY'
        ? placeClass({
            hqTown: rep?.hq_town ?? '',
            plannedTown: townOn.get(line.spend_date) ?? '',
            claimedTown: line.town,
            nights: line.nights,
          })
        : null;
    const key = rateKeyFor({
      basis: category?.basis,
      vehicle: line.vehicle,
      place: place?.place,
      grade: claim.grade,
    });
    const rate = rateFor({ rates, categoryId: line.category_id, key });
    if (rate && rate.period_cap !== null && rate.period_cap !== undefined)
      periodCaps[String(line.category_id)] = rate.period_cap;

    const priced = lineAmount({
      line,
      category,
      rate,
      dayStatus: statusOn.get(line.spend_date) ?? null,
      place,
      hasReceipt: !!line.file_id,
    });
    // No policy at all is its own answer, and a different one from "the policy allows nothing".
    if (!policy && category?.basis !== 'ACTUAL' && !priced.reasons.includes('NO_RATE'))
      priced.reasons.push('NO_POLICY');
    return {
      ...line,
      ...priced,
      policy: policy?.code ?? '',
      day_status: statusOn.get(line.spend_date) ?? null,
    };
  });

  return {
    ...claimTotals({ lines: priced, periodCaps }),
    period: { from: claim.period_from, to: claim.period_to },
    rep: rep ? { id: rep.id, code: rep.code, name: rep.name, hq_town: rep.hq_town } : null,
  };
}

// ---------- Submitting and deciding ----------

export async function submitClaim(db, { id, version }) {
  const r = await db.query(
    `UPDATE expense_claims SET status='SUBMITTED', submitted_at=now(), version=version+1,
            updated_at=now()
     WHERE id=$1 AND version=$2 AND status IN ('DRAFT','REJECTED')`,
    [id, version],
  );
  return r.rowCount === 1;
}

// A manager passes it, or sends it back. Finance approves it, or sends it back. The column that
// records who acted is set in the same statement that moves the status, so the table's own check
// — that the two people differ — is the last word rather than the first.
export async function decideClaim(db, actorId, { id, version, stage, approve, note, reason }) {
  const settled = approve ? (stage === 'MANAGER' ? 'MANAGER_OK' : 'APPROVED') : 'REJECTED';
  const from = stage === 'MANAGER' ? 'SUBMITTED' : 'MANAGER_OK';
  const column = stage === 'MANAGER' ? 'manager' : 'finance';
  const r = await db.query(
    `UPDATE expense_claims
     SET status=$3, ${column}_by=$4, ${column}_at=now(), ${column}_note=$5, reject_reason=$6,
         version=version+1, updated_at=now()
     WHERE id=$1 AND version=$2 AND status=$7`,
    [id, version, settled, actorId, note ?? '', approve ? '' : (reason ?? ''), from],
  );
  return r.rowCount === 1;
}

// A claim sent back loses the decision that sent it back, so the next journey is a clean one.
export async function reopenClaim(db, { id, version }) {
  const r = await db.query(
    `UPDATE expense_claims SET status='DRAFT', submitted_at=NULL,
            manager_by=NULL, manager_at=NULL, manager_note='',
            finance_by=NULL, finance_at=NULL, finance_note='', reject_reason='',
            version=version+1, updated_at=now()
     WHERE id=$1 AND version=$2 AND status='REJECTED'`,
    [id, version],
  );
  return r.rowCount === 1;
}

export async function listClaims(
  db,
  { repId = null, status = null, from = null, to = null, limit = DEFAULT_PAGE_SIZE },
) {
  const where = ['1=1'];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('$n', '$' + params.length));
  };
  if (repId) add('c.rep_id=$n', repId);
  if (status) add('c.status=$n', status);
  if (from) add('c.period_to >= $n', from);
  if (to) add('c.period_from <= $n', to);
  const clause = where.join(' AND ');
  const total = (
    await db.query(`SELECT count(*)::int AS n FROM ${CLAIM_FROM} WHERE ${clause}`, params)
  ).rows[0].n;
  const items = (
    await db.query(
      `SELECT ${CLAIM_COLUMNS} FROM ${CLAIM_FROM} WHERE ${clause}
       ORDER BY c.period_from DESC, lower(r.code) LIMIT $${params.length + 1}`,
      [...params, limit],
    )
  ).rows.map(asClaim);
  return { items, total };
}

// ---------- The register and the payout ----------

// Every claim in a window, priced. Used by the register screen and by the payout file, so the
// two can never disagree: there is one calculation and both read it.
export async function expenseRegister(db, { from, to, repId = null, status = null }, settings) {
  const { items } = await listClaims(db, { repId, status, from, to, limit: 500 });
  const rows = [];
  for (const claim of items) {
    const priced = await priceClaim(db, claim, settings);
    rows.push({
      id: claim.id,
      rep: claim.rep,
      rep_name: claim.rep_name,
      status: claim.status,
      period_from: claim.period_from,
      period_to: claim.period_to,
      lines: priced.count,
      claimed: priced.claimed,
      allowed: priced.allowed,
      disallowed: priced.disallowed,
      capped: priced.capped,
      blocked: priced.blocked,
      manager_name: claim.manager_name,
      finance_name: claim.finance_name,
    });
  }
  const sum = (key) => Math.round(rows.reduce((t, r) => t + r[key], 0) * 100) / 100;
  return {
    rows,
    totals: { claims: rows.length, claimed: sum('claimed'), allowed: sum('allowed') },
  };
}

export { SETTING_DEFAULTS };
