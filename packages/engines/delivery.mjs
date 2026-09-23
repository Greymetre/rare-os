// Delivery (AV-10): what the plan promises and what it is about to deliver — order-level OTIF, the
// time buffer each promise still has, the exceptions worth a planner's day, and the day's list of
// things to order, make and watch. Pure. Reference: Nilkamal simulation handover (21-Sep-2026):
// Order OTIF, Buffer Board & Exceptions, Alerts, Planning Priorities and the Release Schedule.
//
// The demo drew its time-buffer bar and its at-risk list from prepared numbers; here both come from
// the calculated schedule: an order's protection is the runway it has to its promise, and what is
// left of it is its slack.

const EPS = 1e-6;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------- Order-level OTIF ----------

// An order is on time when everything it has to make is finished by its promise: one late lot
// makes the whole order late, which is what the customer feels.
// rows: [{ order, item, qty, promiseDay, shipDay, lots, material, state }]
export function otif(rows) {
  const orders = rows.map((r) => ({
    ...r,
    onTime: r.shipDay !== null && r.shipDay <= r.promiseDay,
    lateDays: r.shipDay === null ? null : Math.max(0, r.shipDay - r.promiseDay),
  }));
  const counted = orders.filter((o) => o.shipDay !== null);
  const onTime = counted.filter((o) => o.onTime).length;
  const lots = counted.reduce((n, o) => n + (o.lots ?? 1), 0);
  const lotsOnTime = counted.reduce(
    (n, o) => n + (o.lotsOnTime ?? (o.onTime ? (o.lots ?? 1) : 0)),
    0,
  );
  return {
    orders,
    total: counted.length,
    onTime,
    orderPct: counted.length ? Math.round((onTime / counted.length) * 100) : null,
    lots,
    lotsOnTime,
    lotPct: lots ? Math.round((lotsOnTime / lots) * 100) : null,
    unscheduled: orders.length - counted.length,
    late: counted.filter((o) => !o.onTime),
  };
}

// ---------- Time buffer ----------

// The protection a promise still has: the runway from the start of the schedule to the promise, and
// the slack left after the work is done. Consumed = the share of that runway already used.
// row: { promiseDay, shipDay, slackMinutes }; dayMinutes: the plant's working minutes in a day.
export function timeBuffer({ promiseDay, shipDay, slackMinutes }, dayMinutes) {
  const runway = Math.max(dayMinutes, promiseDay * dayMinutes);
  const slack = slackMinutes ?? (promiseDay - (shipDay ?? promiseDay)) * dayMinutes;
  const consumed = clamp(Math.round((1 - slack / runway) * 100), 0, 100);
  const penetrated = slack < -EPS;
  return {
    runwayMinutes: runway,
    slackMinutes: slack,
    consumed: penetrated ? 100 : consumed,
    zone: penetrated ? 'penetrated' : consumed > 70 ? 'red' : consumed > 40 ? 'yellow' : 'green',
  };
}

// ---------- Alerts ----------

