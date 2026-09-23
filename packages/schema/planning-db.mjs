// Database side of material buffers (AV-4): profiles, buffer settings and versioned planning runs.
// Every function receives a pg client inside a company-scoped (RLS) transaction.
import { effectiveAdu, effectiveSeries, planPlant } from '../engines/ddmrp.mjs';
import { eventFactor, schemeDemand } from '../engines/planning-tools.mjs';
import { conversionFactors } from './demand-stock-db.mjs';
import { itemsByCode, plantsByCode, resolvePlant } from './plant-model-db.mjs';
import { syncProposals } from './purchase-db.mjs';
import {
  BOOK_COLUMNS,
  bookRow,
  NOT_PENDING,
  loadBomUsage,
  loadPlantModel,
  plantLeadTimes,
  prunedSchedules,
  scheduleSites,
} from './schedule-db.mjs';

const CHUNK = 1000;
const KEEP_RUNS = 5;
const lc = (v) => String(v ?? '').toLowerCase();
const num = (v) => (v === null || v === undefined ? null : Number(v));
const err = (column, message) => ({ column, message });
const PROFILE_COLUMNS = [
  'name',
  'red_base_pct',
  'red_safety_pct',
  'green_pct',
  'order_cycle_days',
  'spike_threshold_pct',
  'adu_window_days',
  'method',
  'zone_weeks',
  'cv_weeks',
  'order_multiple',
  'moq_adu_days',
];

// ---------- Buffer profiles ----------

export async function listProfiles(db) {
  return (
    await db.query(
      `SELECT p.*,(SELECT count(*) FROM item_buffers b WHERE b.profile_id=p.id AND b.active)::int AS items
       FROM buffer_profiles p ORDER BY lower(p.code) LIMIT 500`,
    )
  ).rows;
}

export async function profileByCode(db, code) {
  return (
    (await db.query('SELECT * FROM buffer_profiles WHERE lower(code)=lower($1)', [code])).rows[0] ??
    null
  );
}

export async function writeProfile(db, tenantId, value, old, active = true) {
  const args = PROFILE_COLUMNS.map((c) => value[c] ?? null);
  if (old) {
    await db.query(
      `UPDATE buffer_profiles SET ${PROFILE_COLUMNS.map((c, i) => `${c}=$${i + 2}`).join(',')},active=$${PROFILE_COLUMNS.length + 2},version=version+1,updated_at=now() WHERE id=$1`,
      [old.id, ...args, active],
    );
    return old.id;
  }
  return (
    await db.query(
      `INSERT INTO buffer_profiles(id,tenant_id,code,${PROFILE_COLUMNS.join(',')}) VALUES(gen_random_uuid(),$1,$2,${PROFILE_COLUMNS.map((_, i) => '$' + (i + 3)).join(',')}) RETURNING id`,
      [tenantId, value.code, ...args],
    )
  ).rows[0].id;
}

// ---------- Buffer settings ----------

// rows: [{ line?, value, errors }] from validateBufferSetting; resolves ids and the existing setting.
export async function checkBufferSettings(db, rows, scope) {
  const pending = rows.filter((r) => !r.errors.length);
  const plants = await plantsByCode(
    db,
    pending.map((r) => r.value.plant),
  );
  const items = await itemsByCode(
    db,
    pending.map((r) => r.value.item),
  );
  const profiles = new Map(
    (
      await db.query(
        'SELECT id,code,active FROM buffer_profiles WHERE lower(code)=ANY($1::text[])',
        [[...new Set(pending.map((r) => lc(r.value.profile)).filter(Boolean))]],
      )
    ).rows.map((p) => [lc(p.code), p]),
  );
  for (const row of pending) {
    const v = row.value,
      e = row.errors;
    const plant = resolvePlant(plants, v.plant, scope, e);
    if (plant) {
      v.plant = plant.code;
      v.site_id = plant.id;
    }
    const item = items.get(lc(v.item));
    if (!item) e.push(err('item', `Item ${v.item} was not found.`));
    else if (!item.active) e.push(err('item', `Item ${item.code} is inactive.`));
    else {
      v.item = item.code;
      v.item_id = item.id;
      if (v.policy === 'BUFFER' && item.make_buy === 'MAKE' && v.lead_time_days === null)
        e.push(
          err(
            'lead_time_days',
            `Item ${item.code} is made in the plant: set its manufacturing lead time in days.`,
          ),
        );
    }
    v.profile_id = null;
    if (v.profile) {
      const p = profiles.get(lc(v.profile));
      if (!p) e.push(err('profile', `Buffer profile ${v.profile} was not found.`));
      else if (!p.active) e.push(err('profile', `Buffer profile ${p.code} is inactive.`));
      else {
        v.profile = p.code;
        v.profile_id = p.id;
      }
    }
  }
  const keys = pending.filter((r) => r.value.site_id && r.value.item_id);
  const existing = new Map();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    for (const b of (
      await db.query(
        `SELECT b.* FROM item_buffers b JOIN unnest($1::uuid[],$2::uuid[]) AS k(site_id,item_id)
         ON k.site_id=b.site_id AND k.item_id=b.item_id`,
        [part.map((r) => r.value.site_id), part.map((r) => r.value.item_id)],
      )
    ).rows)
      existing.set(`${b.site_id}|${b.item_id}`, b);
  }
  for (const row of keys)
    row.existing = existing.get(`${row.value.site_id}|${row.value.item_id}`) ?? null;
  return rows;
}

