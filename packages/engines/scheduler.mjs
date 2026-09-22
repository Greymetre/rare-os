// Finite-capacity forward scheduler (AV-6). Pure: the planning run loads the inputs and stores
// what this returns. Reference: Nilkamal simulation handover (21-Sep-2026), allocStation(),
// forwardPass(), deriveDrum(), the P19 same-item grouping rule and dynDlt().
//
// Time axis: plant working minutes from the start of the first schedule day (tomorrow);
// day d (1-based) covers ((d-1) x dayMinutes, d x dayMinutes]. A resource works all of the
// plant's working time at its efficiency, so W minutes of work take W / efficiency plant minutes.
//
// 1. Sequence: open orders by due date, then order number. Same-item orders whose due dates are
//    at most clubWindowDays apart are pulled back to back, unless the pull makes another order
//    later than its promise (or later than it already was).
// 2. Allocation, per resource and in sequence: each order goes to the machine that would be free
//    first counting the changeover it would need (a machine already set up for the item needs
//    none); consecutive orders of the same item stay on one machine.
// 3. Forward pass, in sequence: each operation starts when its previous operation has finished and
//    its machine is free and changed over; operations never overtake on a machine.
// 4. The drum is the resource with the highest load (run + changeover) over its daily capacity.

const EPS = 1e-6;
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const byDue = (a, b) =>
  a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.ref.localeCompare(b.ref);
const daysBetween = (a, b) =>
  Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

// Operations of an order: its routing with the work in resource minutes.
function operationsOf(order, routings) {
  return (routings.get(order.itemId) ?? [])
    .filter((op) => op.perUnit > 0)
    .map((op) => ({ ...op, work: order.qty * op.perUnit }));
}

// Assigns every order's work on one resource to its machines, in sequence.
export function allocate(resource, sequence, routings) {
  const machines = Math.max(1, Math.round(resource.machines));
  const c = resource.changeover ?? 0;
  const lanes = Array.from({ length: machines }, (_, i) => ({
    machine: i + 1,
    load: 0,
    run: 0,
    changeover: 0,
    changeovers: 0,
    last: null,
  }));
  const assigned = new Map(); // `${orderId}|${sequence}` -> { machine, changeover }
  let previous = null,
    previousMachine = 0;
  for (const order of sequence)
    for (const op of operationsOf(order, routings)) {
      if (op.resourceId !== resource.id) continue;
      let k = 0,
        best = Infinity;
      for (let j = 0; j < machines; j++) {
        const need = lanes[j].last !== null && lanes[j].last !== order.itemId ? c : 0;
        if (lanes[j].load + need < best - 1e-9) {
          best = lanes[j].load + need;
          k = j;
        }
      }
      if (previous && previous.itemId === order.itemId && previous.id !== order.id)
        k = previousMachine;
      previous = order;
      previousMachine = k;
      const lane = lanes[k];
      let changeover = 0;
      if (lane.last !== null && lane.last !== order.itemId) {
        changeover = c;
        lane.changeovers++;
        lane.changeover += c;
        lane.load += c;
      }
      lane.run += op.work;
      lane.load += op.work;
      lane.last = order.itemId;
      assigned.set(order.id + '|' + op.sequence, { machine: k + 1, changeover });
    }
  const sum = (f) => lanes.reduce((s, l) => s + l[f], 0);
  return {
    resourceId: resource.id,
    lanes,
    assigned,
    run: sum('run'),
    changeover: sum('changeover'),
    changeovers: sum('changeovers'),
  };
}

// Times every operation. Returns per-order operations and finish, and per-machine blocks.
export function forwardPass({ sequence, routings, resources, dayMinutes }) {
  const allocations = new Map(
    [...resources.values()].map((r) => [r.id, allocate(r, sequence, routings)]),
  );
  const free = new Map(); // `${resourceId}|${machine}` -> plant minute the machine is next free
  const orders = new Map();
  for (const order of sequence) {
    const ops = [];
    let ready = 0;
    for (const op of operationsOf(order, routings)) {
      const resource = resources.get(op.resourceId);
      const a = allocations.get(op.resourceId).assigned.get(order.id + '|' + op.sequence);
      const eff = resource.efficiency / 100;
      const key = op.resourceId + '|' + a.machine;
      const chg = a.changeover / eff,
        run = op.work / eff;
      const start = Math.max(ready, (free.get(key) ?? 0) + chg, order.release ?? 0);
      const finish = start + run;
      free.set(key, finish);
      ops.push({
        sequence: op.sequence,
        code: op.code,
        resourceId: op.resourceId,
        machine: a.machine,
        changeover: a.changeover,
        work: op.work,
        start,
        finish,
      });
      ready = finish;
    }
    const finish = ops.length ? ops[ops.length - 1].finish : 0;
    const shipDay = Math.max(1, Math.ceil(finish / dayMinutes - 1e-9));
    orders.set(order.id, {
      order,
      ops,
      start: ops.length ? ops[0].start : 0,
      finish,
      shipDay,
      slack: order.dueDay * dayMinutes - finish,
      late: shipDay > order.dueDay,
    });
  }
  return { allocations, orders };
}

