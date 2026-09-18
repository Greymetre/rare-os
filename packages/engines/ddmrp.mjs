// Demand-driven material buffers (AV-4). Pure arithmetic: the planning run loads the inputs and
// stores what this returns. Quantities are base-unit numbers; results are rounded to 6 decimals.
//
// Zones (06_DERIVATION_ENGINES.md section 3/4, standard DDMRP):
//   yellow = ADU x DLT
//   red    = yellow x red_base% x (1 + red_safety%)
//   green  = max(yellow x green%, ADU x order cycle, MOQ)
//   TOG    = red + yellow + green
//   NFP    = on hand + open supply - qualified demand
//   zone   = NFP <= 0 breach | <= top of red | <= top of yellow | <= TOG green | above TOG excess

const EPS = 1e-9;
export const round6 = (n) => Math.round(n * 1e6) / 1e6;
const addDays = (day, n) => {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

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

export function zoneOf(nfp, zones) {
  if (nfp <= EPS) return 'breach';
  if (nfp <= zones.topOfRed + EPS) return 'red';
  if (nfp <= zones.topOfYellow + EPS) return 'yellow';
  if (nfp <= zones.topOfGreen + EPS) return 'green';
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

// usage: Map(parentId -> [{ componentId, qtyPer }]); qtyPer is per one base unit of the parent.
// Returns effective ADU per item: its own ADU plus what its parents consume, all the way down.
export function effectiveAdu(direct, usage, overrides = new Map()) {
  const parentsOf = new Map();
  for (const [parent, lines] of usage)
    for (const l of lines) {
      if (!parentsOf.has(l.componentId)) parentsOf.set(l.componentId, []);
      parentsOf.get(l.componentId).push({ parent, qtyPer: l.qtyPer });
    }
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

// Plans one plant.
// input: {
//   today, settings: [{ itemId, code, policy: 'BUFFER'|'MTO', profile, leadTimeDays, decimals,
//                       makeBuy, source?: { moq, multiple, factor, unit, leadTimeDays, supplierId } }],
//   adu: Map(itemId -> effective ADU), usage (as above, stops nothing), onHand: Map, supply: Map,
//   demand: [{ itemId, due, qty }] open customer order lines
// }
export function planPlant(input) {
  const { today, settings, adu, usage, onHand, supply, demand } = input;
  const byItem = new Map(settings.map((s) => [s.itemId, s]));
  const buffered = (id) => byItem.get(id)?.policy === 'BUFFER';
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
      zones: null,
      nfp: null,
      zone: null,
      priority: null,
      recommended: null,
      onHandAlert: null,
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
    if (!(row.adu > 0))
      messages.push('No usage in the demand window: import demand history or set an ADU override.');
    if (messages.length) {
      row.status = 'missing';
      continue;
    }
    row.dlt = dlt;
    const moqBase = s.makeBuy === 'BUY' && s.source ? s.source.moq * s.source.factor : 0;
    row.zones = bufferZones({ adu: row.adu, dlt, profile: s.profile, moq: moqBase });
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

  for (const row of rows.values()) {
    if (row.status !== 'planned') continue;
    const s = byItem.get(row.itemId);
    row.qualifiedDemand = round6(row.qualifiedDemand);
    row.spikeDemand = round6(row.spikeDemand);
    row.outsideHorizon = round6(row.outsideHorizon);
    row.nfp = round6(row.onHand + row.openSupply - row.qualifiedDemand);
    row.zone = zoneOf(row.nfp, row.zones);
    row.priority = row.zones.topOfGreen > 0 ? round6((row.nfp / row.zones.topOfGreen) * 100) : null;
    row.onHandAlert =
      row.onHand <= EPS ? 'stockout' : row.onHand < row.zones.topOfRed - EPS ? 'low' : null;
    if (row.nfp <= row.zones.topOfYellow + EPS) {
      const need = row.zones.topOfGreen - row.nfp;
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
          due: addDays(today, row.dlt),
        };
      } else {
        row.recommended = {
          kind: s.makeBuy === 'BUY' ? 'BUY' : 'MAKE',
          qty: orderQuantity(need, { decimals: s.decimals ?? 6 }),
          due: addDays(today, row.dlt),
        };
        if (s.makeBuy === 'BUY')
          row.messages.push('No preferred supplier: the order quantity ignores MOQ and multiples.');
      }
    }
  }
  return [...rows.values()];
}

// A result may replace the current one only if it was calculated from the same or newer inputs.
export function supersedes(currentVersion, runVersion) {
  return currentVersion === null || currentVersion === undefined || runVersion >= currentVersion;
}
