import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAIM_STATUSES,
  LINE_REASONS,
  NOT_AT_WORK,
  canDecide,
  claimTotals,
  lineAmount,
  money,
  nextStage,
  periodOf,
  placeClass,
  policyFor,
  policyIsOpen,
  rateFor,
  rateKeyFor,
} from '../packages/engines/expense.mjs';
import { permissions, requiredPermissions } from '../packages/schema/permissions.mjs';

// The client's own numbers, from question 9 of the milestone plan: a bike at 3.5 a kilometre and
// a car at 9; a daily allowance of 250 at headquarters, 400 out of it and 600 away overnight;
// lodging capped by grade; a phone bill capped at 500 a fortnight; a receipt above 200.
const CATEGORIES = {
  km: { id: 'c-km', code: 'KM', basis: 'KM', receipt_above: null },
  da: { id: 'c-da', code: 'DA', basis: 'DAILY', receipt_above: null },
  stay: { id: 'c-stay', code: 'STAY', basis: 'NIGHTLY', receipt_above: 200 },
  phone: { id: 'c-phone', code: 'PHONE', basis: 'ACTUAL', receipt_above: 200 },
};

const RATES = [
  { category_id: 'c-km', key: 'BIKE', rate: 3.5, cap: null },
  { category_id: 'c-km', key: 'CAR', rate: 9, cap: null },
  { category_id: 'c-da', key: 'HQ', rate: 250, cap: null },
  { category_id: 'c-da', key: 'EX_HQ', rate: 400, cap: null },
  { category_id: 'c-da', key: 'OUTSTATION', rate: 600, cap: null },
  { category_id: 'c-stay', key: 'E1', rate: 2500, cap: 2500 },
  { category_id: 'c-stay', key: 'E2', rate: 1800, cap: 1800 },
  { category_id: 'c-phone', key: '', rate: null, cap: 500 },
];

const priceOf = (over = {}) => {
  const {
    category = CATEGORIES.da,
    line = {},
    dayStatus = 'PRESENT',
    place = { place: 'EX_HQ', town: 'Hisar', source: 'PLAN' },
    hasReceipt = false,
    grade = 'E1',
    vehicle = '',
  } = over;
  const key = rateKeyFor({ basis: category.basis, vehicle, place: place?.place, grade });
  return lineAmount({
    line,
    category,
    rate: rateFor({ rates: RATES, categoryId: category.id, key }),
    dayStatus,
    place,
    hasReceipt,
  });
};

test('the milestone acceptance: a day the register says the rep was not at work earns no daily allowance', () => {
  for (const status of NOT_AT_WORK) {
    const row = priceOf({ dayStatus: status });
    assert.equal(row.allowed, 0, `${status} earned a daily allowance`);
    assert.ok(row.reasons.includes('NOT_AT_WORK'));
  }
  // And the same line on a day that was worked earns the full rate for where it was spent.
  assert.equal(priceOf({ dayStatus: 'PRESENT' }).allowed, 400);
  assert.equal(priceOf({ dayStatus: 'LATE' }).allowed, 400);
  // Every reason the engine can give is a sentence a screen can print as it is.
  for (const reason of Object.keys(LINE_REASONS))
    assert.equal(typeof LINE_REASONS[reason], 'string');
});

test('the milestone acceptance: a line over the limit is capped, and says so, rather than refused', () => {
  const row = priceOf({
    category: CATEGORIES.stay,
    line: { nights: 2, claimed_amount: 6000 },
    grade: 'E2',
  });
  // Two nights at 1800 is 3600, but the policy caps the line at 1800.
  assert.equal(row.computed, 3600);
  assert.equal(row.allowed, 1800);
  assert.equal(row.capped, true);
  assert.ok(row.reasons.includes('CAPPED'));
  // What was asked for is still on the line. An approver sees both numbers.
  assert.equal(row.claimed, 6000);
});

test('the milestone acceptance: one person cannot approve a claim as both manager and finance', () => {
  const claim = { status: 'SUBMITTED', rep_user_id: 'rep', manager_by: null };
  // A manager who is not the rep may pass it.
  assert.equal(
    canDecide({ claim, stage: 'MANAGER', actorId: 'boss', repUserId: 'rep' }).allowed,
    true,
  );
  // The rep may not, at either stage.
  assert.equal(
    canDecide({ claim, stage: 'MANAGER', actorId: 'rep', repUserId: 'rep' }).allowed,
    false,
  );

  const passed = { status: 'MANAGER_OK', manager_by: 'boss' };
  // Finance may approve it — unless finance is the same person who passed it as its manager.
  assert.equal(
    canDecide({ claim: passed, stage: 'FINANCE', actorId: 'cashier', repUserId: 'rep' }).allowed,
    true,
  );
  const blocked = canDecide({ claim: passed, stage: 'FINANCE', actorId: 'boss', repUserId: 'rep' });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason, /somebody else/);
});

