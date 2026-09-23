// Database side of execution (AV-9): make orders released from a buffer recommendation, the
// two-event work-order loop (release and completion), the breakdown / downtime log, the promises a
// stoppage puts at risk, and the master-data self-audit of cycle times.
// Every function receives a pg client inside a company-scoped (RLS) transaction.
import {
  adherence,
  atRisk,
  auditRows,
  correctedOperations,
  penetration,
} from '../engines/execution.mjs';

const n = (v) => (v === null || v === undefined ? null : Number(v));

// The audit rule of the Nilkamal handover: at least five completions, every one on the same side
// of the standard, and a drift of at least 10%.
export const cycleTimeAuditOptions = { minCompletions: 5, driftPct: 10 };

// ---------- Make order release ----------

// The item's current MAKE recommendation, as the buffer board shows it.
export async function makeRecommendation(db, siteId, itemId) {
  return (
    await db.query(
      `SELECT r.item_id,i.code,i.name,r.recommended_qty,to_char(r.due_date,'YYYY-MM-DD') AS due,r.zone,
         r.nfp,r.recommended_kind,u.code AS unit
       FROM planning_results r JOIN planning_state s ON s.current_run_id=r.run_id
       JOIN items i ON i.id=r.item_id JOIN units u ON u.id=i.base_unit_id
       WHERE r.site_id=$1 AND r.item_id=$2 AND r.status='planned'`,
      [siteId, itemId],
    )
  ).rows[0];
}

// Writes the recommendation as an ordinary production order, due on the recommendation's date.
export async function releaseMakeOrder(db, actor, siteId, rec, decisionNo) {
  const no = 'MO-' + (await db.query("SELECT next_number('make_order') AS n")).rows[0].n;
  await db.query(
    `INSERT INTO production_orders(id,tenant_id,site_id,order_no,item_id,quantity,due_date,order_type,reference,
       source,buffer_item_id,decision_no)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,'MAKE','Buffer replenishment','MAKE',$4,$7)`,
    [actor.tenant_id, siteId, no, rec.item_id, Number(rec.recommended_qty), rec.due, decisionNo],
  );
  return no;
}

// ---------- The two events ----------

const orderRows = async (db, siteId, orderNo) =>
  (
    await db.query(
      `SELECT o.*,i.code AS item FROM production_orders o JOIN items i ON i.id=o.item_id
       WHERE o.site_id=$1 AND lower(o.order_no)=lower($2) FOR UPDATE OF o`,
      [siteId, orderNo],
    )
  ).rows;

export async function workOrder(db, siteId, orderNo) {
  const rows = await orderRows(db, siteId, orderNo);
  return rows[0] ?? null;
}

// Release: the planned minutes of the schedule the planner released are frozen on the order, and
// released work keeps its place in the book from now on.
export async function releaseWork(db, actor, siteId, order, today) {
  const planned = n(
    (
      await db.query(
        `SELECT sum(x.run_min) AS m FROM schedule_operations x JOIN planning_state s ON s.current_run_id=x.run_id
         WHERE x.production_order_id=$1`,
        [order.id],
      )
    ).rows[0]?.m,
  );
  const release = (await db.query("SELECT next_number('work_release') AS n")).rows[0].n;
  await db.query(
    `UPDATE production_orders SET execution_state='released',released_date=$2,released_at=now(),released_by=$3,
       release_no=$4,planned_minutes=$5,version=version+1,updated_at=now() WHERE id=$1`,
    [order.id, today, actor.id, release, planned],
  );
  return { release: Number(release), planned };
}

// Completion: the second and last event. The order is finished and leaves the book.
export async function completeWork(db, actor, order, { date, quantity, elapsed }) {
  await db.query(
    `UPDATE production_orders SET execution_state='completed',status='CLOSED',completed_date=$2,completed_at=now(),
       completed_by=$3,completed_quantity=$4,elapsed_work_minutes=$5,version=version+1,updated_at=now() WHERE id=$1`,
    [order.id, date, actor.id, quantity, elapsed],
  );
}