export function bufferSettingAction(value, old) {
  if (!old) return 'create';
  const same =
    old.policy === value.policy &&
    (old.profile_id ?? null) === (value.profile_id ?? null) &&
    (old.lead_time_days ?? null) === (value.lead_time_days ?? null) &&
    num(old.adu_override) === num(value.adu_override) &&
    num(old.reference_lot) === num(value.reference_lot) &&
    old.active;
  return same ? 'unchanged' : 'update';
}

export async function writeBufferSettings(db, tenantId, values) {
  for (let i = 0; i < values.length; i += CHUNK) {
    const part = values.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO item_buffers(id,tenant_id,site_id,item_id,policy,profile_id,lead_time_days,adu_override,active,reference_lot)
       SELECT gen_random_uuid(),$1,v.site,v.item,v.policy,v.profile,v.lead,v.adu,coalesce(v.active,true),v.lot
       FROM unnest($2::uuid[],$3::uuid[],$4::text[],$5::uuid[],$6::int[],$7::numeric[],$8::boolean[],$9::numeric[]) AS v(site,item,policy,profile,lead,adu,active,lot)
       ON CONFLICT (tenant_id,site_id,item_id) DO UPDATE SET policy=excluded.policy,profile_id=excluded.profile_id,
         lead_time_days=excluded.lead_time_days,adu_override=excluded.adu_override,active=excluded.active,reference_lot=excluded.reference_lot,
         version=item_buffers.version+1,updated_at=now()`,
      [
        tenantId,
        part.map((v) => v.site_id),
        part.map((v) => v.item_id),
        part.map((v) => v.policy),
        part.map((v) => v.profile_id ?? null),
        part.map((v) => v.lead_time_days ?? null),
        part.map((v) => v.adu_override ?? null),
        part.map((v) => (v.active === undefined ? true : v.active)),
        part.map((v) => v.reference_lot ?? null),
      ],
    );
  }
}

export async function listBufferSettings(db, siteId, { q = '', cursor = null, limit = 25 }) {
  const params = [siteId, q];
  let where = 'b.site_id=$1 AND (starts_with(lower(i.code),$2) OR starts_with(lower(i.name),$2))';
  if (cursor) {
    params.push(...cursor);
    where += ' AND (lower(i.code),b.id::text) > ($3,$4)';
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `SELECT b.id,i.code AS item,i.name AS item_name,i.make_buy,b.policy,p.code AS profile,b.lead_time_days,b.adu_override,b.reference_lot,b.active,b.version
       FROM item_buffers b JOIN items i ON i.id=b.item_id LEFT JOIN buffer_profiles p ON p.id=b.profile_id
       WHERE ${where} ORDER BY lower(i.code),b.id::text LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit ? [lc(last.item), String(last.id)] : null };
}

// ---------- Planning runs ----------