// The exceptions of one plant, most serious first. Everything here is derived from the calculation:
// buffers in trouble, promises that cannot be met, material that cannot be validated, requests
// waiting for a supplier, orders waiting for a customer, and machines that are down.
// input: { buffers, orders, expedites, pending, downtime, atRisk }
export function alerts(input) {
  const out = [];
  const add = (severity, kind, subject, message, extra = {}) =>
    out.push({ severity, kind, subject, message, ...extra });
  for (const b of input.buffers ?? []) {
    if (b.status !== 'planned') continue;
    if (b.zone === 'breach' && !b.recommended)
      add(
        'critical',
        'stock',
        b.item,
        'Projected stock out: net flow is at or below zero and nothing is on order.',
      );
    else if (b.zone === 'breach')
      add(
        'high',
        'stock',
        b.item,
        `Net flow is at or below zero; ${b.recommended} is recommended.`,
      );
    else if (b.zone === 'red') add('high', 'stock', b.item, 'Net flow is in the red zone.');
    else if (b.zone === 'yellow') add('medium', 'stock', b.item, 'Net flow is in the yellow zone.');
    if (b.outsideHorizon > EPS)
      add(
        'low',
        'sync',
        b.item,
        `${b.outsideHorizon} of demand falls outside the lead-time horizon.`,
      );
  }
  for (const o of input.orders ?? []) {
    if (o.lateDays > 0)
      add(
        'critical',
        'promise',
        o.order,
        `Promised ${o.promise}, the plan finishes ${o.finishDate} (${o.lateDays} day(s) late).`,
        {
          item: o.item,
        },
      );
    else if (o.material === 'expedite')
      add(
        'high',
        'material',
        o.order,
        'Material is short at its release: expedite or quote a later date.',
        {
          item: o.item,
        },
      );
    else if (o.material === 'unknown')
      add(
        'medium',
        'material',
        o.order,
        'Materials cannot be validated: no stock record, BOM or routing.',
        {
          item: o.item,
        },
      );
  }
  for (const r of input.atRisk ?? [])
    add(
      'high',
      'promise',
      r.order,
      `At risk since the last calculation: promised ${r.promise}, now finishing ${r.now}.`,
    );
  for (const a of input.expedites ?? []) {
    if (a.state === 'late')
      add(
        'high',
        'expedite',
        a.component,
        `Supplier confirmed ${a.confirmation?.date}, after the ${a.required} the order needs.`,
        {
          orders: a.members,
        },
      );
    else if (a.state === 'rejected')
      add('high', 'expedite', a.component, 'Expedite rejected: the order needs a new decision.', {
        orders: a.members,
      });
    else if (a.state === 'requested' || a.state === 'approved')
      add('medium', 'expedite', a.component, `Expedite ${a.state}: no confirmed supply yet.`, {
        orders: a.members,
      });
  }
  for (const p of input.pending ?? [])
    add(
      'medium',
      'customer',
      p.order,
      `Waiting for the customer: ${p.original} proposed as ${p.proposed}.`,
    );
  for (const d of input.downtime ?? [])
    add('high', 'resource', d.resource, `${d.minutes} minutes lost on ${d.date}: ${d.reason}.`);
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] || String(a.subject).localeCompare(String(b.subject)),
  );
}

// ---------- The planner's day ----------

// Three lists a planner can act on today: what to order, what to release, and what to watch.
// `releaseBy` is the last release date that counts as today's work: the first day of the schedule,
// because a plan calculated today releases work from the next working day.
export function dayList({ buffers, releases, alerts: feed }, today, releaseBy = today) {
  const order = (buffers ?? [])
    .filter((b) => b.recommended && b.kind === 'BUY')
    .map((b) => ({
      item: b.item,
      qty: b.recommended,
      unit: b.unit,
      due: b.due,
      zone: b.zone,
      overdue: b.due !== null && b.due <= today,
    }))
    .sort(
      (a, b) => Number(b.overdue) - Number(a.overdue) || String(a.due).localeCompare(String(b.due)),
    );
  const make = (releases ?? [])
    .filter((r) => r.state === 'planned' && r.releaseDate !== null && r.releaseDate <= releaseBy)
    .map((r) => ({
      order: r.order,
      item: r.item,
      qty: r.qty,
      releaseDate: r.releaseDate,
      promise: r.promise,
      material: r.material,
      hold: r.material === 'expedite' || r.material === 'unknown',
    }))
    .sort(
      (a, b) =>
        String(a.releaseDate).localeCompare(String(b.releaseDate)) ||
        String(a.order).localeCompare(String(b.order)),
    );
  const watch = (feed ?? [])
    .filter((a) => a.severity === 'critical' || a.severity === 'high')
    .slice(0, 25);
  return { order, make, watch };
}
