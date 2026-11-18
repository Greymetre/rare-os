import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGEING_BUCKETS,
  HOLD_REASONS,
  ageing,
  applyReceipts,
  creditState,
  dso,
  financialYearStart,
  kycState,
  lineAmount,
  money,
  orderTotals,
  previousMonth,
  rateFor,
  salesSummary,
  schemeFor,
  timeline,
} from '../packages/engines/trade.mjs';
import { permissions, requiredPermissions } from '../packages/schema/permissions.mjs';

const AS_OF = '2026-11-18';

// A retailer on a 50,000 limit, 30 days of credit, and no selling past 45 days.
const terms = { limit: 50000, creditDays: 30, holdDays: 45 };

const invoice = (date, amount, over = {}) => ({
  id: `inv-${date}-${amount}`,
  invoice_date: date,
  amount,
  status: 'OPEN',
  ...over,
});

test('the milestone acceptance: an order past the credit limit is held, and clears when the reason goes', () => {
  // 40,000 already owed against a 50,000 limit leaves 10,000 to sell against.
  const clear = creditState({ ...terms, outstanding: 40000, oldestDays: 10, orderValue: 8000 });
  assert.equal(clear.hold, false);
  assert.equal(clear.available, 10000);
  assert.equal(clear.message, 'Clear to place.');

  // One rupee past it is past it.
  const held = creditState({ ...terms, outstanding: 40000, oldestDays: 10, orderValue: 10001 });
  assert.equal(held.hold, true);
  assert.deepEqual(held.reasons, ['OVER_LIMIT']);
  assert.equal(held.exposure, 50001);
  assert.match(held.message, /over the credit limit/);

  // Exactly at the limit is not past it.
  assert.equal(
    creditState({ ...terms, outstanding: 40000, oldestDays: 10, orderValue: 10000 }).hold,
    false,
  );

  // A collection lands and the same order goes through: nothing was stored, so the decision is
  // simply taken again against the new evidence.
  const afterCollection = creditState({
    ...terms,
    outstanding: 25000,
    oldestDays: 10,
    orderValue: 10001,
  });
  assert.equal(afterCollection.hold, false);

  // A type with no limit at all never holds for one, and says so rather than reporting zero.
  const unlimited = creditState({ limit: null, outstanding: 900000, orderValue: 500000 });
  assert.equal(unlimited.hold, false);
  assert.equal(unlimited.available, null);
});

test('the milestone acceptance: KYC the type insists on holds the order until it is verified', () => {
  const base = { ...terms, outstanding: 1000, oldestDays: 5, orderValue: 1000, kycRequired: true };
  for (const kyc of ['MISSING', 'PENDING', 'REJECTED']) {
    const held = creditState({ ...base, kyc });
    assert.equal(held.hold, true, kyc);
    assert.ok(held.reasons.includes('KYC'), kyc);
    assert.match(held.message, /KYC is not verified/);
  }
  // Verified, and the same order is clear. Nothing else changed.
  assert.equal(creditState({ ...base, kyc: 'VERIFIED' }).hold, false);
  // A type that does not ask for KYC is not held by it, whatever the paperwork says.
  assert.equal(creditState({ ...base, kycRequired: false, kyc: 'MISSING' }).hold, false);
});

test('an order is held for an old bill, an unapproved account, and says every reason at once', () => {
  // 50 days old against a 45-day hold rule.
  const old = creditState({ ...terms, outstanding: 1000, oldestDays: 50, orderValue: 100 });
  assert.deepEqual(old.reasons, ['OVERDUE']);
  // A type with no hold rule never holds for age, however old.
  assert.equal(
    creditState({ limit: 50000, holdDays: null, outstanding: 1000, oldestDays: 400, orderValue: 1 })
      .hold,
    false,
  );
  // An account still waiting for approval cannot be sold to yet.
  assert.deepEqual(
    creditState({ ...terms, customerStatus: 'AWAITING_APPROVAL', orderValue: 1 }).reasons,
    ['APPROVAL'],
  );
  assert.deepEqual(creditState({ ...terms, customerStatus: 'DORMANT', orderValue: 1 }).reasons, [
    'INACTIVE',
  ]);

  // Three things wrong at once, and the rep is told all three.
  const several = creditState({
    ...terms,
    outstanding: 60000,
    oldestDays: 90,
    orderValue: 5000,
    kycRequired: true,
    kyc: 'MISSING',
  });
  assert.deepEqual(several.reasons, ['OVER_LIMIT', 'OVERDUE', 'KYC']);
  for (const reason of several.reasons) assert.ok(HOLD_REASONS[reason], reason);
  assert.match(several.message, /over the credit limit; a bill is older/);
});

