// Planning tools (AV-11): the questions a planner asks before the plan is fixed — how the month's
// shape sits against the constraint, what level production would cost in stock, which items deserve
// a buffer at all, and what a service level would take. Pure. Reference: Nilkamal simulation
// handover (21-Sep-2026): Month Shape, Buffer vs MTO and Recommended Buffers.

const EPS = 1e-9;
// Expected shortfall of a standard normal beyond z, in standard deviations (unit normal loss).
const normalLoss = (z) => {
  const phi = Math.exp(-(z * z) / 2) / Math.sqrt(2 * Math.PI);
  // Zelen & Severo's approximation of the normal tail.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = z >= 0 ? phi * poly : 1 - phi * poly;
  return phi - z * tail;
};
const round1 = (n) => +n.toFixed(1);
const sum = (list) => list.reduce((a, b) => a + b, 0);
const mean = (list) => (list.length ? sum(list) / list.length : 0);
export const stdDev = (list) => {
  if (list.length < 2) return 0;
  const m = mean(list);
  return Math.sqrt(sum(list.map((x) => (x - m) ** 2)) / list.length);
};

// ---------- The month's shape against the constraint ----------

// A month of work spread by the despatch profile, against what the constraint can do in a day.
// weights: 31 shares of the month (percent); monthMinutes: the constraint's work in a month;
// capacityPerDay: its working minutes in a day.
export function monthShape(weights, monthMinutes, capacityPerDay) {
  const days = (weights ?? []).map((pct, i) => {
    const required = (monthMinutes * pct) / 100;
    return {
      day: i + 1,
      pct,
      required,
      over: Math.max(0, required - capacityPerDay),
      spare: Math.max(0, capacityPerDay - required),
    };
  });
  const over = sum(days.map((d) => d.over));
  // What the quiet days before the surge could take off the peak.
  const early = days.slice(0, Math.round(days.length * 0.65));
  const prebuildable = Math.min(over, sum(early.map((d) => d.spare)));
  return {
    days,
    capacityPerDay,
    monthMinutes,
    over,
    prebuildable,
    peakDay: days.reduce((a, d) => (d.required > a.required ? d : a), days[0] ?? null)?.day ?? null,
    lastThird: round1(sum(days.slice(Math.round((days.length * 2) / 3)).map((d) => d.pct))),
  };
}

// Level production against that shape: the same work every day, and the stock it has to carry.
// The trajectory is the running difference between what is made and what is despatched.
export function levelLoad(weights, monthUnits) {
  const n = (weights ?? []).length;
  if (!n) return null;
  const level = 100 / n;
  let cum = 0,
    peak = 0,
    peakDay = 1;
  const days = weights.map((pct, i) => {
    cum += level - pct;
    if (cum > peak) {
      peak = cum;
      peakDay = i + 1;
    }
    return { day: i + 1, pct, sharePercent: round1(cum) };
  });
  const units = (share) => Math.round((share / 100) * monthUnits);
  return {
    levelPercent: round1(level),
    days: days.map((d) => ({ ...d, stock: units(d.sharePercent) })),
    peakDay,
    peakUnits: units(peak),
    endUnits: units(days[n - 1].sharePercent),
    daysOfDemand: monthUnits > 0 ? round1((units(peak) / monthUnits) * n) : 0,
  };
}

// ---------- Buffer or made to order ----------

