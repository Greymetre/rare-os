import test from 'node:test';
import assert from 'node:assert/strict';
import { alerts, dayList, otif, timeBuffer } from '../packages/engines/delivery.mjs';

const order = (o) => ({ lots: 1, material: 'clear', state: 'planned', ...o });

test('OTIF: one late lot makes the whole order late', () => {
  const r = otif([
    order({ order: 'A', promiseDay: 5, shipDay: 4, lots: 2, lotsOnTime: 2 }),
    // Two lots, one of them late: the order is late and only one lot counts as on time.
    order({ order: 'B', promiseDay: 5, shipDay: 7, lots: 2, lotsOnTime: 1 }),
    order({ order: 'C', promiseDay: 9, shipDay: 9, lots: 1, lotsOnTime: 1 }),
    order({ order: 'D', promiseDay: 3, shipDay: null, lots: 1 }),
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.onTime, 2);
  assert.equal(r.orderPct, 67);
  // The lot view flatters: 4 of 5 lots are on time.
  assert.equal(r.lotPct, 80);
  assert.equal(r.unscheduled, 1);
  assert.deepEqual(
    r.late.map((o) => [o.order, o.lateDays]),
    [['B', 2]],
  );
});

test('time buffer: the runway to the promise, and what is left of it', () => {
  const D = 480;
  // Promised on day 5 (2,400 minutes of runway), finishing with 1,200 left: half used.
  assert.deepEqual(timeBuffer({ promiseDay: 5, shipDay: 3, slackMinutes: 1200 }, D), {
    runwayMinutes: 2400,
    slackMinutes: 1200,
    consumed: 50,
    zone: 'yellow',
  });
  assert.equal(timeBuffer({ promiseDay: 5, slackMinutes: 2300 }, D).zone, 'green');
  assert.equal(timeBuffer({ promiseDay: 5, slackMinutes: 300 }, D).zone, 'red');
  // Finishing after the promise: the protection is gone.
  const late = timeBuffer({ promiseDay: 5, shipDay: 6, slackMinutes: -480 }, D);
  assert.deepEqual([late.consumed, late.zone], [100, 'penetrated']);
  // Without a recorded slack it is derived from the days.
  assert.equal(timeBuffer({ promiseDay: 4, shipDay: 2 }, D).slackMinutes, 960);
});

test('alerts: every exception of the calculation, most serious first', () => {
  const feed = alerts({
    buffers: [
      { item: 'RM1', status: 'planned', zone: 'breach', recommended: null, outsideHorizon: 0 },
      { item: 'RM2', status: 'planned', zone: 'breach', recommended: 100, outsideHorizon: 0 },
      { item: 'RM3', status: 'planned', zone: 'yellow', recommended: 0, outsideHorizon: 25 },
      { item: 'RM4', status: 'missing', zone: null, outsideHorizon: 0 },
    ],
    orders: [
      { order: 'WO1', item: 'FG1', lateDays: 2, promise: '2026-10-02', finishDate: '2026-10-04' },
      { order: 'WO2', item: 'FG1', lateDays: 0, material: 'expedite' },
      { order: 'WO3', item: 'FG2', lateDays: 0, material: 'unknown' },
      { order: 'WO4', item: 'FG2', lateDays: 0, material: 'clear' },
    ],
    expedites: [
      {
        component: 'RM1',
        state: 'late',
        required: '2026-10-01',
        confirmation: { date: '2026-10-05' },
        members: ['WO2'],
      },
      { component: 'RM2', state: 'approved', members: ['WO2'] },
      { component: 'RM3', state: 'confirmed', members: ['WO2'] },
    ],
    pending: [{ order: 'WO9', original: '2026-10-01', proposed: '2026-10-09' }],
    downtime: [{ resource: 'CUT', minutes: 240, date: '2026-10-01', reason: 'Breakdown' }],
    atRisk: [{ order: 'WO5', promise: '2026-10-02', now: '2026-10-03' }],
  });
  assert.deepEqual(
    feed.map((a) => [a.severity, a.kind, a.subject]),
    [
      ['critical', 'stock', 'RM1'],
      ['critical', 'promise', 'WO1'],
      ['high', 'resource', 'CUT'],
      ['high', 'expedite', 'RM1'],
      ['high', 'stock', 'RM2'],
      ['high', 'material', 'WO2'],
      ['high', 'promise', 'WO5'],
      // A request waiting for the supplier is not as serious as one that came back late.
      ['medium', 'expedite', 'RM2'],
      ['medium', 'stock', 'RM3'],
      ['medium', 'material', 'WO3'],
      ['medium', 'customer', 'WO9'],
      ['low', 'sync', 'RM3'],
    ],
  );
  // A confirmed expedite and a clear order raise nothing; a missing buffer is not an alert.
  assert.equal(
    feed.some((a) => a.subject === 'WO4' || a.subject === 'RM4'),
    false,
  );
});

test("the planner's day: what to order, what to release, what to watch", () => {
  const day = dayList(
    {
      buffers: [
        { item: 'RM1', kind: 'BUY', recommended: 100, unit: 'NOS', due: '2026-10-01', zone: 'red' },
        {
          item: 'RM2',
          kind: 'BUY',
          recommended: 50,
          unit: 'NOS',
          due: '2026-10-05',
          zone: 'yellow',
        },
        { item: 'FG1', kind: 'MAKE', recommended: 20, unit: 'NOS', due: '2026-10-02', zone: 'red' },
        { item: 'RM3', kind: null, recommended: null, unit: 'NOS', due: null, zone: 'green' },
      ],
      releases: [
        {
          order: 'WO1',
          item: 'FG1',
          qty: 10,
          releaseDate: '2026-10-02',
          promise: '2026-10-04',
          material: 'clear',
          state: 'planned',
        },
        {
          order: 'WO2',
          item: 'FG1',
          qty: 10,
          releaseDate: '2026-10-02',
          promise: '2026-10-05',
          material: 'expedite',
          state: 'planned',
        },
        {
          order: 'WO3',
          item: 'FG2',
          qty: 10,
          releaseDate: '2026-10-08',
          promise: '2026-10-09',
          material: 'clear',
          state: 'planned',
        },
        {
          order: 'WO4',
          item: 'FG2',
          qty: 10,
          releaseDate: '2026-10-02',
          promise: '2026-10-03',
          material: 'clear',
          state: 'released',
        },
      ],
      alerts: [
        { severity: 'critical', subject: 'A' },
        { severity: 'medium', subject: 'B' },
        { severity: 'high', subject: 'C' },
      ],
    },
    '2026-10-01',
    '2026-10-02',
  );
  // Bought items only, overdue first.
  assert.deepEqual(
    day.order.map((r) => [r.item, r.overdue]),
    [
      ['RM1', true],
      ['RM2', false],
    ],
  );
  // Released work is already out; work due later is not today's.
  assert.deepEqual(
    day.make.map((r) => [r.order, r.hold]),
    [
      ['WO1', false],
      ['WO2', true],
    ],
  );
  assert.deepEqual(
    day.watch.map((a) => a.subject),
    ['A', 'C'],
  );
});
