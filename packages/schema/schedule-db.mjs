// Database side of the scheduler (AV-6): plant model inputs, dynamic lead times, the schedule of
// every planning run, its views and publication. Every function receives a pg client inside a
// company-scoped (RLS) transaction.
import { calendarDayMinutes, shiftSpan } from '../engines/plant-model.mjs';
import {
  allocate,
  dayFactor,
  dueDayIndex,
  dynamicLeadTime,
  forwardPass,
  oidOf,
  releaseMinute,
  schedulePlant,
  workingDates,
} from '../engines/scheduler.mjs';
import { materialReadiness, orderTimes, snapshot } from '../engines/decisions.mjs';
import {
  bundleState,
  confirmedSupply,
  expediteRows,
  laterDates,
  mergeActions,
  orderState,
} from '../engines/materials-decisions.mjs';
import {
  drumBook,
  inheritBom,
  matchOddSize,
  rushInsert,
  simulateInsert,
} from '../engines/insert.mjs';
import { conversionFactors } from './demand-stock-db.mjs';

const CHUNK = 1000;
const AXIS_DAYS = 1500;
const n = (v) => (v === null || v === undefined ? null : Number(v));
const addDays = (day, k) => {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

export const PLANT_PLANNING_DEFAULTS = {
  club_window_days: 1,
  lead_time_basis: 'FIXED',
  day_weights: null,
  profile_day: 7,
  area_operations: [],
  execution_buffer_pct: 25,
};

// Calendars, resources, active routings and planning policy of every active plant.
export async function loadPlantModel(db, today) {
  const plants = new Map();
  const plant = (siteId) => {
    if (!plants.has(siteId))
      plants.set(siteId, {
        settings: { ...PLANT_PLANNING_DEFAULTS },
        calendar: null,
        resources: new Map(),
        routings: new Map(),
      });
    return plants.get(siteId);
  };
  for (const s of (await db.query('SELECT id FROM sites WHERE active')).rows) plant(s.id);
  for (const s of (await db.query('SELECT * FROM plant_planning')).rows)
    if (plants.has(s.site_id))
      plant(s.site_id).settings = {
        club_window_days: s.club_window_days,
        lead_time_basis: s.lead_time_basis,
        day_weights: s.day_weights?.map(Number) ?? null,
        profile_day: s.profile_day,
        area_operations: s.area_operations ?? [],
        execution_buffer_pct: Number(s.execution_buffer_pct ?? 25),
        version: s.version,
      };
  for (const c of (
    await db.query(
      `SELECT c.id,c.site_id,c.working_days,
         coalesce((SELECT json_agg(json_build_object('start_time',to_char(x.start_time,'HH24:MI'),'end_time',to_char(x.end_time,'HH24:MI'),'break_minutes',x.break_minutes) ORDER BY x.sequence)
           FROM calendar_shifts x WHERE x.calendar_id=c.id),'[]') AS shifts,
         coalesce((SELECT array_agg(to_char(h.holiday_date,'YYYY-MM-DD')) FROM calendar_holidays h WHERE h.calendar_id=c.id),'{}') AS holidays
       FROM calendars c WHERE c.active AND c.is_default`,
    )
  ).rows)
    if (plants.has(c.site_id))
      plant(c.site_id).calendar = {
        id: c.id,
        workingDays: c.working_days,
        shifts: c.shifts,
        holidays: new Set(c.holidays),
        dayMinutes: calendarDayMinutes(c.shifts),
      };
  for (const r of (
    await db.query(
      'SELECT id,site_id,code,name,machine_count,efficiency_pct,changeover_minutes,planned_utilization_pct FROM resources WHERE active',
    )
  ).rows)
    if (plants.has(r.site_id))
      plant(r.site_id).resources.set(r.id, {
        id: r.id,
        code: r.code,
        name: r.name,
        machines: r.machine_count,
        efficiency: Number(r.efficiency_pct),
        changeover: Number(r.changeover_minutes),
        plannedUtilization: n(r.planned_utilization_pct),
      });
  // The routing in force today per plant and item (the latest effective revision).
  for (const o of (
    await db.query(
      `SELECT DISTINCT ON (r.site_id,r.item_id,op.sequence) r.site_id,r.item_id,op.sequence,op.operation_code,op.resource_id,op.run_minutes_per_unit
       FROM routings r JOIN routing_operations op ON op.routing_id=r.id
       WHERE r.active AND r.effective_from <= $1::date AND (r.effective_to IS NULL OR r.effective_to >= $1::date)
         AND r.id = (SELECT x.id FROM routings x WHERE x.site_id=r.site_id AND x.item_id=r.item_id AND x.active
           AND x.effective_from <= $1::date AND (x.effective_to IS NULL OR x.effective_to >= $1::date) ORDER BY x.effective_from DESC,x.id LIMIT 1)
       ORDER BY r.site_id,r.item_id,op.sequence`,
      [today],
    )
  ).rows) {
    const p = plants.get(o.site_id);
    if (!p) continue;
    if (!p.routings.has(o.item_id)) p.routings.set(o.item_id, []);
    p.routings.get(o.item_id).push({
      sequence: o.sequence,
      code: o.operation_code,
      resourceId: o.resource_id,
      perUnit: Number(o.run_minutes_per_unit),
    });
  }
  return plants;
}

// Made items' lead time at planned loading, for plants on the PLANNED_LOAD basis.
// settings: the plant's buffer settings; adu: effective ADU per item (for the default lot).
export function plantLeadTimes(plant, settings, adu) {
  const out = new Map();
  if (!plant || plant.settings.lead_time_basis !== 'PLANNED_LOAD' || !plant.calendar?.dayMinutes)
    return out;
  const f = dayFactor(plant.settings.day_weights, plant.settings.profile_day);
  for (const s of settings) {
    if (s.policy !== 'BUFFER' || s.makeBuy !== 'MAKE' || !(s.leadTimeDays > 0)) continue;
    const ops = (plant.routings.get(s.itemId) ?? [])
      .map((op) => ({ op, r: plant.resources.get(op.resourceId) }))
      .filter((x) => x.r && x.op.perUnit > 0);
    if (!ops.length) continue;
    const a = adu.get(s.itemId) ?? 0;
    const lot = s.referenceLot ?? Math.max(10, Math.round((a * 1.5) / 10) * 10);
    out.set(
      s.itemId,
      dynamicLeadTime({
        leadTimeDays: s.leadTimeDays,
        lot,
        ops: ops.map(({ op, r }) => ({
          perUnit: op.perUnit,
          capacityPerDay: (plant.calendar.dayMinutes * r.machines * r.efficiency) / 100,
          utilization: ((r.plannedUtilization ?? 0) / 100) * f,
        })),
      }),
    );
  }
  return out;
}

// Shift blocks of a working day, for turning working minutes into clock times.
function shiftBlocks(shifts) {
  let offset = 0;
  return shifts
    .map((s) => ({
      span: shiftSpan(s),
      net: Math.max(0, shiftSpan(s)?.length - Number(s.break_minutes ?? 0)),
    }))
    .filter((s) => s.span)
    .sort((a, b) => a.span.start - b.span.start)
    .map((s) => {
      const block = { offset, minutes: s.net, start: s.span.start };
      offset += s.net;
      return block;
    });
}

// BOM usage of every item with an active BOM today: [{ componentId, qtyPer }] per parent, in the
// component's base unit per base unit of the parent, in BOM line order (repeated lines kept).
export async function loadBomUsage(db, today) {
  const bomLines = (
    await db.query(
      `SELECT b.item_id AS parent,l.component_item_id,l.quantity,l.unit_id,c.base_unit_id,l.scrap_pct,b.base_quantity
       FROM boms b JOIN bom_lines l ON l.bom_id=b.id JOIN items c ON c.id=l.component_item_id
       WHERE b.active AND b.effective_from <= $1::date AND (b.effective_to IS NULL OR b.effective_to >= $1::date)
       ORDER BY b.item_id,l.line_no`,
      [today],
    )
  ).rows;
  const lineFactor = await conversionFactors(db, [
    ...new Set(bomLines.map((l) => l.component_item_id)),
  ]);
  const usage = new Map();
  for (const l of bomLines) {
    const f = Number(lineFactor(l.unit_id, l.base_unit_id, l.component_item_id) ?? 1);
    const qtyPer =
      (Number(l.quantity) * f) / Number(l.base_quantity) / (1 - Number(l.scrap_pct) / 100);
    if (!usage.has(l.parent)) usage.set(l.parent, []);
    usage.get(l.parent).push({ componentId: l.component_item_id, qtyPer });
  }
  return usage;
}

// Open purchase order lines per plant and item: [{ qty (base unit), due }].
// AV-8: recorded supplier confirmations move the confirmed quantity to its confirmed date.
async function loadSupplyLines(db, siteId = null) {
  const out = new Map();
  for (const r of (
    await db.query(
      `SELECT o.site_id,l.id,o.po_no,l.line_no,l.item_id,(l.quantity-l.received_quantity)*l.unit_factor AS qty,to_char(l.due_date,'YYYY-MM-DD') AS due
       FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.po_id
       WHERE o.status='OPEN' AND l.status='OPEN' AND l.received_quantity < l.quantity AND ($1::uuid IS NULL OR o.site_id=$1)
       ORDER BY l.due_date,o.po_no,l.line_no`,
      [siteId],
    )
  ).rows) {
    if (!out.has(r.site_id)) out.set(r.site_id, new Map());
    const m = out.get(r.site_id);
    if (!m.has(r.item_id)) m.set(r.item_id, []);
    m.get(r.item_id).push({
      qty: Number(r.qty),
      due: r.due,
      key: r.id,
      lineId: r.id,
      poNo: r.po_no,
      lineNo: String(r.line_no),
    });
  }
  const actions = await loadExpediteActions(db, siteId);
  for (const [site, list] of actions) {
    const confirmed = list.filter((a) => a.confirmation);
    if (confirmed.length) out.set(site, confirmedSupply(out.get(site) ?? new Map(), confirmed));
  }
  return out;
}

// Expedite actions per plant in the engine's shape.
export async function loadExpediteActions(db, siteId = null) {
  const out = new Map();
  for (const a of (
    await db.query(
      `SELECT a.*,to_char(a.required_date,'YYYY-MM-DD') AS required,to_char(a.confirmed_date,'YYYY-MM-DD') AS confirmed,
         to_char(a.current_due,'YYYY-MM-DD') AS due
       FROM expedite_actions a WHERE ($1::uuid IS NULL OR a.site_id=$1) ORDER BY a.action_no`,
      [siteId],
    )
  ).rows) {
    if (!out.has(a.site_id)) out.set(a.site_id, []);
    out.get(a.site_id).push({
      id: a.id,
      no: Number(a.action_no),
      key: a.action_key,
      type: a.kind,
      componentId: a.component_item_id,
      qty: a.quantity === null ? null : Number(a.quantity),
      required: a.required,
      supplyKey: a.po_line_id,
      currentDue: a.due,
      members: a.members,
      bundles: a.bundles,
      dependents: a.dependents,
      state: a.state,
      requestedBy: a.requested_by,
      version: a.version,
      confirmation: a.confirmed
        ? { date: a.confirmed, qty: Number(a.confirmed_qty), reference: a.confirmation_ref }
        : null,
    });
  }
  return out;
}

// Order plans per plant: Map(site -> Map(order ref -> plan)).
export async function loadOrderPlans(db, siteId = null) {
  const out = new Map();
  for (const p of (
    await db.query(
      `SELECT p.*,to_char(p.original_date,'YYYY-MM-DD') AS original,to_char(p.proposed_date,'YYYY-MM-DD') AS proposed,
         to_char(p.accepted_date,'YYYY-MM-DD') AS accepted,to_char(p.release_date,'YYYY-MM-DD') AS release
       FROM order_plans p WHERE ($1::uuid IS NULL OR p.site_id=$1)`,
      [siteId],
    )
  ).rows) {
    if (!out.has(p.site_id)) out.set(p.site_id, new Map());
    out.get(p.site_id).set(p.order_ref, {
      state: p.state,
      bundleId: p.bundle_id,
      originalDate: p.original,
      proposedDate: p.proposed,
      acceptedDate: p.accepted,
      releaseDate: p.release,
      reason: p.reason,
      gating: p.gating,
      lastDecisionNo: p.last_decision_no === null ? null : Number(p.last_decision_no),
      version: p.version,
    });
  }
  return out;
}

// AV-9: open downtime per plant, as schedule units the forward pass blocks out.
export async function loadDowntime(db, siteId = null) {
  const out = new Map();
  for (const r of (
    await db.query(
      `SELECT site_id,resource_id,machine,to_char(event_date,'YYYY-MM-DD') AS day,minutes
       FROM downtime_events WHERE state='open' AND ($1::uuid IS NULL OR site_id=$1)`,
      [siteId],
    )
  ).rows) {
    if (!out.has(r.site_id)) out.set(r.site_id, []);
    out.get(r.site_id).push({
      resourceId: r.resource_id,
      machine: r.machine === null ? null : Number(r.machine),
      date: r.day,
      minutes: Number(r.minutes),
    });
  }
  return out;
}

// Downtime on the schedule axis: a date becomes a day index; a past date stops the first day.
export const downtimeOn = (rows, dates) =>
  (rows ?? [])
    .map((d) => ({ ...d, day: Math.max(1, dueDayIndex(d.date, dates)) }))
    .filter((d) => d.day <= dates.length);

async function loadSequences(db, siteId = null) {
  return new Map(
    (
      await db.query('SELECT * FROM plant_sequence WHERE $1::uuid IS NULL OR site_id=$1', [siteId])
    ).rows.map((r) => [r.site_id, r]),
  );
}

const axisDates = (plant, today) =>
  workingDates(addDays(today, 1), AXIS_DAYS, plant.calendar.workingDays, plant.calendar.holidays);

// Open production orders (the book) with their lot fields. due = the order's promise (need-by).
export const BOOK_COLUMNS = `o.id,o.site_id,o.order_no,o.item_id,i.code,to_char(o.due_date,'YYYY-MM-DD') AS due,o.quantity,
  o.source,o.order_ref,o.lot_no,o.lot_count,to_char(o.lot_date,'YYYY-MM-DD') AS lot_date,o.front,o.rush,o.rush_before,
  o.execution_state,o.release_no`;
// AV-8: an order awaiting the customer's date confirmation is visible demand, not committed
// capacity or material (Nilkamal handover: Pending Orders to Plan).
export const NOT_PENDING = `NOT EXISTS (SELECT 1 FROM order_plans pp WHERE pp.site_id=o.site_id
  AND pp.order_ref=coalesce(o.order_ref,o.order_no) AND pp.state IN ('awaiting_confirmation','ready_to_reschedule'))`;
export const bookRow = (o) => ({
  id: o.id,
  ref: o.order_no,
  itemId: o.item_id,
  code: o.code,
  due: o.due,
  qty: Number(o.quantity),
  // AV-9: released work runs first, in release order, and is never re-sequenced.
  executionState: o.execution_state,
  releaseNo: o.release_no === null || o.release_no === undefined ? null : Number(o.release_no),
  ...(o.source === 'INSERTED'
    ? {
        inserted: true,
        orderRef: o.order_ref,
        lotNo: o.lot_no,
        lotCount: o.lot_count,
        lotDate: o.lot_date,
        front: o.front,
        rush: o.rush,
        rushBefore: o.rush_before,
      }
    : {}),
});

// Production orders as schedule units. The order number identifies an imported order; lots of an
// inserted order share its order reference, run no earlier than their lot date (unless the order
// went to the front) and are sequenced on that date.
const unitsOf = (book, dates, today) =>
  book.map((o) => {
    const day = dueDayIndex(o.due, dates);
    const running = o.releaseNo == null ? {} : { releaseNo: o.releaseNo };
    if (!o.lotDate)
      return {
        id: o.id,
        oid: o.ref,
        ref: o.ref,
        itemId: o.itemId,
        code: o.code,
        qty: o.qty,
        dueDate: o.due,
        dueDay: day,
        orderDueDay: day,
        ...running,
      };
    const lotDay = Math.max(1, dueDayIndex(o.lotDate, dates));
    return {
      id: o.id,
      oid: o.orderRef,
      ref: o.ref,
      itemId: o.itemId,
      code: o.code,
      qty: o.qty,
      promiseDate: o.due,
      dueDate: o.front ? today : o.lotDate,
      dueDay: o.front ? 0 : lotDay,
      orderDueDay: day,
      lot: o.lotNo,
      lots: o.lotCount,
      lotDay,
      front: o.front,
      noAutoGroup: true,
      ...running,
      ...(o.rush ? { rushBefore: o.rushBefore ?? null } : {}),
    };
  });

// The planner's decisions on the schedule axis: dates become working-day indexes.
function planOf(row, dates) {
  if (!row) return null;
  const idx = (d) => Math.max(1, dueDayIndex(d, dates));
  return {
    manualOrder: row.manual_order ?? null,
    groups: (row.groups ?? []).map((g) => ({ ...g, day: idx(g.day) })),
    releases: new Map(Object.entries(row.releases ?? {}).map(([id, d]) => [id, idx(d)])),
  };
}

// Readiness inputs of one plant: stock of items with any stock record, open supply lines, zones.
function readinessInputs({ usage, onHand, stockKnown, supply, zones, today, dates, dayMinutes }) {
  const known = new Map();
  for (const id of stockKnown ?? []) known.set(id, onHand?.get(id) ?? 0);
  // The engine reads the quantity per unit of the parent as `qty`.
  const boms = new Map(
    [...usage].map(([id, lines]) => [
      id,
      lines.map((l) => ({ componentId: l.componentId, qty: l.qtyPer })),
    ]),
  );
  return {
    boms,
    onHand: known,
    supply: supply ?? new Map(),
    asOf: today,
    dates,
    dayMinutes,
    zones,
  };
}

const zonesOf = (results, siteId) =>
  new Map(
    results
      .filter((r) => r.siteId === siteId && r.policy === 'BUFFER' && r.status === 'planned')
      .map((r) => [r.itemId, r.zone]),
  );

// Readiness of an order as stored with the schedule (component codes, dates, quantities).
function readinessLines(r, codes, units) {
  const refOf = new Map(units.map((u) => [u.id, u.ref]));
  return (r?.lines ?? []).map((l) => ({
    component: codes.get(l.componentId) ?? l.componentId,
    lot: refOf.get(l.lotId) ?? l.lotId,
    release: l.release,
    requirement: l.requirement,
    onHand: l.onHand,
    timely: l.timely,
    before: l.committedBefore,
    available: l.available,
    shortage: l.shortage,
    unknown: l.unknown,
    replenish: l.replenish,
    zone: l.zone,
    overdue: l.overdueSupply,
    later: l.laterSupply.map((p) => ({ due: p.due, qty: p.qty })),
  }));
}
function readinessMessages(r, codes) {
  if (!r) return [];
  const list = (lines) => [...new Set(lines.map((l) => codes.get(l.componentId) ?? l.componentId))];
  const short = list(r.gaps),
    unknown = list(r.unknown);
  const text = (label, ids) =>
    label + ids.slice(0, 5).join(', ') + (ids.length > 5 ? ` and ${ids.length - 5} more` : '');
  return [
    ...(short.length ? [text('Short at release: ', short)] : []),
    ...(unknown.length ? [text('No stock position: ', unknown)] : []),
    ...(r.missingBom ? ['No active BOM: materials cannot be validated.'] : []),
  ];
}

// Schedules every plant's open production orders for a run and stores the result.
// results: this run's buffer results ([{ siteId, itemId, status, zone }]); usage: BOM usage.
export async function scheduleSites(
  db,
  run,
  today,
  plants,
  { usage, productionOrders, results, onHand, stockKnown },
) {
  const summary = {};
  const supplyBySite = await loadSupplyLines(db);
  const sequences = await loadSequences(db);
  const actionsBySite = await loadExpediteActions(db);
  const plansBySite = await loadOrderPlans(db);
  const downtimeBySite = await loadDowntime(db);
  const codes = new Map(
    (
      await db.query('SELECT id,code FROM items WHERE id=ANY($1::uuid[])', [
        [...new Set([...usage.values()].flat().map((l) => l.componentId))],
      ])
    ).rows.map((r) => [r.id, r.code]),
  );
  for (const [siteId, plant] of plants) {
    const book = productionOrders.get(siteId) ?? [];
    if (!book.length) continue;
    const messages = [];
    if (!plant.calendar?.dayMinutes) {
      messages.push(
        'No default calendar with working time: add one in Calendars to schedule this plant.',
      );
      await db.query(
        `INSERT INTO schedule_plants(tenant_id,run_id,site_id,start_date,day_minutes,day_dates,orders,unscheduled,messages)
         VALUES($1,$2,$3,$4,0,'{}',0,$5,$6)`,
        [run.tenant_id, run.id, siteId, addDays(today, 1), book.length, JSON.stringify(messages)],
      );
      summary[siteId] = { orders: 0, unscheduled: book.length };
      continue;
    }
    const D = plant.calendar.dayMinutes;
    const dates = axisDates(plant, today);
    const orders = unitsOf(book, dates, today);
    const s = schedulePlant({
      orders,
      routings: plant.routings,
      resources: plant.resources,
      dayMinutes: D,
      clubWindowDays: plant.settings.club_window_days,
      plan: planOf(sequences.get(siteId), dates),
      downtime: downtimeOn(downtimeBySite.get(siteId), dates),
    });
    if (s.groupingExhausted)
      messages.push(
        `Same-item grouping stopped after ${s.groupingChecks} checks to keep the calculation fast; later orders stay in due-date order.`,
      );
    if (sequences.get(siteId)?.manual_order?.length)
      messages.push(
        'The order of work was set by a planner; new orders are placed by due date among them.',
      );
    const horizon = Math.min(
      dates.length,
      Math.max(s.horizonDays, ...orders.map((o) => o.orderDueDay)) + 1,
    );
    if (s.horizonDays >= dates.length)
      messages.push('The schedule runs past the planning horizon of the calendar.');
    const dateAt = (minute) =>
      dates[Math.min(dates.length - 1, Math.max(0, Math.floor(minute / D + 1e-9)))];
    // AV-7: time-phased material readiness per order (stock and dated supply, in start order).
    const readiness = materialReadiness(
      { orders: new Map(s.orders.map((o) => [o.order.id, o])) },
      readinessInputs({
        usage,
        onHand: onHand?.get(siteId),
        stockKnown: stockKnown?.get(siteId),
        supply: supplyBySite.get(siteId),
        zones: zonesOf(results, siteId),
        today,
        dates,
        dayMinutes: D,
      }),
    );
    const rows = s.orders.map((o) => {
      const r = readiness.get(oidOf(o.order));
      return {
        id: o.order.id,
        position: o.position,
        status: 'scheduled',
        start: o.start,
        finish: o.finish,
        release: dateAt(o.start),
        finishDate: dates[Math.min(dates.length - 1, o.shipDay - 1)],
        promise: o.order.promiseDate ?? o.order.dueDate,
        slack: o.slack,
        lateDays: o.late ? o.shipDay - (o.order.orderDueDay ?? o.order.dueDay) : 0,
        groupedWith: o.groupedWith,
        material: r?.status ?? null,
        planState: orderState(
          oidOf(o.order),
          r,
          plansBySite.get(siteId)?.get(oidOf(o.order)),
          actionsBySite.get(siteId) ?? [],
        ),
        messages: readinessMessages(r, codes),
        lines: readinessLines(r, codes, s.units),
        planGroup: o.order.planGroup ?? null,
        manualPlaced: !!o.order.manualPlaced,
        releaseMin: releaseMinute(o.order, D) || null,
      };
    });
    for (const [i, o] of s.unrouted.entries())
      rows.push({
        id: o.id,
        position: s.orders.length + i + 1,
        status: 'unscheduled',
        promise: o.dueDate,
        messages: ["No routing on this plant's active resources: add a routing for the item."],
      });
    for (let i = 0; i < rows.length; i += CHUNK) {
      const p = rows.slice(i, i + CHUNK);
      const c = (f) => p.map(f);
      await db.query(
        `INSERT INTO schedule_orders(tenant_id,run_id,site_id,production_order_id,position,status,start_min,finish_min,release_date,finish_date,promise_date,slack_min,late_days,grouped_with,material_check,messages,material_lines,plan_group,manual_placed,release_min,plan_state)
         SELECT $1,$2,$3,r.* FROM unnest($4::uuid[],$5::int[],$6::text[],$7::numeric[],$8::numeric[],$9::date[],$10::date[],$11::date[],$12::numeric[],$13::int[],$14::uuid[],$15::text[],$16::jsonb[],$17::jsonb[],$18::text[],$19::boolean[],$20::numeric[],$21::text[]) AS r`,
        [
          run.tenant_id,
          run.id,
          siteId,
          c((r) => r.id),
          c((r) => r.position),
          c((r) => r.status),
          c((r) => r.start ?? null),
          c((r) => r.finish ?? null),
          c((r) => r.release ?? null),
          c((r) => r.finishDate ?? null),
          c((r) => r.promise),
          c((r) => r.slack ?? null),
          c((r) => r.lateDays ?? null),
          c((r) => r.groupedWith ?? null),
          c((r) => r.material ?? null),
          c((r) => JSON.stringify(r.messages ?? [])),
          c((r) => JSON.stringify(r.lines ?? [])),
          c((r) => r.planGroup ?? null),
          c((r) => r.manualPlaced ?? false),
          c((r) => r.releaseMin ?? null),
          c((r) => r.planState ?? null),
        ],
      );
    }
    const ops = s.orders.flatMap((o) => o.ops.map((op) => ({ orderId: o.order.id, ...op })));
    for (let i = 0; i < ops.length; i += CHUNK) {
      const p = ops.slice(i, i + CHUNK);
      const c = (f) => p.map(f);
      await db.query(
        `INSERT INTO schedule_operations(tenant_id,run_id,site_id,production_order_id,sequence,operation_code,resource_id,machine,changeover_min,run_min,start_min,finish_min)
         SELECT $1,$2,$3,r.* FROM unnest($4::uuid[],$5::int[],$6::text[],$7::uuid[],$8::int[],$9::numeric[],$10::numeric[],$11::numeric[],$12::numeric[]) AS r`,
        [
          run.tenant_id,
          run.id,
          siteId,
          c((r) => r.orderId),
          c((r) => r.sequence),
          c((r) => r.code),
          c((r) => r.resourceId),
          c((r) => r.machine),
          c((r) => r.changeover),
          c((r) => r.work),
          c((r) => r.start),
          c((r) => r.finish),
        ],
      );
    }
    for (const r of s.resources)
      await db.query(
        `INSERT INTO schedule_resources(tenant_id,run_id,site_id,resource_id,drum,machines,run_min,changeover_min,changeovers,capacity_per_day,utilization,lanes,days)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          run.tenant_id,
          run.id,
          siteId,
          r.resourceId,
          r.resourceId === s.drumId,
          r.machines,
          r.run,
          r.changeover,
          r.changeovers,
          r.capacityPerDay,
          r.utilization,
          JSON.stringify(r.lanes),
          JSON.stringify(r.days.slice(0, horizon)),
        ],
      );
    const late = rows.filter((r) => r.lateDays > 0).length;
    await db.query(
      `INSERT INTO schedule_plants(tenant_id,run_id,site_id,start_date,day_minutes,day_dates,shifts,drum_resource_id,orders,late,unscheduled,makespan_min,changeover_saved_min,messages)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        run.tenant_id,
        run.id,
        siteId,
        dates[0],
        D,
        dates.slice(0, horizon),
        JSON.stringify(shiftBlocks(plant.calendar.shifts)),
        s.drumId,
        s.orders.length,
        late,
        s.unrouted.length,
        s.makespan,
        s.changeoverSaved,
        JSON.stringify(messages),
      ],
    );
    summary[siteId] = { orders: s.orders.length, late, unscheduled: s.unrouted.length };
  }
  return summary;
}

