// Insert an order (AV-7): the four ways of saying yes, a rush quote, and odd sizes made to order.
// Pure. Reference: Nilkamal simulation handover (21-Sep-2026): v4UrgentSim2() (drum slot
// placement), decisionScenarioPlan() and the dated recommendation, decisionRush(), mtoRoutingMatch()
// and inheritMaterials().
//
// Placement uses the drum's book run nose to tail from tomorrow: each day the drum has capacity
// minus the book's minutes still to run. Every placement is then checked on the full forward
// schedule (all operations and machines) and on time-phased materials.
import { allocate, forwardPass, oidOf, schedulePlant } from './scheduler.mjs';
import { materialReadiness, orderTimes } from './decisions.mjs';

const finDay = (x) => Math.ceil(x - 1e-9);

// The drum's view of the current book (units in sequence): blocks of changeover + run minutes,
// each order's cumulative start and the free minutes per day.
export function drumBook(units, ctx) {
  const drum = ctx.resources.get(ctx.drumId);
  const per = (itemId) =>
    (ctx.routings.get(itemId) ?? [])
      .filter((o) => o.resourceId === ctx.drumId)
      .reduce((s, o) => s + o.perUnit, 0);
  const cap = (drum.machines * ctx.dayMinutes * drum.efficiency) / 100;
  const a = allocate(drum, units, ctx.routings);
  let cum = 0;
  const base = [];
  let last = null;
  for (const u of units) {
    const hit = [...a.assigned].find(([k]) => k.startsWith(u.id + '|'));
    const chg = hit ? hit[1].changeover : 0;
    cum += chg;
    const mins = u.qty * per(u.itemId);
    base.push({ unit: u, cum, mins });
    cum += mins;
    last = u;
  }
  const total = cum;
  const lastDue = Math.max(1, ...units.map((u) => u.orderDueDay ?? u.dueDay));
  const end = Math.max(lastDue, Math.ceil(total / cap)) + 21;
  const free = new Map();
  for (let d = 1; d <= end; d++) {
    const used = Math.min(cap, Math.max(0, total - (d - 1) * cap));
    free.set(d, { used, free: cap - used });
  }
  return {
    cap,
    chg: drum.changeover,
    total,
    base,
    free,
    last,
    bookEndDay: 1 + Math.floor(total / cap),
    per,
  };
}