// Runners are ordered often and steadily: they earn a buffer. Strangers are rare or wildly
// uneven: making them to order costs less than holding them. weeks: demand per week (most recent
// last); options are the policy thresholds.
export function bufferVsMto(
  { itemId, code, weeks, leadTimeDays, unitCost = null, policy = null },
  { minOrdersPerYear = 12, maxVariability = 1.0, weeksInYear = 52 } = {},
) {
  const active = weeks.filter((w) => w > EPS);
  const weekly = mean(weeks);
  const ordersPerYear = weeks.length ? Math.round((active.length / weeks.length) * weeksInYear) : 0;
  const variability = weekly > EPS ? stdDev(weeks) / weekly : null;
  const steady = variability !== null && variability <= maxVariability;
  const often = ordersPerYear >= minOrdersPerYear;
  const recommend = often && steady ? 'BUFFER' : 'MTO';
  // A buffered item holds about its lead time plus a cycle; a made-to-order one holds nothing.
  const cover = recommend === 'BUFFER' ? (weekly / 7) * (leadTimeDays ?? 0) : 0;
  return {
    itemId,
    code,
    ordersPerYear,
    weeklyDemand: round1(weekly),
    variability: variability === null ? null : round1(variability),
    steady,
    often,
    recommend,
    policy,
    change: policy !== null && policy !== recommend,
    coverUnits: Math.round(cover),
    coverValue: unitCost === null ? null : Math.round(cover * unitCost),
    reason: often
      ? steady
        ? `Ordered in ${ordersPerYear} weeks of the year and steady: a buffer pays for itself.`
        : `Ordered often but uneven (variability ${round1(variability)}): a buffer would be mostly cushion.`
      : `Ordered in only ${ordersPerYear} weeks of the year: make it to order and hold a week of cover.`,
  };
}

// ---------- Recommended buffers (service simulation) ----------

// What a service level would take for one item: the zones that reach it, and the fill they buy.
// A higher service level asks for more safety, which is red; the cycle stock is the green zone.
// weeks: demand per week; service: the share of demand to meet from stock (0..1).
export function serviceSimulation(
  { itemId, code, weeks, leadTimeDays, orderCycleDays = 7, unitCost = null },
  service = 0.9,
) {
  const weekly = mean(weeks);
  const adu = weekly / 7;
  const sigma = stdDev(weeks) / 7;
  const dlt = Math.max(1, leadTimeDays ?? 1);
  // The safety a normal distribution needs for this service level over the lead time.
  const z = { 0.85: 1.04, 0.9: 1.28, 0.95: 1.65, 0.98: 2.05, 0.99: 2.33 }[service] ?? 1.28;
  const safety = z * sigma * Math.sqrt(dlt);
  const yellow = adu * dlt;
  const red = safety;
  const green = Math.max(adu * orderCycleDays, adu * dlt * 0.5);
  const top = red + yellow + green;
  const average = red + green / 2;
  // The share of demand served from stock: one order cycle short by the expected shortfall over the
  // lead time (the standard normal loss function at this safety).
  const sigmaLt = sigma * Math.sqrt(dlt);
  const shortfall = sigmaLt <= EPS ? 0 : sigmaLt * normalLoss(z);
  const fill = green <= EPS ? (shortfall <= EPS ? 1 : 0) : Math.max(0, 1 - shortfall / green);
  return {
    itemId,
    code,
    service,
    adu: round1(adu),
    variability: adu > EPS ? round1(sigma / adu) : null,
    leadTimeDays: dlt,
    topOfRed: Math.round(red),
    topOfYellow: Math.round(red + yellow),
    topOfGreen: Math.round(top),
    averageStock: Math.round(average),
    fillPct: Math.round(Math.min(1, fill) * 100),
    // Valued at the stock shown, so the two columns always agree.
    stockValue: unitCost === null ? null : Math.round(Math.round(average) * unitCost),
  };
}

// The whole book at one service level: what it would hold, and what it would cost.
export function serviceCurve(items, services = [0.85, 0.9, 0.95]) {
  return services.map((service) => {
    const rows = items.map((i) => serviceSimulation(i, service));
    return {
      service,
      items: rows.length,
      averageStock: Math.round(sum(rows.map((r) => r.averageStock))),
      topOfGreen: Math.round(sum(rows.map((r) => r.topOfGreen))),
      stockValue: rows.some((r) => r.stockValue === null)
        ? null
        : Math.round(sum(rows.map((r) => r.stockValue))),
      fillPct: Math.round(mean(rows.map((r) => r.fillPct))),
    };
  });
}

