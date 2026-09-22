// Planning decisions (AV-7): time-phased material readiness, order times and impact, and the
// club / declub comparison. Pure. Reference: Nilkamal simulation handover (21-Sep-2026),
// decisionMaterials(), decisionOrderTimes(), decisionImpact(), planEvaluate(), planCompare().
//
// Units are production lots on the schedule axis (see scheduler.mjs): { id, oid, ref, itemId, qty,
// dueDate, dueDay, orderDueDay, lot, lotDay, front, planRelease, planGroup }. Day numbers are
// 1-based working-day indexes (1 = the first schedule day); times are plant working minutes.
import { allocate, forwardPass, oidOf, placeGroup, placeGroups } from './scheduler.mjs';

const EPS = 1e-6;

// ---------- Order times ----------

// Per order (all its lots): first start, last finish, finish day, promise day, slack, lots.
export function orderTimes(pass, dayMinutes) {
  const out = new Map();
  for (const x of pass.orders.values()) {
    const u = x.order;
    const id = oidOf(u);
    const o =
      out.get(id) ??
      out
        .set(id, {
          id,
          itemId: u.itemId,
          start: Infinity,
          finish: 0,
          prom: u.orderDueDay ?? u.dueDay,
          qty: 0,
          lots: [],
        })
        .get(id);
    o.start = Math.min(o.start, x.start);
    o.finish = Math.max(o.finish, x.finish);
    o.qty += u.qty;
    o.lots.push({ id: u.id, qty: u.qty, start: x.start, finish: x.finish });
  }
  for (const o of out.values()) {
    o.ship = Math.max(1, Math.ceil(o.finish / dayMinutes - 1e-9));
    o.slack = o.prom * dayMinutes - o.finish;
  }
  return out;
}

// ---------- Time-phased material readiness ----------

// Each lot consumes its full BOM when its first operation starts. Lots are served in start order
// from stock on hand plus open purchase lines due on or before that day (overdue lines are not
// stock: they need a new date). A component without any stock record cannot be validated.
// ctx: { boms: Map(itemId -> [{ componentId, qty }]) per unit of the item, in base units;
//        onHand: Map(componentId -> qty) (absent = no stock position);
//        supply: Map(componentId -> [{ qty, due }]); asOf: 'YYYY-MM-DD'; dates: axis dates;
//        dayMinutes; zones: Map(componentId -> zone) of buffered components }
export function materialReadiness(pass, ctx) {
  const byOrder = new Map(),
    events = [];
  for (const x of pass.orders.values()) {
    const u = x.order,
      id = oidOf(u);
    const bom = ctx.boms.get(u.itemId) ?? [];
    const r = byOrder.get(id) ?? byOrder.set(id, { id, lines: [], missingBom: false }).get(id);
    if (!bom.length) r.missingBom = true;
    const totals = new Map();
    for (const l of bom)
      totals.set(l.componentId, (totals.get(l.componentId) ?? 0) + l.qty * u.qty);
    const releaseDay = 1 + Math.floor(x.start / ctx.dayMinutes + 1e-9);
    for (const [componentId, requirement] of totals)
      events.push({
        componentId,
        requirement,
        id,
        lotId: u.id,
        lotRef: u.ref ?? u.id,
        t: x.start,
        releaseDay,
      });
  }
  events.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id) || a.lotRef.localeCompare(b.lotRef));
  const consumed = new Map();
  for (const e of events) {
    const previous = consumed.get(e.componentId) ?? 0;
    const release = ctx.dates[Math.min(ctx.dates.length - 1, e.releaseDay - 1)];
    const known = ctx.onHand.has(e.componentId);
    const onHand = known ? ctx.onHand.get(e.componentId) : null;
    const supply = ctx.supply.get(e.componentId) ?? [];
    const timely = supply
      .filter((p) => p.due >= ctx.asOf && p.due <= release)
      .reduce((s, p) => s + p.qty, 0);
    const available = onHand === null ? null : onHand + timely - previous;
    const shortage = available === null ? null : Math.max(0, e.requirement - available);
    const zone = ctx.zones.get(e.componentId) ?? null;
    byOrder.get(e.id).lines.push({
      componentId: e.componentId,
      lotId: e.lotId,
      releaseDay: e.releaseDay,
      release,
      requirement: e.requirement,
      onHand,
      timely,
      committedBefore: previous,
      available,
      shortage,
      zone,
      replenish: zone !== null && zone !== 'green',
      unknown: !known,
      overdueSupply: supply.filter((p) => p.due < ctx.asOf).reduce((s, p) => s + p.qty, 0),
      laterSupply: supply.filter((p) => p.due >= ctx.asOf && p.due > release),
    });
    consumed.set(e.componentId, previous + e.requirement);
  }
  for (const r of byOrder.values()) {
    r.gaps = r.lines.filter((l) => l.shortage > EPS);
    r.unknown = r.lines.filter((l) => l.unknown);
    r.replenishComponents = [
      ...new Set(r.lines.filter((l) => l.replenish).map((l) => l.componentId)),
    ];
    r.gated = !!(r.gaps.length || r.unknown.length || r.missingBom);
    r.status = r.gaps.length
      ? 'expedite'
      : r.unknown.length || r.missingBom
        ? 'unknown'
        : r.replenishComponents.length
          ? 'replenish'
          : 'clear';
  }
  return byOrder;
}