test('the milestone acceptance: recording a collection reduces what is outstanding', () => {
  const invoices = [invoice('2026-10-01', 12000), invoice('2026-11-01', 8000)];
  const before = ageing({ invoices, receipts: [], asOf: AS_OF });
  assert.equal(before.outstanding, 20000);

  // 10,000 collected at the counter. It lands on the oldest bill first, because a collection is
  // money against a shop and nobody says which invoice it was for.
  const after = ageing({ invoices, receipts: [{ amount: 10000 }], asOf: AS_OF });
  assert.equal(after.outstanding, 10000);
  assert.equal(after.rows[0].outstanding, 2000);
  assert.equal(after.rows[0].status, 'PART_PAID');
  assert.equal(after.rows[1].outstanding, 8000);
  assert.equal(after.rows[1].status, 'OPEN');

  // Enough to clear the oldest bill entirely settles it and moves on to the next.
  const more = ageing({ invoices, receipts: [{ amount: 15000 }], asOf: AS_OF });
  assert.equal(more.rows[0].status, 'PAID');
  assert.equal(more.rows[0].outstanding, 0);
  assert.equal(more.rows[1].outstanding, 5000);
  assert.equal(more.outstanding, 5000);

  // More than is owed is not lost: the extra is reported as money no bill has claimed.
  const over = ageing({ invoices, receipts: [{ amount: 25000 }], asOf: AS_OF });
  assert.equal(over.outstanding, 0);
  assert.equal(over.unapplied, 5000);
});

test('a receipt against one named bill settles that bill, not the oldest', () => {
  const invoices = [
    invoice('2026-10-01', 12000),
    invoice('2026-11-01', 8000, { paid: 8000, status: 'PAID' }),
  ];
  const out = applyReceipts({
    invoices,
    receipts: [{ amount: 8000, invoice_id: 'x' }],
    asOf: AS_OF,
  });
  // The newer bill was already settled against itself, and the pooled receipt is not spread
  // because it names an invoice.
  assert.equal(out.rows[0].outstanding, 12000);
  assert.equal(out.rows[1].outstanding, 0);
  assert.equal(out.unapplied, 0);
  // A cancelled invoice is not owed at all.
  const cancelled = ageing({
    invoices: [invoice('2026-10-01', 12000, { status: 'CANCELLED' })],
    asOf: AS_OF,
  });
  assert.equal(cancelled.outstanding, 0);
  assert.equal(cancelled.rows.length, 0);
});

test('ageing puts each bill in one bucket, and names the oldest', () => {
  const invoices = [
    invoice('2026-11-10', 1000), // 8 days
    invoice('2026-10-10', 2000), // 39 days
    invoice('2026-09-10', 3000), // 69 days
    invoice('2026-06-10', 4000), // 161 days
  ];
  const out = ageing({ invoices, asOf: AS_OF });
  assert.deepEqual(out.labels, ['0-30', '31-60', '61-90', '91+']);
  assert.deepEqual(out.totals, { '0-30': 1000, '31-60': 2000, '61-90': 3000, '91+': 4000 });
  assert.equal(out.outstanding, 10000);
  assert.equal(out.invoices, 4);
  assert.equal(out.oldestDays, 161);
  // A company may read its ageing on its own scale.
  const fortnightly = ageing({ invoices, asOf: AS_OF, buckets: [15, 45] });
  assert.deepEqual(fortnightly.labels, ['0-15', '16-45', '46+']);
  assert.equal(fortnightly.totals['46+'], 7000);
  assert.deepEqual(AGEING_BUCKETS, [30, 60, 90]);
  // Nothing owed is no oldest bill, not a zero-day-old one.
  assert.equal(ageing({ invoices: [], asOf: AS_OF }).oldestDays, null);
});

