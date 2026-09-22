// Materials decisions (AV-8): expedite requests against existing purchase lines, recorded supplier
// confirmations as dated supply, the order's decision state, and a later date for an order that
// materials or capacity cannot support now. Pure. Reference: Nilkamal simulation handover
// (21-Sep-2026): planExpediteRows(), planBundleWrite(), decisionSupplies() with confirmations,
// planOrderState(), planLater().
//
// Days are 1-based working-day indexes of the schedule axis; dates are 'YYYY-MM-DD'.
import { forwardPass, oidOf } from './scheduler.mjs';
import { impact, orderTimes, snapshot } from './decisions.mjs';

const EPS = 1e-6;

// ---------- Expedite ----------

// Component actions that would let `ids` (order ids, e.g. a pinned group) release as scheduled.
// For each short component: the existing purchase lines due after the required date (then overdue
// ones), latest-needed first; what they cannot cover becomes a new expedited purchase. A component
// without a stock record cannot be validated; neither can an order without a BOM or a routing.
// snap: snapshot(); supply: Map(componentId -> [{ qty, due, key, poNo, lineNo, lineId }]).
export function expediteRows(snap, ids, supply, asOf) {
  const byComponent = new Map();
  for (const id of ids)
    for (const l of snap.materials.get(id)?.lines ?? []) {
      const t =
        byComponent.get(l.componentId) ??
        byComponent
          .set(l.componentId, {
            componentId: l.componentId,
            requirement: 0,
            shortage: 0,
            unknown: false,
            members: [],
            releases: [],
            lines: [],
          })
          .get(l.componentId);
      t.requirement += l.requirement;
      t.shortage = Math.max(t.shortage, l.shortage ?? 0);
      if (l.unknown) t.unknown = true;
      if (!t.members.includes(id)) t.members.push(id);
      t.releases.push({ id, lot: l.lotId, date: l.release, qty: l.requirement });
      t.lines.push({ ...l, id });
    }
  const rows = [];
  for (const t of byComponent.values()) {
    if (t.shortage <= EPS && !t.unknown) continue;
    const gated = t.lines.filter((l) => l.shortage > EPS || l.unknown);
    const required = gated.map((l) => l.release).sort()[0];
    const base = {
      componentId: t.componentId,
      requirement: t.requirement,
      shortage: t.shortage,
      members: t.members,
      required,
      onHand: t.lines[0].onHand,
      timely: Math.min(...gated.map((l) => l.timely)),
      dependents: gated.map((l) => ({
        id: l.id,
        lot: l.lotId,
        qty: l.requirement,
        date: l.release,
      })),
      incremental: t.releases.map((r) => ({ id: r.id, qty: r.qty, date: r.date })),
    };
    if (t.unknown) {
      rows.push({ ...base, type: 'CANNOT_VALIDATE', qty: null, key: t.componentId + '|unknown' });
      continue;
    }
    let remaining = t.shortage;
    const seen = new Set();
    const lines = (supply.get(t.componentId) ?? [])
      .filter((p) => {
        if (seen.has(p.key)) return false;
        seen.add(p.key);
        return p.due > required || p.due < asOf;
      })
      .sort(
        (a, b) =>
          Number(b.due > required) - Number(a.due > required) ||
          (a.due < b.due ? -1 : a.due > b.due ? 1 : 0),
      );
    for (const p of lines) {
      if (remaining <= EPS) break;
      const qty = Math.min(remaining, p.qty);
      rows.push({
        ...base,
        type: 'EXPEDITE_PO',
        qty,
        poNo: p.poNo,
        lineNo: p.lineNo,
        lineId: p.lineId,
        supplyKey: p.key,
        currentDue: p.due,
        key: t.componentId + '|' + p.key,
      });
      remaining -= qty;
    }
    if (remaining > EPS)
      rows.push({ ...base, type: 'NEW_PO', qty: remaining, key: t.componentId + '|new' });
  }
  for (const id of ids)
    if (snap.materials.get(id)?.missingBom || !snap.times.get(id))
      rows.push({
        componentId: null,
        type: 'CANNOT_VALIDATE',
        qty: null,
        key: id + '|missing',
        members: [id],
        dependents: [],
        incremental: [],
        required: null,
        missing: true,
      });
  return rows;
}

