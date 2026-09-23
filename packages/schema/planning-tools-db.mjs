// Database side of the planning tools (AV-11): the month's shape against the constraint, level
// production, whether an item deserves a buffer at all, and what a service level would take.
// Every function receives a pg client inside a company-scoped (RLS) transaction.
import {
  bufferVsMto,
  constraintStability,
  eventCurve,
  levelLoad,
  machineWhatIf,
  monthShape,
  serviceCurve,
  serviceSimulation,
  spaceFit,
  targetScenario,
} from '../engines/planning-tools.mjs';
import { effectiveSeries } from '../engines/ddmrp.mjs';
import { loadBomUsage, loadPlantModel, planningDate } from './schedule-db.mjs';
import { workingDates } from '../engines/scheduler.mjs';

const n = (v) => (v === null || v === undefined ? null : Number(v));

// Demand per week of every item of a plant, oldest week first; a component's demand is its
// parents' demand through the BOM, exactly as the buffer engine reads it.
export async function weeklyDemand(db, siteId, today, weeks = 52) {
  const direct = new Map();
  const last = (
    await db.query('SELECT max(demand_date)::text AS d FROM demand_history WHERE site_id=$1', [
      siteId,
    ])
  ).rows[0]?.d;
  const asOf = last && last < today ? last : today;
  for (const r of (
    await db.query(
      `SELECT item_id,((date_trunc('week',$2::date)::date - date_trunc('week',demand_date)::date)/7) AS wk,
         sum(quantity) AS qty
       FROM demand_history WHERE site_id=$1 AND demand_date <= $2::date
         AND demand_date > date_trunc('week',$2::date)::date - 7*$3
       GROUP BY 1,2`,
      [siteId, asOf, weeks],
    )
  ).rows) {
    const w = Number(r.wk);
    if (w >= weeks) continue;
    if (!direct.has(r.item_id)) direct.set(r.item_id, new Array(weeks).fill(0));
    direct.get(r.item_id)[weeks - 1 - w] += Number(r.qty);
  }
  const usage = await loadBomUsage(db, today);
  return { asOf, weeks: effectiveSeries(direct, usage, weeks) };
}

// Items of the plant with what the tools need: cost, lead time, current policy and profile.
export async function toolItems(db, siteId) {
  return (
    await db.query(
      `SELECT i.id,i.code,i.name,i.item_type,i.make_buy,i.family,i.standard_cost,u.code AS unit,
         b.policy,b.lead_time_days,p.order_cycle_days,
         coalesce(s.source_lead_time,0) AS supplier_lead_time
       FROM items i JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN item_buffers b ON b.item_id=i.id AND b.site_id=$1 AND b.active
       LEFT JOIN buffer_profiles p ON p.id=b.profile_id
       LEFT JOIN (SELECT item_id,min(lead_time_days) AS source_lead_time FROM item_suppliers
                  WHERE preferred AND active GROUP BY item_id) s ON s.item_id=i.id
       WHERE i.active`,
      [siteId],
    )
  ).rows.map((r) => ({
    itemId: r.id,
    code: r.code,
    name: r.name,
    family: r.family ?? '',
    type: r.item_type,
    makeBuy: r.make_buy,
    unit: r.unit,
    unitCost: n(r.standard_cost),
    policy: r.policy ?? null,
    leadTimeDays: n(r.lead_time_days) ?? n(r.supplier_lead_time) ?? 0,
    orderCycleDays: n(r.order_cycle_days) ?? 7,
  }));
}