// Queues a run unless one is already waiting, consuming the visible input-change markers.
// A change that commits later leaves a new marker, so it always triggers another run.
export async function queueRun(db, tenantId, { trigger, actor = null }) {
  await db.query('INSERT INTO planning_state(tenant_id) VALUES($1) ON CONFLICT DO NOTHING', [
    tenantId,
  ]);
  await db.query('SELECT 1 FROM planning_state WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
  const consumed = (
    await db.query('DELETE FROM planning_input_events RETURNING version')
  ).rows.reduce((max, r) => Math.max(max, Number(r.version)), 0);
  const waiting = (
    await db.query("SELECT * FROM planning_runs WHERE status='queued' ORDER BY run_no LIMIT 1")
  ).rows[0];
  // A queued run has not read anything yet, so it will include these changes too.
  if (waiting) {
    if (consumed > Number(waiting.input_version))
      await db.query('UPDATE planning_runs SET input_version=$2 WHERE id=$1', [
        waiting.id,
        consumed,
      ]);
    return { run: waiting, created: false };
  }
  const runNo = (await db.query("SELECT next_number('planning_run') AS n")).rows[0].n;
  const run = (
    await db.query(
      'INSERT INTO planning_runs(id,tenant_id,run_no,trigger,input_version,requested_by,requested_by_subject) VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6) RETURNING *',
      [tenantId, runNo, trigger, consumed, actor?.id ?? null, actor?.actor_subject ?? null],
    )
  ).rows[0];
  await db.query("INSERT INTO outbox_events(tenant_id,kind,payload) VALUES($1,'planning.run',$2)", [
    tenantId,
    JSON.stringify({ runId: run.id, actorId: actor?.id ?? null }),
  ]);
  return { run, created: true };
}

async function loadInputs(db, today) {
  const settings = (
    await db.query(
      `SELECT b.site_id,b.item_id,i.code,i.make_buy,u.decimals,b.policy,b.lead_time_days,b.adu_override,b.reference_lot,
         p.red_base_pct,p.red_safety_pct,p.green_pct,p.order_cycle_days,p.spike_threshold_pct,p.adu_window_days,
         p.method,p.zone_weeks,p.cv_weeks,p.order_multiple,p.moq_adu_days,
         src.moq,src.lot_multiple,src.purchase_unit_id,pu.code AS purchase_unit,pu.decimals AS purchase_decimals,
         src.supplier_id,coalesce(src.lead_time_days,s.lead_time_days) AS source_lead_time,i.base_unit_id,i.family
       FROM item_buffers b
       JOIN sites site ON site.id=b.site_id AND site.active
       JOIN items i ON i.id=b.item_id AND i.active
       JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN buffer_profiles p ON p.id=b.profile_id AND p.active
       LEFT JOIN item_suppliers src ON src.item_id=i.id AND src.preferred AND src.active
       LEFT JOIN suppliers s ON s.id=src.supplier_id AND s.active
       LEFT JOIN units pu ON pu.id=src.purchase_unit_id
       WHERE b.active`,
    )
  ).rows;
  const factor = await conversionFactors(db, [
    ...new Set(settings.filter((s) => s.purchase_unit_id).map((s) => s.item_id)),
  ]);
  const usage = await loadBomUsage(db, today);
  const bySite = (rows, value) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.site_id)) m.set(r.site_id, new Map());
      m.get(r.site_id).set(r.item_id, value(r));
    }
    return m;
  };
  // WEEKLY profiles read demand up to the plant's latest history date (the source extract may end
  // before today); items without a buffer setting follow the plant. Others end yesterday.
  const ends = new Map(
    (
      await db.query(
        `SELECT h.site_id,to_char(max(h.demand_date),'YYYY-MM-DD') AS last_day,
           EXISTS (SELECT 1 FROM item_buffers b JOIN buffer_profiles p ON p.id=b.profile_id AND p.active
                   WHERE b.site_id=h.site_id AND b.active AND b.policy='BUFFER' AND p.method='WEEKLY') AS weekly
         FROM demand_history h WHERE h.demand_date <= $1::date GROUP BY h.site_id`,
        [today],
      )
    ).rows.map((r) => [r.site_id, r]),
  );
  const weeklySites = [...ends.values()].filter((e) => e.weekly);
  // Own usage per item: demand history over the item's profile window (90 days without a setting).
  const direct = bySite(
    (
      await db.query(
        `WITH e AS (SELECT * FROM unnest($2::uuid[],$3::date[]) AS e(site_id,last_day))
         SELECT h.site_id,h.item_id,
           sum(h.quantity) FILTER (WHERE CASE WHEN wk.weekly THEN h.demand_date > e.last_day - w.days AND h.demand_date <= e.last_day
             ELSE h.demand_date >= $1::date - w.days AND h.demand_date < $1::date END) / w.days AS adu
         FROM demand_history h
         LEFT JOIN e ON e.site_id=h.site_id
         LEFT JOIN item_buffers b ON b.site_id=h.site_id AND b.item_id=h.item_id AND b.active
         LEFT JOIN buffer_profiles p ON p.id=b.profile_id
         CROSS JOIN LATERAL (SELECT coalesce(p.adu_window_days,90) AS days) w
         CROSS JOIN LATERAL (SELECT e.last_day IS NOT NULL AND (p.method='WEEKLY' OR (p.id IS NULL AND b.policy IS DISTINCT FROM 'BUFFER')) AS weekly) wk
         WHERE h.demand_date <= $1::date AND h.demand_date >= $1::date - 800
         GROUP BY h.site_id,h.item_id,w.days`,
        [today, weeklySites.map((e) => e.site_id), weeklySites.map((e) => e.last_day)],
      )
    ).rows,
    (r) => Math.max(0, Number(r.adu ?? 0)),
  );
  // WEEKLY series: Monday-week totals and 7-day block totals ending at the latest history date.
  const zoneWeeks = Math.max(1, ...settings.map((s) => Number(s.zone_weeks ?? 1)));
  const cvWeeks = Math.max(1, ...settings.map((s) => Number(s.cv_weeks ?? 1)));
  const weeklySeries = new Map();
  for (const e of weeklySites) {
    const weeks = new Map(),
      blocks = new Map();
    const at = (m, id, n, i, q) => {
      if (!m.has(id)) m.set(id, new Array(n).fill(0));
      m.get(id)[n - 1 - i] += q;
    };
    for (const r of (
      await db.query(
        `SELECT item_id,((date_trunc('week',$2::date)::date - date_trunc('week',demand_date)::date)/7) AS wk,
           (($2::date - demand_date)/7) AS blk,sum(quantity) AS qty
         FROM demand_history WHERE site_id=$1 AND demand_date <= $2::date
           AND demand_date > least(date_trunc('week',$2::date)::date - 7*$3, $2::date - 7*$4)
         GROUP BY 1,2,3`,
        [e.site_id, e.last_day, zoneWeeks, cvWeeks],
      )
    ).rows) {
      const q = Number(r.qty);
      if (Number(r.wk) < zoneWeeks) at(weeks, r.item_id, zoneWeeks, Number(r.wk), q);
      if (Number(r.blk) < cvWeeks) at(blocks, r.item_id, cvWeeks, Number(r.blk), q);
    }
    weeklySeries.set(e.site_id, {
      weeks: effectiveSeries(weeks, usage, zoneWeeks),
      blocks: effectiveSeries(blocks, usage, cvWeeks),
    });
  }
  const onHand = bySite(
    (
      await db.query(
        `SELECT b.site_id,b.item_id,sum(b.quantity) AS qty FROM stock_balances b
         JOIN stock_locations l ON l.id=b.location_id AND l.nettable GROUP BY b.site_id,b.item_id`,
      )
    ).rows,
    (r) => Number(r.qty),
  );
  // Items with any stock record at the plant, including zero or non-nettable stock.
  const stockKnown = new Map();
  for (const r of (await db.query('SELECT DISTINCT site_id,item_id FROM stock_balances')).rows) {
    if (!stockKnown.has(r.site_id)) stockKnown.set(r.site_id, new Set());
    stockKnown.get(r.site_id).add(r.item_id);
  }
  const productionOrders = new Map();
  for (const o of (
    await db.query(
      `SELECT ${BOOK_COLUMNS} FROM production_orders o JOIN items i ON i.id=o.item_id WHERE o.status='OPEN' AND ${NOT_PENDING}`,
    )
  ).rows) {
    if (!productionOrders.has(o.site_id)) productionOrders.set(o.site_id, []);
    productionOrders.get(o.site_id).push(bookRow(o));
  }
  // AV-11: events and seasons size the zones for a rate the history has not seen; an accepted
  // scheme's volume inside the horizon is demand.
  const events = new Map();
  for (const e of (
    await db.query(
      `SELECT e.*,to_char(e.from_date,'YYYY-MM-DD') AS from_day,to_char(e.to_date,'YYYY-MM-DD') AS to_day
       FROM demand_events e WHERE e.active`,
    )
  ).rows) {
    if (!events.has(e.site_id)) events.set(e.site_id, []);
    events.get(e.site_id).push({
      itemIds: e.item_ids,
      family: e.family,
      from: e.from_day,
      to: e.to_day,
      upliftPct: Number(e.uplift_pct),
      active: e.active,
    });
  }
  const schemes = new Map();
  for (const s of (
    await db.query(
      `SELECT s.*,to_char(s.from_date,'YYYY-MM-DD') AS from_day,to_char(s.to_date,'YYYY-MM-DD') AS to_day
       FROM demand_schemes s WHERE s.state='accepted'`,
    )
  ).rows) {
    if (!schemes.has(s.site_id)) schemes.set(s.site_id, []);
    schemes.get(s.site_id).push({
      itemId: s.item_id,
      from: s.from_day,
      to: s.to_day,
      expectedUnits: Number(s.expected_units),
      state: s.state,
    });
  }
  // AV-8: imported orders awaiting the customer's new date leave their finished good's demand.
  const pendingDemand = new Map();
  for (const r of (
    await db.query(
      `SELECT o.site_id,o.item_id,sum(o.quantity) AS qty FROM production_orders o
       WHERE o.status='OPEN' AND o.source='IMPORT' AND NOT ${NOT_PENDING} GROUP BY o.site_id,o.item_id`,
    )
  ).rows) {
    if (!pendingDemand.has(r.site_id)) pendingDemand.set(r.site_id, new Map());
    pendingDemand.get(r.site_id).set(r.item_id, Number(r.qty));
  }
  const supply = bySite(
    (
      await db.query(
        `SELECT o.site_id,l.item_id,sum((l.quantity-l.received_quantity)*l.unit_factor) AS qty
         FROM purchase_order_lines l JOIN purchase_orders o ON o.id=l.po_id
         WHERE o.status='OPEN' AND l.status='OPEN' AND l.received_quantity < l.quantity
         GROUP BY o.site_id,l.item_id`,
      )
    ).rows,
    (r) => Number(r.qty),
  );
  const demand = new Map();
  for (const d of (
    await db.query(
      `SELECT o.site_id,l.item_id,to_char(l.promise_date,'YYYY-MM-DD') AS due,l.quantity
       FROM sales_order_lines l JOIN sales_orders o ON o.id=l.order_id
       WHERE o.status='OPEN' AND l.status='OPEN'`,
    )
  ).rows) {
    if (!demand.has(d.site_id)) demand.set(d.site_id, []);
    demand.get(d.site_id).push({ itemId: d.item_id, due: d.due, qty: Number(d.quantity) });
  }
  const sites = new Map();
  for (const s of settings) {
    if (!sites.has(s.site_id)) sites.set(s.site_id, []);
    const profile = s.red_base_pct
      ? {
          red_base_pct: Number(s.red_base_pct),
          red_safety_pct: Number(s.red_safety_pct),
          green_pct: Number(s.green_pct),
          order_cycle_days: s.order_cycle_days,
          spike_threshold_pct: Number(s.spike_threshold_pct),
          method: s.method,
          zone_weeks: s.zone_weeks,
          cv_weeks: s.cv_weeks,
          order_multiple: s.order_multiple === null ? null : Number(s.order_multiple),
          moq_adu_days: s.moq_adu_days === null ? null : Number(s.moq_adu_days),
        }
      : null;
    const f = s.purchase_unit_id ? factor(s.purchase_unit_id, s.base_unit_id, s.item_id) : null;
    sites.get(s.site_id).push({
      itemId: s.item_id,
      code: s.code,
      family: s.family ?? '',
      makeBuy: s.make_buy,
      decimals: s.decimals,
      policy: s.policy,
      profile,
      leadTimeDays: s.lead_time_days,
      aduOverride: s.adu_override === null ? null : Number(s.adu_override),
      referenceLot: s.reference_lot === null ? null : Number(s.reference_lot),
      source:
        s.supplier_id && s.source_lead_time !== null && f
          ? {
              moq: Number(s.moq),
              multiple: Number(s.lot_multiple),
              factor: Number(f),
              unit: s.purchase_unit,
              decimals: s.purchase_decimals,
              leadTimeDays: s.source_lead_time,
              supplierId: s.supplier_id,
            }
          : null,
    });
  }
  return {
    sites,
    usage,
    direct,
    onHand,
    supply,
    demand,
    weeklySeries,
    stockKnown,
    productionOrders,
    pendingDemand,
    events,
    schemes,
  };
}

