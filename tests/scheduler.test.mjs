import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
  dayFactor,
  dueDayIndex,
  dynamicLeadTime,
  forwardPass,
  groupedSequence,
  schedulePlant,
  workingDates,
} from '../packages/engines/scheduler.mjs';
import { planPlant } from '../packages/engines/ddmrp.mjs';

// Two resources: CUT (1 machine, 100%, 30 min changeover) then SEW (2 machines, 50%, no changeover).
const resources = new Map([
  ['CUT', { id: 'CUT', code: 'CUT', machines: 1, efficiency: 100, changeover: 30 }],
  ['SEW', { id: 'SEW', code: 'SEW', machines: 2, efficiency: 50, changeover: 0 }],
]);
const routings = new Map([
  [
    'A',
    [
      { sequence: 10, code: 'CU', resourceId: 'CUT', perUnit: 2 },
      { sequence: 20, code: 'SE', resourceId: 'SEW', perUnit: 1 },
    ],
  ],
  ['B', [{ sequence: 10, code: 'CU', resourceId: 'CUT', perUnit: 1 }]],
]);
const order = (id, itemId, qty, dueDate, dueDay) => ({ id, ref: id, itemId, qty, dueDate, dueDay });

test('allocation: least-loaded machine counting changeover; the same item stays on its machine', () => {
  const two = { id: 'X', machines: 2, efficiency: 100, changeover: 30 };
  const routes = new Map([
    ['A', [{ sequence: 10, code: 'X', resourceId: 'X', perUnit: 1 }]],
    ['B', [{ sequence: 10, code: 'X', resourceId: 'X', perUnit: 1 }]],
  ]);
  const a = allocate(
    two,
    [order('1', 'A', 100), order('2', 'B', 10), order('3', 'A', 10), order('4', 'B', 10)],
    routes,
  );
  // 1 -> m1 (100); 2 -> m2 (10); 3 is A: m1 costs 100, m2 costs 10 + 30 -> m2 with a changeover;
  // 4 is B right after A on m2... least loaded: m1 100 + 30 vs m2 50 + 30 -> m2.
  assert.deepEqual(
    ['1', '2', '3', '4'].map((id) => a.assigned.get(id + '|10')),
    [
      { machine: 1, changeover: 0 },
      { machine: 2, changeover: 0 },
      { machine: 2, changeover: 30 },
      { machine: 2, changeover: 30 },
    ],
  );
  assert.deepEqual([a.run, a.changeover, a.changeovers], [130, 60, 2]);
  // Consecutive orders of one item keep their machine even when another is less loaded.
  const b = allocate(two, [order('1', 'A', 100), order('2', 'A', 5)], routes);
  assert.equal(b.assigned.get('2|10').machine, 1);
});

test('forward pass: operations wait for their predecessor and never overtake on a machine; efficiency stretches time', () => {
  const seq = [order('1', 'A', 10, '2026-10-02', 2), order('2', 'B', 20, '2026-10-01', 1)];
  const { orders } = forwardPass({ sequence: seq, routings, resources, dayMinutes: 480 });
  const one = orders.get('1'),
    two = orders.get('2');
  // CUT 20 min, then SEW 10 min of work at 50% = 20 plant minutes.
  assert.deepEqual(
    one.ops.map((o) => [o.code, o.start, o.finish]),
    [
      ['CU', 0, 20],
      ['SE', 20, 40],
    ],
  );
  // Order 2 follows on CUT after a 30-minute changeover: 20 + 30 -> 50..70.
  assert.deepEqual([two.ops[0].start, two.ops[0].finish], [50, 70]);
  assert.deepEqual([one.shipDay, one.late, two.shipDay, two.late], [1, false, 1, false]);
  assert.equal(one.slack, 2 * 480 - 40);
});

test('grouping: same item inside the window runs back to back unless another order becomes late', () => {
  const orders = [
    order('A1', 'A', 10, '2026-10-01', 1),
    order('B1', 'B', 10, '2026-10-01', 1),
    order('A2', 'A', 10, '2026-10-02', 2),
    order('A3', 'A', 10, '2026-10-05', 5),
  ];
  const g = groupedSequence({ orders, routings, resources, dayMinutes: 480, clubWindowDays: 1 });
  // A2 (1 day after A1) joins A1; A3 is 4 days away and stays in due-date order.
  assert.deepEqual(
    g.sequence.map((o) => o.id),
    ['A1', 'A2', 'B1', 'A3'],
  );
  assert.deepEqual(g.groups, [{ anchor: 'A1', members: ['A1', 'A2'] }]);
  // With a tiny day, pulling A2 forward would make B1 later than its promise: refused.
  const tight = groupedSequence({
    orders: [
      order('A1', 'A', 10, '2026-10-01', 1),
      order('B1', 'B', 45, '2026-10-01', 1),
      order('A2', 'A', 10, '2026-10-02', 2),
    ],
    routings,
    resources,
    // B1 finishes at 95 of a 100-minute day; after A2 it would finish at 115, on day 2.
    dayMinutes: 100,
    clubWindowDays: 1,
  });
  assert.deepEqual(
    tight.sequence.map((o) => o.id),
    ['A1', 'B1', 'A2'],
  );
  assert.match(tight.refused[0].reason[0], /B1 later by 1 day/);
  // Window 0 = strict due-date order.
  const strict = groupedSequence({
    orders,
    routings,
    resources,
    dayMinutes: 480,
    clubWindowDays: 0,
  });
  assert.deepEqual(
    strict.sequence.map((o) => o.id),
    ['A1', 'B1', 'A2', 'A3'],
  );
});

