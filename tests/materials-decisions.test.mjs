import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulePlant, workingDates } from '../packages/engines/scheduler.mjs';
import { snapshot } from '../packages/engines/decisions.mjs';
import {
  bundleState,
  confirmedSupply,
  expediteRows,
  laterDates,
  mergeActions,
  orderState,
} from '../packages/engines/materials-decisions.mjs';

// One machine M (480 min a day, no changeover); FG takes 1 min per unit and 1 RM per unit.
const D = 480;
const dates = workingDates('2026-10-01', 60, '1111111');
const resources = new Map([
  ['M', { id: 'M', code: 'M', machines: 1, efficiency: 100, changeover: 0 }],
]);
const routings = new Map([['FG', [{ sequence: 10, code: 'M', resourceId: 'M', perUnit: 1 }]]]);
const unit = (id, qty, day) => ({
  id,
  oid: id,
  ref: id,
  itemId: 'FG',
  qty,
  dueDate: dates[day - 1],
  dueDay: day,
  orderDueDay: day,
});
const line = (key, qty, due, extra = {}) => ({
  key,
  lineId: key,
  poNo: 'PO1',
  lineNo: key,
  qty,
  due,
  ...extra,
});
const ctxWith = (onHand, supply) => ({
  boms: new Map([['FG', [{ componentId: 'RM', qty: 1 }]]]),
  onHand: new Map(onHand === null ? [] : [['RM', onHand]]),
  supply: new Map([['RM', supply]]),
  asOf: '2026-09-30',
  dates,
  dayMinutes: D,
  zones: new Map(),
  routings,
  resources,
  drumId: 'M',
  clubWindowDays: 1,
});
const plan = (orders) =>
  schedulePlant({ orders, routings, resources, dayMinutes: D, clubWindowDays: 0 }).units;

test('expedite rows: later purchase lines first, then overdue ones, the rest as a new purchase', () => {
  // O1 needs 100 RM on day 1 (2026-10-01); 30 on hand; lines: 20 due 10-05, 10 due 10-03, 5 overdue.
  const supply = [
    line('L1', 20, '2026-10-05'),
    line('L2', 10, '2026-10-03'),
    line('L3', 5, '2026-09-20'),
  ];
  const ctx = ctxWith(30, supply);
  const snap = snapshot(plan([unit('O1', 100, 3)]), ctx);
  assert.equal(snap.materials.get('O1').status, 'expedite');
  const rows = expediteRows(snap, ['O1'], ctx.supply, ctx.asOf);
  assert.deepEqual(
    rows.map((r) => [r.type, r.lineNo ?? null, r.qty, r.required, r.currentDue ?? null]),
    [
      ['EXPEDITE_PO', 'L2', 10, '2026-10-01', '2026-10-03'],
      ['EXPEDITE_PO', 'L1', 20, '2026-10-01', '2026-10-05'],
      ['EXPEDITE_PO', 'L3', 5, '2026-10-01', '2026-09-20'],
      ['NEW_PO', null, 35, '2026-10-01', null],
    ],
  );
  assert.deepEqual(rows[0].members, ['O1']);
  // No stock record: cannot validate, nothing a supplier can confirm.
  const unknown = ctxWith(null, supply);
  const u = expediteRows(
    snapshot(plan([unit('O1', 100, 3)]), unknown),
    ['O1'],
    unknown.supply,
    unknown.asOf,
  );
  assert.deepEqual(
    u.map((r) => [r.type, r.qty]),
    [['CANNOT_VALIDATE', null]],
  );
});

test('confirmations: only a recorded supplier date moves supply; the rest keeps its due date', () => {
  const supply = new Map([['RM', [line('L1', 90, '2026-10-05')]]]);
  const approved = {
    id: 'A1',
    componentId: 'RM',
    supplyKey: 'L1',
    state: 'approved',
    confirmation: null,
  };
  assert.deepEqual(confirmedSupply(supply, [approved]).get('RM'), supply.get('RM'));
  const confirmed = {
    ...approved,
    state: 'confirmed',
    confirmation: { date: '2026-10-01', qty: 10 },
  };
  assert.deepEqual(
    confirmedSupply(supply, [confirmed])
      .get('RM')
      .map((p) => [p.qty, p.due]),
    [
      [10, '2026-10-01'],
      [80, '2026-10-05'],
    ],
  );
  const rejected = { ...confirmed, state: 'rejected' };
  assert.equal(confirmedSupply(supply, [rejected]).get('RM').length, 1);
  const created = {
    id: 'A2',
    type: 'NEW_PO',
    componentId: 'RM',
    state: 'confirmed',
    confirmation: { date: '2026-10-02', qty: 7 },
  };
  assert.deepEqual(
    confirmedSupply(supply, [created])
      .get('RM')
      .map((p) => [p.qty, p.due]),
    [
      [90, '2026-10-05'],
      [7, '2026-10-02'],
    ],
  );
});

