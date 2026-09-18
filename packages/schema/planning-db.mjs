// Database side of material buffers (AV-4): profiles, buffer settings and versioned planning runs.
// Every function receives a pg client inside a company-scoped (RLS) transaction.
import { effectiveAdu, planPlant } from '../engines/ddmrp.mjs';
import { conversionFactors } from './demand-stock-db.mjs';
import { itemsByCode, plantsByCode, resolvePlant } from './plant-model-db.mjs';

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
    old.active;
  return same ? 'unchanged' : 'update';
}

export async function writeBufferSettings(db, tenantId, values) {
  for (let i = 0; i < values.length; i += CHUNK) {
    const part = values.slice(i, i + CHUNK);
    await db.query(
      `INSERT INTO item_buffers(id,tenant_id,site_id,item_id,policy,profile_id,lead_time_days,adu_override,active)
       SELECT gen_random_uuid(),$1,v.site,v.item,v.policy,v.profile,v.lead,v.adu,coalesce(v.active,true)
       FROM unnest($2::uuid[],$3::uuid[],$4::text[],$5::uuid[],$6::int[],$7::numeric[],$8::boolean[]) AS v(site,item,policy,profile,lead,adu,active)
       ON CONFLICT (tenant_id,site_id,item_id) DO UPDATE SET policy=excluded.policy,profile_id=excluded.profile_id,
         lead_time_days=excluded.lead_time_days,adu_override=excluded.adu_override,active=excluded.active,
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
      `SELECT b.id,i.code AS item,i.name AS item_name,i.make_buy,b.policy,p.code AS profile,b.lead_time_days,b.adu_override,b.active,b.version
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
      `SELECT b.site_id,b.item_id,i.code,i.make_buy,u.decimals,b.policy,b.lead_time_days,b.adu_override,
         p.red_base_pct,p.red_safety_pct,p.green_pct,p.order_cycle_days,p.spike_threshold_pct,p.adu_window_days,
         src.moq,src.lot_multiple,src.purchase_unit_id,pu.code AS purchase_unit,pu.decimals AS purchase_decimals,
         src.supplier_id,coalesce(src.lead_time_days,s.lead_time_days) AS source_lead_time,i.base_unit_id
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
  const bomLines = (
    await db.query(
      `SELECT b.item_id AS parent,l.component_item_id,l.quantity,l.unit_id,c.base_unit_id,l.scrap_pct,b.base_quantity
       FROM boms b JOIN bom_lines l ON l.bom_id=b.id JOIN items c ON c.id=l.component_item_id
       WHERE b.active AND b.effective_from <= $1::date AND (b.effective_to IS NULL OR b.effective_to >= $1::date)`,
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
  const bySite = (rows, value) => {
    const m = new Map();
    for (const r of rows) {
      if (!m.has(r.site_id)) m.set(r.site_id, new Map());
      m.get(r.site_id).set(r.item_id, value(r));
    }
    return m;
  };
  // Own usage per item: demand history over the item's profile window (90 days without a setting).
  const direct = bySite(
    (
      await db.query(
        `SELECT h.site_id,h.item_id,sum(h.quantity) FILTER (WHERE h.demand_date >= $1::date - w.days) / w.days AS adu
         FROM demand_history h
         LEFT JOIN item_buffers b ON b.site_id=h.site_id AND b.item_id=h.item_id AND b.active
         LEFT JOIN buffer_profiles p ON p.id=b.profile_id
         CROSS JOIN LATERAL (SELECT coalesce(p.adu_window_days,90) AS days) w
         WHERE h.demand_date < $1::date AND h.demand_date >= $1::date - 365
         GROUP BY h.site_id,h.item_id,w.days`,
        [today],
      )
    ).rows,
    (r) => Number(r.adu ?? 0),
  );
  const onHand = bySite(
    (
      await db.query(
        `SELECT b.site_id,b.item_id,sum(b.quantity) AS qty FROM stock_balances b
         JOIN stock_locations l ON l.id=b.location_id AND l.nettable GROUP BY b.site_id,b.item_id`,
      )
    ).rows,
    (r) => Number(r.qty),
  );
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
        }
      : null;
    const f = s.purchase_unit_id ? factor(s.purchase_unit_id, s.base_unit_id, s.item_id) : null;
    sites.get(s.site_id).push({
      itemId: s.item_id,
      code: s.code,
      makeBuy: s.make_buy,
      decimals: s.decimals,
      policy: s.policy,
      profile,
      leadTimeDays: s.lead_time_days,
      aduOverride: s.adu_override === null ? null : Number(s.adu_override),
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
  return { sites, usage, direct, onHand, supply, demand };
}

export function planSites(inputs, today) {
  const results = [];
  for (const [siteId, settings] of inputs.sites) {
    const overrides = new Map(
      settings.filter((s) => s.aduOverride !== null).map((s) => [s.itemId, s.aduOverride]),
    );
    const adu = effectiveAdu(inputs.direct.get(siteId) ?? new Map(), inputs.usage, overrides);
    // A buffered item whose profile was deactivated is reported as missing data, not dropped.
    const noProfile = settings.filter((s) => s.policy === 'BUFFER' && !s.profile);
    const rows = planPlant({
      today,
      settings: settings.filter((s) => !(s.policy === 'BUFFER' && !s.profile)),
      adu,
      usage: inputs.usage,
      onHand: inputs.onHand.get(siteId) ?? new Map(),
      supply: inputs.supply.get(siteId) ?? new Map(),
      demand: inputs.demand.get(siteId) ?? [],
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
         recommended_kind,recommended_qty,recommended_purchase_qty,purchase_unit,supplier_id,due_date,messages)
       SELECT $1,$2,r.* FROM unnest($3::uuid[],$4::uuid[],$5::text[],$6::text[],$7::numeric[],$8::int[],$9::numeric[],$10::numeric[],
         $11::numeric[],$12::numeric[],$13::numeric[],$14::numeric[],$15::numeric[],$16::numeric[],$17::numeric[],$18::text[],$19::numeric[],
         $20::text[],$21::text[],$22::numeric[],$23::numeric[],$24::text[],$25::uuid[],$26::date[],$27::jsonb[]) AS r`,
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
      ],
    );
  }
}