test('plant schedule: drum = highest load over capacity, unrouted orders reported, self-check clean', () => {
  const s = schedulePlant({
    orders: [
      order('1', 'A', 100, '2026-10-01', 1),
      order('2', 'B', 50, '2026-10-02', 2),
      order('3', 'Z', 5, '2026-10-02', 2),
    ],
    routings,
    resources,
    dayMinutes: 480,
  });
  // CUT: 200 + 50 run + 30 changeover over 480/day; SEW: 100 over 2 x 480 x 50%.
  assert.equal(s.drumId, 'CUT');
  assert.deepEqual(
    s.unrouted.map((o) => o.id),
    ['3'],
  );
  assert.deepEqual(s.check, { backward: 0, overlaps: 0 });
  const cut = s.resources.find((r) => r.resourceId === 'CUT');
  assert.deepEqual([cut.run, cut.changeover, cut.changeovers], [250, 30, 1]);
  assert.equal(s.orders[0].late, false);
  // Busy share per day: CUT is busy 280 of 480 minutes on day 1.
  assert.ok(Math.abs(cut.days[0] - 280 / 480) < 1e-4);
});

test('dynamic lead time: master plus M/M/1 queue per routed resource; unbounded at 95%', () => {
  const r = dynamicLeadTime({
    leadTimeDays: 2,
    lot: 100,
    ops: [
      { perUnit: 6, capacityPerDay: 1200, utilization: 0.5 },
      { perUnit: 3, capacityPerDay: 600, utilization: 0.2 },
    ],
  });
  // 0.5 d x 1 + 0.5 d x 0.25 = 0.625 d of queue.
  assert.equal(r.queueDays, 0.625);
  assert.deepEqual([r.days, r.factor, r.unbounded], [2.625, 1.3125, false]);
  const full = dynamicLeadTime({
    leadTimeDays: 2,
    lot: 1,
    ops: [{ perUnit: 1, capacityPerDay: 1, utilization: 0.95 }],
  });
  assert.deepEqual([full.days, full.factor, full.unbounded], [null, null, true]);
  // Despatch profile: 31 shares; day 30 at 11.01% is 3.41 average days.
  const weights = Array(31).fill(100 / 31);
  weights[29] = 11.01;
  assert.ok(Math.abs(dayFactor(weights, 30) - 3.4131) < 1e-9);
  assert.equal(dayFactor(null, 7), 1);
});

test('calendar axis: working dates skip weekends and holidays; due dates map to working-day indexes', () => {
  // 2026-10-01 is a Thursday; Monday-Saturday calendar with a holiday on 2026-10-02.
  const dates = workingDates('2026-10-01', 4, '1111110', new Set(['2026-10-02']));
  assert.deepEqual(dates, ['2026-10-01', '2026-10-03', '2026-10-05', '2026-10-06']);
  assert.deepEqual(
    ['2026-09-30', '2026-10-01', '2026-10-04', '2026-10-05'].map((d) => dueDayIndex(d, dates)),
    [0, 1, 2, 3],
  );
});

test('buffers: a made item at planned loading scales its zones and times its planned make order', () => {
  const settings = [
    {
      itemId: 'FG',
      code: 'FG',
      makeBuy: 'MAKE',
      decimals: 0,
      policy: 'BUFFER',
      leadTimeDays: 2,
      aduOverride: null,
      profile: {
        method: 'WEEKLY',
        red_base_pct: 50,
        order_cycle_days: 7,
        zone_weeks: 4,
        cv_weeks: 4,
        order_multiple: 10,
      },
    },
  ];
  const input = (leadTimes) => ({
    today: '2026-07-27',
    settings,
    adu: new Map([['FG', 10]]),
    usage: new Map(),
    onHand: new Map([['FG', 0]]),
    supply: new Map(),
    demand: [],
    series: new Map([['FG', { weeks: [70, 70, 70, 70], blocks: [70, 70, 70, 70] }]]),
    stockKnown: new Set(['FG']),
    leadTimes,
  });
  const [fixed] = planPlant(input(new Map()));
  const [live] = planPlant(input(new Map([['FG', { days: 3, factor: 1.5, unbounded: false }]])));
  assert.deepEqual([fixed.zones.topOfRed, fixed.zones.topOfGreen], [46, 186]);
  assert.deepEqual([live.zones.topOfRed, live.zones.topOfGreen, live.leadTimeLive], [69, 279, 3]);
  const [stuck] = planPlant(
    input(new Map([['FG', { days: null, factor: null, unbounded: true }]])),
  );
  assert.equal(stuck.zones.topOfGreen, 186);
  assert.match(stuck.messages.join(' '), /unbounded at the planned loading/);
});