export const READINESS_LABELS = {
  expedite: 'Expedite or quote later',
  unknown: 'Cannot validate materials',
  replenish: 'Commit + replenish',
  clear: 'Clear to commit',
};

// ---------- Snapshot and impact ----------

// Everything a decision is judged on: timing, materials, drum and route-wide changeovers.
export function snapshot(seq, ctx) {
  const pass = forwardPass({
    sequence: seq,
    routings: ctx.routings,
    resources: ctx.resources,
    dayMinutes: ctx.dayMinutes,
  });
  const times = orderTimes(pass, ctx.dayMinutes);
  const materials = materialReadiness(pass, ctx);
  const capacity = [...pass.allocations.values()].map((a) => ({
    resourceId: a.resourceId,
    run: a.run,
    changeover: a.changeover,
    changeovers: a.changeovers,
  }));
  const drum = ctx.drumId ? pass.allocations.get(ctx.drumId) : null;
  return {
    seq,
    pass,
    times,
    materials,
    capacity,
    changeover: capacity.reduce((s, c) => s + c.changeover, 0),
    drum: drum
      ? { changeovers: drum.changeovers, minutes: drum.changeover }
      : { changeovers: 0, minutes: 0 },
  };
}

// What changed between two snapshots: every order whose start or finish moved, the ones that are
// newly late or later than before, and material readiness changes.
export function impact(before, after, id = null) {
  const rows = [];
  for (const n of after.times.values()) {
    const o = before.times.get(n.id);
    if (!o || (Math.abs(o.start - n.start) <= EPS && Math.abs(o.finish - n.finish) <= EPS))
      continue;
    rows.push({
      id: n.id,
      startBefore: o.start,
      startAfter: n.start,
      finishBefore: o.finish,
      finishAfter: n.finish,
      shipBefore: o.ship,
      shipAfter: n.ship,
      prom: n.prom,
      slipDays: Math.max(0, n.ship - n.prom),
      newlyBroken: n.ship > n.prom && n.ship > o.ship,
      slackAfter: n.slack,
      slackConsumed: o.slack - n.slack,
    });
  }
  const materials = [];
  for (const [k, b] of after.materials) {
    const a = before.materials.get(k);
    if (a?.status !== b.status)
      materials.push({ id: k, before: a?.status ?? null, after: b.status });
  }
  const moved =
    id && before.times.get(id) && after.times.get(id)
      ? { before: before.times.get(id), after: after.times.get(id) }
      : null;
  return {
    id,
    moved,
    rows,
    broken: rows.filter((r) => r.newlyBroken),
    recovered: [...after.times.values()]
      .filter((n) => {
        const o = before.times.get(n.id);
        return o && o.ship > o.prom && n.ship <= n.prom;
      })
      .map((n) => n.id),
    materials,
    drum: {
      before: before.drum,
      after: after.drum,
      delta: after.drum.minutes - before.drum.minutes,
    },
    changeoverDelta: after.changeover - before.changeover,
  };
}