// ---------- Events, seasons and schemes ----------

const addDays = (day, k) => {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + k);
  return d.toISOString().slice(0, 10);
};

// Does an event cover this item? An event with no items and no family covers the whole plant.
export const eventCovers = (event, item) =>
  (!event.itemIds?.length && !event.family) ||
  (event.itemIds ?? []).includes(item.itemId) ||
  (!!event.family && item.family === event.family);

// The rate an item should be sized for on a day: its trailing rate times the largest uplift of the
// events covering it. Zones have to rise before the window, by the item's lead time, or the
// replenishment arrives when the event is over.
export function eventFactor(events, item, date, leadTimeDays = 0) {
  let factor = 1;
  for (const e of events ?? []) {
    if (e.active === false || !eventCovers(e, item)) continue;
    const from = addDays(e.from, -Math.max(0, leadTimeDays));
    if (date >= from && date <= e.to) factor = Math.max(factor, 1 + e.upliftPct / 100);
  }
  return factor;
}

// The zone line over a horizon: where an item's top of green sits week by week with the events, and
// where trailing demand alone would have put it.
export function eventCurve(item, events, { from, weeks = 13, topOfGreen, leadTimeDays = 0 }) {
  return Array.from({ length: weeks }, (_, i) => {
    const date = addDays(from, i * 7);
    const factor = eventFactor(events, item, date, leadTimeDays);
    const inWindow = (events ?? []).some(
      (e) => e.active !== false && eventCovers(e, item) && date >= e.from && date <= e.to,
    );
    return {
      date,
      factor: round1(factor),
      planned: Math.round(topOfGreen * factor),
      trailing: Math.round(topOfGreen),
      inWindow,
    };
  });
}

// An accepted scheme is demand: its units spread evenly over its window, counted inside the horizon.
export function schemeDemand(schemes, today, horizonDays) {
  const out = new Map();
  const end = addDays(today, Math.max(0, horizonDays));
  for (const s of schemes ?? []) {
    if (s.state !== 'accepted') continue;
    const days = Math.max(1, Math.round((Date.parse(s.to) - Date.parse(s.from)) / 86400000) + 1);
    const perDay = s.expectedUnits / days;
    let inside = 0;
    for (let i = 0; i < days; i++) {
      const d = addDays(s.from, i);
      if (d >= today && d <= end) inside += perDay;
    }
    if (inside > EPS) out.set(s.itemId, (out.get(s.itemId) ?? 0) + inside);
  }
  return out;
}

// ---------- Space ----------

// A buffer set fitted to the space it has: red and yellow protect service, so green is trimmed
// first, and only then the cushion. rows: [{ itemId, code, topOfRed, topOfYellow, topOfGreen, size }]
// where size is the space one unit takes (1 for a unit count).
export function spaceFit(rows, capacity) {
  const need = sum(rows.map((r) => r.topOfGreen * (r.size ?? 1)));
  const floor = sum(rows.map((r) => r.topOfYellow * (r.size ?? 1)));
  if (need <= capacity + EPS)
    return {
      fits: true,
      need,
      capacity,
      spare: capacity - need,
      trimmed: 0,
      rows: rows.map((r) => ({ ...r, fitted: r.topOfGreen, trimmed: 0 })),
    };
  // Trim the green zones in proportion until the set fits, never below the yellow top.
  const green = need - floor;
  const keep = Math.max(0, capacity - floor);
  const share = green > EPS ? Math.min(1, keep / green) : 0;
  const out = rows.map((r) => {
    const size = r.size ?? 1;
    const g = (r.topOfGreen - r.topOfYellow) * size;
    const fitted = (r.topOfYellow * size + g * share) / size;
    return { ...r, fitted: Math.round(fitted), trimmed: Math.round(r.topOfGreen - fitted) };
  });
  return {
    fits: false,
    need,
    capacity,
    spare: 0,
    below: floor > capacity,
    floor,
    greenKept: Math.round(share * 100),
    trimmed: Math.round(need - Math.max(capacity, floor)),
    rows: out,
  };
}

