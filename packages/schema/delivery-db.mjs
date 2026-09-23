// Database side of delivery (AV-10): the current calculation read back as what it promises —
// order-level OTIF, the time buffer of every promise, the exceptions and the planner's day.
// Every function receives a pg client inside a company-scoped (RLS) transaction.
import { alerts, dayList, otif, timeBuffer } from '../engines/delivery.mjs';
import { atRiskOrders, listDowntime } from './execution-db.mjs';
import { loadExpediteActions, listPending, planningDate } from './schedule-db.mjs';

const n = (v) => (v === null || v === undefined ? null : Number(v));

// The plant's current schedule: one row per order (lots of one order count as one promise).
async function bookOf(db, siteId) {
  const plant = (
    await db.query(
      `SELECT to_char(p.start_date,'YYYY-MM-DD') AS start_date,p.day_minutes,p.day_dates,r.run_no,p.run_id
       FROM schedule_plants p JOIN planning_state s ON s.current_run_id=p.run_id
       JOIN planning_runs r ON r.id=p.run_id WHERE p.site_id=$1`,
      [siteId],
    )
  ).rows[0];
  if (!plant) return null;
  const dayOf = new Map(
    (plant.day_dates ?? []).map((d, i) => [
      d.toISOString ? d.toISOString().slice(0, 10) : String(d),
      i + 1,
    ]),
  );
  const rows = (
    await db.query(
      `SELECT coalesce(o.order_ref,o.order_no) AS order_ref,o.order_no,i.code AS item,i.name AS item_name,u.code AS unit,
         o.quantity,o.source,o.execution_state,s.status,s.material_check,s.plan_state,s.late_days,s.slack_min,
         to_char(s.promise_date,'YYYY-MM-DD') AS promise,to_char(s.finish_date,'YYYY-MM-DD') AS finish_date,
         to_char(s.release_date,'YYYY-MM-DD') AS release_date,s.position
       FROM schedule_orders s JOIN production_orders o ON o.id=s.production_order_id
       JOIN items i ON i.id=o.item_id JOIN units u ON u.id=i.base_unit_id
       WHERE s.run_id=$1 AND s.site_id=$2 ORDER BY s.position`,
      [plant.run_id, siteId],
    )
  ).rows;
  const byOrder = new Map();
  for (const r of rows) {
    const o =
      byOrder.get(r.order_ref) ??
      byOrder
        .set(r.order_ref, {
          order: r.order_ref,
          item: r.item,
          itemName: r.item_name,
          unit: r.unit,
          qty: 0,
          lots: 0,
          lotsOnTime: 0,
          source: r.source,
          state: r.execution_state,
          status: r.status,
          material: r.material_check,
          planState: r.plan_state,
          promise: r.promise,
          finishDate: null,
          releaseDate: null,
          slackMinutes: null,
          position: r.position,
        })
        .get(r.order_ref);
    o.qty += Number(r.quantity);
    o.lots += 1;
    if (r.status !== 'scheduled') {
      o.unscheduled = true;
      continue;
    }
    const late = Number(r.late_days ?? 0) > 0;
    if (!late) o.lotsOnTime += 1;
    if (o.finishDate === null || r.finish_date > o.finishDate) o.finishDate = r.finish_date;
    if (o.releaseDate === null || r.release_date < o.releaseDate) o.releaseDate = r.release_date;
    const slack = n(r.slack_min);
    if (slack !== null && (o.slackMinutes === null || slack < o.slackMinutes))
      o.slackMinutes = slack;
    // The worst material verdict of the order's lots is the order's.
    const rank = { expedite: 3, unknown: 2, replenish: 1, clear: 0 };
    if ((rank[r.material_check] ?? 0) > (rank[o.material] ?? 0)) o.material = r.material_check;
  }
  const dayNo = (date) => dayOf.get(date) ?? null;
  return {
    runNo: Number(plant.run_no),
    runId: plant.run_id,
    startDate: plant.start_date,
    dayMinutes: Number(plant.day_minutes),
    orders: [...byOrder.values()].map((o) => ({
      ...o,
      promiseDay: dayNo(o.promise),
      shipDay: o.unscheduled && o.finishDate === null ? null : dayNo(o.finishDate),
    })),
  };
}

// Buffers of the current run, as the board reads them.
async function buffersOf(db, siteId) {
  return (
    await db.query(
      `SELECT i.code AS item,r.status,r.zone,r.nfp,r.outside_horizon,r.recommended_kind,r.recommended_qty,
         to_char(r.due_date,'YYYY-MM-DD') AS due,u.code AS unit,r.priority_pct,r.on_hand_alert
       FROM planning_results r JOIN planning_state s ON s.current_run_id=r.run_id
       JOIN items i ON i.id=r.item_id JOIN units u ON u.id=i.base_unit_id
       WHERE r.site_id=$1 AND r.policy='BUFFER' ORDER BY r.priority_pct NULLS LAST,i.code`,
      [siteId],
    )
  ).rows.map((b) => ({
    item: b.item,
    status: b.status,
    zone: b.zone,
    nfp: n(b.nfp),
    outsideHorizon: n(b.outside_horizon) ?? 0,
    kind: b.recommended_kind,
    recommended: n(b.recommended_qty),
    due: b.due,
    unit: b.unit,
    priority: n(b.priority_pct),
    onHandAlert: b.on_hand_alert,
  }));
}

