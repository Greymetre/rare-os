// Demand-driven material buffers (AV-4). Pure arithmetic: the planning run loads the inputs and
// stores what this returns. Quantities are base-unit numbers; results are rounded to 6 decimals.
//
// STANDARD zones (06_DERIVATION_ENGINES.md section 3/4, standard DDMRP):
//   yellow = ADU x DLT
//   red    = yellow x red_base% x (1 + red_safety%)
//   green  = max(yellow x green%, ADU x order cycle, MOQ)
//   TOG    = red + yellow + green
//   NFP    = on hand + open supply - qualified demand
//   zone   = NFP <= 0 breach | <= top of red | <= top of yellow | <= TOG green | above TOG excess
//
// WEEKLY zones (the Nilkamal method, Nilkamal simulation handover 21-Sep-2026, BUILD_NOTE "Buffer
// and demand calculation"). Demand is read up to the latest history date, not today:
//   weekly mean = mean of the last zone_weeks Monday weeks (the last week may be partial)
//   CV          = population std / mean of the last cv_weeks 7-day blocks, to 3 decimals
//   safety      = 30% below CV 0.5, 50% below CV 1.0, otherwise 70%
//   DLT weeks   = lead time days / 7, rounded, at least 1
//   yellow = weekly mean x DLT weeks; red = yellow x red_base% x (1 + safety);
//   green  = weekly mean x order cycle days / 7 (one week when not set)
//   Tops are kept to 0.1 and planned in whole units. Nothing above TOG is called excess.
//   Made items: ADU = weekly mean / 7 (3 decimals); qualified demand includes ADU x lead time.
//   A made item's recommendation beyond its open production orders is demand on its components.
//   A buffered item without any stock record has an unknown position, never zero.
// Open production orders are demand on their components in both methods.

