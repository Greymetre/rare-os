// Database side of the scheduler (AV-6): plant model inputs, dynamic lead times, the schedule of
// every planning run, its views and publication. Every function receives a pg client inside a
// company-scoped (RLS) transaction.
import { calendarDayMinutes, shiftSpan } from '../engines/plant-model.mjs';
import {
  dayFactor,
  dueDayIndex,
  dynamicLeadTime,
  schedulePlant,
  workingDates,
} from '../engines/scheduler.mjs';

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

// Schedules every plant's open production orders for a run and stores the result.
// results: this run's buffer results ([{ siteId, itemId, status, zone }]); usage: BOM usage.
export async function scheduleSites(db, run, today, plants, { usage, productionOrders, results }) {
  const summary = {};
  const status = new Map(results.map((r) => [r.siteId + '|' + r.itemId, r]));
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
    const dates = workingDates(
      addDays(today, 1),
      AXIS_DAYS,
      plant.calendar.workingDays,
      plant.calendar.holidays,
    );
    const orders = book.map((o) => ({
      id: o.id,
      ref: o.ref,
      itemId: o.itemId,
      code: o.code,
      qty: o.qty,
      dueDate: o.due,
      dueDay: dueDayIndex(o.due, dates),
    }));
    const s = schedulePlant({
      orders,
      routings: plant.routings,
      resources: plant.resources,
      dayMinutes: D,
      clubWindowDays: plant.settings.club_window_days,
    });
    if (s.groupingExhausted)
      messages.push(
        `Same-item grouping stopped after ${s.groupingChecks} checks to keep the calculation fast; later orders stay in due-date order.`,
      );
    const horizon = Math.min(
      dates.length,
      Math.max(s.horizonDays, ...orders.map((o) => o.dueDay)) + 1,
    );
    if (s.horizonDays >= dates.length)
      messages.push('The schedule runs past the planning horizon of the calendar.');
    const dateAt = (minute) =>
      dates[Math.min(dates.length - 1, Math.max(0, Math.floor(minute / D + 1e-9)))];
    // Material check from this run's buffers: a buffered component in breach gates the order;
    // one without a stock position cannot be validated.
    const check = (itemId) => {
      const gated = [],
        unknown = [];
      for (const l of usage.get(itemId) ?? []) {
        const r = status.get(siteId + '|' + l.componentId);
        if (!r || r.policy !== 'BUFFER') continue;
        if (r.status === 'missing') unknown.push(l.componentId);
        else if (r.zone === 'breach') gated.push(l.componentId);
      }
      return gated.length
        ? { v: 'gated', ids: gated }
        : unknown.length
          ? { v: 'unknown', ids: unknown }
          : { v: 'clear', ids: [] };
    };
    const codes = new Map(
      (
        await db.query('SELECT id,code FROM items WHERE id=ANY($1::uuid[])', [
          [...new Set([...usage.values()].flat().map((l) => l.componentId))],
        ])
      ).rows.map((r) => [r.id, r.code]),
    );
    const rows = s.orders.map((o) => {
      const m = check(o.order.itemId);
      const msg = m.ids.length
        ? [
            (m.v === 'gated' ? 'Component in breach: ' : 'No stock position: ') +
              m.ids
                .slice(0, 5)
                .map((id) => codes.get(id) ?? id)
                .join(', ') +
              (m.ids.length > 5 ? ` and ${m.ids.length - 5} more` : ''),
          ]
        : [];
      return {
        id: o.order.id,
        position: o.position,
        status: 'scheduled',
        start: o.start,
        finish: o.finish,
        release: dateAt(o.start),
        finishDate: dates[Math.min(dates.length - 1, o.shipDay - 1)],
        promise: o.order.dueDate,
        slack: o.slack,
        lateDays: o.late ? o.shipDay - o.order.dueDay : 0,
        groupedWith: o.groupedWith,
        material: m.v,
        messages: msg,
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
        `INSERT INTO schedule_orders(tenant_id,run_id,site_id,production_order_id,position,status,start_min,finish_min,release_date,finish_date,promise_date,slack_min,late_days,grouped_with,material_check,messages)
         SELECT $1,$2,$3,r.* FROM unnest($4::uuid[],$5::int[],$6::text[],$7::numeric[],$8::numeric[],$9::date[],$10::date[],$11::date[],$12::numeric[],$13::int[],$14::uuid[],$15::text[],$16::jsonb[]) AS r`,
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
         s.slack_min,s.late_days,s.material_check,s.messages,o.id,o.order_no,o.quantity,i.code AS item,i.name AS item_name,
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
    `INSERT INTO plant_planning(tenant_id,site_id,club_window_days,lead_time_basis,day_weights,profile_day)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id,site_id) DO UPDATE SET club_window_days=excluded.club_window_days,lead_time_basis=excluded.lead_time_basis,
       day_weights=excluded.day_weights,profile_day=excluded.profile_day,version=plant_planning.version+1,updated_at=now()`,
    [
      tenantId,
      siteId,
      value.club_window_days,
      value.lead_time_basis,
      value.day_weights,
      value.profile_day,
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