// Runs whose schedule is the published plan of a plant are kept when old runs are pruned.
export async function prunedSchedules(db, runIds) {
  if (!runIds.length) return;
  const keep = (
    await db.query(
      'SELECT DISTINCT ON (site_id) run_id FROM schedule_publications ORDER BY site_id,published_at DESC',
    )
  ).rows.map((r) => r.run_id);
  const drop = runIds.filter((id) => !keep.includes(id));
  for (const t of [
    'schedule_operations',
    'schedule_orders',
    'schedule_resources',
    'schedule_plants',
  ])
    await db.query(`DELETE FROM ${t} WHERE run_id=ANY($1::uuid[])`, [drop]);
}

// ---------- Views ----------

// The run to show for a plant: the current calculation, or the published plan.
export async function scheduleRun(db, siteId, view) {
  const publication =
    (
      await db.query(
        `SELECT p.*,u.name AS published_by_name FROM schedule_publications p LEFT JOIN app_users u ON u.id=p.published_by
         WHERE p.site_id=$1 ORDER BY p.published_at DESC LIMIT 1`,
        [siteId],
      )
    ).rows[0] ?? null;
  const current = (await db.query('SELECT current_run_id,current_run_no FROM planning_state'))
    .rows[0];
  const runId = view === 'published' ? publication?.run_id : current?.current_run_id;
  const header = runId
    ? ((
        await db.query(
          `SELECT sp.*,to_char(sp.start_date,'YYYY-MM-DD') AS start_date,
             (SELECT array_agg(to_char(d,'YYYY-MM-DD')) FROM unnest(sp.day_dates) d) AS dates,
             r.code AS drum,r.name AS drum_name,pr.run_no,to_char(pr.as_of,'YYYY-MM-DD') AS as_of,pr.finished_at
           FROM schedule_plants sp JOIN planning_runs pr ON pr.id=sp.run_id LEFT JOIN resources r ON r.id=sp.drum_resource_id
           WHERE sp.run_id=$1 AND sp.site_id=$2`,
          [runId, siteId],
        )
      ).rows[0] ?? null)
    : null;
  return {
    runId: header ? runId : null,
    header,
    publication: publication && {
      run_no: Number(publication.run_no),
      note: publication.note,
      published_by: publication.published_by_name ?? publication.published_by_subject,
      published_at: publication.published_at,
      current: Number(publication.run_no) === Number(current?.current_run_no),
    },
  };
}