// ---------- Club / declub ----------

// Judges a candidate sequence for `ids` (order ids) against `base`.
export function evaluate(base, seq, ids, groups, ctx, kind) {
  const after = snapshot(seq, ctx);
  const imp = impact(base, after, ids[0]);
  const gaps = [],
    missing = [];
  for (const id of ids) {
    const m = after.materials.get(id);
    if (!after.times.get(id) || !m || m.missingBom || m.unknown.length) missing.push(id);
  }
  // Cumulative member requirement per component: the largest shortage at any member release.
  const shortBy = new Map();
  for (const id of ids)
    for (const l of after.materials.get(id)?.lines ?? [])
      if (l.shortage > EPS)
        shortBy.set(l.componentId, Math.max(shortBy.get(l.componentId) ?? 0, l.shortage));
  for (const [componentId, shortage] of shortBy) gaps.push({ componentId, shortage });
  const late = ids.filter((id) => after.times.get(id)?.ship > after.times.get(id)?.prom);
  const carryBy = {},
    pullBy = {},
    fgCarryBy = {};
  for (const id of ids) {
    const a = after.times.get(id),
      b = base.times.get(id);
    if (!a || !b) continue;
    pullBy[id] = Math.max(0, (b.finish - a.finish) / ctx.dayMinutes);
    carryBy[id] = a.qty * pullBy[id];
    fgCarryBy[id] = a.qty * Math.max(0, a.prom - a.finish / ctx.dayMinutes);
  }
  const saved = base.changeover - after.changeover;
  const pull = Math.max(0, ...Object.values(pullBy));
  const reasons = [];
  if (missing.length) reasons.push({ code: 'cannot_validate', orders: missing });
  if (gaps.length) reasons.push({ code: 'material_short', components: gaps });
  if (late.length) reasons.push({ code: 'members_late', orders: late });
  if (imp.broken.length)
    reasons.push({ code: 'promises_broken', orders: imp.broken.map((r) => r.id) });
  if (pull > ctx.clubWindowDays + 1e-8)
    reasons.push({ code: 'pull_forward', days: pull, limit: ctx.clubWindowDays });
  if (kind === 'club' && saved <= EPS) reasons.push({ code: 'no_saving' });
  // A club must not take material away from an unrelated order.
  const hurt = [];
  for (const [id, m] of after.materials) {
    if (ids.includes(id)) continue;
    const old = base.materials.get(id);
    if (!old) continue;
    const worse = m.lines.some((l) => {
      const o = old.lines.find((x) => x.componentId === l.componentId && x.lotId === l.lotId);
      return o && (l.shortage ?? 0) > (o.shortage ?? 0) + EPS;
    });
    if (worse) hurt.push(id);
  }
  if (kind === 'club' && hurt.length) reasons.push({ code: 'material_hurt', orders: hurt });
  const capacityOK =
    (kind !== 'club' || !hurt.length) &&
    !missing.some((id) => !after.times.get(id)) &&
    !late.length &&
    !imp.broken.length;
  const withinPull = pull <= ctx.clubWindowDays + 1e-8;
  const normal =
    capacityOK && !missing.length && !gaps.length && withinPull && (kind !== 'club' || saved > EPS);
  const conditional =
    kind === 'club' &&
    capacityOK &&
    !missing.length &&
    gaps.length > 0 &&
    withinPull &&
    saved > EPS;
  const members = ids.map((id) => after.times.get(id)).filter(Boolean);
  return {
    kind,
    ids,
    groups,
    seq,
    after,
    impact: imp,
    savedMin: saved,
    carryBy,
    pullBy,
    fgCarryBy,
    carryUnits: Object.values(carryBy).reduce((s, n) => s + n, 0),
    fgCarryUnits: Object.values(fgCarryBy).reduce((s, n) => s + n, 0),
    pull,
    normal,
    conditional,
    capacityOK,
    missing,
    gaps,
    reasons,
    qty: members.reduce((s, t) => s + t.qty, 0),
    start: Math.min(...members.map((t) => t.start)),
    finish: Math.max(0, ...members.map((t) => t.finish)),
  };
}