// The constraint of the current calculation and what it can do in a day.
export async function constraintOf(db, siteId) {
  const row = (
    await db.query(
      `SELECT r.code,r.name,x.capacity_per_day,x.run_min,x.changeover_min,p.day_minutes
       FROM schedule_resources x JOIN planning_state s ON s.current_run_id=x.run_id
       JOIN resources r ON r.id=x.resource_id JOIN schedule_plants p ON p.run_id=x.run_id AND p.site_id=x.site_id
       WHERE x.site_id=$1 AND x.drum`,
      [siteId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    code: row.code,
    name: row.name,
    capacityPerDay: Number(row.capacity_per_day),
    bookMinutes: Number(row.run_min) + Number(row.changeover_min),
    dayMinutes: Number(row.day_minutes),
  };
}

// Month shape and level production for one plant.
export async function monthShapeView(db, siteId) {
  const today = await planningDate(db);
  const settings = (await db.query('SELECT * FROM plant_planning WHERE site_id=$1', [siteId]))
    .rows[0];
  const weights = (settings?.day_weights ?? []).map(Number);
  const drum = await constraintOf(db, siteId);
  if (!weights.length || !drum)
    return {
      empty: !drum
        ? 'No calculated schedule yet: the constraint is derived from it.'
        : 'No despatch profile: add one in Setup → Plant planning.',
    };
  // Working days in the profile's window, from the plant's own calendar.
  const plant = (await loadPlantModel(db, today)).get(siteId);
  const days = plant?.calendar
    ? workingDates(today, weights.length, plant.calendar.workingDays, plant.calendar.holidays)
        .length
    : weights.length;
  const monthMinutes = drum.capacityPerDay * days;
  // The month's volume is what the plant despatches: its finished goods, not every component.
  const demand = await weeklyDemand(db, siteId, today, 13);
  const finished = new Set(
    (await db.query("SELECT id FROM items WHERE item_type='FG'")).rows.map((r) => r.id),
  );
  const weekly = [...demand.weeks.entries()]
    .filter(([itemId]) => finished.has(itemId))
    .reduce((a, [, w]) => a + w.reduce((x, y) => x + y, 0) / w.length, 0);
  const monthUnits = Math.round((weekly / 7) * weights.length);
  return {
    today,
    drum,
    workdays: days,
    shape: monthShape(weights, monthMinutes, drum.capacityPerDay),
    level: levelLoad(weights, monthUnits),
    monthUnits,
    profileDay: settings?.profile_day ?? null,
  };
}

// Buffer or made to order, for every item with demand.
export async function bufferVsMtoView(db, siteId, options = {}) {
  const today = await planningDate(db);
  const { weeks, asOf } = await weeklyDemand(db, siteId, today);
  const items = await toolItems(db, siteId);
  const rows = items
    .filter((i) => weeks.has(i.itemId))
    .map((i) => bufferVsMto({ ...i, weeks: weeks.get(i.itemId) }, options))
    .sort((a, b) => Number(b.change) - Number(a.change) || b.ordersPerYear - a.ordersPerYear);
  return {
    asOf,
    rows,
    counts: {
      items: rows.length,
      buffer: rows.filter((r) => r.recommend === 'BUFFER').length,
      mto: rows.filter((r) => r.recommend === 'MTO').length,
      changes: rows.filter((r) => r.change).length,
    },
  };
}

// The recommended buffer set at a service level, and the curve across service levels.
export async function recommendedBuffersView(db, siteId, service = 0.9) {
  const today = await planningDate(db);
  const { weeks, asOf } = await weeklyDemand(db, siteId, today);
  const items = (await toolItems(db, siteId)).filter((i) => weeks.has(i.itemId));
  const withWeeks = items.map((i) => ({ ...i, weeks: weeks.get(i.itemId) }));
  const rows = withWeeks
    .map((i) => ({
      ...serviceSimulation(i, service),
      name: i.name,
      type: i.type,
      unit: i.unit,
      policy: i.policy,
      makeBuy: i.makeBuy,
    }))
    .filter((r) => r.adu > 0)
    .sort((a, b) => b.topOfGreen - a.topOfGreen);
  return {
    asOf,
    service,
    rows,
    curve: serviceCurve(withWeeks.filter((i) => i.weeks.some((w) => w > 0))),
    counts: {
      items: rows.length,
      buffered: rows.filter((r) => r.policy === 'BUFFER').length,
      finished: rows.filter((r) => r.type === 'FG').length,
      components: rows.filter((r) => r.type !== 'FG').length,
    },
  };
}

// ---------- Events, seasons and schemes ----------

export async function listEvents(db, siteId) {
  return (
    await db.query(
      `SELECT e.id,e.code,e.name,e.kind,to_char(e.from_date,'YYYY-MM-DD') AS from_date,
         to_char(e.to_date,'YYYY-MM-DD') AS to_date,e.uplift_pct,e.item_ids,e.family,e.note,e.active,e.version,
         (SELECT array_agg(i.code ORDER BY i.code) FROM items i WHERE i.id = ANY(e.item_ids)) AS items
       FROM demand_events e WHERE e.site_id=$1 ORDER BY e.from_date DESC,e.code`,
      [siteId],
    )
  ).rows.map((e) => ({ ...e, uplift_pct: Number(e.uplift_pct), items: e.items ?? [] }));
}

export async function listSchemes(db, siteId) {
  return (
    await db.query(
      `SELECT s.id,s.code,s.name,i.code AS item,s.item_id,to_char(s.from_date,'YYYY-MM-DD') AS from_date,
         to_char(s.to_date,'YYYY-MM-DD') AS to_date,s.expected_units,s.state,s.note,s.version,
         coalesce(u.name,'') AS decided_by,s.decided_at
       FROM demand_schemes s JOIN items i ON i.id=s.item_id LEFT JOIN app_users u ON u.id=s.decided_by
       WHERE s.site_id=$1 ORDER BY s.from_date DESC,s.code`,
      [siteId],
    )
  ).rows.map((s) => ({ ...s, expected_units: Number(s.expected_units) }));
}

// The zone line of one item over the coming weeks, with and without its events.
export async function eventCurveView(db, siteId, itemCode, weeks = 13) {
  const today = await planningDate(db);
  const item = (
    await db.query(
      `SELECT i.id,i.code,i.family,r.top_of_green,b.lead_time_days
       FROM items i LEFT JOIN item_buffers b ON b.item_id=i.id AND b.site_id=$1 AND b.active
       LEFT JOIN planning_results r ON r.item_id=i.id AND r.site_id=$1
         AND r.run_id=(SELECT current_run_id FROM planning_state)
       WHERE lower(i.code)=lower($2)`,
      [siteId, itemCode],
    )
  ).rows[0];
  if (!item) return null;
  const events = (await listEvents(db, siteId)).map((e) => ({
    itemIds: e.item_ids,
    family: e.family,
    from: e.from_date,
    to: e.to_date,
    upliftPct: e.uplift_pct,
    active: e.active,
    name: e.name,
  }));
  return {
    item: item.code,
    topOfGreen: n(item.top_of_green) ?? 0,
    leadTimeDays: n(item.lead_time_days) ?? 0,
    weeks: eventCurve({ itemId: item.id, family: item.family ?? '' }, events, {
      from: today,
      weeks,
      topOfGreen: n(item.top_of_green) ?? 0,
      leadTimeDays: n(item.lead_time_days) ?? 0,
    }),
  };
}

// ---------- Target mode ----------

// A target priced against history: the buffers it needs, the stock it costs and whether the
// constraint can make it.
export async function targetView(db, siteId, target) {
  const today = await planningDate(db);
  const { weeks, asOf } = await weeklyDemand(db, siteId, today);
  // A target is a target for what the plant sells: its finished goods, or one family of them.
  const items = (await toolItems(db, siteId))
    .filter(
      (i) => weeks.has(i.itemId) && (target.family ? i.family === target.family : i.type === 'FG'),
    )
    .map((i) => ({ ...i, weeks: weeks.get(i.itemId) }));
  const days = Math.max(
    1,
    Math.round((Date.parse(target.to) - Date.parse(target.from)) / 86400000) + 1,
  );
  const history = items.reduce(
    (a, i) => a + (i.weeks.reduce((x, y) => x + y, 0) / i.weeks.length / 7) * days,
    0,
  );
  const ratio = history > 0 ? target.targetUnits / history : 1;
  if (!(history > 0))
    return {
      asOf,
      target,
      days,
      historyUnits: 0,
      ratio: 1,
      rows: [],
      empty: 'No demand history for these items: a target cannot be priced against it.',
    };
  const drum = await constraintOf(db, siteId);
  const book = (
    await db.query(
      `SELECT sum(x.run_min) AS minutes,sum(o.quantity) AS units FROM schedule_operations x
       JOIN planning_state s ON s.current_run_id=x.run_id JOIN production_orders o ON o.id=x.production_order_id
       WHERE x.site_id=$1 AND x.resource_id=(SELECT resource_id FROM schedule_resources WHERE run_id=x.run_id AND site_id=$1 AND drum)`,
      [siteId],
    )
  ).rows[0];
  const minutesPerUnit = n(book?.units) > 0 ? Number(book.minutes) / Number(book.units) : null;
  return {
    asOf,
    target,
    days,
    historyUnits: Math.round(history),
    ratio,
    drum,
    ...targetScenario(items, ratio, {
      capacityPerDay: drum?.capacityPerDay ?? null,
      minutesPerUnit,
    }),
  };
}

// ---------- Space mode ----------

export async function spaceView(db, siteId, service = 0.9) {
  const limit = (
    await db.query(
      `SELECT id,location_id,measure,capacity,note,version FROM space_limits WHERE site_id=$1 AND location_id IS NULL`,
      [siteId],
    )
  ).rows[0];
  const rec = await recommendedBuffersView(db, siteId, service);
  if (!limit) return { ...rec, limit: null, fit: null };
  return {
    ...rec,
    limit: { ...limit, capacity: Number(limit.capacity) },
    fit: spaceFit(
      rec.rows.map((r) => ({
        itemId: r.itemId,
        code: r.code,
        topOfRed: r.topOfRed,
        topOfYellow: r.topOfYellow,
        topOfGreen: r.topOfGreen,
        size: 1,
      })),
      Number(limit.capacity),
    ),
  };
}

// ---------- The network ----------

// Every plant with its constraint, and how safely that resource is the constraint.
export async function networkView(db) {
  const plants = (
    await db.query(
      `SELECT s.id,s.code,s.name,
         (SELECT count(*) FROM production_orders o WHERE o.site_id=s.id AND o.status='OPEN')::int AS open_orders
       FROM sites s WHERE s.active ORDER BY s.code`,
    )
  ).rows;
  const resources = (
    await db.query(
      `SELECT x.site_id,x.resource_id,r.code,r.name,x.machines,x.capacity_per_day,x.run_min,x.changeover_min,
         x.utilization,x.drum,p.day_minutes
       FROM schedule_resources x JOIN planning_state s ON s.current_run_id=x.run_id
       JOIN resources r ON r.id=x.resource_id JOIN schedule_plants p ON p.run_id=x.run_id AND p.site_id=x.site_id`,
    )
  ).rows.map((r) => ({
    siteId: r.site_id,
    resourceId: r.resource_id,
    code: r.code,
    name: r.name,
    machines: Number(r.machines),
    capacityPerDay: Number(r.capacity_per_day),
    load: Number(r.run_min) + Number(r.changeover_min),
    utilisation: Number(r.utilization),
    utilisationPct: Math.round(Number(r.utilization) * 100),
    drum: r.drum,
    days: 1,
  }));
  return {
    plants: plants.map((p) => {
      const own = resources.filter((r) => r.siteId === p.id);
      const stability = constraintStability(own.map((r) => ({ ...r, days: 1 })));
      return {
        ...p,
        resources: own,
        drum: own.find((r) => r.drum) ?? stability.drum ?? null,
        stability: {
          gapPct: stability.gapPct,
          stable: stability.stable,
          next: stability.next ?? null,
        },
      };
    }),
  };
}

// What another machine would do to a plant's constraint.
export async function whatIfView(db, siteId, resourceCode, machines) {
  const net = await networkView(db);
  const plant = net.plants.find((p) => p.id === siteId);
  if (!plant) return null;
  const resource = plant.resources.find(
    (r) => r.code.toLowerCase() === String(resourceCode).toLowerCase(),
  );
  if (!resource) return null;
  return {
    plant: plant.code,
    resource: resource.code,
    from: resource.machines,
    to: machines,
    ...machineWhatIf(plant.resources, resource.resourceId, machines),
  };
}

// ---------- Assumptions ----------

// Every assumption the plan rests on, with the value in force and where it comes from.
export async function assumptionsView(db, siteId) {
  const settings = (await db.query('SELECT * FROM plant_planning WHERE site_id=$1', [siteId]))
    .rows[0];
  const profiles = (
    await db.query(
      `SELECT p.code,p.method,p.red_base_pct,p.red_safety_pct,p.green_pct,p.order_cycle_days,p.adu_window_days,
         p.zone_weeks,p.cv_weeks,count(b.item_id)::int AS items
       FROM buffer_profiles p LEFT JOIN item_buffers b ON b.profile_id=p.id AND b.site_id=$1 AND b.active
       WHERE p.active GROUP BY p.id ORDER BY p.code`,
      [siteId],
    )
  ).rows;
  const notes = new Map(
    (
      await db.query('SELECT code,note,confirmed FROM planning_assumptions WHERE site_id=$1', [
        siteId,
      ])
    ).rows.map((r) => [r.code, r]),
  );
  const rows = [
    {
      code: 'club_window_days',
      what: 'Maximum pull-forward when same-item orders are grouped',
      value: String(settings?.club_window_days ?? 1) + ' day(s)',
      where: 'Setup → Plant planning',
    },
    {
      code: 'lead_time_basis',
      what: 'Lead time that sizes made-item buffers',
      value:
        settings?.lead_time_basis === 'PLANNED_LOAD'
          ? 'Master plus queue at planned loading'
          : 'Master lead time',
      where: 'Setup → Plant planning',
    },
    {
      code: 'execution_buffer_pct',
      what: 'Protective buffer the execution loop measures completions against',
      value: String(settings?.execution_buffer_pct ?? 25) + '%',
      where: 'Setup → Plant planning',
    },
    {
      code: 'day_weights',
      what: 'Despatch profile: the shape of a month',
      value: settings?.day_weights?.length
        ? `${settings.day_weights.length} days, day ${settings.profile_day} used`
        : 'level (no profile)',
      where: 'Setup → Plant planning',
    },
    {
      code: 'area_operations',
      what: 'Operations whose minutes scale with the area of an odd size',
      value: (settings?.area_operations ?? []).join(', ') || 'none',
      where: 'Setup → Plant planning',
    },
    ...profiles.map((p) => ({
      code: 'profile:' + p.code,
      what: `Buffer profile ${p.code} (${p.items} items)`,
      value:
        p.method === 'WEEKLY'
          ? `weekly zones, ${p.zone_weeks} weeks, CV over ${p.cv_weeks}, green ${p.green_pct}%`
          : `red ${p.red_base_pct}% + safety ${p.red_safety_pct}%, green ${p.green_pct}%, cycle ${p.order_cycle_days ?? '—'} days, usage window ${p.adu_window_days} days`,
      where: 'Setup → Buffer profiles',
    })),
  ];
  return {
    rows: rows.map((r) => ({
      ...r,
      note: notes.get(r.code)?.note ?? '',
      confirmed: notes.get(r.code)?.confirmed ?? false,
    })),
  };
}
