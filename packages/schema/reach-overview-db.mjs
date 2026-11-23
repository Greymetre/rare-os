// RCH-7: counting what is actually there.
//
// Every number on the overview comes from one of the queries below, and the list a person opens
// underneath a tile is filtered from the same evidence. There is no overview table to fall out of
// step with the thing it describes — which is the milestone's own acceptance ("har tile ka number
// neeche ki asli activity se mile") made true by construction rather than by care.
//
// Nothing here writes. Not one statement in this file changes a row, and that is the other
// acceptance: a proposal cannot change anything if the code that makes proposals has no way to
// change anything.
import {
  approvalQueue,
  cutoverSteps,
  cutoverVerdict,
  proposalsFrom,
} from '../engines/reach-overview.mjs';
import { reachSettings } from './customers-db.mjs';
import { todayFor } from './attendance-db.mjs';

// ---------- What the system notices ----------

// One row of counts, gathered in a single round trip. Each sub-select is the same condition the
// screen it points at uses, so opening that screen shows exactly the rows that were counted.
export async function proposalCounts(db, { date, settings }) {
  const dueDay = Number(settings.plan_due_day ?? 25);
  const lateMinutes = Number(settings.absent_after_minutes ?? 120);
  const zone = settings.timezone ?? 'Asia/Kolkata';
  const row = (
    await db.query(
      `SELECT
        (SELECT count(*)::int FROM field_reps r
           LEFT JOIN shifts s ON s.id=r.shift_id
           WHERE r.deleted_at IS NULL AND r.active AND s.id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM attendance_days a
                               WHERE a.rep_id=r.id AND a.work_date=$1::date)
             AND (($1::date + s.ends_at) AT TIME ZONE $4) + ($3 || ' minutes')::interval < now()
        ) AS "DAY_NOT_STARTED",
        (SELECT count(*)::int FROM leave_requests WHERE status='PENDING') AS "LEAVE_WAITING",
        (SELECT count(*)::int FROM attendance_edits WHERE status='PENDING') AS "CORRECTION_WAITING",
        (SELECT count(*)::int FROM field_reps r
           WHERE r.deleted_at IS NULL AND r.active
             AND date_part('day', $1::date) >= $2
             AND NOT EXISTS (SELECT 1 FROM tour_plans p
                               WHERE p.rep_id=r.id AND p.status<>'DRAFT'
                                 AND p.plan_month=(date_trunc('month',$1::date) + interval '1 month')::date)
        ) AS "PLAN_LATE",
        (SELECT count(*)::int FROM tour_plans WHERE status='SUBMITTED') AS "PLAN_WAITING",
        (SELECT count(*)::int FROM tour_plan_changes WHERE status='PENDING') AS "DAY_CHANGE_WAITING",
        (SELECT count(*)::int FROM visits WHERE visit_date=$1::date AND out_of_fence) AS "VISIT_FLAGGED",
        (SELECT count(*)::int FROM visits v
           WHERE v.visit_date=$1::date AND v.checked_out_at IS NOT NULL
             AND EXISTS (SELECT 1 FROM visit_form_rules f
                           JOIN trade_customers c ON c.id=v.customer_id
                           JOIN visit_form_fields x ON x.id=f.field_id
                          WHERE f.type_id=c.type_id AND f.requirement='R'
                            AND f.deleted_at IS NULL AND x.deleted_at IS NULL
                            AND NOT (v.report ? x.field_key))
        ) AS "REPORT_UNFINISHED",
        (SELECT count(*)::int FROM trade_customers
           WHERE deleted_at IS NULL AND status='AWAITING_APPROVAL') AS "CUSTOMER_WAITING",
        (SELECT count(*)::int FROM customer_geo_log WHERE status='PENDING') AS "GEO_WAITING",
        (SELECT count(*)::int FROM kyc_documents WHERE status='PENDING') AS "KYC_WAITING",
        (SELECT count(*)::int FROM trade_orders WHERE status='HELD') AS "ORDER_HELD",
        (SELECT count(*)::int FROM (
           SELECT c.id FROM trade_customers c
             JOIN customer_types t ON t.id=c.type_id
             JOIN trade_invoices i ON i.customer_id=c.id AND i.status='OPEN'
            WHERE c.deleted_at IS NULL
              AND coalesce(c.hold_days, t.hold_days) IS NOT NULL
              AND $1::date - i.invoice_date > coalesce(c.hold_days, t.hold_days)
              AND i.amount > coalesce((SELECT sum(p.amount) FROM trade_receipts p
                                        WHERE p.invoice_id=i.id AND p.status='RECORDED'),0)
            GROUP BY c.id) AS overdue
        ) AS "OVERDUE_CUSTOMER",
        (SELECT count(*)::int FROM expense_claims
           WHERE status IN ('SUBMITTED','MANAGER_OK')) AS "CLAIM_WAITING"`,
      [date, dueDay, lateMinutes, zone],
    )
  ).rows[0];
  return row;
}

// ---------- The overview ----------

