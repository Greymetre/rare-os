// RCH-5: what a shop owes, what it may order, and what it has bought.
//
// Five calculations live here and none of them is ever stored.
//
// **The price of a line.** A company's rate for an item depends on the customer's type and the
// day, and a scheme may give a discount or free units at a slab. All of it is read from dated
// rows, so last month's order still reads at last month's rate instead of being silently
// repriced by today's list.
//
// **Whether an order may go.** The milestone's own acceptance: an order that would take a shop
// past its credit limit is held, and it opens again the moment the reason is gone. The decision
// is made from the evidence — the limit, what is outstanding, how old the oldest bill is, and
// whether the type insists on verified KYC — and every reason it gives is a sentence a person
// can act on. Nothing is "blocked" without saying why.
//
// **What is outstanding.** Invoices less what has been collected against them, aged into
// buckets. Receipts are applied oldest bill first, which is what a collection against a shop
// means in the trade: nobody rings up to say which invoice the cash was for.
//
// **How a shop is selling.** This month against last, the financial year to date, and the items
// that actually move.
//
// **Where the KYC stands.** Which documents the type insists on, which are in, which are
// verified, and which are still missing.
//
// Money is rounded to two places at every step, so a total is the sum of what each line says it
// is. A float that drifts by a paisa is a float somebody has to explain.
// Pure: no database, no HTTP.

import { datesBetween } from './attendance.mjs';

export const ORDER_STATUSES = ['DRAFT', 'HELD', 'PLACED', 'ROUTED', 'CANCELLED'];
export const INVOICE_STATUSES = ['OPEN', 'PART_PAID', 'PAID', 'CANCELLED'];
export const KYC_STATUSES = ['MISSING', 'PENDING', 'VERIFIED', 'REJECTED'];
export const PAYMENT_MODES = ['CASH', 'CHEQUE', 'UPI', 'NEFT', 'ADJUSTMENT'];

// Why an order is held. Each one is a sentence the screen shows as it is.
export const HOLD_REASONS = {
  OVER_LIMIT: 'over the credit limit',
  OVERDUE: 'a bill is older than this type allows',
  KYC: 'KYC is not verified',
  APPROVAL: 'the account is still waiting for approval',
  INACTIVE: 'the account is not active',
};

// Money, to the paisa. Every step rounds, so a total equals the sum of its lines.
export const money = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

// Quantities keep more places than money: a case of 24 broken into pieces is not a round number.
const qty = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000000) / 1000000 : 0;
};

// A rate is money per unit, and it is not always a round paisa: a bulk list may quote a piece at
// 0.3333. So a rate keeps four places and only the amounts it produces are rounded to the paisa.
// Rounding the rate first would quietly lose a hundredth of a paisa on every unit sold.
const unitRate = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
};

const onDate = (row, date) =>
  (!row.from_date || String(row.from_date) <= date) &&
  (!row.to_date || String(row.to_date) >= date);

// ---------- Price ----------

// The rate for one item on one day, from the list the customer's type is on.
//
// Two rows may cover the same day — a company extends a list and opens a new one — so the one
// that started latest wins. Choosing the cheaper, or the first found, would make the answer
// depend on row order, which nobody can explain to a salesman.
export function rateFor({ rates = [], itemId, date }) {
  const live = rates
    .filter((r) => String(r.item_id) === String(itemId) && onDate(r, date))
    .sort((a, b) => String(b.from_date ?? '').localeCompare(String(a.from_date ?? '')));
  return live[0] ?? null;
}

// The scheme slab an order line falls into, if any.
//
// Slabs are read as "from this quantity upwards", so the highest slab the line reaches is the one
// it earns. A line below every slab earns nothing, which is not an error.
export function schemeFor({ schemes = [], itemId, quantity, date }) {
  const reached = schemes
    .filter(
      (s) =>
        String(s.item_id) === String(itemId) &&
        onDate(s, date) &&
        qty(quantity) >= qty(s.min_quantity),
    )
    .sort((a, b) => qty(b.min_quantity) - qty(a.min_quantity));
  return reached[0] ?? null;
}