test('order state follows the evidence, not the request', () => {
  const gated = { gated: true, lines: [{ componentId: 'RM', release: '2026-10-01' }] };
  const clear = { gated: false, lines: [{ componentId: 'RM', release: '2026-10-01' }] };
  const act = (state, confirmation = null) => [
    { id: 'A1', componentId: 'RM', members: ['O1'], bundles: ['B1'], state, confirmation },
  ];
  const p = { state: 'scheduled', bundleId: 'B1' };
  assert.equal(orderState('O1', gated, null, []), 'decision_required');
  assert.equal(orderState('O1', gated, p, act('requested')), 'expedite_pending');
  assert.equal(orderState('O1', gated, p, act('approved')), 'expedite_pending');
  assert.equal(
    orderState('O1', gated, p, act('late', { date: '2026-10-05' })),
    'decision_required',
  );
  assert.equal(orderState('O1', gated, p, act('rejected')), 'decision_required');
  assert.equal(
    orderState('O1', clear, p, act('confirmed', { date: '2026-10-01' })),
    'conditional_expedite',
  );
  // Covered later by the original stock or supply: no expedite needed.
  assert.equal(
    orderState('O1', clear, p, act('confirmed', { date: '2026-10-09' })),
    'material_clear',
  );
  assert.equal(
    orderState('O1', gated, { state: 'awaiting_confirmation' }, []),
    'awaiting_confirmation',
  );
  assert.equal(bundleState([{ state: 'approved' }, { state: 'late' }]), 'quote_later_required');
  assert.equal(bundleState([{ state: 'approved' }, { state: 'approved' }]), 'approved');
  assert.equal(bundleState([{ state: 'confirmed' }]), 'confirmed');
  assert.equal(bundleState([{ state: 'requested' }, { state: 'approved' }]), 'requested');
});

test('a repeated request merges into the open action; a short confirmation reopens it', () => {
  const existing = [
    {
      id: 'A1',
      key: 'RM|L1',
      qty: 10,
      required: '2026-10-03',
      state: 'confirmed',
      members: ['O1'],
      dependents: [{ id: 'O1', lot: 'O1', qty: 10 }],
      confirmation: { date: '2026-10-02', qty: 10 },
    },
  ];
  const [a] = mergeActions(existing, [
    {
      key: 'RM|L1',
      qty: 5,
      required: '2026-10-01',
      members: ['O2'],
      dependents: [{ id: 'O2', lot: 'O2', qty: 5 }],
    },
  ]);
  assert.equal(a.isNew, false);
  assert.equal(a.qty, 15);
  assert.equal(a.required, '2026-10-01');
  assert.equal(a.state, 'requested');
  assert.deepEqual(a.members, ['O1', 'O2']);
  const [b] = mergeActions(existing, [{ key: 'RM|new', type: 'NEW_PO', qty: 3, members: ['O3'] }]);
  assert.equal(b.isNew, true);
  assert.equal(b.state, 'requested');
});

test('later date: the earliest date materials support, or a conditional quote; candidate checks', () => {
  // O1 (100) needs RM from 2026-10-01; 20 on hand and 200 arrive on 2026-10-04 (day 4).
  const ctx = ctxWith(20, [line('L1', 200, '2026-10-04')]);
  const current = plan([unit('O1', 100, 2)]);
  const units = current.filter((u) => u.oid === 'O1');
  const r = laterDates({ current, units, id: 'O1', ctx, originalPromise: 2 });
  const best = r.scenarios[0];
  assert.equal(best.normal, true);
  assert.equal(best.day, 4);
  assert.equal(best.promise, 4);
  assert.equal(best.status, 'clear');
  assert.equal(best.moveSlip, 2);
  // A candidate before the material arrives: capacity fits, materials do not - only conditional.
  const early = laterDates({ current, units, id: 'O1', ctx, candidate: 3, originalPromise: 2 });
  assert.ok(early.scenarios.every((s) => !s.normal));
  assert.equal(early.scenarios[0].capacityOK, true);
  assert.equal(early.scenarios[0].status, 'expedite');
  // A candidate before the full-route finish is refused for capacity.
  const tight = laterDates({
    current: plan([unit('O1', 900, 2)]),
    units: plan([unit('O1', 900, 2)]),
    id: 'O1',
    ctx: ctxWith(1000, []),
    candidate: 1,
    originalPromise: 2,
  });
  assert.ok(tight.scenarios.every((s) => s.late && !s.capacityOK));
  // A candidate after the material date is supported and carries finished stock until then.
  const later = laterDates({ current, units, id: 'O1', ctx, candidate: 6, originalPromise: 2 });
  assert.equal(later.scenarios[0].normal, true);
  assert.equal(later.scenarios[0].promise, 6);
  assert.ok(later.scenarios[0].carryUnits > 0);
});

test('later date: a placement that takes material from another order is not supported', () => {
  // O1 (20) and O2 (20) share 30 RM on hand. Taking O2 first would short O1.
  const ctx = ctxWith(30, []);
  const current = plan([unit('O1', 20, 2), unit('O2', 20, 5)]);
  const units = current.filter((u) => u.oid === 'O2');
  const r = laterDates({ current, units, id: 'O2', ctx, originalPromise: 5 });
  for (const s of r.scenarios) {
    if (s.beforeId === 'O1') assert.deepEqual(s.materialHurt, ['O1']);
    assert.equal(s.normal, false);
  }
});