export async function listSchedule(
  db,
  siteId,
  runId,
  { q = '', filter = null, cursor = null, limit = 50 },
) {
  const params = [runId, siteId, q];
  let where =
    's.run_id=$1 AND s.site_id=$2 AND (starts_with(lower(o.order_no),$3) OR starts_with(lower(i.code),$3))';
  if (filter === 'late') where += ' AND s.late_days > 0';
  else if (filter === 'gated') where += " AND s.material_check IN ('gated','unknown')";
  else if (filter === 'unscheduled') where += " AND s.status='unscheduled'";
  if (cursor) {
    params.push(Number(cursor));
    where += ` AND s.position > $${params.length}`;
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `SELECT s.position,s.status,s.start_min,s.finish_min,to_char(s.release_date,'YYYY-MM-DD') AS release_date,
         to_char(s.finish_date,'YYYY-MM-DD') AS finish_date,to_char(s.promise_date,'YYYY-MM-DD') AS promise_date,
         s.slack_min,s.late_days,s.material_check,s.messages,s.material_lines,s.plan_group,s.manual_placed,s.plan_state,coalesce(o.order_ref,o.order_no) AS order_ref,
         o.id,o.order_no,o.quantity,o.execution_state,i.code AS item,i.name AS item_name,
         u.code AS unit,g.order_no AS grouped_with
       FROM schedule_orders s JOIN production_orders o ON o.id=s.production_order_id JOIN items i ON i.id=o.item_id
       JOIN units u ON u.id=i.base_unit_id LEFT JOIN production_orders g ON g.id=s.grouped_with
       WHERE ${where} ORDER BY s.position LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit ? String(items[items.length - 1].position) : null,
  };
}

export async function scheduleResources(db, siteId, runId) {
  return (
    await db.query(
      `SELECT r.code,r.name,s.resource_id,s.drum,s.machines,s.run_min,s.changeover_min,s.changeovers,s.capacity_per_day,
         s.utilization,s.lanes,s.days,r.efficiency_pct,r.changeover_minutes,r.planned_utilization_pct
       FROM schedule_resources s JOIN resources r ON r.id=s.resource_id
       WHERE s.run_id=$1 AND s.site_id=$2 ORDER BY s.utilization DESC,lower(r.code)`,
      [runId, siteId],
    )
  ).rows;
}

// Timed blocks for the Gantt, limited to a window of working days and optionally one resource.
export async function scheduleBlocks(
  db,
  siteId,
  runId,
  { dayMinutes, from, to, resourceId = null, limit = 3000 },
) {
  const params = [runId, siteId, from * dayMinutes, to * dayMinutes];
  let where = 'x.run_id=$1 AND x.site_id=$2 AND x.finish_min > $3 AND x.start_min < $4';
  if (resourceId) {
    params.push(resourceId);
    where += ` AND x.resource_id=$${params.length}`;
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `SELECT x.resource_id,x.machine,x.operation_code,x.changeover_min,x.run_min,x.start_min,x.finish_min,
         o.order_no,i.code AS item,o.quantity,res.efficiency_pct
       FROM schedule_operations x JOIN production_orders o ON o.id=x.production_order_id JOIN items i ON i.id=o.item_id
       JOIN resources res ON res.id=x.resource_id
       WHERE ${where} ORDER BY x.resource_id,x.machine,x.start_min LIMIT $${params.length}`,
      params,
    )
  ).rows;
  return { blocks: rows.slice(0, limit), truncated: rows.length > limit };
}

// A made item's lead time and queue at planned loading, for the buffer board details.
export async function leadTimeReality(db, siteId, itemId, today) {
  const plants = await loadPlantModel(db, today);
  const plant = plants.get(siteId);
  const setting = (
    await db.query(
      `SELECT b.lead_time_days,b.reference_lot,i.make_buy FROM item_buffers b JOIN items i ON i.id=b.item_id
       WHERE b.site_id=$1 AND b.item_id=$2 AND b.policy='BUFFER'`,
      [siteId, itemId],
    )
  ).rows[0];
  if (!plant || !setting || setting.make_buy !== 'MAKE' || !(setting.lead_time_days > 0))
    return null;
  const adu = n(
    (
      await db.query(
        `SELECT r.adu FROM planning_results r JOIN planning_state s ON s.current_run_id=r.run_id
         WHERE r.site_id=$1 AND r.item_id=$2`,
        [siteId, itemId],
      )
    ).rows[0]?.adu,
  );
  const lt = plantLeadTimes(
    { ...plant, settings: { ...plant.settings, lead_time_basis: 'PLANNED_LOAD' } },
    [
      {
        itemId,
        policy: 'BUFFER',
        makeBuy: 'MAKE',
        leadTimeDays: setting.lead_time_days,
        referenceLot: n(setting.reference_lot),
      },
    ],
    new Map([[itemId, adu ?? 0]]),
  ).get(itemId);
  if (!lt) return null;
  const ops = (plant.routings.get(itemId) ?? []).filter(
    (op) => plant.resources.has(op.resourceId) && op.perUnit > 0,
  );
  return {
    basis: plant.settings.lead_time_basis,
    master_days: setting.lead_time_days,
    lot: n(setting.reference_lot) ?? Math.max(10, Math.round(((adu ?? 0) * 1.5) / 10) * 10),
    day_factor: dayFactor(plant.settings.day_weights, plant.settings.profile_day),
    days: lt.days,
    queue_days: lt.queueDays,
    factor: lt.factor,
    unbounded: lt.unbounded,
    stations: lt.stations.map((st, i) => ({
      resource: plant.resources.get(ops[i].resourceId).code,
      operation: ops[i].code,
      utilization: st.utilization,
      proc_days: st.procDays,
      wait_days: st.waitDays,
    })),
  };
}

// ---------- Plant planning settings ----------

export async function plantPlanning(db, siteId) {
  const row = (await db.query('SELECT * FROM plant_planning WHERE site_id=$1', [siteId])).rows[0];
  return row
    ? { ...row, day_weights: row.day_weights?.map(Number) ?? null }
    : { ...PLANT_PLANNING_DEFAULTS, site_id: siteId, version: 0 };
}

export async function savePlantPlanning(db, tenantId, siteId, value) {
  await db.query(
    `INSERT INTO plant_planning(tenant_id,site_id,club_window_days,lead_time_basis,day_weights,profile_day,area_operations,execution_buffer_pct)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tenant_id,site_id) DO UPDATE SET club_window_days=excluded.club_window_days,lead_time_basis=excluded.lead_time_basis,
       day_weights=excluded.day_weights,profile_day=excluded.profile_day,area_operations=excluded.area_operations,
       execution_buffer_pct=excluded.execution_buffer_pct,version=plant_planning.version+1,updated_at=now()`,
    [
      tenantId,
      siteId,
      value.club_window_days,
      value.lead_time_basis,
      value.day_weights,
      value.profile_day,
      value.area_operations ?? [],
      value.execution_buffer_pct ?? 25,
    ],
  );
}

export async function scheduleReadiness(db, siteId, today) {
  const c = (
    await db.query(
      `SELECT (SELECT count(*) FROM production_orders WHERE site_id=$1 AND status='OPEN')::int AS orders,
        (SELECT count(*) FROM production_orders o WHERE o.site_id=$1 AND o.status='OPEN' AND NOT EXISTS (
          SELECT 1 FROM routings r WHERE r.site_id=$1 AND r.item_id=o.item_id AND r.active AND r.effective_from <= $2::date
            AND (r.effective_to IS NULL OR r.effective_to >= $2::date)))::int AS unrouted,
        EXISTS (SELECT 1 FROM calendars WHERE site_id=$1 AND is_default AND active) AS calendar`,
      [siteId, today],
    )
  ).rows[0];
  return {
    key: 'schedule',
    title: 'Production schedule',
    status: !c.orders ? 'info' : c.calendar && !c.unrouted ? 'ready' : 'missing',
    detail: !c.orders
      ? 'Import open production orders to schedule them on the plant resources.'
      : !c.calendar
        ? 'Add a default calendar: the scheduler needs the plant working time.'
        : c.unrouted
          ? `${c.orders} open production order(s); ${c.unrouted} have no routing and cannot be scheduled.`
          : `${c.orders} open production order(s) scheduled on the plant resources every recalculation.`,
  };
}

// ---------- Planning decisions (AV-7) ----------

// The planning date: a fixed simulation date, or today.
export async function planningDate(db) {
  return (
    await db.query(
      "SELECT to_char(coalesce((SELECT as_of_date FROM planning_state),current_date),'YYYY-MM-DD') AS d",
    )
  ).rows[0].d;
}

// Everything a decision on one plant is judged on, loaded from the current data: the schedule
// with the planner's decisions applied and the time-phased readiness context.
export async function decisionContext(db, siteId) {
  const today = await planningDate(db);
  const plant = (await loadPlantModel(db, today)).get(siteId);
  if (!plant?.calendar?.dayMinutes) return null;
  const usage = await loadBomUsage(db, today);
  const book = (
    await db.query(
      `SELECT ${BOOK_COLUMNS} FROM production_orders o JOIN items i ON i.id=o.item_id
       WHERE o.site_id=$1 AND o.status='OPEN' AND ${NOT_PENDING}`,
      [siteId],
    )
  ).rows.map(bookRow);
  const stock = (
    await db.query(
      `SELECT b.item_id,sum(b.quantity) FILTER (WHERE l.nettable) AS qty FROM stock_balances b
       JOIN stock_locations l ON l.id=b.location_id WHERE b.site_id=$1 GROUP BY b.item_id`,
      [siteId],
    )
  ).rows;
  const onHand = new Map(stock.map((r) => [r.item_id, Number(r.qty ?? 0)]));
  const zones = new Map(
    (
      await db.query(
        `SELECT r.item_id,r.zone FROM planning_results r JOIN planning_state s ON s.current_run_id=r.run_id
         WHERE r.site_id=$1 AND r.policy='BUFFER' AND r.status='planned'`,
        [siteId],
      )
    ).rows.map((r) => [r.item_id, r.zone]),
  );
  const row = (await loadSequences(db, siteId)).get(siteId) ?? null;
  const dates = axisDates(plant, today);
  const D = plant.calendar.dayMinutes;
  const plan = planOf(row, dates);
  const base = {
    orders: unitsOf(book, dates, today),
    routings: plant.routings,
    resources: plant.resources,
    dayMinutes: D,
    clubWindowDays: plant.settings.club_window_days,
    downtime: downtimeOn((await loadDowntime(db, siteId)).get(siteId), dates),
  };
  const schedule = schedulePlant({ ...base, plan });
  const ctx = {
    ...readinessInputs({
      usage,
      onHand,
      stockKnown: onHand.keys(),
      supply: (await loadSupplyLines(db, siteId)).get(siteId),
      zones,
      today,
      dates,
      dayMinutes: D,
    }),
    routings: plant.routings,
    resources: plant.resources,
    drumId: schedule.drumId,
    clubWindowDays: plant.settings.club_window_days,
    downtime: base.downtime,
  };
  const codes = new Map(
    (
      await db.query('SELECT id,code FROM items WHERE id=ANY($1::uuid[])', [
        [
          ...new Set([
            ...book.map((b) => b.itemId),
            ...[...usage.values()].flat().map((l) => l.componentId),
          ]),
        ],
      ])
    ).rows.map((r) => [r.id, r.code]),
  );
  return {
    siteId,
    today,
    plant,
    dates,
    base,
    plan,
    row,
    schedule,
    units: schedule.units,
    ctx,
    codes,
    book,
  };
}

// Re-schedules with a changed plan (for a move's before / after).
export function scheduleWith(dc, plan) {
  return schedulePlant({ ...dc.base, plan });
}

const planRow = (row) => ({
  manual_order: row?.manual_order ?? null,
  groups: row?.groups ?? [],
  releases: row?.releases ?? {},
});

export async function savePlan(db, tenantId, siteId, value) {
  await db.query(
    `INSERT INTO plant_sequence(tenant_id,site_id,manual_order,groups,releases) VALUES($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id,site_id) DO UPDATE SET manual_order=excluded.manual_order,groups=excluded.groups,
       releases=excluded.releases,version=plant_sequence.version+1,updated_at=now()`,
    [
      tenantId,
      siteId,
      value.manual_order,
      JSON.stringify(value.groups),
      JSON.stringify(value.releases),
    ],
  );
}

// A decision's plan from a club / declub scenario (the planner's order of work becomes the
// scenario's sequence; the members' group is pinned with its release day).
export function planFromScenario(dc, compare, scenario, decisionNo) {
  const old = planRow(dc.row);
  const affected = new Set(compare.ids);
  const groups = old.groups.filter((g) => !g.ids.some((id) => affected.has(id)));
  for (const g of scenario.groups.filter((g) => g.ids.some((id) => scenario.ids.includes(id))))
    groups.push({
      id: g.id,
      ids: g.ids,
      item: dc.codes.get(g.fg) ?? g.fg,
      day: dc.dates[Math.max(0, g.day - 1)],
      beforeId: g.beforeId ?? null,
      savedMin: scenario.savedMin,
      carryUnits: g.ids.reduce((n, id) => n + (scenario.carryBy[id] || 0), 0),
      decisionNo,
    });
  const releases = {};
  for (const u of scenario.seq) {
    const day = Math.max(u.planRelease || 0, (!u.manualPlaced && !u.front && u.lotDay) || 0);
    if (day > 0) releases[u.id] = dc.dates[day - 1];
  }
  return { manual_order: [...new Set(scenario.seq.map(oidOf))], groups, releases };
}

// Compact, display-ready summaries (order numbers, dates, component codes).
export function describeImpact(dc, imp) {
  const date = (day) => dc.dates[Math.min(dc.dates.length - 1, Math.max(0, day - 1))];
  return {
    changed: imp.rows.length,
    broken: imp.broken.map((r) => ({
      order: r.id,
      promise: date(r.prom),
      was: date(r.shipBefore),
      now: date(r.shipAfter),
    })),
    recovered: imp.recovered,
    rows: imp.rows.slice(0, 200).map((r) => ({
      order: r.id,
      startBefore: r.startBefore,
      startAfter: r.startAfter,
      finishBefore: r.finishBefore,
      finishAfter: r.finishAfter,
      promise: date(r.prom),
      finishDate: date(r.shipAfter),
      slipDays: r.slipDays,
      newlyBroken: r.newlyBroken,
      slackAfter: r.slackAfter,
      slackConsumed: r.slackConsumed,
    })),
    materials: imp.materials,
    drum: imp.drum,
    changeoverDelta: imp.changeoverDelta,
  };
}

export function describeScenario(dc, s) {
  const code = (id) => dc.codes.get(id) ?? id;
  const reasons = s.reasons.map((r) => ({
    ...r,
    ...(r.components
      ? {
          components: r.components.map((c) => ({
            component: code(c.componentId),
            shortage: c.shortage,
          })),
        }
      : {}),
  }));
  const members = s.ids.map((id) => {
    const t = s.after.times.get(id);
    return {
      order: id,
      qty: t?.qty ?? null,
      promise: t ? dc.dates[Math.max(0, t.prom - 1)] : null,
      start: t?.start ?? null,
      finish: t?.finish ?? null,
      finishDate: t ? dc.dates[Math.max(0, t.ship - 1)] : null,
      pullDays: s.pullBy[id] ?? 0,
      carryUnits: s.carryBy[id] ?? 0,
      materials: s.after.materials.get(id)?.status ?? null,
    };
  });
  return {
    key: s.key,
    label: s.label,
    kind: s.kind,
    orders: s.ids,
    members,
    day: s.day ? dc.dates[s.day - 1] : null,
    beforeId: s.beforeId ?? null,
    savedMin: s.savedMin,
    carryUnits: s.carryUnits,
    fgCarryUnits: s.fgCarryUnits,
    pullDays: s.pull,
    normal: s.normal,
    conditional: s.conditional,
    reasons,
    excluded: (s.excluded ?? []).map((e) => ({ order: e.id, reasons: e.reasons })),
    impact: describeImpact(dc, s.impact),
  };
}

export async function recordDecision(db, actor, siteId, runNo, kind, orders, details) {
  const no = (await db.query("SELECT next_number('planning_decision') AS n")).rows[0].n;
  const id = (
    await db.query(
      `INSERT INTO planning_decisions(id,tenant_id,site_id,decision_no,kind,orders,run_no,details,decided_by,decided_by_subject)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        actor.tenant_id,
        siteId,
        no,
        kind,
        orders,
        runNo,
        JSON.stringify(details),
        actor.id,
        actor.actor_subject,
      ],
    )
  ).rows[0].id;
  return { id, no: Number(no) };
}