test('days sales outstanding is a number or nothing, never infinity', () => {
  assert.equal(dso({ outstanding: 30000, sales: 90000, days: 90 }), 30);
  assert.equal(dso({ outstanding: 0, sales: 90000 }), 0);
  // A shop that bought nothing has no DSO; dividing by zero tells a manager nothing.
  assert.equal(dso({ outstanding: 30000, sales: 0 }), null);
});

test('a line is priced from the list that was live that day, and the latest list wins', () => {
  const rates = [
    { item_id: 'i1', rate: 100, gst_pct: 18, from_date: '2026-01-01', to_date: '2026-12-31' },
    { item_id: 'i1', rate: 110, gst_pct: 18, from_date: '2026-11-01', to_date: null },
    { item_id: 'i2', rate: 50, gst_pct: 5, from_date: '2026-01-01', to_date: null },
  ];
  // Two rows cover today; the one that started latest is the price.
  assert.equal(rateFor({ rates, itemId: 'i1', date: '2026-11-18' }).rate, 110);
  // Last month, the old list was the only one live, so last month's order still reads at 100.
  assert.equal(rateFor({ rates, itemId: 'i1', date: '2026-10-18' }).rate, 100);
  assert.equal(rateFor({ rates, itemId: 'i9', date: '2026-11-18' }), null);
  assert.equal(rateFor({ rates, itemId: 'i2', date: '2025-01-01' }), null);
});

test('a scheme gives the highest slab the line reaches, and nothing below the first', () => {
  const schemes = [
    { code: 'S10', item_id: 'i1', min_quantity: 10, discount_pct: 5, from_date: '2026-01-01' },
    {
      code: 'S50',
      item_id: 'i1',
      min_quantity: 50,
      discount_pct: 8,
      free_quantity: 2,
      from_date: '2026-01-01',
    },
  ];
  assert.equal(schemeFor({ schemes, itemId: 'i1', quantity: 9, date: AS_OF }), null);
  assert.equal(schemeFor({ schemes, itemId: 'i1', quantity: 10, date: AS_OF }).code, 'S10');
  assert.equal(schemeFor({ schemes, itemId: 'i1', quantity: 49, date: AS_OF }).code, 'S10');
  assert.equal(schemeFor({ schemes, itemId: 'i1', quantity: 50, date: AS_OF }).code, 'S50');
  // A scheme that has expired is not earned.
  assert.equal(
    schemeFor({
      schemes: [{ ...schemes[0], to_date: '2026-01-31' }],
      itemId: 'i1',
      quantity: 99,
      date: AS_OF,
    }),
    null,
  );
});

test('a line discounts before it taxes, and free units are given rather than billed', () => {
  // 50 at 110, 8% off, 18% GST, two free.
  const line = lineAmount({
    quantity: 50,
    rate: 110,
    gstPct: 18,
    scheme: { code: 'S50', discount_pct: 8, free_quantity: 2 },
  });
  assert.equal(line.gross, 5500);
  assert.equal(line.discount, 440);
  assert.equal(line.taxable, 5060);
  // Tax is on what is left after the discount, not on the gross.
  assert.equal(line.gst, 910.8);
  assert.equal(line.total, 5970.8);
  assert.equal(line.free_units, 2);
  assert.equal(line.scheme, 'S50');

  // No scheme, no tax: the simplest line still adds up.
  const plain = lineAmount({ quantity: 3, rate: 33.33 });
  assert.equal(plain.gross, 99.99);
  assert.equal(plain.total, 99.99);

  // A total is the sum of what the lines say, to the paisa.
  const totals = orderTotals([line, plain]);
  assert.equal(totals.total, money(5970.8 + 99.99));
  assert.equal(totals.gst, 910.8);
  assert.equal(totals.units, 53);
  assert.equal(totals.free_units, 2);
  assert.equal(totals.lines, 2);
  assert.equal(orderTotals([]).total, 0);
});