// plants (optional): loadPlantModel() output, for made items' lead time at planned loading.
export function planSites(inputs, today, plants = new Map()) {
  const results = [];
  for (const [siteId, settings] of inputs.sites) {
    const overrides = new Map(
      settings.filter((s) => s.aduOverride !== null).map((s) => [s.itemId, s.aduOverride]),
    );
    const adu = effectiveAdu(inputs.direct.get(siteId) ?? new Map(), inputs.usage, overrides);
    // A buffered item whose profile was deactivated is reported as missing data, not dropped.
    const noProfile = settings.filter((s) => s.policy === 'BUFFER' && !s.profile);
    // Each WEEKLY item reads the last zone_weeks / cv_weeks of the plant's exploded series.
    const plantSeries = inputs.weeklySeries?.get(siteId);
    const series = new Map();
    if (plantSeries)
      for (const s of settings) {
        if (s.profile?.method !== 'WEEKLY') continue;
        const w = plantSeries.weeks.get(s.itemId),
          b = plantSeries.blocks.get(s.itemId);
        if (w && b)
          series.set(s.itemId, {
            weeks: w.slice(-s.profile.zone_weeks),
            blocks: b.slice(-s.profile.cv_weeks),
          });
      }
    const rows = planPlant({
      today,
      settings: settings.filter((s) => !(s.policy === 'BUFFER' && !s.profile)),
      adu,
      usage: inputs.usage,
      onHand: inputs.onHand.get(siteId) ?? new Map(),
      supply: inputs.supply.get(siteId) ?? new Map(),
      demand: inputs.demand.get(siteId) ?? [],
      productionOrders: inputs.productionOrders?.get(siteId) ?? [],
      pendingDemand: inputs.pendingDemand?.get(siteId) ?? new Map(),
      // AV-11: the planning tools' events and schemes.
      demandFactors: new Map(
        settings.map((s) => [
          s.itemId,
          eventFactor(
            inputs.events?.get(siteId) ?? [],
            { itemId: s.itemId, family: s.family ?? '' },
            today,
            s.leadTimeDays ?? s.source?.leadTimeDays ?? 0,
          ),
        ]),
      ),
      schemeDemand: schemeDemand(
        inputs.schemes?.get(siteId) ?? [],
        today,
        Math.max(...settings.map((s) => s.leadTimeDays ?? 0), 30),
      ),
      series,
      stockKnown: inputs.stockKnown?.get(siteId) ?? new Set(),
      leadTimes: plantLeadTimes(plants.get(siteId), settings, adu),
    });
    for (const s of noProfile)
      rows.push({
        itemId: s.itemId,
        policy: 'BUFFER',
        status: 'missing',
        adu: adu.get(s.itemId) ?? 0,
        onHand: inputs.onHand.get(siteId)?.get(s.itemId) ?? 0,
        openSupply: inputs.supply.get(siteId)?.get(s.itemId) ?? 0,
        qualifiedDemand: 0,
        spikeDemand: 0,
        outsideHorizon: 0,
        messages: ['The buffer profile is inactive: choose an active profile.'],
      });
    for (const r of rows) results.push({ siteId, ...r });
  }
  return results;
}

