// Execution (AV-9): the loop runs on two events only — a work order is released, and it is
// completed. From those, buffer penetration and schedule adherence; from the same completions, the
// master-data self-audit of cycle times. Pure. Reference: Nilkamal simulation handover
// (21-Sep-2026): the work-order log, seExec() and v4AuditRows().

const round1 = (n) => +n.toFixed(1);
const round2 = (n) => +n.toFixed(2);

// How much of the protective buffer a completion used: 0% = inside the plan, 100% = the whole
// buffer, above 100% = the buffer is blown. planned and elapsed are work minutes.
export function penetration(planned, elapsed, bufferPct) {
  const p = Number(planned) || 0,
    e = Number(elapsed) || 0;
  const buffer = (p * bufferPct) / 100;
  if (buffer <= 0) return { buffer: 0, penetration: e > p ? 100 : 0, ok: e <= p };
  return {
    buffer,
    penetration: Math.max(0, Math.round(((e - p) / buffer) * 100)),
    ok: e <= p + buffer,
  };
}

// Completions finishing inside plan + buffer, as a percentage.
export function adherence(rows) {
  const done = rows.filter((r) => r.elapsed != null && r.planned != null);
  if (!done.length) return { completions: 0, inside: 0, pct: null };
  const inside = done.filter((r) => penetration(r.planned, r.elapsed, r.bufferPct).ok).length;
  return { completions: done.length, inside, pct: Math.round((inside / done.length) * 100) };
}

// Maintained cycle time against what production actually took, from completed work orders alone.
// completions: [{ itemId, quantity, elapsed }] (elapsed = work minutes of that completion);
// standards: Map(itemId -> minutes per unit of the item's routing).
// An item is flagged when it has enough completions, every one of them is on the same side of the
// standard, and the drift is at least the threshold: that is a standard to correct, not noise.
export function auditRows(completions, standards, { minCompletions = 5, driftPct = 10 } = {}) {
  const byItem = new Map();
  for (const c of completions) {
    if (!(c.quantity > 0) || c.elapsed == null) continue;
    if (!byItem.has(c.itemId)) byItem.set(c.itemId, []);
    byItem.get(c.itemId).push(Number(c.elapsed) / Number(c.quantity));
  }
  const rows = [];
  for (const [itemId, series] of byItem) {
    const std = Number(standards.get(itemId) ?? 0);
    if (!(std > 0)) continue;
    const avg = round2(series.reduce((s, x) => s + x, 0) / series.length);
    const drift = round1(((avg - std) / std) * 100);
    const consistent =
      series.length >= minCompletions &&
      (series.every((x) => x > std) || series.every((x) => x < std));
    rows.push({
      itemId,
      standard: std,
      actual: avg,
      completions: series.length,
      drift,
      consistent,
      flagged: consistent && Math.abs(drift) >= driftPct,
      scale: avg / std,
      series,
    });
  }
  return rows.sort(
    (a, b) => Math.abs(b.drift) - Math.abs(a.drift) || a.itemId.localeCompare(b.itemId),
  );
}

// The corrected routing: every operation scaled by the same factor, so the shape of the route is
// kept and only its total moves to what production actually takes.
export const correctedOperations = (operations, scale) =>
  operations.map((op) => ({ ...op, perUnit: +(op.perUnit * scale).toFixed(6) }));

// Promises that the new schedule puts at risk: orders that are late now and were not before, or
// later than they were. before / after: Map(orderId -> { ship, prom }).
export function atRisk(before, after) {
  const rows = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b || a.ship <= a.prom) continue;
    if (b.ship > b.prom && a.ship <= b.ship) continue;
    rows.push({ id, promise: a.prom, was: b.ship, now: a.ship, days: a.ship - a.prom });
  }
  return rows.sort((x, y) => y.days - x.days || x.id.localeCompare(y.id));
}
