import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allocate,
  forwardPass,
  schedulePlant,
  workingDates,
} from '../packages/engines/scheduler.mjs';
import { orderTimes } from '../packages/engines/decisions.mjs';
import {
  drumBook,
  inheritBom,
  matchOddSize,
  placements,
  rushInsert,
  simulateInsert,
  sizeOfCode,
} from '../packages/engines/insert.mjs';

// One drum D (1 machine, 100%, 30 min changeover), 480 minutes a day. A = 1 min, B = 2 min per unit.
const D = 480;
const dates = workingDates('2026-10-01', 60, '1111111');
const resources = new Map([
  ['D', { id: 'D', code: 'D', machines: 1, efficiency: 100, changeover: 30 }],
]);
const routings = new Map([
  ['A', [{ sequence: 10, code: 'D', resourceId: 'D', perUnit: 1 }]],
  ['B', [{ sequence: 10, code: 'D', resourceId: 'D', perUnit: 2 }]],
]);
const unit = (id, itemId, qty, day, extra = {}) => ({
  id,
  oid: id,
  ref: id,
  itemId,
  qty,
  dueDate: dates[day - 1],
  dueDay: day,
  orderDueDay: day,
  ...extra,
});
// Book: o1 A 200 (day 1), o2 B 100 (day 2), o3 A 100 (day 3): 200 + 30 + 200 + 30 + 100 = 560 min.
const orders = [unit('o1', 'A', 200, 1), unit('o2', 'B', 100, 2), unit('o3', 'A', 100, 3)];
const book = { orders, routings, resources, dayMinutes: D, clubWindowDays: 1 };
const setup = (onHandC = 1000) => {
  const r = schedulePlant(book);
  const ctx = {
    boms: new Map([
      ['A', [{ componentId: 'C', qty: 1 }]],
      ['B', [{ componentId: 'C', qty: 1 }]],
    ]),
    onHand: new Map([['C', onHandC]]),
    supply: new Map(),
    asOf: '2026-09-30',
    dates,
    dayMinutes: D,
    zones: new Map(),
    routings,
    resources,
    drumId: 'D',
    clubWindowDays: 1,
  };
  const env = {
    today: '2026-09-30',
    dates,
    current: r.units,
    baseTimes: orderTimes(forwardPass({ ...book, sequence: r.units }), D),
    baseDrum: allocate(resources.get('D'), r.units, routings).changeover,
    drum: drumBook(r.units, ctx),
  };
  return { r, ctx, env };
};

test('drum placement: free minutes per day and the four ways of saying yes', () => {
  const { env } = setup();
  assert.equal(env.drum.total, 560);
  assert.deepEqual(
    [1, 2, 3].map((d) => env.drum.free.get(d).free),
    [0, 400, 480],
  );
  const p = placements([{ itemId: 'A', qty: 300, needDay: 3 }], env.drum);
  const s = p.scenarios;
  // Whole now: first on the drum, o1 slips into day 2 and breaks its promise.
  assert.deepEqual(s.whole_now.lines[0].lots, [{ qty: 300, day: 1 }]);
  assert.equal(s.whole_now.chgMinAdded, 30);
  assert.equal(s.whole_now.promisesBroken, 1);
  assert.equal(s.whole_now.carryUnits, 600);
  // Latest window before the need-by: day 3, a changeover (the book ends on day 2).
  assert.deepEqual(s.whole_late.lines[0].lots, [{ qty: 300, day: 3 }]);
  assert.deepEqual(s.split.lines[0].lots, [{ qty: 300, day: 3 }]);
  // Decline: the earliest date that displaces nothing.
  assert.equal(s.decline.lines[0].quoteDay, 2);
  // No promise broken, need-by met: least changeover, carry, lots; a one-lot split loses the tie.
  assert.equal(p.rec, 'whole_late');
});

test('split: walks back from the need-by date with at most two lots', () => {
  const { env } = setup();
  const p = placements([{ itemId: 'A', qty: 700, needDay: 3 }], env.drum);
  assert.deepEqual(p.scenarios.split.lines[0].lots, [
    { qty: 250, day: 2 },
    { qty: 450, day: 3 },
  ]);
  // Day 2 follows o3 (also A) at the end of the book: no changeover there.
  assert.equal(p.scenarios.split.chgMinAdded, 30);
  assert.equal(p.scenarios.whole_late.feasible, false);
  assert.equal(p.scenarios.whole_late.reasons[0].code, 'no_window');
  assert.equal(p.rec, 'split');
});

