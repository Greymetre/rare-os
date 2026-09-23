import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bufferVsMto,
  constraintStability,
  eventCurve,
  eventFactor,
  levelLoad,
  machineWhatIf,
  monthShape,
  schemeDemand,
  serviceCurve,
  serviceSimulation,
  spaceFit,
  targetScenario,
} from '../packages/engines/planning-tools.mjs';

// A month with a quiet start and a surge: 10 days at 2%, 10 at 3%, 10 at 5%.
const weights = [...Array(10).fill(2), ...Array(10).fill(3), ...Array(10).fill(5)];

test('month shape: what the surge asks of the constraint, and what the quiet days could take', () => {
  // 30,000 minutes of work in the month, 1,000 minutes a day of capacity.
  const s = monthShape(weights, 30000, 1000);
  assert.equal(s.days.length, 30);
  assert.deepEqual(
    [s.days[0].required, s.days[10].required, s.days[29].required],
    [600, 900, 1500],
  );
  // Only the last ten days go over: 500 minutes each.
  assert.equal(s.over, 5000);
  assert.equal(s.peakDay, 21);
  // The quiet two thirds have spare: 10 x 400 + 10 x 100, which is all the surge needs.
  assert.equal(s.prebuildable, 5000);
  assert.equal(s.lastThird, 50);
});

test('level production: the stock it has to carry, and when it peaks', () => {
  const l = levelLoad(weights, 30000);
  assert.equal(l.levelPercent, 3.3);
  // Stock builds while the month despatches less than it makes, and peaks before the surge.
  assert.equal(l.peakDay, 20);
  assert.equal(l.peakUnits, 5000);
  // By the end of the month it is back to where it started.
  assert.equal(l.endUnits, 0);
  assert.equal(levelLoad([], 100), null);
});

test('buffer or made to order: often and steady earns a buffer', () => {
  const steady = new Array(52).fill(10);
  const rare = new Array(52).fill(0).map((_, i) => (i % 13 === 0 ? 40 : 0));
  const lumpy = new Array(52).fill(0).map((_, i) => (i % 4 === 0 ? 80 : 0));
  const runner = bufferVsMto({
    itemId: 'A',
    code: 'A',
    weeks: steady,
    leadTimeDays: 7,
    unitCost: 5,
  });
  assert.deepEqual([runner.recommend, runner.ordersPerYear, runner.variability], ['BUFFER', 52, 0]);
  assert.equal(runner.coverUnits, 10);
  assert.equal(runner.coverValue, 50);
  const stranger = bufferVsMto({ itemId: 'B', code: 'B', weeks: rare, leadTimeDays: 7 });
  assert.equal(stranger.recommend, 'MTO');
  assert.match(stranger.reason, /only 4 weeks/);
  const uneven = bufferVsMto({ itemId: 'C', code: 'C', weeks: lumpy, leadTimeDays: 7 });
  assert.equal(uneven.recommend, 'MTO');
  assert.equal(uneven.often, true);
  assert.equal(uneven.steady, false);
  // A setting that disagrees with the recommendation is flagged.
  assert.equal(
    bufferVsMto({ itemId: 'D', code: 'D', weeks: rare, leadTimeDays: 7, policy: 'BUFFER' }).change,
    true,
  );
});

test('service simulation: more service is more safety, and the zones say so', () => {
  const weeks = [70, 84, 56, 77, 63, 91, 70, 70, 84, 56, 70, 77, 63];
  const item = { itemId: 'A', code: 'A', weeks, leadTimeDays: 7, orderCycleDays: 7, unitCost: 10 };
  const low = serviceSimulation(item, 0.85);
  const high = serviceSimulation(item, 0.95);
  assert.equal(low.adu, 10.2);
  assert.ok(high.topOfRed > low.topOfRed, 'more service needs more safety');
  assert.ok(high.topOfGreen > low.topOfGreen);
  assert.ok(high.fillPct >= low.fillPct);
  assert.equal(low.stockValue, low.averageStock * 10);
  // A steady item needs no safety at all.
  const flat = serviceSimulation({ ...item, weeks: new Array(13).fill(70) }, 0.95);
  assert.equal(flat.topOfRed, 0);
  assert.equal(flat.fillPct, 100);
  const curve = serviceCurve([item]);
  assert.deepEqual(
    curve.map((c) => c.service),
    [0.85, 0.9, 0.95],
  );
  assert.ok(curve[2].averageStock > curve[0].averageStock);
});

test('events and seasons: the zones rise early enough for the lead time', () => {
  const events = [
    { from: '2026-11-01', to: '2026-11-15', upliftPct: 50, itemIds: ['A'], family: '' },
    { from: '2026-12-01', to: '2026-12-10', upliftPct: 20, itemIds: [], family: 'MAT' },
  ];
  const a = { itemId: 'A', family: 'OTHER' };
  const b = { itemId: 'B', family: 'MAT' };
  // Ten days of lead time: the zone is up on 22-Oct, not on the 1st of November.
  assert.equal(eventFactor(events, a, '2026-10-20', 10), 1);
  assert.equal(eventFactor(events, a, '2026-10-23', 10), 1.5);
  assert.equal(eventFactor(events, a, '2026-11-20', 10), 1);
  // The second event names a family, not items.
  assert.equal(eventFactor(events, b, '2026-12-05', 0), 1.2);
  assert.equal(eventFactor(events, a, '2026-12-05', 0), 1);
  // An event with neither items nor a family covers the whole plant.
  assert.equal(
    eventFactor(
      [{ from: '2026-12-01', to: '2026-12-10', upliftPct: 10, itemIds: [], family: '' }],
      a,
      '2026-12-05',
      0,
    ),
    1.1,
  );
  const curve = eventCurve(a, events, {
    from: '2026-10-19',
    weeks: 4,
    topOfGreen: 100,
    leadTimeDays: 10,
  });
  assert.deepEqual(
    curve.map((w) => [w.date, w.planned, w.inWindow]),
    [
      ['2026-10-19', 100, false],
      ['2026-10-26', 150, false],
      ['2026-11-02', 150, true],
      ['2026-11-09', 150, true],
    ],
  );
});