export async function listDecisions(db, siteId, limit = 30) {
  return (
    await db.query(
      `SELECT d.decision_no,d.kind,d.orders,d.run_no,d.details,d.decided_at,coalesce(u.name,d.decided_by_subject) AS decided_by
       FROM planning_decisions d LEFT JOIN app_users u ON u.id=d.decided_by
       WHERE d.site_id=$1 ORDER BY d.decision_no DESC LIMIT $2`,
      [siteId, limit],
    )
  ).rows;
}

// ---------- Insert order (AV-7) ----------
// Reference: Nilkamal simulation handover (21-Sep-2026), the Insert screen: a catalogue item or an
// odd size (family + L x W x H), a quantity and a need-by date (or a rush quote); four ways of
// saying yes checked on the drum, the full forward route and time-phased materials.

const ZONE_AT = (r, nfp) =>
  nfp <= 0
    ? 'breach'
    : nfp <= Number(r.top_of_red)
      ? 'red'
      : nfp <= Number(r.top_of_yellow)
        ? 'yellow'
        : 'green';

// A catalogue item of the plant: routed at the plant, with a BOM. Buffered when the current run
// planned a buffer for it: the order consumes it (net flow before and after).
export async function insertItem(db, dc, code) {
  const it = (
    await db.query('SELECT id,code,name FROM items WHERE lower(code)=lower($1)', [
      String(code ?? ''),
    ])
  ).rows[0];
  if (!it) return { refused: `Item ${code} is not in the item master.` };
  const ops = (dc.base.routings.get(it.id) ?? []).filter((op) =>
    dc.base.resources.has(op.resourceId),
  );
  if (!ops.length)
    return {
      item: it,
      refused: `${it.code} has no routing at this plant: it cannot be timed. No average or sibling routing is substituted.`,
    };
  if (!(dc.ctx.boms.get(it.id) ?? []).length)
    return { item: it, refused: `${it.code} has no BOM: its materials cannot be checked.` };
  const b = (
    await db.query(
      `SELECT r.nfp,r.zone,r.top_of_red,r.top_of_yellow,r.top_of_green,r.on_hand,r.open_supply,r.qualified_demand,r.adu
       FROM planning_results r JOIN planning_state s ON s.current_run_id=r.run_id
       WHERE r.site_id=$1 AND r.item_id=$2 AND r.policy='BUFFER' AND r.status='planned'`,
      [dc.siteId, it.id],
    )
  ).rows[0];
  const drumMin = ops
    .filter((op) => op.resourceId === dc.ctx.drumId)
    .reduce((n, op) => n + op.perUnit, 0);
  return {
    item: it,
    itemId: it.id,
    class: b ? 'buffered' : 'standard',
    operations: ops.length,
    drumMinPerUnit: drumMin,
    buffer: b
      ? {
          nfp: Number(b.nfp),
          zone: b.zone,
          topOfRed: Number(b.top_of_red),
          topOfYellow: Number(b.top_of_yellow),
          topOfGreen: Number(b.top_of_green),
          onHand: Number(b.on_hand),
          onOrder: Number(b.open_supply),
          qualifiedDemand: Number(b.qualified_demand),
          adu: Number(b.adu),
          after: (qty) => ({ nfp: Number(b.nfp) - qty, zone: ZONE_AT(b, Number(b.nfp) - qty) }),
        }
      : null,
  };
}

