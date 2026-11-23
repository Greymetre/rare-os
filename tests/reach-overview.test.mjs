import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DECISION_KINDS,
  PROPOSAL_KINDS,
  PROPOSAL_RIGHTS,
  SEVERITY_ORDER,
  approvalQueue,
  cutoverSteps,
  cutoverVerdict,
  proposalsFrom,
} from '../packages/engines/reach-overview.mjs';
import { permissions } from '../packages/schema/permissions.mjs';

test('a proposal is only made when there is something to say', () => {
  // Nothing counted is nothing proposed. The system does not reassure anybody that all is well.
  assert.deepEqual(proposalsFrom({}), []);
  assert.deepEqual(proposalsFrom({ KYC_WAITING: 0, ORDER_HELD: 0 }), []);
  const rows = proposalsFrom({ KYC_WAITING: 2 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  // Every proposal says where a person goes to do something about it.
  assert.equal(rows[0].module, 'Trade');
  assert.equal(rows[0].screen, 'Paperwork');
  assert.ok(rows[0].why.length > 10);
});

test('what somebody must decide outranks what somebody should watch', () => {
  const rows = proposalsFrom({
    VISIT_FLAGGED: 9,
    ORDER_HELD: 1,
    DAY_NOT_STARTED: 3,
    KYC_WAITING: 2,
  });
  assert.deepEqual(
    rows.map((r) => r.code),
    ['KYC_WAITING', 'ORDER_HELD', 'DAY_NOT_STARTED', 'VISIT_FLAGGED'],
  );
  // Within one severity the bigger pile comes first, and ties break by name so the order is
  // stable from one refresh to the next.
  const tied = proposalsFrom({ KYC_WAITING: 2, ORDER_HELD: 2, LEAVE_WAITING: 2 });
  assert.deepEqual(
    tied.map((r) => r.code),
    ['KYC_WAITING', 'LEAVE_WAITING', 'ORDER_HELD'],
  );
  assert.deepEqual(SEVERITY_ORDER, ['DECIDE', 'WARN', 'WATCH']);
});

test('a proposal pointing at a screen somebody cannot open is never shown to them', () => {
  const counts = { KYC_WAITING: 2, ORDER_HELD: 1, VISIT_FLAGGED: 4 };
  // A manager who may only read sees what they can act on by reading, and nothing else.
  const reader = proposalsFrom(counts, { permissions: ['reach.read'] });
  assert.deepEqual(
    reader.map((r) => r.code),
    ['VISIT_FLAGGED'],
  );
  // Somebody holding the credit right as well now sees the held order too.
  const credit = proposalsFrom(counts, { permissions: ['reach.read', 'reach.credit'] });
  assert.deepEqual(
    credit.map((r) => r.code),
    ['ORDER_HELD', 'VISIT_FLAGGED'],
  );
  // Passing no permissions at all means "do not filter", which is what the register wants.
  assert.equal(proposalsFrom(counts).length, 3);
});

test('the approval queue is one queue, and its total is the sum of the rows beneath it', () => {
  const rows = proposalsFrom({
    KYC_WAITING: 2,
    ORDER_HELD: 1,
    CLAIM_WAITING: 3,
    LEAVE_WAITING: 1,
    VISIT_FLAGGED: 9,
    DAY_NOT_STARTED: 4,
  });
  const queue = approvalQueue(rows);
  // The milestone's own acceptance: the tile and the list are the same number by construction.
  assert.equal(
    queue.total,
    queue.rows.reduce((sum, r) => sum + r.count, 0),
  );
  assert.equal(queue.total, 7);
  // Nothing that is merely worth watching is in a queue of decisions.
  assert.ok(!queue.rows.some((r) => r.code === 'VISIT_FLAGGED'));
  assert.ok(!queue.rows.some((r) => r.code === 'DAY_NOT_STARTED'));
  // It spans the modules, which is the whole point of there being one of it.
  assert.deepEqual(queue.modules.sort(), ['Attendance', 'Expenses', 'Trade']);
  assert.equal(DECISION_KINDS.length, 9);
});

test('every proposal names a real permission, a module and a screen', () => {
  const codes = permissions.map((p) => p[0]);
  for (const [code, kind] of Object.entries(PROPOSAL_KINDS)) {
    assert.ok(SEVERITY_ORDER.includes(kind.severity), `${code} has an unknown severity`);
    assert.ok(kind.module && kind.screen, `${code} does not say where to act`);
    assert.ok(kind.title && kind.why, `${code} does not say what it is or why it matters`);
    const needs = PROPOSAL_RIGHTS[code];
    assert.ok(needs, `${code} does not say what right it needs`);
    assert.ok(codes.includes(needs), `${code} needs ${needs}, which is not a permission`);
  }
});

test('cutover is read from the data, never from somebody ticking a box', () => {
  const empty = cutoverSteps({});
  assert.ok(empty.every((s) => s.status === 'missing'));
  const verdict = cutoverVerdict(empty);
  assert.equal(verdict.ready, false);
  assert.equal(verdict.done, 0);
  assert.ok(verdict.blockers.length > 0);

  const loaded = cutoverSteps({
    repsWithLogin: 4,
    customers: 120,
    beatOutlets: 90,
    taggedCustomers: 110,
    repsWithShift: 4,
    prices: 0,
    livePolicies: 0,
  });
  const live = cutoverVerdict(loaded);
  // A price list and an expense policy are worth having but do not stop a company going live
  // with attendance and visits, so they do not block.
  assert.equal(live.ready, true);
  assert.deepEqual(live.blockers, []);
  assert.equal(live.done, 5);
  assert.equal(live.total, 7);
  assert.ok(loaded.find((s) => s.key === 'prices')?.blocking === false);
});