test('money rounds to the paisa, so a total never drifts', () => {
  assert.equal(money(0.1 + 0.2), 0.3);
  assert.equal(money('12.345'), 12.35);
  assert.equal(money('not a number'), 0);
  // A rate is money per unit and keeps four places, because a bulk list may quote a piece at
  // 0.3333. Only the amount it produces is rounded to the paisa.
  const third = lineAmount({ quantity: 3, rate: 0.333333 });
  assert.equal(third.rate, 0.3333);
  assert.equal(third.gross, 1);
  // And a rate that is round stays round.
  assert.equal(lineAmount({ quantity: 7, rate: 12.5 }).gross, 87.5);
});

test('KYC says what is asked, what is in, and what somebody refused', () => {
  const required = [
    { id: 'k1', code: 'GSTIN', name: 'GST certificate', requirement: 'R' },
    { id: 'k2', code: 'PAN', name: 'PAN card', requirement: 'R' },
    { id: 'k3', code: 'SHOP', name: 'Shop photo', requirement: 'O' },
  ];
  // Nothing uploaded: both required documents are missing, and the optional one is not.
  const empty = kycState({ required, documents: [] });
  assert.equal(empty.status, 'MISSING');
  assert.deepEqual(empty.missing, ['GSTIN', 'PAN']);
  assert.equal(empty.required, 2);
  assert.equal(empty.asked, 3);

  // One in and waiting, one still missing.
  const part = kycState({
    required,
    documents: [{ kyc_type_id: 'k1', status: 'PENDING', uploaded_at: '2026-11-01T10:00:00Z' }],
  });
  assert.equal(part.status, 'MISSING');
  assert.deepEqual(part.pending, ['GSTIN']);

  // Both in, one still waiting: not verified yet.
  const waiting = kycState({
    required,
    documents: [
      { kyc_type_id: 'k1', status: 'VERIFIED', uploaded_at: '2026-11-01T10:00:00Z' },
      { kyc_type_id: 'k2', status: 'PENDING', uploaded_at: '2026-11-02T10:00:00Z' },
    ],
  });
  assert.equal(waiting.status, 'PENDING');

  // Both verified. The optional one is still not asked about.
  const done = kycState({
    required,
    documents: [
      { kyc_type_id: 'k1', status: 'VERIFIED', uploaded_at: '2026-11-01T10:00:00Z' },
      { kyc_type_id: 'k2', status: 'VERIFIED', uploaded_at: '2026-11-02T10:00:00Z' },
    ],
  });
  assert.equal(done.status, 'VERIFIED');

  // A refusal is shown as a refusal, not hidden behind "missing".
  const refused = kycState({
    required,
    documents: [
      { kyc_type_id: 'k1', status: 'VERIFIED', uploaded_at: '2026-11-01T10:00:00Z' },
      {
        kyc_type_id: 'k2',
        status: 'REJECTED',
        decision_reason: 'Blurred',
        uploaded_at: '2026-11-02T10:00:00Z',
      },
    ],
  });
  assert.equal(refused.status, 'REJECTED');
  assert.deepEqual(refused.rejected, ['PAN']);
  assert.equal(refused.rows.find((r) => r.code === 'PAN').decision_reason, 'Blurred');

  // The newest upload for a document is the one that counts: a re-upload after a refusal is
  // what the shop is standing on now.
  const reUploaded = kycState({
    required,
    documents: [
      { kyc_type_id: 'k2', status: 'REJECTED', uploaded_at: '2026-11-02T10:00:00Z' },
      { kyc_type_id: 'k2', status: 'PENDING', uploaded_at: '2026-11-05T10:00:00Z' },
    ],
  });
  assert.equal(reUploaded.rows.find((r) => r.code === 'PAN').status, 'PENDING');

  // A type that asks for nothing is verified by default, so it never holds an order.
  assert.equal(kycState({ required: [], documents: [] }).status, 'VERIFIED');
});