// Families an odd size can be estimated in: a standard of the family is routed here, has a BOM
// and carries its size in its code.
export async function oddSizeFamilies(db, dc) {
  const fams = (await db.query('SELECT code,name FROM odd_size_families ORDER BY name,code')).rows;
  const routed = (
    await db.query('SELECT id,code FROM items WHERE item_type=$1', ['FG'])
  ).rows.filter(
    (i) => dc.base.routings.has(i.id) && dc.ctx.boms.has(i.id) && /\d\d\d\d\d$/.test(i.code),
  );
  return fams.map((f) => ({
    code: f.code,
    name: f.name,
    standards: routed.filter((i) => i.code.startsWith(f.code)).length,
  }));
}

const dimText = (dims) => dims.map((x) => String(+x)).join('X');

// An odd size: the nearest standard of the family (same thickness first, then closest area); its
// routing with area operations scaled, its BOM with metres by area, pieces as they are, the rest
// by volume. Nothing is written until the planner commits.
export async function oddSizeItem(db, dc, familyCode, dims) {
  const fam = (
    await db.query('SELECT code,name FROM odd_size_families WHERE lower(code)=lower($1)', [
      String(familyCode ?? ''),
    ])
  ).rows[0];
  if (!fam) return { refused: `Family ${familyCode} is not an odd-size family of this company.` };
  const settings = dc.plant.settings;
  const areaOps = settings.area_operations ?? [];
  const cands = (
    await db.query("SELECT id,code FROM items WHERE item_type='FG' AND code LIKE $1", [
      fam.code + '%',
    ])
  ).rows
    .filter((i) => dc.base.routings.has(i.id) && dc.ctx.boms.has(i.id))
    .map((i) => ({ itemId: i.id, code: i.code }));
  const m = matchOddSize(fam.code, dims, cands, dc.base.routings, areaOps);
  if (!m.ok)
    return {
      family: fam,
      refused: `No routed ${fam.name} standard with a BOM and a size in its code at this plant: this size cannot be timed.`,
    };
  const src = (
    await db.query(
      `SELECT l.component_item_id,l.quantity,l.unit_id,u.code AS unit,l.scrap_pct,l.line_no
       FROM boms b JOIN bom_lines l ON l.bom_id=b.id JOIN units u ON u.id=l.unit_id
       WHERE b.item_id=$1 AND b.active AND b.effective_from <= $2::date AND (b.effective_to IS NULL OR b.effective_to >= $2::date)
       ORDER BY l.line_no`,
      [m.source.itemId, dc.today],
    )
  ).rows;
  const ib = inheritBom(
    src.map((l) => ({ componentId: l.component_item_id, qty: Number(l.quantity), unit: l.unit })),
    m.sourceSize,
    dims,
  );
  if (!ib.ok)
    return {
      family: fam,
      refused: `Materials cannot be inherited from ${m.source.code}: unit ${ib.line.unit} is not a length, area, weight, volume or piece.`,
    };
  const code = `${fam.code}-${dimText(dims)}`;
  const existing = (
    await db.query('SELECT id,code,name FROM items WHERE lower(code)=lower($1)', [code])
  ).rows[0];
  // The simulation's view: the source usage per line, scaled by the line's factor.
  const usage = dc.ctx.boms.get(m.source.itemId);
  return {
    family: fam,
    class: 'oddsize',
    code,
    existing: existing ?? null,
    itemId: existing?.id ?? 'new:' + code,
    source: m.source,
    sourceSize: m.sourceSize,
    dims,
    scale: m.scale,
    exactThickness: m.exactThickness,
    candidates: m.candidates,
    areaOps,
    ops: m.ops,
    bomLines: src.map((l, i) => ({ ...l, qty: ib.lines[i].qty, factor: ib.lines[i].factor })),
    usage: usage.map((u, i) => ({ componentId: u.componentId, qty: u.qty * ib.lines[i].factor })),
    area: ib.area,
    volume: ib.volume,
    drumMinPerUnit: m.ops
      .filter((op) => op.resourceId === dc.ctx.drumId)
      .reduce((n, op) => n + op.perUnit, 0),
  };
}