// The four placements of one or more lines [{ itemId, qty, needDay }] on the drum.
export function placements(lines, book) {
  const { cap, chg, total, base, free, last, bookEndDay, per } = book;
  const T0 = 0;
  const freeOn = (d, used) => (free.has(d) ? free.get(d).free : cap) - (used[d] || 0);
  const rowsFor = (shift) =>
    base.map((b) => {
      const fin0 = T0 + (b.cum + b.mins) / cap,
        fin1 = fin0 + shift / cap;
      const prom = b.unit.orderDueDay ?? b.unit.dueDay;
      return {
        unit: b.unit,
        fin0,
        fin1,
        slip: finDay(fin1) - finDay(fin0),
        late: finDay(fin1) > prom,
        wasLate: finDay(fin0) > prom,
      };
    });
  const unitMin = (l) => l.qty * per(l.itemId);
  const carryOf = (l, lots) => lots.reduce((s, x) => s + x.qty * Math.max(0, l.needDay - x.day), 0);
  const chgFor = (itemId, d) => (d === bookEndDay && last && last.itemId === itemId ? 0 : chg);
  const out = {};
  {
    // Take it whole, now: to the front of the drum.
    let cum = 0,
      added = 0,
      prev = null;
    const ls = lines.map((l) => {
      if (prev !== l.itemId) added += chg;
      cum += (prev !== l.itemId ? chg : 0) + unitMin(l);
      const fin = T0 + cum / cap;
      prev = l.itemId;
      return {
        ...l,
        lots: [{ qty: l.qty, day: finDay(fin) }],
        meetsNeedBy: finDay(fin) <= l.needDay,
      };
    });
    if (base[0] && base[0].unit.itemId !== prev) added += chg;
    const rows = rowsFor(lines.reduce((s, l) => s + unitMin(l), 0) + added);
    const broken = rows.filter((r) => r.late && !r.wasLate);
    out.whole_now = {
      key: 'whole_now',
      label: 'Take it whole, now',
      feasible: true,
      lines: ls,
      chgMinAdded: added,
      carryUnits: ls.reduce((s, l) => s + carryOf(l, l.lots), 0),
      ordersSlipped: rows.filter((r) => r.slip > 0).length,
      promisesBroken: new Set(broken.map((r) => oidOf(r.unit))).size,
    };
  }
  {
    // Whole, in the latest free drum window before the need-by date.
    const used = {};
    let added = 0;
    const reasons = [];
    const ls = lines.map((l) => {
      const need = unitMin(l);
      let placed = null,
        bestFree = 0,
        bestDay = null;
      for (let d = l.needDay; d >= 1; d--) {
        const f = freeOn(d, used);
        if (f > bestFree) {
          bestFree = f;
          bestDay = d;
        }
        const c = chgFor(l.itemId, d);
        if (f >= need + c) {
          placed = { qty: l.qty, day: d };
          used[d] = (used[d] || 0) + need + c;
          added += c;
          break;
        }
      }
      if (!placed)
        reasons.push({ code: 'no_window', need: need + chg, largest: bestFree, day: bestDay });
      return { ...l, lots: placed ? [placed] : [], meetsNeedBy: !!placed };
    });
    out.whole_late = {
      key: 'whole_late',
      label: 'Whole, latest feasible slot',
      feasible: !reasons.length,
      reasons,
      lines: ls,
      chgMinAdded: added,
      carryUnits: ls.reduce((s, l) => s + carryOf(l, l.lots), 0),
      ordersSlipped: 0,
      promisesBroken: 0,
    };
  }
  {
    // Split across free drum windows, walking back from the need-by date, at most two lots.
    const used = {};
    let added = 0;
    const reasons = [];
    const ls = lines.map((l) => {
      let rem = l.qty;
      const lots = [],
        p = per(l.itemId);
      for (let d = l.needDay; d >= 1 && rem > 0 && lots.length < 2; d--) {
        const f = freeOn(d, used);
        const c = chgFor(l.itemId, d);
        const q = Math.min(rem, Math.floor((f - c) / p));
        if (q <= 0) continue;
        lots.push({ qty: q, day: d });
        used[d] = (used[d] || 0) + q * p + c;
        added += c;
        rem -= q;
      }
      if (rem > 0) reasons.push({ code: 'third_lot', placed: l.qty - rem, qty: l.qty });
      lots.sort((a, b) => a.day - b.day);
      return { ...l, lots, meetsNeedBy: rem === 0 };
    });
    out.split = {
      key: 'split',
      label: 'Split across available drum slots',
      feasible: ls.every((l) => l.meetsNeedBy),
      reasons,
      lines: ls,
      chgMinAdded: added,
      carryUnits: ls.reduce((s, l) => s + carryOf(l, l.lots), 0),
      ordersSlipped: 0,
      promisesBroken: 0,
    };
  }
  {
    // Decline, quote the earliest date that displaces nothing.
    const used = {};
    const ls = lines.map((l) => {
      let rem = unitMin(l),
        d = 1,
        first = null;
      while (rem > 0 && d < 1 + 72) {
        const f = freeOn(d, used);
        if (f > 0) {
          const take = Math.min(f, rem + chg);
          if (first === null) first = d;
          used[d] = (used[d] || 0) + take;
          rem -= take - (first === d ? chg : 0);
        }
        if (rem > 0) d++;
      }
      return { ...l, lots: [{ qty: l.qty, day: d }], quoteDay: d, meetsNeedBy: d <= l.needDay };
    });
    out.decline = {
      key: 'decline',
      label: 'Decline, quote a later date',
      feasible: true,
      lines: ls,
      chgMinAdded: 0,
      carryUnits: 0,
      ordersSlipped: 0,
      promisesBroken: 0,
    };
  }
  // Legacy recommendation: no promise broken, need-by met, least changeover then carry.
  const lotCount = (s) => s.lines.reduce((n, l) => n + l.lots.length, 0);
  const noSplit = (s) => (s.key === 'split' && s.lines.every((l) => l.lots.length <= 1) ? 1 : 0);
  const cands = [out.whole_now, out.split, out.whole_late].filter(
    (s) => s.feasible && s.promisesBroken === 0 && s.lines.every((l) => l.meetsNeedBy),
  );
  cands.sort(
    (a, b) =>
      a.chgMinAdded - b.chgMinAdded ||
      a.carryUnits - b.carryUnits ||
      lotCount(a) - lotCount(b) ||
      noSplit(a) - noSplit(b),
  );
  return {
    scenarios: out,
    order: ['whole_now', 'split', 'whole_late', 'decline'],
    rec: cands[0]?.key ?? 'decline',
    total,
  };
}