// What one line of an order comes to.
//
// The order is deliberate: the scheme discount comes off the gross, tax is charged on what is
// left, and free units are given away rather than billed. A company that taxes before discount
// is a company arguing with its own invoice.
export function lineAmount({ quantity, rate, gstPct = 0, scheme = null }) {
  const units = qty(quantity);
  const price = unitRate(rate);
  const gross = money(units * price);

  const discountPct = scheme ? Number(scheme.discount_pct ?? 0) : 0;
  const discount = money((gross * discountPct) / 100);
  // Free units are given, not billed: they cost the company margin, not the customer money.
  const free = scheme ? qty(scheme.free_quantity ?? 0) : 0;

  const taxable = money(gross - discount);
  const gst = money((taxable * Number(gstPct || 0)) / 100);

  return {
    units,
    rate: price,
    gross,
    discount_pct: discountPct,
    discount,
    free_units: free,
    taxable,
    gst_pct: Number(gstPct || 0),
    gst,
    total: money(taxable + gst),
    scheme: scheme?.code ?? '',
  };
}

export function orderTotals(lines = []) {
  const add = (key) => money(lines.reduce((sum, l) => sum + Number(l[key] ?? 0), 0));
  return {
    lines: lines.length,
    units: qty(lines.reduce((sum, l) => sum + Number(l.units ?? 0), 0)),
    free_units: qty(lines.reduce((sum, l) => sum + Number(l.free_units ?? 0), 0)),
    gross: add('gross'),
    discount: add('discount'),
    taxable: add('taxable'),
    gst: add('gst'),
    total: add('total'),
  };
}

// ---------- Outstanding ----------

// An ISO date as days before `asOf`, or null.
function ageOf(date, asOf) {
  const from = String(date ?? ''),
    to = String(asOf ?? '');
  if (!datesBetween(from, from).length || !datesBetween(to, to).length) return null;
  const span = datesBetween(from, to);
  // datesBetween is inclusive and empty when the order is reversed, which is the future.
  return span.length ? span.length - 1 : 0;
}

// What is still owed, bill by bill, with each bill's age.
//
// Receipts are applied oldest bill first. A collection in the trade is money against a shop, not
// against a document: a rep who takes 10,000 at the counter is not told which invoice it settles,
// and guessing the newest would leave the oldest bill ageing for ever.
export function applyReceipts({ invoices = [], receipts = [], asOf }) {
  const open = invoices
    .filter((i) => i.status !== 'CANCELLED')
    .map((i) => ({
      ...i,
      amount: money(i.amount),
      // Anything already settled against this exact bill is honoured before the pool is spread.
      paid: money(i.paid ?? 0),
    }))
    .sort((a, b) => String(a.invoice_date).localeCompare(String(b.invoice_date)));

  let pool = money(
    receipts
      .filter((r) => !r.invoice_id && r.status !== 'CANCELLED')
      .reduce((sum, r) => sum + Number(r.amount ?? 0), 0),
  );

  const rows = open.map((invoice) => {
    const owedBefore = money(invoice.amount - invoice.paid);
    const applied = money(Math.min(Math.max(owedBefore, 0), Math.max(pool, 0)));
    pool = money(pool - applied);
    const outstanding = money(owedBefore - applied);
    return {
      ...invoice,
      applied: money(invoice.paid + applied),
      outstanding,
      age_days: ageOf(invoice.invoice_date, asOf),
      status: outstanding <= 0 ? 'PAID' : invoice.paid + applied > 0 ? 'PART_PAID' : 'OPEN',
    };
  });

  return { rows, unapplied: money(Math.max(pool, 0)) };
}

// The buckets a company reads its ageing in. Dated from the invoice, not from its due date, so a
// shop on 30 days and a shop on cash are read on the same scale.
export const AGEING_BUCKETS = [30, 60, 90];

export function ageing({ invoices = [], receipts = [], asOf, buckets = AGEING_BUCKETS }) {
  const { rows, unapplied } = applyReceipts({ invoices, receipts, asOf });
  const owing = rows.filter((r) => r.outstanding > 0);

  const edges = [...buckets].sort((a, b) => a - b);
  const labels = [
    ...edges.map((edge, i) => (i === 0 ? `0-${edge}` : `${edges[i - 1] + 1}-${edge}`)),
    `${edges[edges.length - 1] + 1}+`,
  ];
  const totals = Object.fromEntries(labels.map((l) => [l, 0]));

  for (const row of owing) {
    const age = row.age_days ?? 0;
    const index = edges.findIndex((edge) => age <= edge);
    const label = index === -1 ? labels[labels.length - 1] : labels[index];
    totals[label] = money(totals[label] + row.outstanding);
  }

  const outstanding = money(owing.reduce((sum, r) => sum + r.outstanding, 0));
  const oldest = owing.reduce((max, r) => Math.max(max, r.age_days ?? 0), 0);

  return {
    rows,
    open: owing,
    labels,
    totals,
    outstanding,
    // Money collected that no bill has claimed yet. It still reduces what the shop owes, so it is
    // reported rather than hidden: a credit balance is not an error.
    unapplied,
    oldestDays: owing.length ? oldest : null,
    invoices: owing.length,
  };
}