// ---------- Target mode ----------

// A target priced against history: the buffers it would need, the stock that costs, and whether the
// constraint can make it. items carry their history rate; ratio is target over history.
export function targetScenario(items, ratio, { capacityPerDay, minutesPerUnit = null } = {}) {
  const rows = items.map((i) => {
    const base = serviceSimulation(i, i.service ?? 0.9);
    const target = serviceSimulation(
      { ...i, weeks: i.weeks.map((w) => w * ratio) },
      i.service ?? 0.9,
    );
    return {
      itemId: i.itemId,
      code: i.code,
      base,
      target,
      deltaTopOfGreen: target.topOfGreen - base.topOfGreen,
      deltaStock: target.averageStock - base.averageStock,
      deltaValue:
        base.stockValue === null || target.stockValue === null
          ? null
          : target.stockValue - base.stockValue,
    };
  });
  const extraUnits = sum(rows.map((r) => r.target.adu - r.base.adu));
  const addedMinutes = minutesPerUnit === null ? null : extraUnits * minutesPerUnit;
  return {
    ratio: round1(ratio),
    rows: rows
      .filter((r) => r.deltaTopOfGreen !== 0)
      .sort((a, b) => b.deltaTopOfGreen - a.deltaTopOfGreen),
    deltaStock: Math.round(sum(rows.map((r) => r.deltaStock))),
    deltaValue: rows.some((r) => r.deltaValue === null)
      ? null
      : Math.round(sum(rows.map((r) => r.deltaValue))),
    addedMinutesPerDay: addedMinutes === null ? null : Math.round(addedMinutes),
    utilisationPct:
      addedMinutes === null || !capacityPerDay
        ? null
        : Math.round(((capacityPerDay + addedMinutes) / capacityPerDay) * 100),
  };
}

// ---------- The network ----------

// How safely the constraint is the constraint: the gap between it and the next resource. A small
// gap means a machine change, a mix change or an outage moves the constraint somewhere else.
export function constraintStability(resources) {
  const rows = resources
    .filter((r) => r.capacityPerDay > 0)
    .map((r) => ({
      ...r,
      // A caller that already measured utilisation over the book's window keeps its number.
      utilisation: r.utilisation ?? r.load / (r.capacityPerDay * (r.days || 1)),
    }))
    .sort((a, b) => b.utilisation - a.utilisation);
  const drum = rows[0] ?? null,
    next = rows[1] ?? null;
  const gap = drum && next ? drum.utilisation - next.utilisation : null;
  return {
    rows,
    drum,
    next,
    gapPct: gap === null ? null : round1(gap * 100),
    stable: gap === null ? true : gap >= 0.1,
  };
}

// What another machine (or one fewer) would do to a resource and to the constraint.
export function machineWhatIf(resources, resourceId, machines) {
  const changed = resources.map((r) => {
    if (r.resourceId !== resourceId) return r;
    const capacityPerDay =
      machines > 0 ? (r.capacityPerDay / Math.max(1, r.machines)) * machines : 0;
    // The work does not change, so the utilisation moves with the capacity. A caller's own measured
    // number is on the same basis, so it is scaled rather than kept: keeping it would make the
    // machine change do nothing at all.
    const utilisation =
      r.utilisation === null || r.utilisation === undefined || capacityPerDay <= 0
        ? undefined
        : (r.utilisation * r.capacityPerDay) / capacityPerDay;
    return { ...r, machines, capacityPerDay, utilisation };
  });
  const before = constraintStability(resources);
  const after = constraintStability(changed);
  return {
    before: before.drum,
    after: after.drum,
    moved: before.drum?.resourceId !== after.drum?.resourceId,
    stability: after,
  };
}