// Units of a new order from a scenario's lots. Lots of one order share its order id; taking it
// whole now puts it in front of every promise.
export function insertedUnits(orderId, line, lots, { front = false, today, dates }) {
  const multi = lots.length > 1;
  return lots.map((x, i) => ({
    id: multi ? `${orderId}#${i + 1}` : orderId,
    oid: orderId,
    ref: multi ? `${orderId}#${i + 1}` : orderId,
    itemId: line.itemId,
    qty: x.qty,
    dueDate: front ? today : dates[x.day - 1],
    dueDay: front ? 0 : x.day,
    orderDueDay: line.needDay,
    lot: i + 1,
    lots: lots.length,
    lotDay: x.day,
    front,
    noAutoGroup: true,
    ...(line.rushBefore !== undefined ? { rushBefore: line.rushBefore } : {}),
  }));
}

// A placement checked on the full forward schedule and time-phased materials.
// book: { orders (current units), plan, routings, resources, dayMinutes, clubWindowDays };
// rctx: readiness context (boms may include the new item's BOM).
export function evaluatePlacement(s, orderId, book, rctx, { today, dates, baseTimes, baseDrum }) {
  const drumRes = book.resources.get(rctx.drumId);
  const units = s.lines.flatMap((l, i) =>
    insertedUnits(s.lines.length > 1 ? `${orderId}-${i}` : orderId, l, l.lots, {
      front: s.key === 'whole_now',
      today,
      dates,
    }),
  );
  const seq = schedulePlant({ ...book, orders: book.orders.concat(units) }).units;
  const pass = forwardPass({ ...book, sequence: seq });
  const times = orderTimes(pass, book.dayMinutes);
  const materials = materialReadiness(pass, rctx);
  const ids = [...new Set(units.map((u) => u.oid))];
  const reports = ids.map((id) => materials.get(id)).filter(Boolean);
  const gaps = reports.flatMap((m) => m.gaps),
    unknown = reports.flatMap((m) => m.unknown);
  const replenish = [...new Set(reports.flatMap((m) => m.replenishComponents))];
  const status = gaps.length
    ? 'expedite'
    : unknown.length || reports.some((m) => m.missingBom)
      ? 'unknown'
      : replenish.length
        ? 'replenish'
        : 'clear';
  const need = new Map(
    s.lines.map((l, i) => [s.lines.length > 1 ? `${orderId}-${i}` : orderId, l.needDay]),
  );
  const shifted = [...times.values()].filter((n) => {
    const b = baseTimes.get(n.id);
    return b && (Math.abs(n.start - b.start) > 1e-6 || Math.abs(n.finish - b.finish) > 1e-6);
  });
  return {
    ...s,
    orderIds: ids,
    materials: { status, gated: status === 'expedite' || status === 'unknown', reports },
    production: ids.flatMap((id) => times.get(id)?.lots ?? []),
    fullRouteFinish: Math.max(...ids.map((id) => times.get(id)?.ship ?? 0)),
    forwardCarry: ids.reduce(
      (sum, id) =>
        sum +
        (times.get(id)?.lots ?? []).reduce(
          (a, l) => a + l.qty * Math.max(0, need.get(id) - l.finish / book.dayMinutes),
          0,
        ),
      0,
    ),
    forwardChgDelta: allocate(drumRes, seq, book.routings).changeover - baseDrum,
    forwardShifted: shifted.length,
    capacityMeetsPromise: ids.every((id) => times.get(id) && times.get(id).ship <= need.get(id)),
    capacityBroken: [...times.values()]
      .filter((n) => baseTimes.has(n.id) && n.ship > n.prom && n.ship > baseTimes.get(n.id).ship)
      .map((n) => ({ id: n.id, prom: n.prom, was: baseTimes.get(n.id).ship, ship: n.ship })),
    sequence: seq,
  };
}