// Days sales outstanding: how many days of selling the unpaid pile is worth.
//
// Null when there were no sales in the window — a shop that bought nothing has no DSO, and
// dividing by zero to say "infinite days" tells a manager nothing.
export function dso({ outstanding, sales, days = 90 }) {
  const sold = money(sales);
  if (!sold || !Number(days)) return null;
  return Math.round((money(outstanding) / sold) * Number(days));
}

// ---------- Whether an order may go ----------

// The decision the milestone's acceptance test is written against.
//
// An order that takes the shop past its limit is held. So is one placed against a bill older than
// the type allows, or an account whose KYC the type insists on and which is not verified yet. The
// reasons are a list, because a shop can be past its limit *and* unverified, and a rep told only
// "held" learns nothing.
//
// Nothing here refuses to record the order. A held order is saved, visible and waiting for a
// person — the same principle as a check-in from outside the fence.
export function creditState({
  limit = null,
  creditDays = null,
  holdDays = null,
  outstanding = 0,
  oldestDays = null,
  orderValue = 0,
  kyc = null,
  customerStatus = 'ACTIVE',
  kycRequired = false,
}) {
  const owed = money(outstanding);
  const asking = money(orderValue);
  const ceiling = limit === null || limit === undefined ? null : money(limit);
  const exposure = money(owed + asking);

  const reasons = [];

  if (customerStatus === 'AWAITING_APPROVAL') reasons.push('APPROVAL');
  else if (customerStatus !== 'ACTIVE') reasons.push('INACTIVE');

  if (ceiling !== null && exposure > ceiling) reasons.push('OVER_LIMIT');

  // `hold_days` is the age at which a company stops selling; `credit_days` is only the terms it
  // sells on. A type with no hold rule never holds for age, however old the bill.
  const ageLimit = holdDays === null || holdDays === undefined ? null : Number(holdDays);
  if (ageLimit !== null && oldestDays !== null && Number(oldestDays) > ageLimit)
    reasons.push('OVERDUE');

  if (kycRequired && kyc !== 'VERIFIED') reasons.push('KYC');

  return {
    limit: ceiling,
    creditDays: creditDays === null || creditDays === undefined ? null : Number(creditDays),
    holdDays: ageLimit,
    outstanding: owed,
    orderValue: asking,
    exposure,
    // What is left to sell against. Null when the type sets no limit: unlimited is not a number.
    available: ceiling === null ? null : money(ceiling - owed),
    oldestDays: oldestDays === null ? null : Number(oldestDays),
    hold: reasons.length > 0,
    reasons,
    // One line a screen can print without knowing what any of the codes mean.
    message: reasons.length
      ? `On hold: ${reasons.map((r) => HOLD_REASONS[r] ?? r).join('; ')}.`
      : 'Clear to place.',
  };
}

// ---------- KYC ----------

// Where a shop's paperwork stands against what its type insists on.
//
// A document the type does not ask for is not reported as missing, and a document that was
// rejected is not treated as absent: somebody looked at it and said no, and that is worth
// showing rather than hiding behind "missing".
export function kycState({ required = [], documents = [] }) {
  const latest = new Map();
  for (const doc of documents) {
    const key = String(doc.kyc_type_id ?? doc.kyc_type);
    const seen = latest.get(key);
    if (!seen || String(doc.uploaded_at ?? '') > String(seen.uploaded_at ?? ''))
      latest.set(key, doc);
  }

  const rows = required.map((need) => {
    const doc = latest.get(String(need.id ?? need.code)) ?? null;
    return {
      kyc_type_id: need.id ?? null,
      code: need.code,
      name: need.name,
      required: need.requirement === 'R',
      status: doc ? doc.status : 'MISSING',
      file_id: doc?.file_id ?? null,
      number: doc?.number ?? '',
      decided_by: doc?.decided_by ?? '',
      decision_reason: doc?.decision_reason ?? '',
      uploaded_at: doc?.uploaded_at ?? null,
    };
  });

  const mandatory = rows.filter((r) => r.required);
  const missing = mandatory.filter((r) => r.status === 'MISSING').map((r) => r.code);
  const pending = mandatory.filter((r) => r.status === 'PENDING').map((r) => r.code);
  const rejected = mandatory.filter((r) => r.status === 'REJECTED').map((r) => r.code);

  // The one word the order decision asks for. Verified means every document the type insists on
  // is verified — not "most of them".
  const status = !mandatory.length
    ? 'VERIFIED'
    : rejected.length
      ? 'REJECTED'
      : missing.length
        ? 'MISSING'
        : pending.length
          ? 'PENDING'
          : 'VERIFIED';

  return {
    rows,
    status,
    missing,
    pending,
    rejected,
    asked: rows.length,
    required: mandatory.length,
  };
}