async function saveResults(db, tenantId, runId, results) {
  for (let i = 0; i < results.length; i += CHUNK) {
    const part = results.slice(i, i + CHUNK);
    const col = (f) => part.map(f);
    await db.query(
      `INSERT INTO planning_results(tenant_id,run_id,site_id,item_id,policy,status,adu,dlt,top_of_red,top_of_yellow,top_of_green,
         on_hand,open_supply,qualified_demand,spike_demand,outside_horizon,nfp,zone,priority_pct,on_hand_alert,
         recommended_kind,recommended_qty,recommended_purchase_qty,purchase_unit,supplier_id,due_date,messages,
         zone_adu,zone_days,cv,safety_pct,lead_time_demand,production_demand,planned_make_demand,required_date,drivers,
         lead_time_live,lead_time_factor,event_factor,scheme_demand)
       SELECT $1,$2,r.* FROM unnest($3::uuid[],$4::uuid[],$5::text[],$6::text[],$7::numeric[],$8::int[],$9::numeric[],$10::numeric[],
         $11::numeric[],$12::numeric[],$13::numeric[],$14::numeric[],$15::numeric[],$16::numeric[],$17::numeric[],$18::text[],$19::numeric[],
         $20::text[],$21::text[],$22::numeric[],$23::numeric[],$24::text[],$25::uuid[],$26::date[],$27::jsonb[],
         $28::numeric[],$29::int[],$30::numeric[],$31::numeric[],$32::numeric[],$33::numeric[],$34::numeric[],$35::date[],$36::jsonb[],
         $37::numeric[],$38::numeric[],$39::numeric[],$40::numeric[]) AS r`,
      [
        tenantId,
        runId,
        col((r) => r.siteId),
        col((r) => r.itemId),
        col((r) => r.policy),
        col((r) => r.status),
        col((r) => r.adu),
        col((r) => r.dlt ?? null),
        col((r) => r.zones?.topOfRed ?? null),
        col((r) => r.zones?.topOfYellow ?? null),
        col((r) => r.zones?.topOfGreen ?? null),
        col((r) => r.onHand),
        col((r) => r.openSupply),
        col((r) => r.qualifiedDemand),
        col((r) => r.spikeDemand),
        col((r) => r.outsideHorizon),
        col((r) => r.nfp ?? null),
        col((r) => r.zone ?? null),
        col((r) => r.priority ?? null),
        col((r) => r.onHandAlert ?? null),
        col((r) => r.recommended?.kind ?? null),
        col((r) => r.recommended?.qty ?? null),
        col((r) => r.recommended?.purchaseQty ?? null),
        col((r) => r.recommended?.purchaseUnit ?? null),
        col((r) => r.recommended?.supplierId ?? null),
        col((r) => r.recommended?.due ?? null),
        col((r) => JSON.stringify(r.messages ?? [])),
        col((r) => r.zoneAdu ?? null),
        col((r) => r.zoneDays ?? null),
        col((r) => r.cv ?? null),
        col((r) => r.safetyPct ?? null),
        col((r) => r.leadTimeDemand ?? 0),
        col((r) => r.productionDemand ?? 0),
        col((r) => r.plannedMakeDemand ?? 0),
        col((r) => r.requiredDate ?? null),
        col((r) => JSON.stringify((r.drivers ?? []).map(({ itemId, ...d }) => d))),
        col((r) => r.leadTimeLive ?? null),
        col((r) => r.leadTimeFactor ?? null),
        col((r) => r.eventFactor ?? null),
        col((r) => r.schemeDemand ?? null),
      ],
    );
  }
}