// Runs a queued run. Replays of a finished run do nothing.
export async function runPlanning(db, runId) {
  const run = (await db.query('SELECT * FROM planning_runs WHERE id=$1 FOR UPDATE', [runId]))
    .rows[0];
  if (!run || run.status !== 'queued') return null;
  const today = (await db.query("SELECT to_char(current_date,'YYYY-MM-DD') AS d")).rows[0].d;
  const results = planSites(await loadInputs(db, today), today);
  await saveResults(db, run.tenant_id, run.id, results);
  const summary = { items: results.length, zones: {} };
  for (const r of results) {
    const key = r.status === 'planned' ? r.zone : r.status;
    summary.zones[key] = (summary.zones[key] ?? 0) + 1;
  }
  const promoted = (
    await db.query('SELECT promote_planning_run($1,$2) AS ok', [run.id, run.run_no])
  ).rows[0].ok;
  await db.query(
    'UPDATE planning_runs SET status=$2,as_of=$3,summary=$4,finished_at=now() WHERE id=$1',
    [run.id, promoted ? 'completed' : 'superseded', today, JSON.stringify(summary)],
  );
  // Keep the current run and the most recent ones; older results are derived and recomputable.
  await db.query(
    `DELETE FROM planning_results WHERE run_id IN (
       SELECT id FROM planning_runs WHERE status IN ('completed','superseded')
         AND id <> coalesce((SELECT current_run_id FROM planning_state),'00000000-0000-0000-0000-000000000000')
       ORDER BY run_no DESC OFFSET $1)`,
    [KEEP_RUNS],
  );
  return { promoted, summary };
}

export async function failRun(db, runId, message) {
  await db.query(
    "UPDATE planning_runs SET status='failed',error=$2,finished_at=now() WHERE id=$1 AND status='queued'",
    [runId, message],
  );
}

export async function planningStatus(db) {
  const state = (await db.query('SELECT * FROM planning_state')).rows[0] ?? null;
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
  return { current, queued, upToDate: !!current && !queued && !pending, runs };
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
         to_char(r.due_date,'YYYY-MM-DD') AS due_date
       FROM planning_results r JOIN items i ON i.id=r.item_id JOIN units u ON u.id=i.base_unit_id
       LEFT JOIN suppliers s ON s.id=r.supplier_id
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