// The scenarios of an insert. line: { itemId, qty, needDay } (needDay null for a rush quote).
export function simulateInsertOrder(dc, target, line, intent) {
  const routings = new Map(dc.base.routings),
    boms = new Map(dc.ctx.boms);
  if (target.class === 'oddsize' && !target.existing) {
    routings.set(target.itemId, target.ops);
    boms.set(target.itemId, target.usage);
  }
  const book = { ...dc.base, routings, plan: dc.plan };
  const rctx = { ...dc.ctx, boms, routings };
  const drumRes = dc.plant.resources.get(dc.ctx.drumId);
  const env = {
    today: dc.today,
    dates: dc.dates,
    current: dc.units,
    baseTimes: orderTimes(forwardPass({ ...book, sequence: dc.units }), dc.base.dayMinutes),
    baseDrum: drumRes ? allocate(drumRes, dc.units, routings).changeover : 0,
    drum: drumBook(dc.units, rctx),
  };
  const id = 'NEW';
  return intent === 'rush'
    ? rushInsert({ itemId: line.itemId, qty: line.qty }, id, book, rctx, env)
    : simulateInsert([line], id, book, rctx, env);
}

// Display-ready scenarios: dates, order numbers and component codes.
export function describeInsert(dc, res) {
  const date = (d) => dc.dates[Math.min(dc.dates.length - 1, Math.max(0, d - 1))];
  const code = (id) => dc.codes.get(id) ?? id;
  const D = dc.base.dayMinutes;
  return {
    intent: res.intent,
    recommended: res.rec,
    supported: res.supported,
    evaluated: res.evaluated ?? null,
    scenarios: res.order.map((k) => {
      const s = res.scenarios[k];
      const reports = s.materials?.reports ?? [];
      const lines = reports.flatMap((r) => r.lines ?? []);
      return {
        key: k,
        label: s.label,
        feasible: s.feasible !== false && !s.unplaced,
        reasons: (s.reasons ?? []).map((r) => ({ ...r, ...(r.day ? { date: date(r.day) } : {}) })),
        lots: s.lines.flatMap((l) => l.lots.map((x) => ({ qty: x.qty, date: date(x.day) }))),
        front: k === 'whole_now',
        changeoverMin: s.chgMinAdded ?? 0,
        carryUnits: s.carryUnits ?? 0,
        ordersSlipped: s.ordersSlipped ?? 0,
        promisesBroken: s.promisesBroken ?? 0,
        materials: {
          status: s.materials?.status ?? 'unknown',
          gated: !!s.materials?.gated,
          gaps: lines
            .filter((l) => l.shortage > 1e-6)
            .slice(0, 50)
            .map((l) => ({
              component: code(l.componentId),
              release: l.release,
              requirement: l.requirement,
              available: l.available,
              shortage: l.shortage,
              later: (l.laterSupply ?? []).map((p) => ({ qty: p.qty, due: p.due })),
            })),
          unknown: [...new Set(lines.filter((l) => l.unknown).map((l) => code(l.componentId)))],
          missingBom: reports.some((r) => r.missingBom),
          replenish: [...new Set(reports.flatMap((r) => r.replenishComponents ?? []))].map(code),
        },
        production: (s.production ?? []).map((p) => ({
          qty: p.qty,
          start: p.start,
          finish: p.finish,
          startDate: date(1 + Math.floor(p.start / D + 1e-9)),
          finishDate: date(Math.max(1, Math.ceil(p.finish / D - 1e-9))),
        })),
        finishDate: s.fullRouteFinish ? date(s.fullRouteFinish) : null,
        meetsNeedBy: s.capacityMeetsPromise ?? null,
        broken: (s.capacityBroken ?? s.broken ?? []).map((b) => ({
          order: b.id,
          promise: date(b.prom),
          was: date(b.was),
          now: date(b.ship),
        })),
        forwardChangeoverMin: s.forwardChgDelta ?? s.chgMinAdded ?? 0,
        forwardCarry: s.forwardCarry ?? s.carryUnits ?? 0,
        forwardShifted: s.forwardShifted ?? s.ordersSlipped ?? 0,
        quoteDate:
          k === 'decline' ? date(s.lines[0].quoteDay) : s.quoteDay ? date(s.quoteDay) : null,
        rushBefore: s.rushBefore === undefined ? undefined : s.rushBefore,
      };
    }),
  };
}

