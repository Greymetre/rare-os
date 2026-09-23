import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  adherence,
  atRisk,
  auditRows,
  correctedOperations,
  penetration,
} from '../packages/engines/execution.mjs';
import {
  downtimeIntervals,
  forwardPass,
  schedulePlant,
  workingDates,
} from '../packages/engines/scheduler.mjs';

// The simulation handover bundle is client data and lives outside the repository, so the parity
// test below runs where it is present and is skipped everywhere else (CI, a fresh clone).
// NILKAMAL_HANDOVER_SEED points at the seed file on a machine that keeps the bundle elsewhere.
const DEMO =
  process.env.NILKAMAL_HANDOVER_SEED ??
  '/Users/apple/Developer/rare-os/Nilkamal_Simulation_Demo_Developer_Handover_21Sep2026/Demo_Build/nilkamal_seed_v9_materials.json';
const demoSeed = fs.existsSync(DEMO)
  ? false
  : 'the Nilkamal handover bundle is not on this machine';

test('buffer penetration and schedule adherence come from the two events', () => {
  // 1,320 planned minutes with a 25% buffer: 1,326 used 2% of the protection.
  assert.deepEqual(penetration(1320, 1326, 25), { buffer: 330, penetration: 2, ok: true });
  assert.deepEqual(penetration(1080, 1204, 25), { buffer: 270, penetration: 46, ok: true });
  // Inside the plan: no penetration at all.
  assert.equal(penetration(1000, 900, 25).penetration, 0);
  // Past plan + buffer: blown.
  assert.deepEqual(penetration(1000, 1400, 25), { buffer: 250, penetration: 160, ok: false });
  const rows = [
    { planned: 1000, elapsed: 900, bufferPct: 25 },
    { planned: 1000, elapsed: 1400, bufferPct: 25 },
    { planned: 1000, elapsed: 1250, bufferPct: 25 },
    { planned: 1000, elapsed: null, bufferPct: 25 },
  ];
  assert.deepEqual(adherence(rows), { completions: 3, inside: 2, pct: 67 });
  assert.equal(adherence([]).pct, null);
});

test('master-data self-audit: consistent drift is flagged, noise is not', () => {
  const standards = new Map([
    ['A', 20],
    ['B', 27],
    ['C', 10],
  ]);
  const c = (itemId, perUnit, quantity = 10) => ({ itemId, quantity, elapsed: perUnit * quantity });
  const completions = [
    // A: five completions, all under the standard, 10% drift -> flagged.
    ...[18, 17.9, 18.1, 18, 18].map((x) => c('A', x)),
    // B: mixed sides, large drift -> not consistent, not flagged.
    ...[30, 24, 31, 25, 33].map((x) => c('B', x)),
    // C: consistent but only four completions -> not enough evidence.
    ...[12, 12.1, 12, 12.2].map((x) => c('C', x)),
  ];
  const rows = auditRows(completions, standards);
  const byItem = Object.fromEntries(rows.map((r) => [r.itemId, r]));
  assert.deepEqual(
    [byItem.A.actual, byItem.A.drift, byItem.A.consistent, byItem.A.flagged],
    [18, -10, true, true],
  );
  assert.equal(byItem.B.consistent, false);
  assert.equal(byItem.B.flagged, false);
  assert.equal(byItem.C.completions, 4);
  assert.equal(byItem.C.flagged, false);
  // The corrected routing keeps the shape of the route.
  const ops = correctedOperations([{ perUnit: 12 }, { perUnit: 8 }], byItem.A.scale);
  assert.deepEqual(
    ops.map((o) => o.perUnit),
    [10.8, 7.2],
  );
});