test('scheme intake: an accepted scheme is demand inside the horizon', () => {
  const schemes = [
    { itemId: 'A', from: '2026-10-01', to: '2026-10-10', expectedUnits: 100, state: 'accepted' },
    { itemId: 'B', from: '2026-10-01', to: '2026-10-10', expectedUnits: 100, state: 'proposed' },
  ];
  // Ten days of 10 units; a horizon of five days counts half of it.
  assert.equal(Math.round(schemeDemand(schemes, '2026-10-01', 4).get('A')), 50);
  assert.equal(Math.round(schemeDemand(schemes, '2026-10-01', 30).get('A')), 100);
  assert.equal(schemeDemand(schemes, '2026-10-01', 30).has('B'), false);
  assert.equal(schemeDemand(schemes, '2026-11-01', 30).size, 0);
});

test('space mode: green is trimmed first, red and yellow are protected', () => {
  const rows = [
    { itemId: 'A', code: 'A', topOfRed: 10, topOfYellow: 30, topOfGreen: 60 },
    { itemId: 'B', code: 'B', topOfRed: 20, topOfYellow: 40, topOfGreen: 80 },
  ];
  const fits = spaceFit(rows, 200);
  assert.equal(fits.fits, true);
  assert.equal(fits.spare, 60);
  // 140 asked for, 105 available: the 70 units of green are cut in half.
  const tight = spaceFit(rows, 105);
  assert.equal(tight.fits, false);
  assert.equal(tight.greenKept, 50);
  assert.deepEqual(
    tight.rows.map((r) => [r.code, r.fitted]),
    [
      ['A', 45],
      ['B', 60],
    ],
  );
  // Below the yellow tops there is nothing left to trim: the set cannot fit.
  assert.equal(spaceFit(rows, 50).below, true);
});

test('target mode: the stock and the capacity a target asks for', () => {
  const weeks = new Array(13).fill(70);
  const items = [
    { itemId: 'A', code: 'A', weeks, leadTimeDays: 7, orderCycleDays: 7, unitCost: 10 },
    { itemId: 'B', code: 'B', weeks, leadTimeDays: 7, orderCycleDays: 7, unitCost: 10 },
  ];
  const up = targetScenario(items, 1.5, { capacityPerDay: 1000, minutesPerUnit: 2 });
  assert.equal(up.ratio, 1.5);
  assert.ok(up.deltaStock > 0);
  assert.equal(up.deltaValue, up.deltaStock * 10);
  // Two items at 10 a day each, half as much again: 10 extra units a day, 20 more minutes.
  assert.equal(up.addedMinutesPerDay, 20);
  assert.equal(up.utilisationPct, 102);
  const flat = targetScenario(items, 1, {});
  assert.equal(flat.rows.length, 0);
  assert.equal(flat.deltaStock, 0);
});

test('the network: how safely the constraint is the constraint, and what a machine would change', () => {
  const resources = [
    { resourceId: 'CUT', code: 'CUT', machines: 1, capacityPerDay: 480, load: 400, days: 1 },
    { resourceId: 'SEW', code: 'SEW', machines: 2, capacityPerDay: 960, load: 700, days: 1 },
  ];
  const s = constraintStability(resources);
  assert.equal(s.drum.code, 'CUT');
  assert.equal(s.next.code, 'SEW');
  assert.equal(s.gapPct, 10.4);
  assert.equal(s.stable, true);
  // A second machine on CUT halves its utilisation: the constraint moves to SEW.
  const w = machineWhatIf(resources, 'CUT', 2);
  assert.equal(w.moved, true);
  assert.equal(w.after.code, 'SEW');
  // A caller that already measured utilisation keeps its own number.
  assert.equal(
    constraintStability([
      { resourceId: 'X', code: 'X', capacityPerDay: 100, load: 0, utilisation: 0.9 },
    ]).drum.utilisation,
    0.9,
  );
  // ... but a machine change still moves that measured number, or the what-if would do nothing.
  const measured = [
    {
      resourceId: 'CUT',
      code: 'CUT',
      machines: 1,
      capacityPerDay: 480,
      load: 400,
      utilisation: 0.83,
    },
    {
      resourceId: 'SEW',
      code: 'SEW',
      machines: 2,
      capacityPerDay: 960,
      load: 700,
      utilisation: 0.72,
    },
  ];
  const m = machineWhatIf(measured, 'CUT', 2);
  assert.equal(m.before.code, 'CUT');
  assert.equal(m.after.code, 'SEW');
  assert.equal(m.moved, true);
  assert.equal(m.stability.rows.find((r) => r.code === 'CUT').utilisation, 0.415);
});