const rank = (a, b) =>
  b.savedMin - a.savedMin ||
  a.carryUnits - b.carryUnits ||
  a.impact.rows.filter((r) => !a.ids.includes(r.id)).length -
    b.impact.rows.filter((r) => !b.ids.includes(r.id)).length ||
  b.start - a.start;

// Compares ways to run one item's open orders: the best club (members, release day and slot),
// a partial club, a larger club that needs an expedite, or each order on its own promise date.
// current: the plant's current sequence of units (decisions applied); groups: the planner's
// pinned groups [{ id, ids, fg, day, beforeId }]. ctx adds routings, resources, dayMinutes,
// drumId and clubWindowDays (the maximum pull-forward in days) to the readiness context.
export function compareClub(current, groups, itemId, ctx, options = {}) {
  const ids = (
    options.ids ?? [...new Set(current.filter((u) => u.itemId === itemId).map(oidOf))]
  ).filter((id) => current.some((u) => oidOf(u) === id && u.itemId === itemId));
  const set = new Set(ids);
  const kept = groups.filter((g) => !g.ids.some((id) => set.has(id)));
  const byDue = (a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : a.ref.localeCompare(b.ref);
  // Declub: members back to their promise-date position; the rest keeps its order.
  let separate = current.map((u) =>
    set.has(oidOf(u))
      ? { ...u, planGroup: null, planRelease: options.releases?.get(u.id) ?? null }
      : u,
  );
  const target = separate.filter((u) => set.has(oidOf(u))).sort(byDue);
  separate = separate.filter((u) => !set.has(oidOf(u)));
  for (const u of target) {
    const at = separate.findIndex((x) => byDue(x, u) > 0);
    separate.splice(at < 0 ? separate.length : at, 0, u);
  }
  const live = snapshot(current, ctx);
  const base = groups.some((g) => g.ids.some((id) => set.has(id))) ? snapshot(separate, ctx) : live;
  const subsets = [];
  if (ids.length <= 7) {
    for (let mask = 1; mask < 1 << ids.length; mask++) {
      const sub = ids.filter((_, i) => mask & (1 << i));
      if (sub.length >= 2) subsets.push(sub);
    }
  } else
    for (let a = 0; a < ids.length; a++)
      for (let b = a + 2; b <= ids.length; b++) subsets.push(ids.slice(a, b));
  const trials = [];
  for (const members of subsets) {
    const positions = base.seq
      .map((u, i) => (members.includes(oidOf(u)) ? i : -1))
      .filter((i) => i >= 0);
    const adjacent = positions.every((n, i) => i === 0 || n === positions[i - 1] + 1);
    const shared = [...base.pass.allocations.values()].every((a) => {
      const machines = new Set();
      for (const u of base.seq)
        if (members.includes(oidOf(u)))
          for (const [k, v] of a.assigned) if (k.startsWith(u.id + '|')) machines.add(v.machine);
      return machines.size <= 1;
    });
    if (adjacent && shared) {
      const s = evaluate(base, base.seq, members, kept, ctx, 'club');
      s.reasons.push({ code: 'already_adjacent' });
      trials.push(s);
      continue;
    }
    const units = separate.filter((u) => members.includes(oidOf(u)));
    const maxProm = Math.min(...members.map((id) => base.times.get(id)?.prom ?? 1));
    const minRelease = Math.max(1, ...units.map((u) => u.lotDay || 1));
    const maxDay = Math.max(minRelease, Math.ceil(maxProm));
    const anchors = new Set(
      options.beforeId !== undefined
        ? [options.beforeId]
        : units.map((u) => {
            const pos = separate.indexOf(u);
            const next = separate.slice(pos).find((x) => !members.includes(oidOf(x)));
            return next ? oidOf(next) : null;
          }),
    );
    let best = null,
      conditional = null,
      refused = null;
    for (let day = minRelease; day <= maxDay; day++)
      for (const beforeId of anchors) {
        const g = {
          id: 'club:' + members.slice().sort().join('+'),
          ids: members,
          fg: itemId,
          day,
          beforeId,
        };
        const seq = placeGroup(separate, members, day, beforeId, g.id);
        const s = evaluate(base, seq, members, kept.concat(g), ctx, 'club');
        s.day = day;
        s.beforeId = beforeId;
        if (s.normal && (!best || rank(s, best) < 0)) best = s;
        if (s.conditional && (!conditional || rank(s, conditional) < 0)) conditional = s;
        if (
          !refused ||
          s.reasons.length < refused.reasons.length ||
          (s.reasons.length === refused.reasons.length && rank(s, refused) < 0)
        )
          refused = s;
      }
    trials.push(best || conditional || refused);
  }
  const normals = trials.filter((s) => s?.normal).sort(rank);
  let chosen = normals[0] ?? null;
  // Groups never overlap; for small sets every compatible combination is re-evaluated jointly.
  const own = (s) => s.groups.filter((g) => s.ids.includes(g.ids[0]));
  if (ids.length <= 7 && normals.length) {
    const visit = (start, picked, used) => {
      for (let i = start; i < normals.length; i++) {
        const other = normals[i];
        if (other.ids.some((id) => used.has(id))) continue;
        const list = picked.concat(other),
          next = new Set([...used, ...other.ids]);
        if (list.length > 1) {
          const gs = kept.concat(list.flatMap(own));
          const joint = evaluate(base, placeGroups(separate, gs), [...next], gs, ctx, 'club');
          if (joint.normal && (!chosen || rank(joint, chosen) < 0)) chosen = joint;
        }
        visit(i + 1, list, next);
      }
    };
    visit(0, [], new Set());
  } else if (chosen)
    for (const other of normals) {
      if (other.ids.some((id) => chosen.ids.includes(id))) continue;
      const gs = chosen.groups.concat(own(other));
      const joint = evaluate(
        base,
        placeGroups(separate, gs),
        [...chosen.ids, ...other.ids],
        gs,
        ctx,
        'club',
      );
      if (joint.normal && rank(joint, chosen) < 0) chosen = joint;
    }
  const scenarios = [];
  const add = (s, key, label) => {
    if (!s) return;
    scenarios.push({ ...s, key, label, impact: impact(live, s.after, s.ids[0]) });
  };
  add(chosen, 'recommended', 'Recommended club');
  const partial = normals.find(
    (s) => s.ids.length < ids.length && (!chosen || s.ids.join('|') !== chosen.ids.join('|')),
  );
  add(partial, 'partial', 'Partial club');
  const larger = trials
    .filter((s) => s?.conditional && (!chosen || s.ids.length > chosen.ids.length))
    .sort((a, b) => b.ids.length - a.ids.length || rank(a, b))[0];
  add(larger, 'expedite', 'Larger club with expedite');
  if (!chosen && !larger && trials.length)
    add(
      trials.filter(Boolean).sort((a, b) => a.reasons.length - b.reasons.length || rank(a, b))[0],
      'refused',
      'Club refused',
    );
  const declub = evaluate(base, separate, ids, kept, ctx, 'declub');
  declub.normal = true;
  add(declub, 'declub', 'Declub / promise-date sequence');
  for (const s of scenarios)
    s.excluded = ids
      .filter((id) => !s.ids.includes(id))
      .map((id) => ({
        id,
        reasons: trials.find((t) => t?.ids.includes(id) && !t.normal)?.reasons ?? [
          { code: 'separate_better' },
        ],
      }));
  return {
    itemId,
    ids,
    scenarios,
    recommended: chosen ? 'recommended' : null,
    search: ids.length <= 7 ? 'all_subsets' : 'contiguous_subsets',
  };
}

// The drum changeovers of a sequence (for move reports).
export function drumChangeovers(seq, ctx) {
  const r = ctx.drumId ? ctx.resources.get(ctx.drumId) : null;
  if (!r) return { changeovers: 0, minutes: 0 };
  const a = allocate(r, seq, ctx.routings);
  return { changeovers: a.changeovers, minutes: a.changeover };
}
