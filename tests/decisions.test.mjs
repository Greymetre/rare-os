import test from 'node:test';
import assert from 'node:assert/strict';
import {
  forwardPass,
  manualSequence,
  placeGroup,
  schedulePlant,
  workingDates,
} from '../packages/engines/scheduler.mjs';
import { compareClub, materialReadiness, orderTimes } from '../packages/engines/decisions.mjs';

// One drum D (1 machine, 100%, 60 min changeover), 480 minutes a day; A and B 1 min per unit.
const D = 480;
const dates = workingDates('2026-10-01', 60, '1111111');
const resources = new Map([
  ['D', { id: 'D', code: 'D', machines: 1, efficiency: 100, changeover: 60 }],
]);
const routings = new Map([
  ['A', [{ sequence: 10, code: 'D', resourceId: 'D', perUnit: 1 }]],
  ['B', [{ sequence: 10, code: 'D', resourceId: 'D', perUnit: 1 }]],
]);
const unit = (id, itemId, qty, day) => ({
  id,
  oid: id,
  ref: id,
  itemId,
  qty,
  dueDate: dates[day - 1],
  dueDay: day,
  orderDueDay: day,
});
const orders = [unit('o1', 'A', 100, 2), unit('o2', 'B', 100, 3), unit('o3', 'A', 100, 5)];
const ctx = (onHand) => ({
  boms: new Map([
    ['A', [{ componentId: 'C', qty: 1 }]],
    ['B', [{ componentId: 'K', qty: 2 }]],
  ]),
  onHand: new Map(onHand),
  supply: new Map([['C', [{ qty: 50, due: dates[3] }]]]),
  asOf: '2026-09-30',
  dates,
  dayMinutes: D,
  zones: new Map([['C', 'yellow']]),
  routings,
  resources,
  drumId: 'D',
  clubWindowDays: 3,
});

test('readiness: lots consume in start order; dated receipts count up to the release', () => {
  const r = schedulePlant({ orders, routings, resources, dayMinutes: D, clubWindowDays: 1 });
  const pass = { orders: new Map(r.orders.map((o) => [o.order.id, o])) };
  // 150 of C: o1 takes 100; o3 starts on day 1 too (plenty of capacity), 50 left, the receipt on
  // day 4 is after its release -> short 50. K has no stock record -> cannot validate.
  const m = materialReadiness(pass, ctx([['C', 150]]));
  assert.equal(m.get('o1').status, 'replenish');
  assert.equal(m.get('o3').status, 'expedite');
  assert.equal(m.get('o3').gaps[0].shortage, 50);
  assert.equal(m.get('o3').gaps[0].laterSupply[0].qty, 50);
  assert.equal(m.get('o2').status, 'unknown');
  const t = orderTimes(pass, D);
  assert.equal(t.get('o1').ship, 1);
  assert.equal(t.get('o1').prom, 2);
});

test('manual sequence and pinned groups', () => {
  const seq = manualSequence(orders, ['o3', 'o1']);
  // Listed orders in the planner's order; o2 goes before the first listed order due later (o3).
  assert.deepEqual(
    seq.map((u) => u.id),
    ['o2', 'o3', 'o1'],
  );
  assert.equal(seq[1].manualPlaced, true);
  assert.equal(seq[0].manualPlaced, undefined);
  const g = placeGroup(orders, ['o1', 'o3'], 2, 'o2', 'G1');
  assert.deepEqual(
    g.map((u) => [u.id, u.planGroup ?? null, u.planRelease ?? null]),
    [
      ['o1', 'G1', 2],
      ['o3', 'G1', 2],
      ['o2', null, null],
    ],
  );
  const pass = forwardPass({ sequence: g, routings, resources, dayMinutes: D });
  assert.equal(pass.orders.get('o1').start, D);
});

test('club compare: the recommended club saves a changeover; declub is always offered', () => {
  const r = schedulePlant({ orders, routings, resources, dayMinutes: D, clubWindowDays: 1 });
  const c = compareClub(
    r.units,
    [],
    'A',
    ctx([
      ['C', 1000],
      ['K', 1000],
    ]),
  );
  assert.deepEqual(c.ids, ['o1', 'o3']);
  assert.equal(c.search, 'all_subsets');
  const keys = c.scenarios.map((s) => s.key);
  assert.ok(keys.includes('declub'));
  assert.equal(c.recommended, 'recommended');
  {
    const rec = c.scenarios.find((s) => s.key === 'recommended');
    assert.deepEqual(rec.ids, ['o1', 'o3']);
    assert.ok(rec.savedMin > 0);
    assert.equal(rec.impact.broken.length, 0);
  }
});