// Merges a new request into the open actions (same component and purchase line): quantity grows to
// cover the new shortage beyond what was confirmed, and a confirmation that no longer covers the
// requirement goes back to requested. Returns { actions (changed or new), created }.
export function mergeActions(existing, rows) {
  const out = [];
  for (const row of rows) {
    const a = existing.find(
      (x) => x.key === row.key && !['rejected', 'superseded'].includes(x.state),
    );
    if (!a) {
      out.push({
        ...row,
        state: row.type === 'CANNOT_VALIDATE' ? 'cannot_validate' : 'requested',
        isNew: true,
      });
      continue;
    }
    const next = { ...a, isNew: false };
    next.qty = Math.max(a.qty ?? 0, (row.qty ?? 0) + (a.confirmation?.qty ?? 0));
    next.required = [a.required, row.required].filter(Boolean).sort()[0] ?? null;
    if (
      a.confirmation &&
      (a.confirmation.qty < next.qty - EPS || a.confirmation.date > next.required)
    )
      next.state = 'requested';
    next.members = [...new Set([...(a.members ?? []), ...(row.members ?? [])])];
    next.dependents = [
      ...new Map(
        [...(a.dependents ?? []), ...(row.dependents ?? [])].map((d) => [d.id + '|' + d.lot, d]),
      ).values(),
    ];
    out.push(next);
  }
  return out;
}

// State of a request after a supplier confirmation: on or before the required date = confirmed.
export const confirmationState = (action, date) => (date <= action.required ? 'confirmed' : 'late');

// Open purchase supply with recorded supplier confirmations: a confirmed quantity of a purchase
// line moves to its confirmed date (the rest keeps the line's due date); a confirmed new purchase
// is supply on its confirmed date. Approval alone changes nothing.
export function confirmedSupply(supply, actions) {
  const live = actions.filter(
    (a) => a.confirmation && !['rejected', 'superseded'].includes(a.state),
  );
  const out = new Map();
  for (const [componentId, lines] of supply) {
    const list = [];
    for (const p of lines) {
      let remaining = p.qty;
      for (const a of live.filter((x) => x.componentId === componentId && x.supplyKey === p.key)) {
        const qty = Math.min(remaining, a.confirmation.qty);
        if (qty > 0)
          list.push({ ...p, qty, due: a.confirmation.date, confirmedBy: a.id, originalDue: p.due });
        remaining -= qty;
      }
      if (remaining > 1e-8) list.push({ ...p, qty: remaining });
    }
    out.set(componentId, list);
  }
  for (const a of live.filter((x) => x.type === 'NEW_PO')) {
    if (!out.has(a.componentId)) out.set(a.componentId, []);
    out.get(a.componentId).push({
      qty: a.confirmation.qty,
      due: a.confirmation.date,
      key: 'action:' + a.id,
      confirmedBy: a.id,
    });
  }
  return out;
}

// ---------- Order decision state ----------

export const ORDER_STATES = {
  decision_required: 'Decision required: expedite or quote later',
  expedite_pending: 'Scheduled: expedite pending',
  conditional_expedite: 'Scheduled: conditional on confirmed expedite',
  material_clear: 'Scheduled: material clear',
  awaiting_confirmation: 'Awaiting customer date confirmation',
  ready_to_reschedule: 'Ready to reschedule',
  cancelled: 'Cancelled',
};
export const PENDING = ['awaiting_confirmation', 'ready_to_reschedule'];

// plan: the order's plan row ({ state, bundleId }); actions: every expedite action of the plant.
export function orderState(id, material, plan, actions) {
  if (plan && (PENDING.includes(plan.state) || plan.state === 'cancelled')) return plan.state;
  if (material && !material.gated) {
    const recorded = actions.some(
      (a) =>
        a.members?.includes(id) &&
        a.confirmation &&
        !['rejected', 'superseded'].includes(a.state) &&
        material.lines.some(
          (l) => l.componentId === a.componentId && a.confirmation.date <= l.release,
        ),
    );
    return recorded ? 'conditional_expedite' : 'material_clear';
  }
  if (plan?.bundleId) {
    const list = actions.filter((a) => a.bundles?.includes(plan.bundleId));
    if (list.some((a) => a.state === 'rejected' || a.state === 'late')) return 'decision_required';
    if (list.some((a) => a.state !== 'confirmed')) return 'expedite_pending';
    if (!material?.gated) return 'conditional_expedite';
  }
  return material?.gated ? 'decision_required' : 'material_clear';
}

// A bundle's state from its actions.
export function bundleState(list) {
  if (list.some((a) => ['rejected', 'late'].includes(a.state))) return 'quote_later_required';
  if (list.every((a) => a.state === 'confirmed')) return 'confirmed';
  if (list.some((a) => a.state === 'cannot_validate')) return 'pending_evidence';
  if (list.every((a) => a.state === 'approved')) return 'approved';
  return 'requested';
}

// ---------- A later date ----------