// P19 rule: pull same-item orders inside the window next to the first one, unless that makes an
// order late that was not, or later than it was. maxChecks bounds the trial passes; by default
// it shrinks with the size of the book so a large book still plans in seconds.
export function groupedSequence({
  orders,
  routings,
  resources,
  dayMinutes,
  clubWindowDays,
  maxChecks,
}) {
  let seq = orders.slice().sort(byDue);
  const opCount = orders.reduce((n, o) => n + operationsOf(o, routings).length, 0);
  const budget = maxChecks ?? Math.max(10, Math.min(400, Math.floor(3e6 / Math.max(1, opCount))));
  let before = null;
  const groups = [],
    refused = [];
  let checks = 0,
    exhausted = false;
  if (clubWindowDays > 0)
    for (let i = 0; i < seq.length; i++) {
      const a = seq[i];
      let end = i + 1;
      for (let j = end; j < seq.length; j++) {
        const p = seq[j];
        if (p.itemId !== a.itemId || p.id === a.id) continue;
        if (Math.abs(daysBetween(a.dueDate, p.dueDate)) > clubWindowDays) continue;
        if (j !== end) {
          if (checks >= budget) {
            exhausted = true;
            continue;
          }
          checks++;
          const candidate = seq.slice();
          candidate.splice(j, 1);
          candidate.splice(end, 0, p);
          before ??= forwardPass({ sequence: seq, routings, resources, dayMinutes }).orders;
          const after = forwardPass({
            sequence: candidate,
            routings,
            resources,
            dayMinutes,
          }).orders;
          const hurt = [...after.values()].filter(
            (o) => o.late && o.shipDay > before.get(o.order.id).shipDay,
          );
          if (hurt.length) {
            refused.push({
              anchor: a.id,
              order: p.id,
              reason: hurt.map(
                (o) =>
                  `${o.order.ref} later by ${o.shipDay - before.get(o.order.id).shipDay} day(s)`,
              ),
            });
            continue;
          }
          seq = candidate;
          before = after;
        }
        end++;
      }
      if (end - i > 1) groups.push({ anchor: a.id, members: seq.slice(i, end).map((o) => o.id) });
      i = end - 1;
    }
  return { sequence: seq, groups, refused, checks, exhausted };
}