// Runs a queued run. Replays of a finished run do nothing.
export async function runPlanning(db, runId) {
  const run = (await db.query('SELECT * FROM planning_runs WHERE id=$1 FOR UPDATE', [runId]))
    .rows[0];
  if (!run || run.status !== 'queued') return null;
  // A fixed planning date (a frozen simulation) replaces today.
  const today = (
    await db.query(
      "SELECT to_char(coalesce((SELECT as_of_date FROM planning_state),current_date),'YYYY-MM-DD') AS d",
    )
  ).rows[0].d;
  const inputs = await loadInputs(db, today);
  const plants = await loadPlantModel(db, today);
  const results = planSites(inputs, today, plants);
  await saveResults(db, run.tenant_id, run.id, results);
  const summary = { items: results.length, zones: {} };
  // AV-6: every plant's open production orders scheduled on its resources, stored with the run.
  summary.schedule = await scheduleSites(db, run, today, plants, { ...inputs, results });
  for (const r of results) {
    const key = r.status === 'planned' ? r.zone : r.status;
    summary.zones[key] = (summary.zones[key] ?? 0) + 1;
  }
  const promoted = (
    await db.query('SELECT promote_planning_run($1,$2) AS ok', [run.id, run.run_no])
  ).rows[0].ok;
  // Rule AV-01: the current buffers decide which purchase proposals are pending.
  if (promoted) summary.proposals = await syncProposals(db, run.tenant_id, run);
  await db.query(
    'UPDATE planning_runs SET status=$2,as_of=$3,summary=$4,finished_at=now() WHERE id=$1',
    [run.id, promoted ? 'completed' : 'superseded', today, JSON.stringify(summary)],
  );
  // Keep the current run and the most recent ones; older results are derived and recomputable.
  // A published schedule stays with its run.
  const old = (
    await db.query(
      `SELECT id FROM planning_runs WHERE status IN ('completed','superseded')
         AND id <> coalesce((SELECT current_run_id FROM planning_state),'00000000-0000-0000-0000-000000000000')
       ORDER BY run_no DESC OFFSET $1`,
      [KEEP_RUNS],
    )
  ).rows.map((r) => r.id);
  if (old.length) {
    await db.query('DELETE FROM planning_results WHERE run_id=ANY($1::uuid[])', [old]);
    await prunedSchedules(db, old);
  }
  return { promoted, summary };
}