test('a claim walks one way and cannot skip a stage', () => {
  assert.equal(nextStage('SUBMITTED'), 'MANAGER');
  assert.equal(nextStage('MANAGER_OK'), 'FINANCE');
  for (const settled of ['DRAFT', 'APPROVED', 'REJECTED']) assert.equal(nextStage(settled), null);
  // Finance cannot reach a claim a manager has not passed.
  const early = canDecide({ claim: { status: 'SUBMITTED' }, stage: 'FINANCE', actorId: 'cashier' });
  assert.equal(early.allowed, false);
  assert.match(early.reason, /manager has to pass/);
  // A draft is waiting for the rep, not for anybody else.
  assert.equal(
    canDecide({ claim: { status: 'DRAFT' }, stage: 'MANAGER', actorId: 'boss' }).allowed,
    false,
  );
  assert.deepEqual(CLAIM_STATUSES, ['DRAFT', 'SUBMITTED', 'MANAGER_OK', 'APPROVED', 'REJECTED']);
});

test('a policy version governs the dates it was in force for, and a later one does not reach back', () => {
  const policies = [
    { id: 'old', effective_from: '2026-01-01' },
    { id: 'new', effective_from: '2026-12-01' },
  ];
  assert.equal(policyFor({ policies, date: '2026-11-20' }).id, 'old');
  assert.equal(policyFor({ policies, date: '2026-12-01' }).id, 'new');
  // Before any version started, there is nothing to pay against — which is not nought.
  assert.equal(policyFor({ policies, date: '2025-06-01' }), null);
  // A version that has been switched off is not in force.
  assert.equal(
    policyFor({
      policies: [{ id: 'x', effective_from: '2026-01-01', active: false }],
      date: '2026-11-20',
    }),
    null,
  );
});

test('a policy version may be edited until it starts, and never afterwards', () => {
  const today = '2026-11-20';
  assert.equal(policyIsOpen({ effective_from: '2026-12-01' }, today), true);
  // The day it starts, it is already governing that day's claims.
  assert.equal(policyIsOpen({ effective_from: today }, today), false);
  assert.equal(policyIsOpen({ effective_from: '2026-01-01' }, today), false);
  assert.equal(policyIsOpen(null, today), false);
});

test('where the day was spent is read from the plan, not from what the rep typed', () => {
  const hq = 'Rohtak';
  // The plan sent the rep to Hisar; the claim says Hisar too.
  assert.deepEqual(placeClass({ hqTown: hq, plannedTown: 'Hisar', claimedTown: 'Hisar' }), {
    place: 'EX_HQ',
    town: 'Hisar',
    source: 'PLAN',
  });
  // The plan kept the rep at headquarters. Typing a far town on the claim does not earn the
  // higher rate — this is the whole point of preferring the plan.
  const gamed = placeClass({ hqTown: hq, plannedTown: 'Rohtak', claimedTown: 'Hisar' });
  assert.equal(gamed.place, 'HQ');
  assert.equal(gamed.source, 'PLAN');
  // With no plan day, what the rep typed is used, and the answer says so.
  const unplanned = placeClass({ hqTown: hq, plannedTown: '', claimedTown: 'Hisar' });
  assert.equal(unplanned.place, 'EX_HQ');
  assert.equal(unplanned.source, 'CLAIM');
  // Town matching ignores case and stray spaces; a night away outranks the town either way.
  assert.equal(placeClass({ hqTown: hq, plannedTown: ' rohtak ' }).place, 'HQ');
  assert.equal(placeClass({ hqTown: hq, plannedTown: 'Rohtak', nights: 1 }).place, 'OUTSTATION');
});

test('kilometres are priced by the vehicle, and the rate is the policy’s', () => {
  const bike = priceOf({
    category: CATEGORIES.km,
    vehicle: 'BIKE',
    line: { km: 42, claimed_amount: 147 },
  });
  assert.equal(bike.units, 42);
  assert.equal(bike.rate, 3.5);
  assert.equal(bike.allowed, 147);
  const car = priceOf({
    category: CATEGORIES.km,
    vehicle: 'CAR',
    line: { km: 42, claimed_amount: 378 },
  });
  assert.equal(car.allowed, 378);
  // A rate the policy does not set is not nought: nobody can be told what they earn until the
  // company has said so.
  const unknown = priceOf({
    category: CATEGORIES.km,
    vehicle: 'TRUCK',
    line: { km: 42, claimed_amount: 500 },
  });
  assert.equal(unknown.allowed, 0);
  assert.ok(unknown.reasons.includes('NO_RATE'));
});