// Released and completed work with what the completion used of its protective buffer.
export async function listExecution(db, siteId, bufferPct, limit = 200) {
  const rows = (
    await db.query(
      `SELECT o.order_no,coalesce(o.order_ref,o.order_no) AS order_ref,i.code AS item,i.name AS item_name,o.quantity,
         o.source,o.execution_state,o.planned_minutes,o.elapsed_work_minutes,o.completed_quantity,
         to_char(o.released_date,'YYYY-MM-DD') AS released_date,to_char(o.completed_date,'YYYY-MM-DD') AS completed_date,
         to_char(o.due_date,'YYYY-MM-DD') AS due_date,o.release_no,
         coalesce(r.name,'') AS released_by,coalesce(c.name,'') AS completed_by
       FROM production_orders o JOIN items i ON i.id=o.item_id
       LEFT JOIN app_users r ON r.id=o.released_by LEFT JOIN app_users c ON c.id=o.completed_by
       WHERE o.site_id=$1 AND o.execution_state <> 'planned'
       ORDER BY o.release_no DESC LIMIT $2`,
      [siteId, limit],
    )
  ).rows.map((o) => {
    const planned = n(o.planned_minutes),
      elapsed = n(o.elapsed_work_minutes);
    const p = elapsed === null ? null : penetration(planned, elapsed, bufferPct);
    return {
      ...o,
      quantity: n(o.quantity),
      completed_quantity: n(o.completed_quantity),
      planned_minutes: planned,
      elapsed_work_minutes: elapsed,
      release_no: n(o.release_no),
      buffer_minutes: p?.buffer ?? null,
      penetration: p?.penetration ?? null,
      inside_buffer: p?.ok ?? null,
    };
  });
  return {
    items: rows,
    bufferPct,
    ...adherence(
      rows.map((r) => ({ planned: r.planned_minutes, elapsed: r.elapsed_work_minutes, bufferPct })),
    ),
    released: rows.filter((r) => r.execution_state === 'released').length,
  };
}

// ---------- Downtime ----------