// Everything the delivery screens read, from one calculation.
export async function deliveryView(db, siteId) {
  const today = await planningDate(db);
  const book = await bookOf(db, siteId);
  if (!book) return { empty: 'No schedule yet: import open production orders and routings.' };
  const buffers = await buffersOf(db, siteId);
  const expedites = ((await loadExpediteActions(db, siteId)).get(siteId) ?? []).filter(
    (a) => !['superseded'].includes(a.state),
  );
  const codes = new Map(
    (
      await db.query('SELECT id,code FROM items WHERE id=ANY($1::uuid[])', [
        [...new Set(expedites.map((a) => a.componentId).filter(Boolean))],
      ])
    ).rows.map((r) => [r.id, r.code]),
  );
  const pending = (await listPending(db, siteId)).map((p) => ({
    order: p.order_ref,
    item: p.item,
    original: p.original_date,
    proposed: p.proposed_date,
    state: p.state,
  }));
  const downtime = (await listDowntime(db, siteId)).filter((d) => d.state === 'open');
  const risk = await atRiskOrders(db, siteId);
  const orders = book.orders.map((o) => ({
    ...o,
    lateDays: o.shipDay === null ? null : Math.max(0, o.shipDay - o.promiseDay),
    buffer: o.shipDay === null ? null : timeBuffer(o, book.dayMinutes),
  }));
  const feed = alerts({
    buffers,
    orders,
    expedites: expedites.map((a) => ({ ...a, component: codes.get(a.componentId) ?? null })),
    pending,
    downtime: downtime.map((d) => ({
      resource: d.resource,
      minutes: d.minutes,
      date: d.event_date,
      reason: d.reason,
    })),
    atRisk: risk.items,
  });
  const day = dayList(
    {
      buffers,
      releases: orders.map((o) => ({
        order: o.order,
        item: o.item,
        qty: o.qty,
        releaseDate: o.releaseDate,
        promise: o.promise,
        material: o.material,
        state: o.state,
      })),
      alerts: feed,
    },
    today,
    book.startDate,
  );
  return {
    today,
    runNo: book.runNo,
    dayMinutes: book.dayMinutes,
    otif: otif(orders),
    orders,
    buffers,
    alerts: feed,
    day,
    atRisk: risk,
    counts: {
      alerts: feed.length,
      critical: feed.filter((a) => a.severity === 'critical').length,
      penetrated: orders.filter((o) => o.buffer?.zone === 'penetrated').length,
      red: orders.filter((o) => o.buffer?.zone === 'red').length,
      gated: orders.filter((o) => o.material === 'expedite' || o.material === 'unknown').length,
    },
  };
}

// ---------- CSV ----------

export const DELIVERY_EXPORTS = ['otif', 'time-buffer', 'alerts', 'release-schedule', 'day-list'];

export function deliveryCsv(kind, view) {
  if (kind === 'otif')
    return [
      [
        'Order',
        'Item',
        'Quantity',
        'Unit',
        'Lots',
        'Promise',
        'Projected finish',
        'Late days',
        'Materials',
        'State',
      ],
      ...view.otif.orders.map((o) => [
        o.order,
        o.item,
        o.qty,
        o.unit,
        o.lots,
        o.promise,
        o.finishDate ?? '',
        o.lateDays ?? '',
        o.material ?? '',
        o.planState ?? o.state ?? '',
      ]),
    ];
  if (kind === 'time-buffer')
    return [
      [
        'Order',
        'Item',
        'Promise',
        'Projected finish',
        'Slack (minutes)',
        'Buffer consumed %',
        'Zone',
      ],
      ...view.orders
        .filter((o) => o.buffer)
        .map((o) => [
          o.order,
          o.item,
          o.promise,
          o.finishDate ?? '',
          o.buffer.slackMinutes,
          o.buffer.consumed,
          o.buffer.zone,
        ]),
    ];
  if (kind === 'alerts')
    return [
      ['Severity', 'Kind', 'Subject', 'Item', 'Message'],
      ...view.alerts.map((a) => [a.severity, a.kind, a.subject, a.item ?? '', a.message]),
    ];
  if (kind === 'release-schedule')
    return [
      [
        'Position',
        'Order',
        'Item',
        'Quantity',
        'Release by',
        'Projected finish',
        'Promise',
        'Materials',
        'State',
      ],
      ...view.orders.map((o) => [
        o.position,
        o.order,
        o.item,
        o.qty,
        o.releaseDate ?? '',
        o.finishDate ?? '',
        o.promise,
        o.material ?? '',
        o.state,
      ]),
    ];
  return [
    ['List', 'Subject', 'Item', 'Quantity', 'Date', 'Note'],
    ...view.day.order.map((r) => ['Order today', r.item, r.item, r.qty, r.due ?? '', r.zone]),
    ...view.day.make.map((r) => [
      'Release today',
      r.order,
      r.item,
      r.qty,
      r.releaseDate ?? '',
      r.hold ? 'Hold: ' + r.material : 'Release on date',
    ]),
    ...view.day.watch.map((r) => ['Watch', r.subject, r.item ?? '', '', '', r.message]),
  ];
}
