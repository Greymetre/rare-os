// The two module overviews (Nilkamal simulation handover, 21-Sep-2026): the first screen of each
// engine — Scheduling & Execution and Materials Planning — reading the calculation that is already
// in force. Nothing here computes a new plan; it summarises the current run, so the numbers match
// the screens underneath it exactly.

const n = (v) => (v === null || v === undefined ? null : Number(v));
// The calculation in force, and whether anything has changed since it ran.
async function currentRun(db) {
  const run =
    (
      await db.query(
        `SELECT r.id,r.run_no,r.status,r.finished_at,to_char(s.as_of_date,'YYYY-MM-DD') AS as_of_date
         FROM planning_state s JOIN planning_runs r ON r.id=s.current_run_id`,
      )
    ).rows[0] ?? null;
  if (!run) return null;
  const pending = Number(
    (await db.query('SELECT count(*) FROM planning_input_events')).rows[0].count,
  );
  const queued = Number(
    (await db.query("SELECT count(*) FROM planning_runs WHERE status='queued'")).rows[0].count,
  );
  return { ...run, up_to_date: !pending && !queued };
}

// Scheduling & Execution: the book, the constraint it runs through, and what is at risk.
export async function schedulingOverview(db, siteId) {
  const run = await currentRun(db);
  if (!run) return { empty: 'No calculation yet. Run planning to see the schedule.' };
  const orders = (
    await db.query(
      `SELECT count(*)::int AS scheduled,
         count(*) FILTER (WHERE status='unscheduled')::int AS unscheduled,
         count(*) FILTER (WHERE late_days > 0)::int AS late,
         count(*) FILTER (WHERE material_check='expedite')::int AS material_short,
         min(release_date)::text AS first_release,
         max(finish_date)::text AS last_finish
       FROM schedule_orders WHERE run_id=$1 AND site_id=$2`,
      [run.id, siteId],
    )
  ).rows[0];
  const stations = (
    await db.query(
      `SELECT r.code,r.name,x.machines,x.capacity_per_day,x.run_min,x.changeover_min,x.utilization,x.drum
       FROM schedule_resources x JOIN resources r ON r.id=x.resource_id
       WHERE x.run_id=$1 AND x.site_id=$2 ORDER BY x.utilization DESC NULLS LAST, r.code LIMIT 8`,
      [run.id, siteId],
    )
  ).rows.map((r) => ({
    code: r.code,
    name: r.name,
    machines: Number(r.machines),
    capacityPerDay: n(r.capacity_per_day),
    runMinutes: Math.round(Number(r.run_min)),
    changeoverMinutes: Math.round(Number(r.changeover_min)),
    utilisationPct: Math.round(Number(r.utilization) * 100),
    drum: r.drum,
  }));
  const work = (
    await db.query(
      `SELECT count(*) FILTER (WHERE execution_state='released')::int AS released,
         count(*) FILTER (WHERE execution_state='completed')::int AS completed
       FROM production_orders WHERE site_id=$1`,
      [siteId],
    )
  ).rows[0] ?? { released: 0, completed: 0 };
  const downtime = (
    await db.query(
      `SELECT count(*)::int AS open FROM downtime_events WHERE site_id=$1 AND state='open'`,
      [siteId],
    )
  ).rows[0] ?? { open: 0 };
  const decisions = (
    await db.query(
      `SELECT count(*)::int AS n FROM planning_decisions WHERE site_id=$1 AND run_no=$2`,
      [siteId, run.run_no],
    )
  ).rows[0] ?? { n: 0 };
  return {
    calculation: {
      runNo: Number(run.run_no),
      at: run.finished_at,
      asOf: run.as_of_date,
      upToDate: run.up_to_date,
    },
    orders: {
      scheduled: orders.scheduled - orders.unscheduled,
      unscheduled: orders.unscheduled,
      late: orders.late,
      materialShort: orders.material_short,
      firstRelease: orders.first_release,
      lastFinish: orders.last_finish,
    },
    drum: stations.find((s) => s.drum) ?? stations[0] ?? null,
    stations,
    execution: { released: work.released, completed: work.completed, downtimeOpen: downtime.open },
    decisions: decisions.n,
  };
}

// Materials Planning: where the buffers stand, and what the board is asking for.
export async function materialsOverview(db, siteId) {
  const run = await currentRun(db);
  if (!run) return { empty: 'No calculation yet. Run planning to see the buffers.' };
  const zones = (
    await db.query(
      `SELECT zone,count(*)::int AS n FROM planning_results
       WHERE run_id=$1 AND site_id=$2 AND policy='BUFFER' AND status='planned' GROUP BY zone`,
      [run.id, siteId],
    )
  ).rows;
  const board = (
    await db.query(
      `SELECT count(*)::int AS buffered,
         count(*) FILTER (WHERE status='missing')::int AS missing,
         count(*) FILTER (WHERE recommended_qty > 0)::int AS recommended,
         count(*) FILTER (WHERE event_factor IS NOT NULL)::int AS event_sized
       FROM planning_results WHERE run_id=$1 AND site_id=$2 AND policy='BUFFER'`,
      [run.id, siteId],
    )
  ).rows[0];
  // On hand is only ever shown per unit: adding KG, NOS and M together would mean nothing.
  const onHand = (
    await db.query(
      `SELECT u.code AS unit,i.item_type,sum(b.quantity) AS qty,count(DISTINCT b.item_id)::int AS items
       FROM stock_balances b JOIN items i ON i.id=b.item_id JOIN units u ON u.id=i.base_unit_id
       JOIN stock_locations l ON l.id=b.location_id
       WHERE b.site_id=$1 AND l.nettable GROUP BY 1,2 ORDER BY 3 DESC LIMIT 8`,
      [siteId],
    )
  ).rows.map((r) => ({
    unit: r.unit,
    type: r.item_type,
    quantity: Math.round(Number(r.qty) * 1000) / 1000,
    items: r.items,
  }));
  const proposals = (
    await db.query(
      `SELECT count(*) FILTER (WHERE status='PROPOSED')::int AS open,
         count(*) FILTER (WHERE status='APPROVED')::int AS approved
       FROM purchase_proposals WHERE site_id=$1 AND status IN ('PROPOSED','APPROVED')`,
      [siteId],
    )
  ).rows[0] ?? { open: 0, approved: 0 };
  const expedites = (
    await db.query(
      `SELECT count(*)::int AS waiting FROM expedite_bundles WHERE site_id=$1
         AND state IN ('requested','approved')`,
      [siteId],
    )
  ).rows[0] ?? { waiting: 0 };
  const schemes = (
    await db.query(
      `SELECT count(*) FILTER (WHERE state='proposed')::int AS proposed,
         count(*) FILTER (WHERE state='accepted')::int AS accepted FROM demand_schemes WHERE site_id=$1`,
      [siteId],
    )
  ).rows[0] ?? { proposed: 0, accepted: 0 };
  return {
    calculation: {
      runNo: Number(run.run_no),
      at: run.finished_at,
      asOf: run.as_of_date,
      upToDate: run.up_to_date,
    },
    zones: Object.fromEntries(zones.map((z) => [z.zone, z.n])),
    buffered: board.buffered,
    missing: board.missing,
    recommended: board.recommended,
    eventSized: board.event_sized,
    onHand,
    proposals,
    expedites,
    schemes,
  };
}