// The dated insert: placements, each checked forward; the recommended one is the cheapest that
// capacity and materials both support, else the legacy choice with its warnings.
export function simulateInsert(lines, orderId, book, rctx, env) {
  const p = placements(lines, env.drum);
  const scenarios = {};
  for (const key of p.order) {
    const s = p.scenarios[key];
    scenarios[key] =
      s.feasible && s.lines.every((l) => l.lots.length)
        ? evaluatePlacement(s, orderId, book, rctx, env)
        : { ...s, materials: { status: 'unknown', gated: true, reports: [] }, unplaced: true };
    if (key === 'decline' && scenarios[key].fullRouteFinish)
      scenarios[key].lines = scenarios[key].lines.map((l) => ({
        ...l,
        quoteDay: scenarios[key].fullRouteFinish,
      }));
  }
  let rec = p.rec,
    supportedRec = false;
  const fit = p.order
    .filter((k) => k !== 'decline')
    .map((k) => scenarios[k])
    .filter((s) => s.feasible && s.capacityMeetsPromise && !s.capacityBroken?.length);
  const supported = fit.filter((s) => !s.materials.gated);
  if (supported.length) {
    supported.sort((a, b) => a.chgMinAdded - b.chgMinAdded || a.carryUnits - b.carryUnits);
    rec = supported[0].key;
    supportedRec = true;
  }
  return { intent: 'dated', order: p.order, scenarios, rec, supported: supportedRec };
}

// Rush: every insertion position of the current sequence and every day from tomorrow on which a
// component's purchase line is due; the promise is the forward finish.
export function rushInsert(line, orderId, book, rctx, env) {
  const base = env.current;
  const bom = rctx.boms.get(line.itemId) ?? [];
  const days = new Set([1]);
  for (const b of bom)
    for (const p of rctx.supply.get(b.componentId) ?? [])
      if (p.due > rctx.asOf) {
        const d = env.dates.indexOf(p.due) + 1;
        if (d > 0) days.add(d);
      }
  const all = [];
  for (const day of [...days].sort((a, b) => a - b))
    for (let i = 0; i <= base.length; i++) {
      if (i > 0 && oidOf(base[i - 1]) === (base[i] ? oidOf(base[i]) : null)) continue;
      const before = base[i] ? oidOf(base[i]) : null;
      const u = {
        id: orderId,
        oid: orderId,
        ref: orderId,
        itemId: line.itemId,
        qty: line.qty,
        dueDate: env.dates[day - 1],
        dueDay: day,
        orderDueDay: day,
        lotDay: day,
        lot: 1,
        lots: 1,
        front: false,
        rushBefore: before,
      };
      const seq = base.slice();
      seq.splice(i, 0, u);
      const pass = forwardPass({ ...book, sequence: seq });
      const times = orderTimes(pass, book.dayMinutes);
      const t = times.get(orderId);
      const promise = t.ship;
      const mats = materialReadiness(pass, rctx).get(orderId);
      const shifted = [...times.values()].filter((n) => {
        const b = env.baseTimes.get(n.id);
        return b && (Math.abs(n.start - b.start) > 1e-6 || Math.abs(n.finish - b.finish) > 1e-6);
      });
      const broken = shifted
        .filter((n) => n.ship > n.prom && n.ship > env.baseTimes.get(n.id).ship)
        .map((n) => ({ id: n.id, prom: n.prom, was: env.baseTimes.get(n.id).ship, ship: n.ship }));
      all.push({
        key: `rush_${day}_${i}`,
        day,
        rushBefore: before,
        quoteDay: promise,
        lines: [{ ...line, needDay: promise, lots: [{ qty: line.qty, day }], meetsNeedBy: true }],
        materials: { status: mats.status, gated: mats.gated, reports: [mats] },
        production: t.lots,
        ordersSlipped: shifted.length,
        promisesBroken: broken.length,
        broken,
        chgMinAdded:
          allocate(book.resources.get(rctx.drumId), seq, book.routings).changeover - env.baseDrum,
        carryUnits: line.qty * Math.max(0, promise - t.finish / book.dayMinutes),
        finish: t.finish,
        fullRouteFinish: promise,
        sequence: seq,
      });
    }
  const rank = (a, b) =>
    a.quoteDay - b.quoteDay ||
    a.promisesBroken - b.promisesBroken ||
    a.chgMinAdded - b.chgMinAdded ||
    a.carryUnits - b.carryUnits ||
    a.finish - b.finish;
  const safe = all.filter((x) => !x.materials.gated),
    pool = safe.length ? safe : all;
  const noBreak = pool.filter((x) => !x.promisesBroken);
  const rec = (noBreak.length ? noBreak : pool).slice().sort(rank)[0];
  const selected = [];
  const add = (x, label) => {
    if (!x) return;
    const same = selected.some(
      (y) =>
        y.quoteDay === x.quoteDay &&
        y.materials.status === x.materials.status &&
        y.promisesBroken === x.promisesBroken &&
        y.chgMinAdded === x.chgMinAdded,
    );
    if (!same) selected.push({ ...x, label });
  };
  add(rec, safe.length ? 'Earliest supported promise' : 'Earliest conditional quote');
  add(all.slice().sort(rank)[0], 'Earliest capacity / impact trade-off');
  add(all.filter((x) => !x.promisesBroken).sort(rank)[0], 'Protect existing promises');
  add(safe.slice().sort(rank)[0], 'Wait for supported material receipt');
  return {
    intent: 'rush',
    evaluated: all.length,
    order: selected.map((x) => x.key),
    scenarios: Object.fromEntries(selected.map((x) => [x.key, x])),
    rec: rec.key,
    supported: safe.length > 0,
  };
}

