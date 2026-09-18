import test from 'node:test';
import assert from 'node:assert/strict';
import { approvalProblem, proposalAction, receiptProblems } from '../packages/engines/purchase.mjs';

const wanted = { supplierId: 'S1', unitId: 'KG', quantity: 300, due: '2026-10-01' };
const pending = {
  source: 'SYSTEM',
  supplier_id: 'S1',
  purchase_unit_id: 'KG',
  quantity: '300',
  due_date: '2026-10-01',
};

test('AV-01: create, keep, update or withdraw one pending proposal per item', () => {
  assert.equal(proposalAction({ pending: null, wanted, lastRejected: null }), 'create');
  assert.equal(proposalAction({ pending, wanted, lastRejected: null }), 'keep');
  assert.equal(proposalAction({ pending, wanted: { ...wanted, quantity: 350 } }), 'update');
  assert.equal(proposalAction({ pending, wanted: { ...wanted, due: '2026-10-02' } }), 'update');
  assert.equal(proposalAction({ pending, wanted: null }), 'withdraw');
  assert.equal(proposalAction({ pending: null, wanted: null }), 'none');
});

test('AV-01: manual proposals are never overridden; a rejected need is not raised again unchanged', () => {
  const manual = { ...pending, source: 'MANUAL' };
  assert.equal(proposalAction({ pending: manual, wanted: null }), 'keep');
  assert.equal(proposalAction({ pending: manual, wanted: { ...wanted, quantity: 900 } }), 'keep');
  const edited = { ...pending, changed_by_subject: 'planner' };
  assert.equal(proposalAction({ pending: edited, wanted: { ...wanted, quantity: 900 } }), 'keep');
  assert.equal(proposalAction({ pending: edited, wanted: null }), 'keep');
  const rejected = { supplier_id: 'S1', quantity: '300' };
  assert.equal(proposalAction({ pending: null, wanted, lastRejected: rejected }), 'none');
  assert.equal(
    proposalAction({ pending: null, wanted: { ...wanted, quantity: 400 }, lastRejected: rejected }),
    'create',
  );
});

test('approval: no self-approval, version and planning checks', () => {
  const proposal = {
    proposal_no: 7,
    status: 'PROPOSED',
    version: 2,
    source: 'SYSTEM',
    run_no: 12,
    changed_by_subject: null,
  };
  const planning = { upToDate: true, currentRunNo: 12 };
  assert.equal(approvalProblem({ proposal, actorSubject: 'u1', version: 2, planning }), null);
  assert.match(
    approvalProblem({ proposal, actorSubject: 'u1', version: 1, planning }),
    /changed after you opened it/,
  );
  assert.match(
    approvalProblem({
      proposal: { ...proposal, source: 'MANUAL', changed_by_subject: 'u1' },
      actorSubject: 'u1',
      version: 2,
      planning,
    }),
    /someone else must approve/,
  );
  assert.match(
    approvalProblem({ proposal, actorSubject: 'u1', version: 2, planning: { upToDate: false } }),
    /being recalculated/,
  );
  assert.match(
    approvalProblem({
      proposal,
      actorSubject: 'u1',
      version: 2,
      planning: { upToDate: true, currentRunNo: 13 },
    }),
    /older calculation/,
  );
  assert.match(
    approvalProblem({
      proposal: { ...proposal, status: 'APPROVED' },
      actorSubject: 'u1',
      version: 2,
      planning,
    }),
    /already approved/,
  );
});

test('receipts: within the open quantity, open lines only, no repeats', () => {
  const orderLines = [
    { line_no: 10, status: 'OPEN', quantity: '100', received_quantity: '40' },
    { line_no: 20, status: 'CANCELLED', quantity: '5', received_quantity: '0' },
    { line_no: 30, status: 'OPEN', quantity: '8', received_quantity: '8' },
  ];
  assert.deepEqual(receiptProblems([{ line_no: 10, quantity: 60 }], orderLines), []);
  assert.deepEqual(receiptProblems([], orderLines), [
    'Enter a received quantity for at least one line.',
  ]);
  assert.match(
    receiptProblems([{ line_no: 10, quantity: 61 }], orderLines)[0],
    /only 60 is still due/,
  );
  assert.match(receiptProblems([{ line_no: 20, quantity: 1 }], orderLines)[0], /cancelled/);
  assert.match(receiptProblems([{ line_no: 30, quantity: 1 }], orderLines)[0], /fully received/);
  assert.match(
    receiptProblems([{ line_no: 99, quantity: 1 }], orderLines)[0],
    /not on this purchase order/,
  );
  assert.match(
    receiptProblems(
      [
        { line_no: 10, quantity: 1 },
        { line_no: 10, quantity: 1 },
      ],
      orderLines,
    ).join(' '),
    /listed more than once/,
  );
});