const EPS = 1e-9;
export const round6 = (n) => Math.round(n * 1e6) / 1e6;
const round1 = (n) => Math.round(n * 10) / 10;
const round3 = (n) => Math.round(n * 1000) / 1000;
const addDays = (day, n) => {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const MAX_DRIVERS = 50;

export function bufferZones({ adu, dlt, profile, moq = 0 }) {
  const yellow = adu * dlt;
  const red = yellow * (profile.red_base_pct / 100) * (1 + (profile.red_safety_pct ?? 0) / 100);
  const green = Math.max(
    yellow * (profile.green_pct / 100),
    adu * (profile.order_cycle_days ?? 0),
    moq,
  );
  return {
    red: round6(red),
    yellow: round6(yellow),
    green: round6(green),
    topOfRed: round6(red),
    topOfYellow: round6(red + yellow),
    topOfGreen: round6(red + yellow + green),
  };
}

export const cvSafetyPct = (cv) => (cv < 0.5 ? 30 : cv < 1 ? 50 : 70);

// weeks: the last zone_weeks Monday-week totals; blocks: the last cv_weeks 7-day totals.
export function weeklyZones({ weeks, blocks, leadTimeDays, profile }) {
  const mean = weeks.reduce((a, b) => a + b, 0) / weeks.length;
  const blockMean = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const variance = blocks.reduce((a, b) => a + (b - blockMean) ** 2, 0) / blocks.length;
  const cv = blockMean > EPS ? round3(Math.sqrt(variance) / blockMean) : 0;
  const safety = cvSafetyPct(cv);
  const dltWeeks = Math.max(1, Math.round(leadTimeDays / 7));
  const yellow = mean * dltWeeks;
  const red = yellow * (profile.red_base_pct / 100) * (1 + safety / 100);
  const green = (mean * (profile.order_cycle_days ?? 7)) / 7;
  const top = (x) => Math.round(round1(x));
  return {
    weeklyMean: mean,
    cv,
    safety,
    zoneDays: dltWeeks * 7,
    red: round6(red),
    yellow: round6(yellow),
    green: round6(green),
    topOfRed: top(red),
    topOfYellow: top(red + yellow),
    topOfGreen: top(red + yellow + green),
  };
}

export function zoneOf(nfp, zones, { excess = true } = {}) {
  if (nfp <= EPS) return 'breach';
  if (nfp <= zones.topOfRed + EPS) return 'red';
  if (nfp <= zones.topOfYellow + EPS) return 'yellow';
  if (!excess || nfp <= zones.topOfGreen + EPS) return 'green';
  return 'excess';
}

// Smallest quantity >= need that is at least MOQ and a whole number of order multiples.
export function orderQuantity(need, { moq = 0, multiple = 0, decimals = 6 } = {}) {
  if (need <= EPS) return 0;
  let q = Math.max(need, moq);
  if (multiple > 0) q = Math.ceil(q / multiple - EPS) * multiple;
  const step = 10 ** decimals;
  return round6(Math.ceil(q * step - EPS) / step);
}

function parentsOfUsage(usage) {
  const parentsOf = new Map();
  for (const [parent, lines] of usage)
    for (const l of lines) {
      if (!parentsOf.has(l.componentId)) parentsOf.set(l.componentId, []);
      parentsOf.get(l.componentId).push({ parent, qtyPer: l.qtyPer });
    }
  return parentsOf;
}

// usage: Map(parentId -> [{ componentId, qtyPer }]); qtyPer is per one base unit of the parent.
// Returns effective ADU per item: its own ADU plus what its parents consume, all the way down.
export function effectiveAdu(direct, usage, overrides = new Map()) {
  const parentsOf = parentsOfUsage(usage);
  const memo = new Map();
  const visit = (id, path = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (overrides.has(id)) {
      memo.set(id, overrides.get(id));
      return overrides.get(id);
    }
    if (path.has(id)) return 0; // BOM loops are refused on save; never recurse forever
    path.add(id);
    let total = direct.get(id) ?? 0;
    for (const p of parentsOf.get(id) ?? []) total += visit(p.parent, path) * p.qtyPer;
    path.delete(id);
    memo.set(id, total);
    return total;
  };
  const ids = new Set([
    ...direct.keys(),
    ...parentsOf.keys(),
    ...usage.keys(),
    ...overrides.keys(),
  ]);
  for (const id of ids) visit(id);
  return memo;
}

// The same explosion for demand series of equal length (weekly totals): each item's own series
// plus its parents' series times the quantity per parent, all the way down.
export function effectiveSeries(direct, usage, length) {
  const parentsOf = parentsOfUsage(usage);
  const memo = new Map();
  const zero = () => new Array(length).fill(0);
  const visit = (id, path = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    if (path.has(id)) return zero();
    path.add(id);
    const total = [...(direct.get(id) ?? zero())];
    for (const p of parentsOf.get(id) ?? []) {
      const s = visit(p.parent, path);
      for (let i = 0; i < length; i++) total[i] += s[i] * p.qtyPer;
    }
    path.delete(id);
    memo.set(id, total);
    return total;
  };
  for (const id of new Set([...direct.keys(), ...parentsOf.keys(), ...usage.keys()])) visit(id);
  return memo;
}

// Items ordered so every parent comes before its components (BOM loops are refused on save).
function bomOrder(ids, usage) {
  const depth = new Map();
  const parentsOf = parentsOfUsage(usage);
  const visit = (id, path = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (path.has(id)) return 0;
    path.add(id);
    let d = 0;
    for (const p of parentsOf.get(id) ?? []) d = Math.max(d, visit(p.parent, path) + 1);
    path.delete(id);
    depth.set(id, d);
    return d;
  };
  return [...ids].sort((a, b) => visit(a) - visit(b));
}

// Plans one plant.
// input: {
//   today, settings: [{ itemId, code, policy: 'BUFFER'|'MTO', profile, leadTimeDays, decimals,
//                       makeBuy, source?: { moq, multiple, factor, unit, leadTimeDays, supplierId } }],
//   adu: Map(itemId -> effective ADU), usage (as above, stops nothing), onHand: Map, supply: Map,
//   demand: [{ itemId, due, qty }] open customer order lines,
//   productionOrders?: [{ ref, itemId, code, due, qty }] open production orders,
//   series?: Map(itemId -> { weeks, blocks }) effective weekly demand for WEEKLY profiles,
//   stockKnown?: Set(itemId) items with a stock record (WEEKLY: others have no known position),
//   leadTimes?: Map(itemId -> { days, factor, unbounded }) made items' lead time at planned loading
// }
export function planPlant(input) {
  const { today, settings, adu, usage, onHand, supply, demand } = input;
  const productionOrders = input.productionOrders ?? [];
  const byItem = new Map(settings.map((s) => [s.itemId, s]));
  const buffered = (id) => byItem.get(id)?.policy === 'BUFFER';
  const weekly = (s) => s?.policy === 'BUFFER' && s.profile?.method === 'WEEKLY';
  const rows = new Map();
  for (const s of settings) {
    const messages = [];
    const row = {
      itemId: s.itemId,
      policy: s.policy,
      status: 'planned',
      adu: round6(adu.get(s.itemId) ?? 0),
      dlt: null,
      onHand: round6(onHand.get(s.itemId) ?? 0),
      openSupply: round6(supply.get(s.itemId) ?? 0),
      qualifiedDemand: 0,
      spikeDemand: 0,
      outsideHorizon: 0,
      leadTimeDemand: 0,
      leadTimeLive: null,
      leadTimeFactor: null,
      productionDemand: 0,
      plannedMakeDemand: 0,
      zones: null,
      zoneAdu: null,
      zoneDays: null,
      cv: null,
      safetyPct: null,
      nfp: null,
      zone: null,
      priority: null,
      recommended: null,
      onHandAlert: null,
      requiredDate: null,
      drivers: [],
      messages,
    };
    rows.set(s.itemId, row);
    if (s.policy !== 'BUFFER') {
      row.status = 'not_applicable';
      messages.push('Made or bought to order: no buffer; demand passes to its components.');
      continue;
    }
    const dlt = s.leadTimeDays ?? (s.makeBuy === 'BUY' ? (s.source?.leadTimeDays ?? null) : null);
    if (dlt === null)
      messages.push(
        s.makeBuy === 'BUY'
          ? 'No lead time: add a preferred supplier or a lead time in the buffer setting.'
          : 'No manufacturing lead time: set the lead time in the buffer setting.',
      );
    const series = weekly(s) ? input.series?.get(s.itemId) : null;
    let zones = null;
    if (weekly(s) && dlt !== null && series && s.aduOverride == null) {
      zones = weeklyZones({ ...series, leadTimeDays: dlt, profile: s.profile });
      if (s.makeBuy === 'MAKE') row.adu = round3(zones.weeklyMean / 7);
    }
    if (!(row.adu > 0))
      messages.push('No usage in the demand window: import demand history or set an ADU override.');
    if (weekly(s) && input.stockKnown && !input.stockKnown.has(s.itemId))
      messages.push(
        'No stock position: this item has no stock record, so its buffer cannot be checked. Post its opening stock (zero if it is really empty).',
      );
    if (messages.length) {
      row.status = 'missing';
      continue;
    }
    row.dlt = dlt;
    if (weekly(s)) {
      if (!zones) {
        // ADU override: the override is the weekly mean / 7 and variability is unknown (CV 0).
        const flat = new Array(s.profile.zone_weeks ?? 13).fill(row.adu * 7);
        zones = weeklyZones({ weeks: flat, blocks: flat, leadTimeDays: dlt, profile: s.profile });
      }
      row.zones = zones;
      row.zoneAdu = round6(zones.weeklyMean / 7);
      row.zoneDays = zones.zoneDays;
      row.cv = zones.cv;
      row.safetyPct = zones.safety;
      if (s.makeBuy === 'MAKE') {
        row.leadTimeDemand = round1(row.adu * dlt);
        row.qualifiedDemand += row.leadTimeDemand;
      }
    } else {
      const moqBase = s.makeBuy === 'BUY' && s.source ? s.source.moq * s.source.factor : 0;
      row.zones = bufferZones({ adu: row.adu, dlt, profile: s.profile, moq: moqBase });
      row.zoneAdu = row.adu;
      row.zoneDays = dlt;
    }
    // Made items at the plant's planned loading: zones scale with lead time plus queue (AV-6).
    const live = s.makeBuy === 'MAKE' ? input.leadTimes?.get(s.itemId) : null;
    row.leadTimeLive = dlt;
    if (live?.unbounded)
      row.messages.push(
        'Lead time is unbounded at the planned loading (a routed resource is at 95% or more): zones stay on the master lead time.',
      );
    else if (live?.factor) {
      const scale = (x) => (weekly(s) ? Math.round(x * live.factor) : round6(x * live.factor));
      row.zones = {
        ...row.zones,
        topOfRed: scale(row.zones.topOfRed),
        topOfYellow: scale(row.zones.topOfYellow),
        topOfGreen: scale(row.zones.topOfGreen),
      };
      row.leadTimeLive = live.days;
      row.leadTimeFactor = live.factor;
    }
  }

  // Direct demand: past due and today always qualify; later lines inside the lead-time horizon
  // qualify as a spike when that day's total reaches the spike threshold.
  const qualify = (row, qty, spike) => {
    row.qualifiedDemand += qty;
    if (spike) row.spikeDemand += qty;
  };
  const byItemDay = new Map();
  for (const d of demand) {
    const key = d.itemId + '|' + d.due;
    byItemDay.set(key, (byItemDay.get(key) ?? 0) + d.qty);
  }
  const explode = []; // parent demand passed to components: [{ itemId, due, qty }]
  for (const d of demand) {
    const row = rows.get(d.itemId);
    if (!buffered(d.itemId)) {
      explode.push(d);
      continue;
    }
    if (row.status !== 'planned') continue;
    if (d.due <= today) qualify(row, d.qty, false);
    else if (d.due <= addDays(today, row.dlt)) {
      const threshold =
        row.zones.topOfRed * ((byItem.get(d.itemId).profile.spike_threshold_pct ?? 50) / 100);
      if (byItemDay.get(d.itemId + '|' + d.due) >= threshold - EPS) {
        qualify(row, d.qty, true);
        explode.push(d); // a spike beyond the buffer is made now, so its components are needed now
      }
    }
  }
  // Dependent demand stops at the next buffered item (the decoupling point).
  const pending = [...explode];
  while (pending.length) {
    const d = pending.pop();
    for (const l of usage.get(d.itemId) ?? []) {
      const need = d.qty * l.qtyPer;
      if (!buffered(l.componentId)) {
        pending.push({ itemId: l.componentId, due: d.due, qty: need });
        continue;
      }
      const row = rows.get(l.componentId);
      if (row.status !== 'planned') continue;
      if (d.due <= addDays(today, row.dlt)) qualify(row, need, d.due > today);
      else row.outsideHorizon += need;
    }
  }

  // Production demand (open production orders, and WEEKLY made-item recommendations beyond them)
  // passes through unbuffered items and qualifies at the next buffer inside its lead time.
  const consume = (source, field) => {
    const stack = [{ itemId: source.itemId, qty: source.qty }];
    while (stack.length) {
      const d = stack.pop();
      for (const l of usage.get(d.itemId) ?? []) {
        const qty = d.qty * l.qtyPer;
        if (!buffered(l.componentId)) {
          stack.push({ itemId: l.componentId, qty });
          continue;
        }
        const row = rows.get(l.componentId);
        if (row.status !== 'planned') continue;
        if (source.due > addDays(today, row.dlt)) {
          row.outsideHorizon += qty;
          continue;
        }
        row.qualifiedDemand += qty;
        row[field] += qty;
        let driver = row.drivers.find((x) => x.kind === source.kind && x.ref === source.ref);
        if (!driver) {
          driver = {
            kind: source.kind,
            ref: source.ref,
            itemId: source.itemId,
            item: source.code ?? null,
            qty: 0,
            need: source.due,
            requiredDate: addDays(source.due, -row.dlt),
          };
          row.drivers.push(driver);
        }
        driver.qty += qty;
      }
    }
  };
  const scheduled = new Map();
  for (const o of productionOrders) {
    scheduled.set(o.itemId, (scheduled.get(o.itemId) ?? 0) + o.qty);
    consume({ ...o, kind: 'production' }, 'productionDemand');
  }
  // Standard DDMRP counts open production orders as supply of the item they make. In the WEEKLY
  // method they are netted against the item's recommendation instead (see below).
  for (const [itemId, qty] of scheduled) {
    const row = rows.get(itemId);
    if (row && row.status === 'planned' && !weekly(byItem.get(itemId))) row.openSupply += qty;
  }

  // Finish parents before their components: a made item's recommendation adds component demand.
  for (const itemId of bomOrder(rows.keys(), usage)) {
    const row = rows.get(itemId);
    if (row.status !== 'planned') continue;
    const s = byItem.get(row.itemId);
    const isWeekly = weekly(s);
    row.qualifiedDemand = round6(row.qualifiedDemand);
    row.spikeDemand = round6(row.spikeDemand);
    row.outsideHorizon = round6(row.outsideHorizon);
    row.productionDemand = round6(row.productionDemand);
    row.plannedMakeDemand = round6(row.plannedMakeDemand);
    row.openSupply = round6(row.openSupply);
    row.nfp = round6(row.onHand + row.openSupply - row.qualifiedDemand);
    row.zone = zoneOf(row.nfp, row.zones, { excess: !isWeekly });
    row.priority = row.zones.topOfGreen > 0 ? round6((row.nfp / row.zones.topOfGreen) * 100) : null;
    row.onHandAlert =
      row.onHand <= EPS ? 'stockout' : row.onHand < row.zones.topOfRed - EPS ? 'low' : null;
    row.drivers.sort((a, b) => (a.need < b.need ? -1 : a.need > b.need ? 1 : 0));
    for (const d of row.drivers) d.qty = round6(d.qty);
    if (row.drivers.length)
      row.requiredDate = row.drivers.reduce(
        (min, d) => (d.requiredDate < min ? d.requiredDate : min),
        row.drivers[0].requiredDate,
      );
    if (row.drivers.length > MAX_DRIVERS) {
      row.messages.push(
        `${row.drivers.length} parent orders drive this demand; the ${MAX_DRIVERS} earliest are listed.`,
      );
      row.drivers = row.drivers.slice(0, MAX_DRIVERS);
    }
    if (row.nfp > row.zones.topOfYellow + EPS) continue;
    const need = row.zones.topOfGreen - row.nfp;
    // A bought component is due when its earliest parent needs it, less its lead time.
    const due =
      isWeekly && row.requiredDate
        ? row.requiredDate < today
          ? today
          : row.requiredDate
        : addDays(today, row.dlt);
    if (isWeekly && row.requiredDate && row.requiredDate < today)
      row.messages.push(
        `Needed by ${row.requiredDate} (earliest parent need less the ${row.dlt}-day lead time); that date has passed.`,
      );
    if (s.makeBuy === 'BUY' && s.source) {
      const purchase = orderQuantity(need / s.source.factor, {
        moq: s.source.moq,
        multiple: s.source.multiple,
        decimals: s.source.decimals ?? 6,
      });
      row.recommended = {
        kind: 'BUY',
        qty: round6(purchase * s.source.factor),
        purchaseQty: purchase,
        purchaseUnit: s.source.unit,
        supplierId: s.source.supplierId,
        due,
      };
      continue;
    }
    let qty = orderQuantity(need, { decimals: s.decimals ?? 6 });
    const multiple = s.profile.order_multiple ?? null;
    if (isWeekly && multiple) {
      const moq = s.profile.moq_adu_days
        ? Math.max(multiple, Math.round((row.adu * s.profile.moq_adu_days) / multiple) * multiple)
        : 0;
      // Red and breach are sized to the order multiple; yellow is a cycle top-up in whole units.
      qty =
        row.zone === 'yellow'
          ? Math.max(moq, Math.round(need))
          : Math.max(moq, Math.ceil(need / multiple - EPS) * multiple);
    }
    row.recommended = { kind: s.makeBuy === 'BUY' ? 'BUY' : 'MAKE', qty: round6(qty), due };
    if (s.makeBuy === 'BUY')
      row.messages.push('No preferred supplier: the order quantity ignores MOQ and multiples.');
    if (isWeekly && s.makeBuy === 'MAKE') {
      const extra = qty - (scheduled.get(row.itemId) ?? 0);
      if (extra > EPS)
        consume(
          {
            kind: 'planned',
            ref: s.code ?? row.itemId,
            itemId: row.itemId,
            code: s.code,
            qty: extra,
            due: addDays(today, Math.max(1, Math.ceil(row.leadTimeLive - 1e-9))),
          },
          'plannedMakeDemand',
        );
    }
  }
  return [...rows.values()];
}

// A result may replace the current one only if it was calculated from the same or newer inputs.
export function supersedes(currentVersion, runVersion) {
  return currentVersion === null || currentVersion === undefined || runVersion >= currentVersion;
}