// ---------- Odd sizes, made to order ----------

// Size of a standard from its code: the last five digits are length, width (inches) and thickness.
export const sizeOfCode = (code) => {
  const z = String(code).match(/(\d\d)(\d\d)(\d)$/);
  return z ? [+z[1], +z[2], +z[3]] : null;
};

// Picks the nearest standard of the family (same thickness first, then closest area) and scales
// its routing: area operations by the area ratio, the others as they are.
// candidates: [{ itemId, code }] routed standards with a BOM; size: [L, W, H] inches.
export function matchOddSize(family, size, candidates, routings, areaOps) {
  const [L, W, H] = size;
  const withSize = candidates
    .filter((c) => c.code.startsWith(family) && sizeOfCode(c.code))
    .map((c) => {
      const s = sizeOfCode(c.code);
      return { ...c, s, dh: Math.abs(s[2] - H), da: Math.abs(s[0] * s[1] - L * W) };
    });
  if (!withSize.length) return { ok: false, reason: 'no_standard' };
  const minDh = Math.min(...withSize.map((x) => x.dh));
  const pick = withSize
    .filter((x) => x.dh === minDh)
    .sort((a, b) => a.da - b.da || a.code.localeCompare(b.code))[0];
  const scale = (L * W) / (pick.s[0] * pick.s[1]);
  const ops = (routings.get(pick.itemId) ?? []).map((op) => ({
    ...op,
    perUnit: +(areaOps.includes(op.code) ? op.perUnit * scale : op.perUnit).toFixed(3),
  }));
  return {
    ok: true,
    source: pick,
    sourceSize: pick.s,
    scale,
    exactThickness: pick.dh === 0,
    ops,
    candidates: withSize.length,
  };
}

// The odd size's BOM from the matched standard: metres by area, pieces as they are, weight and
// volume by volume. lines: [{ componentId, qty, unit }].
export function inheritBom(lines, sourceSize, size) {
  const area = (size[0] * size[1]) / (sourceSize[0] * sourceSize[1]);
  const volume = (size[0] * size[1] * size[2]) / (sourceSize[0] * sourceSize[1] * sourceSize[2]);
  const bad = lines.find(
    (l) => !['M', 'M2', 'KG', 'KGS', 'L', 'NOS'].includes(String(l.unit).toUpperCase()),
  );
  if (bad) return { ok: false, reason: 'unknown_unit', line: bad };
  return {
    ok: true,
    area,
    volume,
    lines: lines.map((l) => {
      const u = String(l.unit).toUpperCase();
      const factor = u === 'M' || u === 'M2' ? area : u === 'NOS' ? 1 : volume;
      return { ...l, sourceQty: l.qty, qty: l.qty * factor, factor };
    }),
  };
}