export async function logDowntime(db, actor, siteId, value) {
  const no = (await db.query("SELECT next_number('downtime') AS n")).rows[0].n;
  const id = (
    await db.query(
      `INSERT INTO downtime_events(id,tenant_id,site_id,event_no,resource_id,machine,event_date,minutes,reason,logged_by)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        actor.tenant_id,
        siteId,
        no,
        value.resourceId,
        value.machine,
        value.date,
        value.minutes,
        value.reason,
        actor.id,
      ],
    )
  ).rows[0].id;
  return { id, no: Number(no) };
}

export async function listDowntime(db, siteId, limit = 100) {
  return (
    await db.query(
      `SELECT d.id,d.event_no,d.machine,to_char(d.event_date,'YYYY-MM-DD') AS event_date,d.minutes,d.reason,d.state,
         r.code AS resource,r.name AS resource_name,coalesce(u.name,'') AS logged_by,d.created_at
       FROM downtime_events d JOIN resources r ON r.id=d.resource_id LEFT JOIN app_users u ON u.id=d.logged_by
       WHERE d.site_id=$1 ORDER BY d.event_no DESC LIMIT $2`,
      [siteId, limit],
    )
  ).rows.map((d) => ({ ...d, minutes: Number(d.minutes), event_no: Number(d.event_no) }));
}

// Promises the latest calculation puts at risk against the one before it.
export async function atRiskOrders(db, siteId) {
  const runs = (
    await db.query(
      `SELECT DISTINCT run_id, (SELECT run_no FROM planning_runs r WHERE r.id=s.run_id) AS run_no
       FROM schedule_orders s WHERE s.site_id=$1 ORDER BY run_no DESC LIMIT 2`,
      [siteId],
    )
  ).rows;
  if (runs.length < 2)
    return { runNo: runs[0] ? Number(runs[0].run_no) : null, previous: null, items: [] };
  const dayNo = (d) => Math.round(Date.parse(d) / 86400000);
  const date = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const load = async (runId) =>
    new Map(
      (
        await db.query(
          `SELECT o.order_no,to_char(s.finish_date,'YYYY-MM-DD') AS ship,to_char(s.promise_date,'YYYY-MM-DD') AS prom
           FROM schedule_orders s JOIN production_orders o ON o.id=s.production_order_id
           WHERE s.run_id=$1 AND s.site_id=$2 AND s.status='scheduled'`,
          [runId, siteId],
        )
      ).rows.map((r) => [r.order_no, { ship: dayNo(r.ship), prom: dayNo(r.prom) }]),
    );
  const after = await load(runs[0].run_id),
    before = await load(runs[1].run_id);
  return {
    runNo: Number(runs[0].run_no),
    previous: Number(runs[1].run_no),
    items: atRisk(before, after).map((r) => ({
      order: r.id,
      promise: date(r.promise),
      was: date(r.was),
      now: date(r.now),
      days: r.days,
    })),
  };
}

// ---------- Master-data self-audit ----------

// The maintained standard of every routed item: minutes per unit down its route.
export async function routingStandards(db, siteId, today) {
  const rows = (
    await db.query(
      `SELECT r.id,r.item_id,i.code,sum(o.run_minutes_per_unit) AS per_unit
       FROM routings r JOIN routing_operations o ON o.routing_id=r.id JOIN items i ON i.id=r.item_id
       WHERE r.site_id=$1 AND r.active AND r.effective_from <= $2::date
         AND (r.effective_to IS NULL OR r.effective_to >= $2::date)
       GROUP BY r.id,r.item_id,i.code`,
      [siteId, today],
    )
  ).rows;
  return new Map(
    rows.map((r) => [r.item_id, { routingId: r.id, code: r.code, perUnit: Number(r.per_unit) }]),
  );
}

// Standards against what production actually took, from completed work orders alone.
export async function cycleTimeAudit(db, siteId, today, options = {}) {
  const standards = await routingStandards(db, siteId, today);
  const completions = (
    await db.query(
      `SELECT item_id,completed_quantity,elapsed_work_minutes,to_char(completed_date,'YYYY-MM-DD') AS day
       FROM production_orders WHERE site_id=$1 AND execution_state='completed' AND elapsed_work_minutes IS NOT NULL
       ORDER BY completed_date`,
      [siteId],
    )
  ).rows.map((r) => ({
    itemId: r.item_id,
    quantity: Number(r.completed_quantity),
    elapsed: Number(r.elapsed_work_minutes),
    date: r.day,
  }));
  const adopted = new Map(
    (
      await db.query(
        `SELECT item_id,max(adopted_at) AS at FROM cycle_time_adoptions WHERE site_id=$1 GROUP BY item_id`,
        [siteId],
      )
    ).rows.map((r) => [r.item_id, r.at]),
  );
  const rows = auditRows(
    completions,
    new Map([...standards].map(([id, s]) => [id, s.perUnit])),
    options,
  ).map((r) => ({
    ...r,
    item: standards.get(r.itemId)?.code ?? r.itemId,
    routingId: standards.get(r.itemId)?.routingId ?? null,
    adoptedAt: adopted.get(r.itemId) ?? null,
  }));
  return { rows, completions: completions.length, items: standards.size };
}

// Adopting a correction writes a new routing revision: every operation scaled to what production
// actually takes. The old revision stops the day before, so nothing else in the plan moves by hand.
export async function adoptCycleTime(db, actor, siteId, row, today) {
  const ops = (
    await db.query(
      `SELECT sequence,operation_code,description,resource_id,setup_minutes,run_minutes_per_unit AS "perUnit"
       FROM routing_operations WHERE routing_id=$1 ORDER BY sequence`,
      [row.routingId],
    )
  ).rows.map((o) => ({ ...o, perUnit: Number(o.perUnit) }));
  const scaled = correctedOperations(ops, row.scale).filter((o) => o.perUnit > 0);
  const revision = (
    await db.query(
      `SELECT 'ACT'||(count(*)+1) AS r FROM routings WHERE site_id=$1 AND item_id=$2 AND revision LIKE 'ACT%'`,
      [siteId, row.itemId],
    )
  ).rows[0].r;
  const routing = (
    await db.query(
      `INSERT INTO routings(id,tenant_id,site_id,item_id,revision,effective_from)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING id`,
      [actor.tenant_id, siteId, row.itemId, revision, today],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,description,resource_id,setup_minutes,run_minutes_per_unit)
     SELECT gen_random_uuid(),$1,$2,x.s,x.c,x.d,x.r,x.m,x.p
     FROM unnest($3::int[],$4::text[],$5::text[],$6::uuid[],$7::numeric[],$8::numeric[]) AS x(s,c,d,r,m,p)`,
    [
      actor.tenant_id,
      routing,
      scaled.map((o) => o.sequence),
      scaled.map((o) => o.operation_code),
      scaled.map((o) => o.description),
      scaled.map((o) => o.resource_id),
      scaled.map((o) => o.setup_minutes),
      scaled.map((o) => o.perUnit),
    ],
  );
  await db.query(
    `UPDATE routings SET effective_to=($2::date - 1),version=version+1,updated_at=now() WHERE id=$1`,
    [row.routingId, today],
  );
  await db.query(
    `INSERT INTO cycle_time_adoptions(id,tenant_id,site_id,item_id,routing_id,standard_minutes,actual_minutes,drift_pct,completions,adopted_by)
     VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      actor.tenant_id,
      siteId,
      row.itemId,
      routing,
      row.standard,
      row.actual,
      row.drift,
      row.completions,
      actor.id,
    ],
  );
  return { revision, routingId: routing, operations: scaled.length };
}