// Writes an odd size the planner committed: item, estimated BOM and routing, provenance.
export async function createOddSizeItem(db, actor, dc, t) {
  const src = (
    await db.query('SELECT base_unit_id,family FROM items WHERE id=$1', [t.source.itemId])
  ).rows[0];
  const itemId = (
    await db.query(
      `INSERT INTO items(id,tenant_id,code,name,item_type,make_buy,base_unit_id,family,demand_class)
       VALUES(gen_random_uuid(),$1,$2,$3,'FG','MAKE',$4,$5,'stranger') RETURNING id`,
      [
        actor.tenant_id,
        t.code,
        `${t.family.name} ${t.dims.map((x) => +x).join('x')} odd size (estimated)`.slice(0, 120),
        src.base_unit_id,
        src.family,
      ],
    )
  ).rows[0].id;
  const bom = (
    await db.query(
      `INSERT INTO boms(id,tenant_id,item_id,revision,effective_from) VALUES(gen_random_uuid(),$1,$2,'EST1',$3) RETURNING id`,
      [actor.tenant_id, itemId, dc.today],
    )
  ).rows[0].id;
  await db.query(
    `INSERT INTO bom_lines(id,tenant_id,bom_id,line_no,component_item_id,quantity,unit_id,scrap_pct)
     SELECT gen_random_uuid(),$1,$2,x.n,x.c,x.q,x.u,x.s FROM unnest($3::int[],$4::uuid[],$5::numeric[],$6::uuid[],$7::numeric[]) AS x(n,c,q,u,s)`,
    [
      actor.tenant_id,
      bom,
      t.bomLines.map((l) => l.line_no),
      t.bomLines.map((l) => l.component_item_id),
      t.bomLines.map((l) => l.qty),
      t.bomLines.map((l) => l.unit_id),
      t.bomLines.map((l) => l.scrap_pct),
    ],
  );
  const srcOps = (
    await db.query(
      `SELECT o.sequence,o.operation_code,o.description,o.resource_id,o.setup_minutes
       FROM routings r JOIN routing_operations o ON o.routing_id=r.id
       WHERE r.site_id=$1 AND r.item_id=$2 AND r.active AND r.effective_from <= $3::date AND (r.effective_to IS NULL OR r.effective_to >= $3::date)
       ORDER BY o.sequence`,
      [dc.siteId, t.source.itemId, dc.today],
    )
  ).rows;
  const perUnit = new Map(t.ops.map((op) => [op.sequence, op.perUnit]));
  const routing = (
    await db.query(
      `INSERT INTO routings(id,tenant_id,site_id,item_id,revision,effective_from) VALUES(gen_random_uuid(),$1,$2,$3,'EST1',$4) RETURNING id`,
      [actor.tenant_id, dc.siteId, itemId, dc.today],
    )
  ).rows[0].id;
  const ops = srcOps.filter((o) => perUnit.get(o.sequence) > 0);
  await db.query(
    `INSERT INTO routing_operations(id,tenant_id,routing_id,sequence,operation_code,description,resource_id,setup_minutes,run_minutes_per_unit)
     SELECT gen_random_uuid(),$1,$2,x.s,x.c,x.d,x.r,x.m,x.p FROM unnest($3::int[],$4::text[],$5::text[],$6::uuid[],$7::numeric[],$8::numeric[]) AS x(s,c,d,r,m,p)`,
    [
      actor.tenant_id,
      routing,
      ops.map((o) => o.sequence),
      ops.map((o) => o.operation_code),
      ops.map((o) =>
        (t.areaOps.includes(o.operation_code)
          ? `${o.description} (area x${t.scale.toFixed(4)})`
          : o.description
        ).slice(0, 120),
      ),
      ops.map((o) => o.resource_id),
      ops.map((o) => o.setup_minutes),
      ops.map((o) => perUnit.get(o.sequence)),
    ],
  );
  await db.query(
    `INSERT INTO estimated_items(tenant_id,item_id,site_id,family,source_item_id,dimensions,source_dimensions,area_ratio,volume_ratio,exact_thickness,area_operations,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      actor.tenant_id,
      itemId,
      dc.siteId,
      t.family.code,
      t.source.itemId,
      t.dims,
      t.sourceSize,
      t.area,
      t.volume,
      t.exactThickness,
      t.areaOps,
      actor.id,
    ],
  );
  return itemId;
}

// Writes a committed order as production-order lots sharing one order reference.
export const nextInsertRef = async (db) =>
  'INS-' + (await db.query("SELECT next_number('inserted_order') AS n")).rows[0].n;

export async function writeInsertedOrder(db, tenantId, siteId, o) {
  const ref = o.ref;
  const many = o.lots.length > 1;
  for (const [i, lot] of o.lots.entries())
    await db.query(
      `INSERT INTO production_orders(id,tenant_id,site_id,order_no,item_id,quantity,due_date,order_type,reference,
         source,order_ref,lot_no,lot_count,lot_date,front,rush,rush_before,customer,decision_no)
       VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,'INSERT',$7,'INSERTED',$8,$9,$10,$11,$12,$13,$14,$7,$15)`,
      [
        tenantId,
        siteId,
        many ? `${ref}-${i + 1}` : ref,
        o.itemId,
        lot.qty,
        o.needDate,
        o.customer,
        ref,
        i + 1,
        o.lots.length,
        lot.date,
        !!o.front,
        !!o.rush,
        o.rush ? (o.rushBefore ?? null) : null,
        o.decisionNo,
      ],
    );
  return ref;
}

// ---------- Materials decisions (AV-8) ----------
// Reference: Nilkamal simulation handover, Request material expedite, supplier confirmation,
// Explore / quote later date and Pending Orders to Plan.

const dayIndex = (dc, date) => Math.max(1, dueDayIndex(date, dc.dates));
const dateOf = (dc, day) => dc.dates[Math.min(dc.dates.length - 1, Math.max(0, day - 1))];

// The plant's expedite actions and order plans, added to a decision context.
export async function materialsContext(db, dc) {
  dc.actions = (await loadExpediteActions(db, dc.siteId)).get(dc.siteId) ?? [];
  dc.plans = (await loadOrderPlans(db, dc.siteId)).get(dc.siteId) ?? new Map();
  return dc;
}

// An order's production units, also when it is pending (out of the committed book).
export async function orderUnits(db, dc, ref) {
  const inBook = dc.units.filter((u) => oidOf(u) === ref);
  if (inBook.length) return { units: inBook, scheduled: true };
  const rows = (
    await db.query(
      `SELECT ${BOOK_COLUMNS} FROM production_orders o JOIN items i ON i.id=o.item_id
       WHERE o.site_id=$1 AND o.status='OPEN' AND coalesce(o.order_ref,o.order_no)=$2`,
      [dc.siteId, ref],
    )
  ).rows.map(bookRow);
  return { units: unitsOf(rows, dc.dates, dc.today), scheduled: false };
}

// Display-ready expedite rows.
export function describeActions(dc, rows) {
  const code = (id) => dc.codes.get(id) ?? id;
  return rows.map((a) => ({
    id: a.id ?? null,
    no: a.no ?? null,
    key: a.key,
    type: a.type,
    component: a.componentId ? code(a.componentId) : null,
    qty: a.qty,
    required: a.required ?? null,
    onHand: a.onHand ?? null,
    timely: a.timely ?? null,
    requirement: a.requirement ?? null,
    shortage: a.shortage ?? null,
    po: a.poNo ?? null,
    line: a.lineNo ?? null,
    currentDue: a.currentDue ?? null,
    members: a.members ?? [],
    dependents: a.dependents ?? [],
    state: a.state ?? null,
    confirmation: a.confirmation ?? null,
    missing: !!a.missing,
  }));
}

// The orders an expedite covers (a pinned group is requested together) and its component rows.
// A pending order is judged on its best later-date placement.
export async function expeditePreview(db, dc, ref) {
  const group = (dc.plan?.groups ?? []).find((g) => g.ids.includes(ref));
  const ids = group ? group.ids : [ref];
  const { units, scheduled } = await orderUnits(db, dc, ref);
  if (!units.length) return null;
  let snap;
  if (scheduled) snap = snapshot(dc.units, dc.ctx);
  else {
    const plan = dc.plans.get(ref);
    const later = laterDates({
      current: dc.units,
      units,
      id: ref,
      groups: dc.plan?.groups ?? [],
      ctx: dc.ctx,
      first: plan?.releaseDate ? dayIndex(dc, plan.releaseDate) : 1,
      originalPromise: units[0].orderDueDay,
    });
    snap = later.scenarios[0]?.after;
    if (!snap) return { ids, rows: [], snap: null };
  }
  const supply = new Map();
  for (const [k, v] of dc.ctx.supply)
    supply.set(
      k,
      v.filter((p) => p.lineId),
    );
  return { ids, rows: expediteRows(snap, ids, supply, dc.today), snap };
}

// Writes an expedite request: one open bundle per set of orders; each component action is merged
// with an open action for the same component and purchase line.
export async function writeExpediteBundle(db, actor, dc, ids, rows, decisionNo) {
  const key = ids.slice().sort().join('+');
  let bundle = (
    await db.query(
      "SELECT id,bundle_no FROM expedite_bundles WHERE site_id=$1 AND order_key=$2 AND state<>'closed'",
      [dc.siteId, key],
    )
  ).rows[0];
  if (!bundle) {
    const no = (await db.query("SELECT next_number('expedite_bundle') AS n")).rows[0].n;
    bundle = (
      await db.query(
        `INSERT INTO expedite_bundles(id,tenant_id,site_id,bundle_no,orders,order_key,decision_no,requested_by)
         VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7) RETURNING id,bundle_no`,
        [actor.tenant_id, dc.siteId, no, ids, key, decisionNo, actor.id],
      )
    ).rows[0];
  }
  const merged = mergeActions(dc.actions, rows);
  const touched = [];
  for (const a of merged) {
    if (a.isNew) {
      const no = (await db.query("SELECT next_number('expedite_action') AS n")).rows[0].n;
      const id = (
        await db.query(
          `INSERT INTO expedite_actions(id,tenant_id,site_id,action_no,action_key,kind,component_item_id,quantity,required_date,
             po_line_id,current_due,members,bundles,dependents,state,requested_by)
           VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,ARRAY[$12]::uuid[],$13,$14,$15) RETURNING id`,
          [
            actor.tenant_id,
            dc.siteId,
            no,
            a.key,
            a.type,
            a.componentId,
            a.qty,
            a.required,
            a.lineId ?? null,
            a.currentDue ?? null,
            a.members,
            bundle.id,
            JSON.stringify(a.dependents ?? []),
            a.state,
            actor.id,
          ],
        )
      ).rows[0].id;
      touched.push(id);
    } else {
      await db.query(
        `UPDATE expedite_actions SET quantity=$2,required_date=$3,state=$4,members=$5,dependents=$6,
           bundles=CASE WHEN $7::uuid = ANY(bundles) THEN bundles ELSE bundles || $7::uuid END,
           approved_by=CASE WHEN $4='requested' THEN NULL ELSE approved_by END,
           approved_at=CASE WHEN $4='requested' THEN NULL ELSE approved_at END,
           requested_by=CASE WHEN $4='requested' THEN $8 ELSE requested_by END,
           version=version+1,updated_at=now() WHERE id=$1`,
        [
          a.id,
          a.qty,
          a.required,
          a.state,
          a.members,
          JSON.stringify(a.dependents ?? []),
          bundle.id,
          actor.id,
        ],
      );
      touched.push(a.id);
    }
  }
  for (const id of ids)
    await db.query(
      `INSERT INTO order_plans(tenant_id,site_id,order_ref,bundle_id,reason,last_decision_no) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,site_id,order_ref) DO UPDATE SET bundle_id=excluded.bundle_id,reason=excluded.reason,
         last_decision_no=excluded.last_decision_no,version=order_plans.version+1,updated_at=now()`,
      [
        actor.tenant_id,
        dc.siteId,
        id,
        bundle.id,
        'Receipt request only; supplier confirmation still required.',
        decisionNo,
      ],
    );
  await refreshBundles(db, dc.siteId);
  return { bundleId: bundle.id, bundleNo: Number(bundle.bundle_no), actions: touched };
}

// Bundle states follow their actions.
export async function refreshBundles(db, siteId) {
  const actions = (await loadExpediteActions(db, siteId)).get(siteId) ?? [];
  for (const b of (
    await db.query("SELECT id FROM expedite_bundles WHERE site_id=$1 AND state<>'closed'", [siteId])
  ).rows) {
    const list = actions.filter((a) => a.bundles.includes(b.id));
    if (list.length)
      await db.query(
        'UPDATE expedite_bundles SET state=$2,updated_at=now() WHERE id=$1 AND state<>$2',
        [b.id, bundleState(list)],
      );
  }
}

// Every expedite bundle and action of a plant, newest first.
export async function listExpedites(db, dc) {
  const bundles = (
    await db.query(
      `SELECT b.id,b.bundle_no,b.orders,b.state,b.decision_no,b.created_at,coalesce(u.name,'') AS requested_by
       FROM expedite_bundles b LEFT JOIN app_users u ON u.id=b.requested_by
       WHERE b.site_id=$1 ORDER BY b.bundle_no DESC LIMIT 100`,
      [dc.siteId],
    )
  ).rows;
  const people = new Map(
    (
      await db.query(
        `SELECT DISTINCT u.id,u.name FROM expedite_actions a JOIN app_users u ON u.id IN (a.requested_by,a.approved_by,a.confirmed_by)
         WHERE a.site_id=$1`,
        [dc.siteId],
      )
    ).rows.map((r) => [r.id, r.name]),
  );
  const raw = (
    await db.query(
      `SELECT a.id,a.requested_by,a.approved_by,a.confirmed_by,a.reason,a.version,o.po_no,l.line_no
       FROM expedite_actions a LEFT JOIN purchase_order_lines l ON l.id=a.po_line_id LEFT JOIN purchase_orders o ON o.id=l.po_id
       WHERE a.site_id=$1`,
      [dc.siteId],
    )
  ).rows;
  const extra = new Map(raw.map((r) => [r.id, r]));
  const codes = new Map(
    (
      await db.query('SELECT id,code FROM items WHERE id=ANY($1::uuid[])', [
        [...new Set(dc.actions.map((a) => a.componentId).filter(Boolean))],
      ])
    ).rows.map((r) => [r.id, r.code]),
  );
  return {
    bundles: bundles.map((b) => ({ ...b, bundle_no: Number(b.bundle_no) })),
    actions: dc.actions
      .slice()
      .reverse()
      .map((a) => {
        const x = extra.get(a.id);
        return {
          ...describeActions({ codes }, [
            { ...a, poNo: x?.po_no, lineNo: x ? String(x.line_no) : null },
          ])[0],
          version: a.version,
          bundles: bundles.filter((b) => a.bundles.includes(b.id)).map((b) => Number(b.bundle_no)),
          requestedBy: people.get(x?.requested_by) ?? null,
          requestedById: x?.requested_by ?? null,
          approvedBy: people.get(x?.approved_by) ?? null,
          confirmedBy: people.get(x?.confirmed_by) ?? null,
          reason: x?.reason ?? '',
        };
      }),
  };
}

// Later dates for one order (scheduled or pending): up to three distinct placements.
export async function laterPreview(db, dc, ref, candidateDate = null) {
  const { units, scheduled } = await orderUnits(db, dc, ref);
  if (!units.length) return null;
  const plan = dc.plans.get(ref);
  const res = laterDates({
    current: dc.units,
    units,
    id: ref,
    groups: dc.plan?.groups ?? [],
    ctx: dc.ctx,
    first: plan?.releaseDate ? dayIndex(dc, plan.releaseDate) : 1,
    candidate: candidateDate ? dayIndex(dc, candidateDate) : null,
    originalPromise: units[0].orderDueDay,
  });
  return { ...res, units, scheduled, plan };
}

export function describeLater(dc, res) {
  const code = (id) => dc.codes.get(id) ?? id;
  return res.scenarios.map((s) => ({
    key: s.key,
    label: s.label,
    normal: s.normal,
    capacityOK: s.capacityOK,
    release: dateOf(dc, s.day),
    // The order's earliest production release in this placement.
    productionRelease: dateOf(
      dc,
      Math.min(...s.seq.filter((u) => oidOf(u) === s.id).map((u) => u.planRelease)),
    ),
    promise: dateOf(dc, s.promise),
    finishDate: dateOf(dc, s.ship),
    start: s.start,
    finish: s.finish,
    beforeId: s.beforeId,
    status: s.status,
    carryUnits: s.carryUnits,
    savedMin: s.savedMin,
    moveSlip: s.moveSlip,
    moveSlackHours: s.moveSlackHours,
    originalPromise: dateOf(dc, s.originalPromise),
    late: s.late,
    broken: s.broken,
    materialHurt: s.materialHurt,
    gaps: s.gaps.map((g) => ({
      component: code(g.componentId),
      shortage: g.shortage,
      release: g.release,
    })),
    unknown: [...new Set(s.unknown.map((g) => code(g.componentId)))],
    impact: describeImpact(dc, s.impact),
  }));
}

// Applies a later-date placement: propose (order goes to Pending, out of the committed book),
// confirm (the accepted date becomes the promise and the order is rescheduled) or move (rescheduled,
// promise unchanged).
export async function applyLater(db, actor, dc, ref, res, s, mode, decisionNo) {
  const old = dc.plans.get(ref);
  const original = old?.originalDate ?? res.units[0].promiseDate ?? res.units[0].dueDate;
  const row = dc.row ?? {};
  const gating = [
    ...s.gaps.map((g) => ({
      component: dc.codes.get(g.componentId) ?? g.componentId,
      shortage: g.shortage,
    })),
    ...[...new Set(s.unknown.map((g) => g.componentId))].map((c) => ({
      component: dc.codes.get(c) ?? c,
      unknown: true,
    })),
  ];
  const groups = (row.groups ?? []).filter((g) => !g.ids.includes(ref));
  const promise = dateOf(dc, s.promise);
  if (mode === 'propose') {
    await savePlan(db, actor.tenant_id, dc.siteId, {
      manual_order: row.manual_order?.length ? row.manual_order.filter((x) => x !== ref) : null,
      groups,
      releases: Object.fromEntries(
        Object.entries(row.releases ?? {}).filter(([id]) => !res.units.some((u) => u.id === id)),
      ),
    });
  } else {
    const releases = {};
    for (const u of s.seq) {
      const day = Math.max(u.planRelease || 0, (!u.manualPlaced && !u.front && u.lotDay) || 0);
      if (day > 0) releases[u.id] = dateOf(dc, day);
    }
    await savePlan(db, actor.tenant_id, dc.siteId, {
      manual_order: [...new Set(s.seq.map(oidOf))],
      groups,
      releases,
    });
    const mine = s.seq.filter((u) => oidOf(u) === ref);
    for (const u of mine)
      await db.query(
        `UPDATE production_orders SET due_date=CASE WHEN $3 THEN $2::date ELSE due_date END,
           lot_date=CASE WHEN source='INSERTED' THEN $4::date ELSE lot_date END,front=false,
           version=version+1,updated_at=now() WHERE id=$1`,
        [u.id, promise, mode === 'confirm', dateOf(dc, u.planRelease)],
      );
  }
  await db.query(
    `INSERT INTO order_plans(tenant_id,site_id,order_ref,state,original_date,proposed_date,accepted_date,release_date,reason,gating,last_decision_no)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tenant_id,site_id,order_ref) DO UPDATE SET state=excluded.state,original_date=excluded.original_date,
       proposed_date=excluded.proposed_date,accepted_date=coalesce(excluded.accepted_date,order_plans.accepted_date),
       release_date=excluded.release_date,reason=excluded.reason,gating=excluded.gating,last_decision_no=excluded.last_decision_no,
       version=order_plans.version+1,updated_at=now()`,
    [
      actor.tenant_id,
      dc.siteId,
      ref,
      mode === 'propose' ? 'awaiting_confirmation' : 'scheduled',
      original,
      promise,
      mode === 'confirm' ? promise : null,
      dateOf(dc, s.day),
      (
        (s.normal ? 'Materials and capacity support this date.' : 'Conditional date.') +
        (mode === 'move' ? ' Original customer promise retained.' : '')
      ).slice(0, 500),
      JSON.stringify(gating),
      decisionNo,
    ],
  );
  const mine = s.seq.filter((u) => oidOf(u) === ref);
  return { original, promise, release: dateOf(dc, Math.min(...mine.map((u) => u.planRelease))) };
}

// Orders awaiting the customer's date (or ready to reschedule).
export async function listPending(db, siteId) {
  return (
    await db.query(
      `SELECT p.order_ref,p.state,to_char(p.original_date,'YYYY-MM-DD') AS original_date,to_char(p.proposed_date,'YYYY-MM-DD') AS proposed_date,
         to_char(p.release_date,'YYYY-MM-DD') AS release_date,p.reason,p.gating,p.last_decision_no,p.version,
         (SELECT i.code FROM production_orders o JOIN items i ON i.id=o.item_id WHERE o.site_id=p.site_id AND coalesce(o.order_ref,o.order_no)=p.order_ref LIMIT 1) AS item,
         (SELECT sum(o.quantity) FROM production_orders o WHERE o.site_id=p.site_id AND coalesce(o.order_ref,o.order_no)=p.order_ref AND o.status='OPEN') AS quantity,
         (SELECT max(o.customer) FROM production_orders o WHERE o.site_id=p.site_id AND coalesce(o.order_ref,o.order_no)=p.order_ref) AS customer
       FROM order_plans p WHERE p.site_id=$1 AND p.state IN ('awaiting_confirmation','ready_to_reschedule')
       ORDER BY p.updated_at`,
      [siteId],
    )
  ).rows;
}