// Candidate release days × slots for one order taken out of the book; each is checked on the full
// route and materials. A date is supported when the order's materials are covered, it finishes by
// the date (when one is entered), no other promise gets later and no other order loses material.
// current: the plant's sequence (the order included when it is scheduled); units: the order's
// production units; groups: pinned groups; first: earliest release day allowed; candidate: a
// planner-entered delivery day; originalPromise: the customer's current promise day.
export function laterDates({
  current,
  units,
  id,
  groups = [],
  ctx,
  first = 1,
  candidate = null,
  originalPromise,
}) {
  const rest = current.filter((u) => oidOf(u) !== id);
  const kept = groups.filter((g) => !g.ids.includes(id));
  const base = snapshot(current, ctx);
  const D = ctx.dayMinutes;
  const dayOf = (date) => ctx.dates.indexOf(date) + 1;
  const supplyDays = [];
  for (const u of units)
    for (const b of ctx.boms.get(u.itemId) ?? [])
      for (const p of ctx.supply.get(b.componentId) ?? [])
        if (p.due >= ctx.asOf) {
          const d = dayOf(p.due);
          if (d > 0) supplyDays.push(d);
        }
  const days = [
    first,
    ...new Set(supplyDays.filter((d) => d >= first)),
    ...units.map((u) => u.lotDay).filter((d) => d != null && d >= first),
  ];
  if (candidate) days.push(candidate);
  let maxFin = 0;
  for (const o of forwardPass({ ...ctx, sequence: rest }).orders.values())
    maxFin = Math.max(maxFin, o.finish);
  const finishDay = Math.max(1, Math.ceil(maxFin / D - 1e-9));
  days.push(finishDay, finishDay + 1);
  const slots = new Set([rest.length]);
  rest.forEach((u, i) => {
    if (i === 0 || oidOf(rest[i - 1]) !== oidOf(u)) slots.add(i);
  });
  const earliestLot = Math.min(...units.map((u) => u.lotDay || first));
  const qty = units.reduce((s, u) => s + u.qty, 0);
  const trials = [];
  for (const day of [...new Set(days)].sort((a, b) => a - b))
    for (const at of slots) {
      const seq = rest.slice();
      seq.splice(
        at,
        0,
        ...units.map((u) => ({
          ...u,
          planGroup: null,
          planRelease: Math.max(first, day + (u.lotDay ? u.lotDay - earliestLot : 0)),
          manualPlaced: false,
          lotDay: null,
          front: false,
        })),
      );
      const fp = forwardPass({ ...ctx, sequence: seq });
      const t = orderTimes(fp, D).get(id);
      if (!t) continue;
      const promise = candidate || t.ship;
      const actual = seq.map((u) =>
        oidOf(u) === id ? { ...u, orderDueDay: promise, dueDay: promise } : u,
      );
      const after = snapshot(actual, ctx);
      const imp = impact(base, after, id);
      const breaks = imp.broken.filter((x) => x.id !== id);
      const r = after.materials.get(id);
      const late = !!candidate && t.ship > candidate;
      const hurt = [...after.materials.keys()].filter((oid) => {
        if (oid === id) return false;
        const old = base.materials.get(oid);
        return (
          old &&
          after.materials.get(oid).lines.some((l) => {
            const o = old.lines.find((x) => x.componentId === l.componentId && x.lotId === l.lotId);
            return o && (l.shortage ?? 0) > (o.shortage ?? 0) + EPS;
          })
        );
      });
      const capacityOK = !breaks.length && !late && !hurt.length;
      const normal = !!r && !r.gated && capacityOK;
      trials.push({
        id,
        day,
        promise,
        normal,
        capacityOK,
        conditional: !normal,
        seq: actual,
        groups: kept,
        after,
        impact: imp,
        materialHurt: hurt,
        late,
        broken: breaks.map((x) => x.id),
        status: r?.status ?? 'unknown',
        gaps: r?.gaps ?? [],
        unknown: r?.unknown ?? [],
        qty,
        start: t.start,
        finish: t.finish,
        ship: t.ship,
        originalPromise,
        moveSlip: Math.max(0, t.ship - originalPromise),
        moveSlackHours: (originalPromise * D - t.finish) / 60,
        savedMin: base.changeover - after.changeover,
        carryUnits: (qty * Math.max(0, promise * D - t.finish)) / D,
        beforeId: rest[at] ? oidOf(rest[at]) : null,
      });
    }
  const rank = (a, b) =>
    Number(b.normal) - Number(a.normal) ||
    Number(b.capacityOK) - Number(a.capacityOK) ||
    a.promise - b.promise ||
    a.impact.broken.length - b.impact.broken.length ||
    a.carryUnits - b.carryUnits ||
    b.savedMin - a.savedMin ||
    a.impact.rows.length - b.impact.rows.length;
  trials.sort(rank);
  const scenarios = [];
  for (const s of trials) {
    if (scenarios.some((x) => x.promise === s.promise && x.normal === s.normal && x.day === s.day))
      continue;
    scenarios.push({
      ...s,
      key: 'later-' + scenarios.length,
      label: candidate
        ? 'Planner-entered date'
        : s.normal
          ? 'Material-supported later date'
          : 'Conditional later-date quote',
    });
    if (scenarios.length >= 3) break;
  }
  return { id, candidate, evaluated: trials.length, scenarios };
}