// What the field organisation is doing today, and what is waiting for somebody.
export async function overviewFor(db, { date = null, permissions = null } = {}) {
  const settings = await reachSettings(db);
  const on = date ?? (await todayFor(db, settings));

  const [counts, day] = await Promise.all([
    proposalCounts(db, { date: on, settings }),
    db.query(
      `SELECT
        (SELECT count(*)::int FROM attendance_days WHERE work_date=$1::date) AS started,
        (SELECT count(*)::int FROM attendance_days
           WHERE work_date=$1::date AND ended_at IS NULL) AS still_out,
        (SELECT count(*)::int FROM visits WHERE visit_date=$1::date) AS visits,
        (SELECT count(*)::int FROM visits
           WHERE visit_date=$1::date AND checked_out_at IS NULL) AS in_a_shop,
        (SELECT count(*)::int FROM trade_orders WHERE order_date=$1::date) AS orders,
        (SELECT coalesce(sum(total),0) FROM trade_orders
           WHERE order_date=$1::date AND status<>'CANCELLED') AS order_value,
        (SELECT coalesce(sum(amount),0) FROM trade_receipts
           WHERE received_on=$1::date AND status='RECORDED') AS collected,
        (SELECT count(*)::int FROM field_reps r WHERE r.deleted_at IS NULL AND r.active) AS reps`,
      [on],
    ),
  ]);

  const proposals = proposalsFrom(counts, { permissions });
  return {
    date: on,
    today: {
      ...day.rows[0],
      order_value: Number(day.rows[0].order_value),
      collected: Number(day.rows[0].collected),
    },
    proposals,
    queue: approvalQueue(proposals),
    // The raw counts travel too, so a screen can show a number for something this person cannot
    // act on without pretending the proposal is theirs to take.
    counts,
  };
}

// ---------- Going live ----------

export async function cutoverFor(db) {
  const facts = (
    await db.query(
      `SELECT
        (SELECT count(*)::int FROM field_reps
           WHERE deleted_at IS NULL AND active AND user_id IS NOT NULL) AS "repsWithLogin",
        (SELECT count(*)::int FROM field_reps
           WHERE deleted_at IS NULL AND active AND shift_id IS NOT NULL) AS "repsWithShift",
        (SELECT count(*)::int FROM trade_customers WHERE deleted_at IS NULL) AS customers,
        (SELECT count(*)::int FROM trade_customers
           WHERE deleted_at IS NULL AND latitude IS NOT NULL) AS "taggedCustomers",
        (SELECT count(*)::int FROM beat_outlets) AS "beatOutlets",
        (SELECT count(*)::int FROM price_list_items
           WHERE deleted_at IS NULL AND active) AS prices,
        (SELECT count(*)::int FROM expense_policies
           WHERE active AND effective_from <= current_date) AS "livePolicies"`,
    )
  ).rows[0];
  const steps = cutoverSteps(facts);
  return { facts, steps, ...cutoverVerdict(steps) };
}

// ---------- The whole module's audit trail ----------

// Everything Reach has recorded, newest first. The audit table is shared, so this is a filter on
// it rather than a second trail — one record of what happened, read through a Reach-shaped window.
export const REACH_TABLES = [
  'trade_customers',
  'customer_geo_log',
  'beat_outlets',
  'field_reps',
  'attendance_days',
  'leave_requests',
  'attendance_edits',
  'tour_plans',
  'tour_plan_days',
  'tour_plan_changes',
  'visits',
  'kyc_documents',
  'trade_orders',
  'trade_invoices',
  'trade_receipts',
  'expense_claims',
  'expense_lines',
  'expense_policies',
  'reach_settings',
];

export async function reachAudit(db, { from, to, action = null, limit = 100 }) {
  const params = [from, to, REACH_TABLES];
  let where = `a.created_at >= $1::date AND a.created_at < ($2::date + 1)
               AND (a.entity_type = ANY($3::text[]) OR a.action LIKE 'reach.%'
                    OR a.action LIKE 'expense.%' OR a.action LIKE 'trade.%'
                    OR a.action LIKE 'kyc.%')`;
  if (action) {
    params.push(action);
    where += ` AND a.action = $${params.length}`;
  }
  const total = (
    await db.query(`SELECT count(*)::int AS n FROM audit_log a WHERE ${where}`, params)
  ).rows[0].n;
  const items = (
    await db.query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.details, a.created_at,
              coalesce(u.name,'') AS actor
       FROM audit_log a LEFT JOIN app_users u ON u.id=a.actor_id
       WHERE ${where}
       ORDER BY a.created_at DESC LIMIT $${params.length + 1}`,
      [...params, limit],
    )
  ).rows;
  // What kinds of thing happened, so a reader can narrow without knowing the action names.
  const kinds = (
    await db.query(
      `SELECT a.action, count(*)::int AS n FROM audit_log a WHERE ${where}
       GROUP BY a.action ORDER BY n DESC, a.action`,
      params,
    )
  ).rows;
  return { items, total, kinds };
}