test('sales read this month against last, the year to date, and what actually moves', () => {
  const invoices = [
    {
      invoice_date: '2026-11-05',
      amount: 12000,
      lines: [
        { item_id: 'i1', item: 'CHAIR', units: 10, total: 8000 },
        { item_id: 'i2', item: 'TABLE', units: 2, total: 4000 },
      ],
    },
    {
      invoice_date: '2026-11-15',
      amount: 3000,
      lines: [{ item_id: 'i1', item: 'CHAIR', units: 4, total: 3000 }],
    },
    {
      invoice_date: '2026-10-20',
      amount: 10000,
      lines: [{ item_id: 'i2', item: 'TABLE', units: 5, total: 10000 }],
    },
    { invoice_date: '2026-03-20', amount: 99000, lines: [] },
    { invoice_date: '2026-11-16', amount: 5000, status: 'CANCELLED', lines: [] },
  ];
  const out = salesSummary({ invoices, asOf: AS_OF });
  assert.equal(out.thisMonth.month, '2026-11');
  // The cancelled invoice is not sales.
  assert.equal(out.thisMonth.amount, 15000);
  assert.equal(out.thisMonth.invoices, 2);
  assert.equal(out.lastMonth.month, '2026-10');
  assert.equal(out.lastMonth.amount, 10000);
  assert.equal(out.growthPct, 50);
  // April to March: the March invoice belongs to the year before, so it is out.
  assert.equal(out.financialYear.from, '2026-04-01');
  assert.equal(out.financialYear.amount, 25000);
  assert.deepEqual(
    out.topItems.map((i) => [i.code, i.units, i.amount]),
    [
      ['TABLE', 7, 14000],
      ['CHAIR', 14, 11000],
    ],
  );
  // A month after nothing has no growth percentage; growth from zero is not a number.
  assert.equal(salesSummary({ invoices: [invoices[0]], asOf: AS_OF }).growthPct, null);
});

test('months and financial years are read, never guessed', () => {
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(previousMonth('2026-11'), '2026-10');
  assert.equal(previousMonth('2026-13'), null);
  assert.equal(previousMonth('nope'), null);
  assert.equal(financialYearStart('2026-11-18'), 2026);
  assert.equal(financialYearStart('2026-03-31'), 2025);
  assert.equal(financialYearStart('2026-04-01'), 2026);
  // A company whose year starts in January reads it that way.
  assert.equal(financialYearStart('2026-03-31', 1), 2026);
  assert.equal(financialYearStart('bad'), null);
});

test('one timeline, newest first, whichever module recorded it', () => {
  const events = [
    { at: '2026-11-10T09:00:00Z', kind: 'VISIT' },
    { at: '2026-11-18T11:00:00Z', kind: 'ORDER' },
    { at: '2026-11-15T10:00:00Z', kind: 'INVOICE' },
    { at: '2026-11-15T10:00:00Z', kind: 'KYC' },
    { at: null, kind: 'BROKEN' },
  ];
  const out = timeline(events);
  assert.deepEqual(
    out.map((e) => e.kind),
    ['ORDER', 'INVOICE', 'KYC', 'VISIT'],
  );
  // An event with no time is not placed at the top of the story; it is left out.
  assert.equal(out.length, 4);
  assert.equal(timeline(events, 2).length, 2);
});

test('the Customer 360 permissions exist and rest only on permissions that exist', () => {
  const codes = new Set(permissions.map(([code]) => code));
  for (const code of ['reach.order', 'reach.collect', 'reach.kyc', 'reach.credit'])
    assert.ok(codes.has(code), code);
  for (const code of ['reach.order', 'reach.collect', 'reach.kyc', 'reach.credit'])
    for (const need of requiredPermissions[code] ?? [])
      assert.ok(codes.has(need), `${code} needs ${need}, which does not exist`);
  // Taking an order and collecting money are a rep's own acts, so neither drags in the right to
  // read every other rep's customers.
  assert.equal(requiredPermissions['reach.order'], undefined);
  assert.equal(requiredPermissions['reach.collect'], undefined);
  // Releasing a credit hold and verifying KYC are decisions taken inside the module.
  assert.deepEqual(requiredPermissions['reach.credit'], ['reach.read']);
  assert.deepEqual(requiredPermissions['reach.kyc'], ['reach.read']);
});