test('dated insert: every option checked forward; materials decide the recommendation', () => {
  const ok = setup(1000);
  const res = simulateInsert([{ itemId: 'A', qty: 300, needDay: 3 }], 'N', book, ok.ctx, ok.env);
  assert.equal(res.scenarios.whole_now.capacityBroken.length, 1);
  assert.equal(res.scenarios.whole_late.fullRouteFinish, 3);
  assert.equal(res.scenarios.whole_late.materials.status, 'clear');
  assert.equal(res.supported, true);
  // Supported options sort on changeover then carry only.
  assert.equal(res.rec, 'split');
  // 500 of C: o1 and o3 take 300 before the new lot starts on day 3.
  const short = setup(500);
  const r2 = simulateInsert(
    [{ itemId: 'A', qty: 300, needDay: 3 }],
    'N',
    book,
    short.ctx,
    short.env,
  );
  assert.equal(r2.scenarios.whole_late.materials.status, 'expedite');
  assert.equal(r2.supported, false);
  assert.equal(r2.rec, 'whole_late');
});

test('rush: every insertion position is priced; the quote is the forward finish', () => {
  const { ctx, env } = setup();
  const res = rushInsert({ itemId: 'B', qty: 50 }, 'R', book, ctx, env);
  assert.equal(res.evaluated, 4);
  const rec = res.scenarios[res.rec];
  assert.equal(rec.label, 'Earliest supported promise');
  assert.equal(rec.promisesBroken, 0);
  assert.ok(rec.quoteDay >= 1);
});

test('scheduler: inserted and rush orders keep their placement and start no new club', () => {
  const units = [
    unit('o1', 'A', 10, 1),
    unit('o2', 'B', 10, 1),
    unit('o3', 'A', 10, 2),
    unit('n1', 'B', 10, 2, { noAutoGroup: true, lotDay: 2 }),
  ];
  const s = schedulePlant({ ...book, orders: units });
  // o3 joins o1 as it would without n1; n1 is not pulled next to o2.
  assert.deepEqual(s.sequence, ['o1', 'o3', 'o2', 'n1']);
  const r = schedulePlant({
    ...book,
    orders: [...units.slice(0, 3), unit('r1', 'B', 10, 3, { rushBefore: 'o2' })],
  });
  assert.deepEqual(r.sequence, ['o1', 'o3', 'r1', 'o2']);
});

test('odd size: nearest standard of the family, area-scaled routing, inherited BOM', () => {
  assert.deepEqual(sizeOfCode('MFRTDZREDSSQ72304'), [72, 30, 4]);
  const routes = new Map([
    [
      'S1',
      [
        { sequence: 10, code: 'QU02', resourceId: 'D', perUnit: 1.05 },
        { sequence: 20, code: 'IP02', resourceId: 'D', perUnit: 1.4 },
      ],
    ],
    ['S2', [{ sequence: 10, code: 'QU02', resourceId: 'D', perUnit: 2 }]],
  ]);
  const m = matchOddSize(
    'FAM',
    [75, 30, 4],
    [
      { itemId: 'S1', code: 'FAMX72304' },
      { itemId: 'S2', code: 'FAMX78725' },
      { itemId: 'S3', code: 'OTHER72304' },
    ],
    routes,
    ['QU02'],
  );
  assert.equal(m.source.itemId, 'S1');
  assert.equal(m.exactThickness, true);
  assert.equal(m.scale, (75 * 30) / (72 * 30));
  assert.deepEqual(
    m.ops.map((o) => o.perUnit),
    [1.094, 1.4],
  );
  const b = inheritBom(
    [
      { componentId: 'FOAM', qty: 12, unit: 'M' },
      { componentId: 'LABEL', qty: 1, unit: 'NOS' },
      { componentId: 'GLUE', qty: 0.29, unit: 'KG' },
    ],
    [72, 30, 4],
    [75, 30, 5],
  );
  assert.deepEqual(
    b.lines.map((l) => +l.qty.toFixed(6)),
    [12.5, 1, +((0.29 * 75 * 5) / (72 * 4)).toFixed(6)],
  );
  assert.equal(
    inheritBom([{ componentId: 'X', qty: 1, unit: 'BOX' }], [1, 1, 1], [1, 1, 1]).ok,
    false,
  );
  assert.equal(matchOddSize('NONE', [1, 1, 1], [], routes, []).ok, false);
});