// ---------- How a shop is selling ----------

const monthOf = (date) => String(date ?? '').slice(0, 7);

// The month before a given 'YYYY-MM'.
export function previousMonth(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month ?? ''));
  if (!m) return null;
  const year = Number(m[1]),
    index = Number(m[2]);
  if (index < 1 || index > 12) return null;
  const d = new Date(Date.UTC(year, index - 2, 1));
  return d.toISOString().slice(0, 7);
}

// The financial year a date falls in, as its starting year. April to March by default, because
// that is the year this company's books run on; the month is a parameter so it is not a constant
// buried in the code.
export function financialYearStart(date, startMonth = 4) {
  const m = /^(\d{4})-(\d{2})/.exec(String(date ?? ''));
  if (!m) return null;
  const year = Number(m[1]),
    month = Number(m[2]);
  return month >= startMonth ? year : year - 1;
}

// This month against last, the year to date, and what actually moves.
//
// Read from invoices rather than orders on purpose: an order is an intention and a cancelled one
// would flatter the number. What was billed is what was sold.
export function salesSummary({ invoices = [], asOf, fyStartMonth = 4, topCount = 5 }) {
  const live = invoices.filter((i) => i.status !== 'CANCELLED');
  const thisMonth = monthOf(asOf);
  const lastMonth = previousMonth(thisMonth);
  const fy = financialYearStart(asOf, fyStartMonth);
  const fyFrom = `${fy}-${String(fyStartMonth).padStart(2, '0')}-01`;

  const sum = (rows) => money(rows.reduce((total, i) => total + Number(i.amount ?? 0), 0));
  const inMonth = (month) => live.filter((i) => monthOf(i.invoice_date) === month);

  const items = new Map();
  for (const invoice of live)
    for (const line of invoice.lines ?? []) {
      const key = String(line.item_id);
      const row = items.get(key) ?? {
        item_id: line.item_id,
        code: line.item ?? '',
        name: line.item_name ?? '',
        units: 0,
        amount: 0,
      };
      row.units = qty(row.units + Number(line.units ?? 0));
      row.amount = money(row.amount + Number(line.total ?? 0));
      items.set(key, row);
    }

  const thisTotal = sum(inMonth(thisMonth));
  const lastTotal = lastMonth ? sum(inMonth(lastMonth)) : 0;

  return {
    thisMonth: { month: thisMonth, amount: thisTotal, invoices: inMonth(thisMonth).length },
    lastMonth: lastMonth
      ? { month: lastMonth, amount: lastTotal, invoices: inMonth(lastMonth).length }
      : null,
    // Null rather than zero when last month sold nothing: growth from nothing is not a percentage.
    growthPct: lastTotal ? Math.round(((thisTotal - lastTotal) / lastTotal) * 100) : null,
    financialYear: {
      from: fyFrom,
      amount: sum(live.filter((i) => String(i.invoice_date) >= fyFrom)),
    },
    topItems: [...items.values()].sort((a, b) => b.amount - a.amount).slice(0, topCount),
  };
}

// ---------- One timeline ----------

// Everything that has happened to a shop, newest first, from whichever module recorded it.
//
// A single stream on purpose: the question a rep asks standing at the counter is "what happened
// here?", not "what happened here in module four?".
export function timeline(events = [], limit = 100) {
  return events
    .filter((e) => e && e.at)
    .map((e) => ({ ...e, at: String(e.at) }))
    .sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : String(a.kind).localeCompare(String(b.kind)),
    )
    .slice(0, limit);
}