test('a line is never paid more than was asked for, and a receipt blocks rather than zeroes', () => {
  // The policy would allow 400, but the rep asked for 150.
  const modest = priceOf({ line: { claimed_amount: 150 } });
  assert.equal(modest.computed, 400);
  assert.equal(modest.allowed, 150);

  // A phone bill at actuals, above the receipt limit, with nothing attached.
  const noPaper = priceOf({
    category: CATEGORIES.phone,
    line: { claimed_amount: 320 },
    place: null,
  });
  assert.ok(noPaper.reasons.includes('RECEIPT_MISSING'));
  // The money is still there. A real expense is not hidden behind a missing piece of paper; the
  // claim simply cannot be sent in until it is attached.
  assert.equal(noPaper.allowed, 320);
  const withPaper = priceOf({
    category: CATEGORIES.phone,
    line: { claimed_amount: 320 },
    place: null,
    hasReceipt: true,
  });
  assert.deepEqual(withPaper.reasons, []);
  // Below the limit no receipt is asked for.
  assert.deepEqual(
    priceOf({ category: CATEGORIES.phone, line: { claimed_amount: 180 }, place: null }).reasons,
    [],
  );
});

test('a cap over the whole claim bites the last expense, not an arbitrary one', () => {
  const line = (spend_date, claimed) => ({
    category_id: 'c-phone',
    spend_date,
    claimed,
    allowed: claimed,
    capped: false,
    reasons: [],
  });
  // Three phone bills in one fortnight against a cap of 500.
  const totals = claimTotals({
    lines: [line('2026-11-10', 300), line('2026-11-02', 300), line('2026-11-14', 100)],
    periodCaps: { 'c-phone': 500 },
  });
  const byDate = Object.fromEntries(totals.lines.map((l) => [l.spend_date, l.allowed]));
  assert.equal(byDate['2026-11-02'], 300);
  assert.equal(byDate['2026-11-10'], 200);
  assert.equal(byDate['2026-11-14'], 0);
  assert.equal(totals.claimed, 700);
  assert.equal(totals.allowed, 500);
  assert.equal(totals.disallowed, 200);
  assert.equal(totals.capped, 2);
  // A category with no cap is left alone.
  const free = claimTotals({ lines: [line('2026-11-02', 900)], periodCaps: {} });
  assert.equal(free.allowed, 900);
  assert.equal(free.disallowed, 0);
});

test('a claim counts what it is asking for, what it may have, and what cannot go in yet', () => {
  const totals = claimTotals({
    lines: [
      {
        category_id: 'a',
        spend_date: '2026-11-02',
        claimed: 400,
        allowed: 400,
        capped: false,
        reasons: [],
      },
      {
        category_id: 'a',
        spend_date: '2026-11-03',
        claimed: 600,
        allowed: 0,
        capped: false,
        reasons: ['NOT_AT_WORK'],
      },
      {
        category_id: 'b',
        spend_date: '2026-11-04',
        claimed: 320,
        allowed: 320,
        capped: false,
        reasons: ['RECEIPT_MISSING'],
      },
    ],
  });
  assert.equal(totals.count, 3);
  assert.equal(totals.claimed, 1320);
  assert.equal(totals.allowed, 720);
  assert.equal(totals.disallowed, 600);
  assert.equal(totals.blocked, 1);
});

test('claims come in fortnightly, and the second half runs to the end of whatever month it is', () => {
  assert.deepEqual(periodOf('2026-11-03'), { from: '2026-11-01', to: '2026-11-15' });
  assert.deepEqual(periodOf('2026-11-15'), { from: '2026-11-01', to: '2026-11-15' });
  assert.deepEqual(periodOf('2026-11-16'), { from: '2026-11-16', to: '2026-11-30' });
  assert.deepEqual(periodOf('2026-12-31'), { from: '2026-12-16', to: '2026-12-31' });
  // February, and February in a leap year.
  assert.deepEqual(periodOf('2026-02-20'), { from: '2026-02-16', to: '2026-02-28' });
  assert.deepEqual(periodOf('2024-02-20'), { from: '2024-02-16', to: '2024-02-29' });
  // A company that claims monthly instead.
  assert.deepEqual(periodOf('2026-11-03', { fortnightly: false }), {
    from: '2026-11-01',
    to: '2026-11-30',
  });
  // A date that is not one is not guessed at.
  for (const bad of ['2026-13-01', '2026-02-30', 'yesterday', '', null])
    assert.equal(periodOf(bad), null);
});

test('money rounds to the paisa, so a total is the sum of its lines', () => {
  assert.equal(money(3.5 * 7), 24.5);
  assert.equal(money(0.1 + 0.2), 0.3);
  assert.equal(money('not a number'), 0);
});

test('the expense permissions exist and rest only on permissions that exist', () => {
  const codes = permissions.map((p) => p[0]);
  for (const code of ['reach.expense', 'reach.expense_approve', 'reach.expense_finance'])
    assert.ok(codes.includes(code), `${code} is missing from the catalogue`);
  for (const [code, needs] of Object.entries(requiredPermissions))
    for (const need of needs)
      assert.ok(codes.includes(need), `${code} depends on ${need}, which does not exist`);
  // Making a claim is a rep's own right and must not drag the whole module in behind it, the
  // same way marking your own attendance does not.
  assert.deepEqual(requiredPermissions['reach.expense'] ?? [], []);
});