test('the audit rule reproduces the simulation handover figures', { skip: demoSeed }, () => {
  const seed = JSON.parse(fs.readFileSync(DEMO, 'utf8'));
  const actuals = seed.routing_actual_elapsed;
  const standards = new Map(Object.entries(actuals).map(([item, a]) => [item, a.std_total_min]));
  const completions = Object.entries(actuals).flatMap(([item, a]) =>
    a.series_min_per_unit.map((m) => ({ itemId: item, quantity: 20, elapsed: m * 20 })),
  );
  const rows = auditRows(completions, standards);
  // The published figures were rounded by the seed generator (half to even); ours round half up,
  // so they agree to the rounding step.
  for (const r of rows) {
    assert.equal(r.completions, actuals[r.itemId].n);
    assert.ok(Math.abs(r.actual - actuals[r.itemId].avg) <= 0.011, r.itemId + ' average');
    assert.ok(Math.abs(r.drift - actuals[r.itemId].drift_pct) <= 0.101, r.itemId + ' drift');
  }
  assert.deepEqual(
    rows.filter((r) => r.flagged).map((r) => [r.itemId, r.drift]),
    [
      ['MFROBNWHTGRN78726', -14.5],
      ['MFROBNWHTGRN75486', 12.4],
      ['MFROBNWHTGRN75726', 11.9],
    ],
    'the same three standards are flagged',
  );
});

test('downtime takes minutes off a machine, and released work keeps its place', () => {
  const D = 480;
  const dates = workingDates('2026-10-01', 30, '1111111');
  const resources = new Map([
    ['M', { id: 'M', code: 'M', machines: 2, efficiency: 100, changeover: 0 }],
  ]);
  const routings = new Map([['FG', [{ sequence: 10, code: 'M', resourceId: 'M', perUnit: 1 }]]]);
  const unit = (id, qty, day, extra = {}) => ({
    id,
    oid: id,
    ref: id,
    itemId: 'FG',
    qty,
    dueDate: dates[day - 1],
    dueDay: day,
    orderDueDay: day,
    ...extra,
  });
  const orders = [unit('O1', 100, 2), unit('O2', 100, 2), unit('O3', 100, 3)];
  const plain = schedulePlant({ orders, routings, resources, dayMinutes: D, clubWindowDays: 0 });
  assert.equal(plain.orders[0].start, 0);
  // 240 minutes lost on machine 1 on day 1: the work there starts after the stoppage.
  const down = [{ resourceId: 'M', machine: 1, day: 1, minutes: 240 }];
  const stopped = schedulePlant({
    orders,
    routings,
    resources,
    dayMinutes: D,
    clubWindowDays: 0,
    downtime: down,
  });
  const first = stopped.orders.find((o) => o.order.id === 'O1');
  assert.equal(first.ops[0].machine, 1);
  assert.equal(first.start, 240);
  // A stoppage on every machine of the resource moves the whole book.
  const all = schedulePlant({
    orders,
    routings,
    resources,
    dayMinutes: D,
    clubWindowDays: 0,
    downtime: [{ resourceId: 'M', machine: null, day: 1, minutes: 300 }],
  });
  assert.ok(all.orders.every((o) => o.start >= 300));
  assert.equal(downtimeIntervals(down, resources, D).get('M|1')[0][1], 240);
  // Released work runs first, in the order it was released, whatever the due dates say.
  const running = schedulePlant({
    orders: [unit('O1', 100, 2), unit('O2', 100, 2), unit('O3', 100, 3, { releaseNo: 1 })],
    routings,
    resources,
    dayMinutes: D,
    clubWindowDays: 0,
  });
  assert.deepEqual(running.sequence, ['O3', 'O1', 'O2']);
  // A planner's manual order cannot move released work either.
  const manual = schedulePlant({
    orders: [unit('O1', 100, 2), unit('O2', 100, 2), unit('O3', 100, 3, { releaseNo: 1 })],
    routings,
    resources,
    dayMinutes: D,
    clubWindowDays: 0,
    plan: { manualOrder: ['O2', 'O3', 'O1'], groups: [], releases: new Map() },
  });
  assert.deepEqual(manual.sequence, ['O3', 'O2', 'O1']);
});

test('at risk: promises that are late now and were not before', () => {
  const before = new Map([
    ['A', { ship: 3, prom: 4 }],
    ['B', { ship: 6, prom: 4 }],
    ['C', { ship: 2, prom: 2 }],
  ]);
  const after = new Map([
    ['A', { ship: 5, prom: 4 }],
    ['B', { ship: 7, prom: 4 }],
    ['C', { ship: 2, prom: 2 }],
  ]);
  assert.deepEqual(atRisk(before, after), [
    { id: 'B', promise: 4, was: 6, now: 7, days: 3 },
    { id: 'A', promise: 4, was: 3, now: 5, days: 1 },
  ]);
});