export async function failRun(db, runId, message) {
  await db.query(
    "UPDATE planning_runs SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status='queued'",
    [runId, message],
  );
}

export async function planningStatus(db) {
  const state =
    (await db.query("SELECT *,to_char(as_of_date,'YYYY-MM-DD') AS fixed_date FROM planning_state"))
      .rows[0] ?? null;
  const pending = Number(
    (await db.query('SELECT count(*) FROM planning_input_events')).rows[0].count,
  );
  const runs = (
    await db.query(
      "SELECT id,run_no,status,trigger,input_version,to_char(as_of,'YYYY-MM-DD') AS as_of,summary,error,created_at,finished_at FROM planning_runs ORDER BY run_no DESC LIMIT 10",
    )
  ).rows;
  let current = runs.find((r) => r.id === state?.current_run_id) ?? null;
  if (!current && state?.current_run_id)
    current = (
      await db.query(
        "SELECT id,run_no,status,input_version,to_char(as_of,'YYYY-MM-DD') AS as_of,summary,finished_at FROM planning_runs WHERE id=$1",
        [state.current_run_id],
      )
    ).rows[0];
  const queued = runs.some((r) => r.status === 'queued');
  return {
    current,
    queued,
    upToDate: !!current && !queued && !pending,
    runs,
    fixedDate: state?.fixed_date ?? null,
  };
}