// Schedules one plant. orders: [{ id, ref, itemId, qty, dueDate, dueDay, release? }];
// routings: Map(itemId -> [{ sequence, code, resourceId, perUnit }]) sorted by sequence;
// resources: Map(id -> { id, code, machines, efficiency, changeover }).
export function schedulePlant({
  orders,
  routings,
  resources,
  dayMinutes,
  clubWindowDays = 1,
  maxChecks,
}) {
  const routed = orders.filter((o) =>
    operationsOf(o, routings).some((op) => resources.has(op.resourceId)),
  );
  const unrouted = orders.filter((o) => !routed.includes(o));
  const plan = groupedSequence({
    orders: routed,
    routings,
    resources,
    dayMinutes,
    clubWindowDays,
    maxChecks,
  });
  const pass = forwardPass({ sequence: plan.sequence, routings, resources, dayMinutes });
  // Busy plant minutes per machine and day, from the timed blocks (changeover precedes its run).
  const busy = new Map();
  const addBusy = (resourceId, from, to) => {
    for (let t = from; t < to - EPS; ) {
      const day = Math.floor(t / dayMinutes + EPS);
      const end = Math.min(to, (day + 1) * dayMinutes);
      const m = busy.get(resourceId) ?? busy.set(resourceId, []).get(resourceId);
      m[day] = (m[day] ?? 0) + (end - t);
      t = end;
    }
  };
  for (const o of pass.orders.values())
    for (const op of o.ops) {
      const eff = resources.get(op.resourceId).efficiency / 100;
      addBusy(op.resourceId, op.start - op.changeover / eff, op.finish);
    }
  let makespan = 0;
  for (const o of pass.orders.values()) makespan = Math.max(makespan, o.finish);
  const horizonDays = Math.max(1, Math.ceil(makespan / dayMinutes - 1e-9));
  const lastDue = routed.reduce((m, o) => Math.max(m, o.dueDay), 1);
  // Utilisation over the book's own window: tomorrow through the latest promise, or longer if needed.
  const span = Math.max(horizonDays, lastDue);
  const resourceRows = [...resources.values()].map((r) => {
    const a = pass.allocations.get(r.id);
    const capacityPerDay = (dayMinutes * r.machines * r.efficiency) / 100;
    const days = (busy.get(r.id) ?? []).map((m) => round4((m ?? 0) / (dayMinutes * r.machines)));
    return {
      resourceId: r.id,
      machines: r.machines,
      run: round4(a.run),
      changeover: round4(a.changeover),
      changeovers: a.changeovers,
      capacityPerDay,
      load: a.run + a.changeover,
      utilization: capacityPerDay > 0 ? (a.run + a.changeover) / (span * capacityPerDay) : 0,
      lanes: a.lanes.map((l) => ({
        machine: l.machine,
        run: round4(l.run),
        changeover: round4(l.changeover),
        changeovers: l.changeovers,
      })),
      days: Array.from({ length: Math.min(span, 366) }, (_, i) => days[i] ?? 0),
    };
  });
  let drum = null;
  for (const r of resourceRows)
    if (
      r.capacityPerDay > 0 &&
      r.load > 0 &&
      (!drum || r.load / r.capacityPerDay > drum.load / drum.capacityPerDay + 1e-12)
    )
      drum = r;
  // Changeovers the grouping avoids on the drum, against plain due-date order.
  let saved = 0;
  if (drum) {
    const res = resources.get(drum.resourceId);
    const naive = allocate(res, routed.slice().sort(byDue), routings);
    saved = naive.changeover - drum.changeover;
  }
  // Self-check: no operation starts before its predecessor ends, no overlap on a machine.
  let backward = 0,
    overlaps = 0;
  const lanes = new Map();
  for (const o of pass.orders.values())
    o.ops.forEach((op, i) => {
      if (i && op.start < o.ops[i - 1].finish - EPS) backward++;
      const key = op.resourceId + '|' + op.machine;
      if (!lanes.has(key)) lanes.set(key, []);
      lanes.get(key).push(op);
    });
  for (const ops of lanes.values()) {
    ops.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ops.length; i++) if (ops[i].start < ops[i - 1].finish - EPS) overlaps++;
  }
  const groupOf = new Map();
  for (const g of plan.groups) for (const m of g.members.slice(1)) groupOf.set(m, g.anchor);
  return {
    sequence: plan.sequence.map((o) => o.id),
    orders: plan.sequence.map((o, i) => ({
      ...pass.orders.get(o.id),
      position: i + 1,
      groupedWith: groupOf.get(o.id) ?? null,
    })),
    unrouted,
    resources: resourceRows,
    drumId: drum?.resourceId ?? null,
    groups: plan.groups,
    refused: plan.refused,
    groupingChecks: plan.checks,
    groupingExhausted: plan.exhausted,
    changeoverSaved: round4(saved),
    makespan,
    horizonDays,
    check: { backward, overlaps },
  };
}

// ---------- Dynamic lead time (Lead time reality) ----------

// Share of an average day's volume on day `day` of a 31-day despatch profile (1.0 = average).
export function dayFactor(weights, day) {
  if (!weights?.length) return 1;
  const d = Math.max(1, Math.min(weights.length, day));
  return (weights[d - 1] * weights.length) / 100;
}

// Master lead time plus the queue each routed resource adds at its planned utilisation
// (M/M/1: wait = processing x u / (1 - u)); at 95% or more the queue is unbounded.
// ops: [{ perUnit, capacityPerDay, utilization (0..1) }]; lot: the reference order quantity.
export function dynamicLeadTime({ leadTimeDays, lot, ops }) {
  let queue = 0,
    proc = 0,
    unbounded = false;
  const stations = ops.map((op) => {
    const procDays = op.capacityPerDay > 0 ? (lot * op.perUnit) / op.capacityPerDay : 0;
    proc += procDays;
    if (op.utilization >= 0.95) {
      unbounded = true;
      return { ...op, procDays, waitDays: null, unbounded: true };
    }
    const waitDays = procDays * (op.utilization / (1 - op.utilization));
    queue += waitDays;
    return { ...op, procDays, waitDays, unbounded: false };
  });
  const days = unbounded ? null : leadTimeDays + queue;
  return {
    days,
    queueDays: queue,
    procDays: proc,
    unbounded,
    factor: unbounded || leadTimeDays <= 0 ? null : days / leadTimeDays,
    stations,
  };
}

// ---------- Calendar ----------

// The plant's working dates from `from` (inclusive), up to `count` of them.
export function workingDates(from, count, workingDays, holidays = new Set(), limit = 4000) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  for (let i = 0; out.length < count && i < limit; i++) {
    const iso = d.toISOString().slice(0, 10);
    const weekday = (d.getUTCDay() + 6) % 7;
    if (workingDays[weekday] === '1' && !holidays.has(iso)) out.push(iso);
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Due day index of a date on the axis: the number of working dates on or before it.
export function dueDayIndex(date, dates) {
  let lo = 0,
    hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