const ZONES = ['breach', 'red', 'yellow', 'green', 'excess'];

// Buffer board of the current run for one plant, most urgent first.
export async function listBoard(db, siteId, { q = '', zone = null, cursor = null, limit = 25 }) {
  const runId = (await db.query('SELECT current_run_id FROM planning_state')).rows[0]
    ?.current_run_id;
  if (!runId) return { runId: null, items: [], nextCursor: null, counts: {} };
  const rank = "CASE r.status WHEN 'planned' THEN 0 WHEN 'missing' THEN 1 ELSE 2 END";
  const params = [runId, siteId, q];
  let where =
    'r.run_id=$1 AND r.site_id=$2 AND (starts_with(lower(i.code),$3) OR starts_with(lower(i.name),$3))';
  if (zone === 'missing' || zone === 'not_applicable') {
    params.push(zone);
    where += ` AND r.status=$${params.length}`;
  } else if (ZONES.includes(zone)) {
    params.push(zone);
    where += ` AND r.zone=$${params.length}`;
  }
  if (cursor) {
    params.push(...cursor);
    const n = params.length;
    where += ` AND (${rank},coalesce(r.priority_pct,0),lower(i.code)) > ($${n - 2}::int,$${n - 1}::numeric,$${n})`;
  }
  params.push(limit + 1);
  const rows = (
    await db.query(
      `SELECT r.*,${rank} AS rank,i.code AS item,i.name AS item_name,i.make_buy,u.code AS unit,s.code AS supplier,
         to_char(r.due_date,'YYYY-MM-DD') AS due_date,to_char(r.required_date,'YYYY-MM-DD') AS required_date,
         pp.proposal_no AS pending_proposal_no
       FROM planning_results r JOIN items i ON i.id=r.item_id JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN suppliers s ON s.id=r.supplier_id
       LEFT JOIN purchase_proposals pp ON pp.site_id=r.site_id AND pp.item_id=r.item_id AND pp.status='PROPOSED'
       WHERE ${where} ORDER BY ${rank},coalesce(r.priority_pct,0),lower(i.code) LIMIT $${params.length}`,
      params,
    )
  ).rows;
  const counts = Object.fromEntries(
    (
      await db.query(
        `SELECT CASE WHEN status='planned' THEN zone ELSE status END AS k,count(*)::int AS n
         FROM planning_results WHERE run_id=$1 AND site_id=$2 GROUP BY 1`,
        [runId, siteId],
      )
    ).rows.map((r) => [r.k, r.n]),
  );
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return {
    runId,
    items,
    counts,
    nextCursor:
      rows.length > limit
        ? [String(last.rank), String(last.priority_pct ?? 0), lc(last.item)]
        : null,
  };
}

export async function bufferReadiness(db, siteId) {
  const c = (
    await db.query(
      `SELECT (SELECT count(*) FROM item_buffers WHERE site_id=$1 AND active AND policy='BUFFER')::int AS buffered,
        (SELECT count(*) FROM planning_results r JOIN planning_state s ON s.current_run_id=r.run_id
          WHERE r.site_id=$1 AND r.status='missing')::int AS missing`,
      [siteId],
    )
  ).rows[0];
  return {
    key: 'buffers',
    title: 'Material buffers',
    status: c.buffered && !c.missing ? 'ready' : 'missing',
    detail: !c.buffered
      ? 'Choose which items this plant buffers in Buffer settings.'
      : c.missing
        ? `${c.buffered} buffered item(s); ${c.missing} need data (lead time or usage). See the buffer board.`
        : `${c.buffered} buffered item(s) with complete data.`,
  };
}
