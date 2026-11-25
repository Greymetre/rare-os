// RCH-5: the database side of Customer 360 — orders, bills, collections and KYC.
//
// What is stored is evidence and decisions: the order as it was taken, the bill as it arrived,
// the money as it was collected, and every KYC document with the decision taken on it.
//
// What is never stored — and this is the whole reason the milestone's acceptance test works — is
// what any of it adds up to. The outstanding is the invoices less the collections, aged at the
// moment it is asked for. The hold on an order is calculated from that outstanding, the limit,
// the age of the oldest bill and the KYC. So a held order clears the instant a collection lands
// or a document is verified, with nothing to find and rewrite.
//
// This module takes orders; it does not raise invoices. `customer_types.order_route` says where
// an order goes — an ERP, a distributor, or nowhere — and an invoice is recorded here rather than
// generated. Nothing in this file posts a ledger entry.
//
// Every function receives a pg client already inside a company-scoped (RLS) transaction.
import { countRows, DEFAULT_PAGE_SIZE } from './paging.mjs';
import { reachSettings } from './customers-db.mjs';
import {
  ageing,
  creditState,
  dso,
  kycState,
  lineAmount,
  orderTotals,
  rateFor,
  salesSummary,
  schemeFor,
  timeline,
} from '../engines/trade.mjs';

const n = (v) => (v === null || v === undefined ? null : Number(v));
const iso = (v) => (v?.toISOString ? v.toISOString() : (v ?? null));

export async function tradeSettings(db) {
  return reachSettings(db);
}

// The buckets the company reads its ageing in, as numbers. Held as text on the settings row
// because a company may want four buckets or two.
export const bucketsOf = (settings) =>
  String(settings.ageing_buckets ?? '30,60,90')
    .split(',')
    .map((b) => Number(b.trim()))
    .filter((b) => Number.isFinite(b) && b > 0)
    .sort((a, b) => a - b);

// ---------- The shop, and the terms it buys on ----------

// The terms that apply to one shop: its own where it has been given them, otherwise its type's.
// Nulls are kept rather than filled in, because "no limit" and "a limit of zero" are different
// answers and only one of them stops a sale.
const pick = (own, fromType) => (own === null || own === undefined ? n(fromType) : n(own));

export async function tradeCustomer(db, customerId) {
  const row = (
    await db.query(
      `SELECT c.id,c.version,c.code,c.name,c.status,c.town,c.phone,c.attrs,c.beat_id,c.territory_id,
              c.rep_id,c.buys_from_id,c.sales_customer_id,c.type_id,
              c.latitude,c.longitude,c.geo_verified,c.geo_source,
              to_char(c.geo_tagged_at,'YYYY-MM-DD HH24:MI') AS geo_tagged_at,
              c.credit_limit AS own_credit_limit, c.credit_days AS own_credit_days,
              c.hold_days AS own_hold_days,
              t.code AS type,t.name AS type_name,t.kyc_before_order,t.order_route,
              t.credit_limit AS type_credit_limit,t.credit_days AS type_credit_days,
              t.hold_days AS type_hold_days,t.checkin_radius_m,t.min_visit_minutes,t.loyalty,
              coalesce(b.code,'') AS beat, coalesce(ter.code,'') AS territory,
              coalesce(r.code,'') AS rep, coalesce(f.code,'') AS buys_from,
              coalesce(sc.code,'') AS sales_customer
       FROM trade_customers c
         JOIN customer_types t ON t.id=c.type_id
         LEFT JOIN beats b ON b.id=c.beat_id
         LEFT JOIN territories ter ON ter.id=c.territory_id
         LEFT JOIN field_reps r ON r.id=c.rep_id
         LEFT JOIN trade_customers f ON f.id=c.buys_from_id
         LEFT JOIN customers sc ON sc.id=c.sales_customer_id
       WHERE c.id=$1 AND c.deleted_at IS NULL`,
      [customerId],
    )
  ).rows[0];
  if (!row) return null;
  return {
    ...row,
    version: Number(row.version),
    terms: {
      credit_limit: pick(row.own_credit_limit, row.type_credit_limit),
      credit_days: pick(row.own_credit_days, row.type_credit_days),
      hold_days: pick(row.own_hold_days, row.type_hold_days),
      // Which of the two the number came from, so a screen can say "from the type" rather than
      // leaving a user wondering why they cannot find where it was set.
      from: {
        credit_limit: row.own_credit_limit === null ? 'type' : 'customer',
        credit_days: row.own_credit_days === null ? 'type' : 'customer',
        hold_days: row.own_hold_days === null ? 'type' : 'customer',
      },
      kyc_before_order: row.kyc_before_order === true,
      order_route: row.order_route,
    },
  };
}

// A shop's own terms. Null clears an override and hands the question back to the type.
export async function saveTerms(db, { customerId, version, limit, days, hold }) {
  const done = await db.query(
    `UPDATE trade_customers SET credit_limit=$3,credit_days=$4,hold_days=$5,
       version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND deleted_at IS NULL`,
    [customerId, version, limit, days, hold],
  );
  return done.rowCount === 1;
}

// ---------- KYC ----------

// The documents this customer's type asks for, in a stable order.
export async function kycRequired(db, typeId) {
  return (
    await db.query(
      `SELECT k.id,k.code,k.name,k.number_check,k.valid_months,r.requirement
       FROM kyc_rules r JOIN kyc_types k ON k.id=r.kyc_type_id
       WHERE r.type_id=$1 AND r.requirement <> 'X'
         AND r.deleted_at IS NULL AND r.active AND k.deleted_at IS NULL AND k.active
       ORDER BY r.requirement, lower(k.code)`,
      [typeId],
    )
  ).rows.map((r) => ({ ...r, valid_months: n(r.valid_months) }));
}

export async function kycDocuments(db, customerId) {
  return (
    await db.query(
      `SELECT d.id,d.version,d.kyc_type_id,d.file_id,d.number,d.status,d.decision_reason,
              to_char(d.valid_to,'YYYY-MM-DD') AS valid_to,
              to_char(d.uploaded_at,'YYYY-MM-DD HH24:MI') AS uploaded_at,
              k.code AS kyc_type, k.name AS kyc_type_name, k.number_check,
              coalesce(u.name,'') AS decided_by
       FROM kyc_documents d JOIN kyc_types k ON k.id=d.kyc_type_id
       LEFT JOIN app_users u ON u.id=d.decided_by
       WHERE d.customer_id=$1 ORDER BY d.uploaded_at DESC, d.id DESC`,
      [customerId],
    )
  ).rows.map((r) => ({ ...r, version: Number(r.version) }));
}

// Where the paperwork stands: what the type asks for, against what has been given.
export async function kycFor(db, customer) {
  const [required, documents] = await Promise.all([
    kycRequired(db, customer.type_id),
    kycDocuments(db, customer.id),
  ]);
  return { ...kycState({ required, documents }), documents };
}

export async function uploadKyc(
  db,
  tenantId,
  { id, customerId, kycTypeId, fileId, number, validTo, actorId },
) {
  await db.query(
    `INSERT INTO kyc_documents(id,tenant_id,customer_id,kyc_type_id,file_id,number,valid_to,
       uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      id,
      tenantId,
      customerId,
      kycTypeId,
      fileId ?? null,
      number ?? '',
      validTo ?? null,
      actorId ?? null,
    ],
  );
  return id;
}

export async function findKycDocument(db, id) {
  const row = (
    await db.query(
      `SELECT d.id,d.version,d.status,d.customer_id,d.kyc_type_id,k.code AS kyc_type,
              c.code AS customer FROM kyc_documents d
       JOIN kyc_types k ON k.id=d.kyc_type_id JOIN trade_customers c ON c.id=d.customer_id
       WHERE d.id=$1`,
      [id],
    )
  ).rows[0];
  return row ? { ...row, version: Number(row.version) } : null;
}

export async function decideKyc(db, actorId, { id, version, status, reason }) {
  const done = await db.query(
    `UPDATE kyc_documents SET status=$4,decided_by=$3,decided_at=now(),decision_reason=$5,
       version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='PENDING'`,
    [id, version, actorId ?? null, status, reason ?? ''],
  );
  return done.rowCount === 1;
}

const KYC_QUEUE_FROM = `kyc_documents d
  JOIN kyc_types k ON k.id=d.kyc_type_id
  JOIN trade_customers c ON c.id=d.customer_id
  JOIN customer_types t ON t.id=c.type_id`;
const KYC_QUEUE_WHERE = `($1::text IS NULL OR d.status=$1) AND c.deleted_at IS NULL`;

export async function listKyc(db, { status = 'PENDING', limit = DEFAULT_PAGE_SIZE }) {
  const params = [status];
  const total = await countRows(db, KYC_QUEUE_FROM, KYC_QUEUE_WHERE, params);
  const items = (
    await db.query(
      `SELECT d.id,d.version,d.status,d.number,d.file_id,d.decision_reason,
              to_char(d.uploaded_at,'YYYY-MM-DD HH24:MI') AS uploaded_at,
              k.code AS kyc_type,k.name AS kyc_type_name,
              c.id AS customer_id,c.code AS customer,c.name AS customer_name,t.code AS type
       FROM ${KYC_QUEUE_FROM} WHERE ${KYC_QUEUE_WHERE}
       ORDER BY d.uploaded_at DESC LIMIT $2`,
      [...params, limit],
    )
  ).rows.map((r) => ({ ...r, version: Number(r.version) }));
  return { items, total };
}

// ---------- Price ----------

// The rate rows live for a customer type around one date. Read as a list rather than one row,
// because the engine decides which of two overlapping lists wins and that rule belongs in one
// place.
export async function ratesFor(db, typeId, date) {
  return (
    await db.query(
      `SELECT p.item_id,p.rate,p.gst_pct,
              to_char(p.from_date,'YYYY-MM-DD') AS from_date,
              to_char(p.to_date,'YYYY-MM-DD') AS to_date,
              i.code AS item,i.name AS item_name
       FROM price_list_items p JOIN items i ON i.id=p.item_id
       WHERE p.type_id=$1 AND p.deleted_at IS NULL AND p.active
         AND p.from_date <= $2 AND (p.to_date IS NULL OR p.to_date >= $2)`,
      [typeId, date],
    )
  ).rows;
}

export async function schemesFor(db, date) {
  return (
    await db.query(
      `SELECT s.id,s.code,s.item_id,s.min_quantity,s.discount_pct,s.free_quantity,
              to_char(s.from_date,'YYYY-MM-DD') AS from_date,
              to_char(s.to_date,'YYYY-MM-DD') AS to_date
       FROM trade_schemes s
       WHERE s.deleted_at IS NULL AND s.active
         AND s.from_date <= $1 AND (s.to_date IS NULL OR s.to_date >= $1)`,
      [date],
    )
  ).rows;
}

// Prices a basket for one customer on one day. An item with no live rate is refused by name
// rather than priced at zero: a zero-rupee order line is a bug nobody notices until the invoice.
export async function priceBasket(db, { typeId, date, lines }) {
  const [rates, schemes] = await Promise.all([ratesFor(db, typeId, date), schemesFor(db, date)]);
  const priced = [];
  const missing = [];

  for (const line of lines) {
    const rate = rateFor({ rates, itemId: line.item_id, date });
    if (!rate) {
      missing.push(line.item_id);
      continue;
    }
    const scheme = schemeFor({ schemes, itemId: line.item_id, quantity: line.units, date });
    priced.push({
      item_id: line.item_id,
      item: rate.item,
      item_name: rate.item_name,
      scheme_id: scheme?.id ?? null,
      ...lineAmount({
        quantity: line.units,
        rate: rate.rate,
        gstPct: rate.gst_pct,
        scheme,
      }),
    });
  }

  return { lines: priced, totals: orderTotals(priced), missing };
}

// ---------- What is outstanding ----------

export async function invoicesFor(db, customerId) {
  const rows = (
    await db.query(
      `SELECT v.id,v.version,v.invoice_no,v.status,v.amount,v.source,
              to_char(v.invoice_date,'YYYY-MM-DD') AS invoice_date,
              to_char(v.due_date,'YYYY-MM-DD') AS due_date,
              coalesce(p.paid,0) AS paid
       FROM trade_invoices v
       LEFT JOIN LATERAL (
         SELECT sum(r.amount) AS paid FROM trade_receipts r
         WHERE r.invoice_id=v.id AND r.status='RECORDED'
       ) p ON true
       WHERE v.customer_id=$1 ORDER BY v.invoice_date, lower(v.invoice_no)`,
      [customerId],
    )
  ).rows;
  return rows.map((r) => ({
    ...r,
    version: Number(r.version),
    amount: Number(r.amount),
    paid: Number(r.paid ?? 0),
  }));
}

export async function receiptsFor(db, customerId) {
  return (
    await db.query(
      `SELECT r.id,r.version,r.receipt_no,r.amount,r.mode,r.reference,r.status,r.invoice_id,r.file_id,
              to_char(r.received_on,'YYYY-MM-DD') AS received_on,
              coalesce(f.code,'') AS rep
       FROM trade_receipts r LEFT JOIN field_reps f ON f.id=r.rep_id
       WHERE r.customer_id=$1 ORDER BY r.received_on DESC, lower(r.receipt_no) DESC`,
      [customerId],
    )
  ).rows.map((r) => ({ ...r, version: Number(r.version), amount: Number(r.amount) }));
}

// Invoices less collections, aged. Nothing here is stored: this is read every time it is asked
// for, which is what lets a collection clear a held order with nothing to rewrite.
export async function outstandingFor(db, customerId, asOf, settings) {
  const [invoices, receipts] = await Promise.all([
    invoicesFor(db, customerId),
    receiptsFor(db, customerId),
  ]);
  return {
    ...ageing({ invoices, receipts, asOf, buckets: bucketsOf(settings) }),
    receipts,
  };
}

// ---------- Whether an order may go ----------

// The live decision. `orderValue` is what is being asked for now; pass zero to read the standing
// position of the account without an order in front of it.
export async function creditFor(db, customer, { asOf, orderValue = 0, settings }) {
  const [owing, kyc] = await Promise.all([
    outstandingFor(db, customer.id, asOf, settings),
    kycFor(db, customer),
  ]);
  const credit = creditState({
    limit: customer.terms.credit_limit,
    creditDays: customer.terms.credit_days,
    holdDays: customer.terms.hold_days,
    outstanding: owing.outstanding,
    oldestDays: owing.oldestDays,
    orderValue,
    kyc: kyc.status,
    customerStatus: customer.status,
    kycRequired: customer.terms.kyc_before_order,
  });
  return { credit, outstanding: owing, kyc };
}

// ---------- Orders ----------

const ORDER_COLUMNS = `
  o.id, o.version, o.order_no, o.status, o.route, o.external_ref, o.hold_reasons,
  o.gross, o.discount, o.taxable, o.gst, o.total, o.note, o.release_reason, o.cancel_reason,
  to_char(o.order_date,'YYYY-MM-DD') AS order_date,
  to_char(o.routed_at,'YYYY-MM-DD HH24:MI') AS routed_at,
  to_char(o.released_at,'YYYY-MM-DD HH24:MI') AS released_at,
  o.customer_id, c.code AS customer, c.name AS customer_name, c.town,
  o.rep_id, coalesce(r.code,'') AS rep, o.visit_id,
  t.code AS type, coalesce(u.name,'') AS released_by`;

const ORDER_FROM = `trade_orders o
  JOIN trade_customers c ON c.id=o.customer_id
  JOIN customer_types t ON t.id=c.type_id
  LEFT JOIN field_reps r ON r.id=o.rep_id
  LEFT JOIN app_users u ON u.id=o.released_by`;

const asOrder = (row) => ({
  ...row,
  version: Number(row.version),
  gross: Number(row.gross),
  discount: Number(row.discount),
  taxable: Number(row.taxable),
  gst: Number(row.gst),
  total: Number(row.total),
  hold_reasons: row.hold_reasons ? String(row.hold_reasons).split(',').filter(Boolean) : [],
});

export async function orderLines(db, orderId) {
  return (
    await db.query(
      `SELECT l.line_no,l.item_id,i.code AS item,i.name AS item_name,l.units,l.rate,l.gst_pct,
              l.scheme_code,l.discount_pct,l.free_units,l.gross,l.discount,l.taxable,l.gst,l.total
       FROM trade_order_lines l JOIN items i ON i.id=l.item_id
       WHERE l.order_id=$1 ORDER BY l.line_no`,
      [orderId],
    )
  ).rows.map((r) => ({
    ...r,
    units: Number(r.units),
    rate: Number(r.rate),
    gross: Number(r.gross),
    discount: Number(r.discount),
    taxable: Number(r.taxable),
    gst: Number(r.gst),
    total: Number(r.total),
    free_units: Number(r.free_units),
  }));
}

// RCH-8: the order a phone already sent.
//
// A device that lost the reply retries, and this is what makes that free. It is deliberately not
// a general search: an empty reference matches nothing, because the web writes no reference and
// every one of those rows would otherwise look like the same order.
export async function orderByClientRef(db, clientRef) {
  const ref = String(clientRef ?? '').trim();
  if (!ref) return null;
  const row = (
    await db.query(`SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE o.client_ref=$1`, [ref])
  ).rows[0];
  return row ? asOrder(row) : null;
}

export async function findOrder(db, orderId) {
  const row = (
    await db.query(`SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE o.id=$1`, [orderId])
  ).rows[0];
  if (!row) return null;
  return { ...asOrder(row), lines: await orderLines(db, orderId) };
}

// Takes the order: the priced lines and the totals as they stood, and the status the live credit
// decision produced. A held order is saved, not refused.
export async function createOrder(
  db,
  tenantId,
  { id, orderNo, customerId, repId, visitId, orderDate, route, note, priced, credit, clientRef },
) {
  await db.query(
    `INSERT INTO trade_orders(id,tenant_id,order_no,customer_id,rep_id,visit_id,order_date,
       status,route,gross,discount,taxable,gst,total,hold_reasons,note,client_ref)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      id,
      tenantId,
      orderNo,
      customerId,
      repId,
      visitId ?? null,
      orderDate,
      credit.hold ? 'HELD' : 'PLACED',
      route ?? 'NONE',
      priced.totals.gross,
      priced.totals.discount,
      priced.totals.taxable,
      priced.totals.gst,
      priced.totals.total,
      credit.reasons.join(','),
      note ?? '',
      clientRef ?? '',
    ],
  );
  let lineNo = 0;
  for (const line of priced.lines) {
    lineNo += 1;
    await db.query(
      `INSERT INTO trade_order_lines(tenant_id,order_id,line_no,item_id,units,rate,gst_pct,
         scheme_id,scheme_code,discount_pct,free_units,gross,discount,taxable,gst,total)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        tenantId,
        id,
        lineNo,
        line.item_id,
        line.units,
        line.rate,
        line.gst_pct,
        line.scheme_id ?? null,
        line.scheme ?? '',
        line.discount_pct,
        line.free_units,
        line.gross,
        line.discount,
        line.taxable,
        line.gst,
        line.total,
      ],
    );
  }
  return id;
}

// Releases a held order. The reason is required by the table, because releasing a hold is a
// decision somebody has to own.
export async function releaseOrder(db, actorId, { id, version, reason }) {
  const done = await db.query(
    `UPDATE trade_orders SET status='PLACED',released_by=$3,released_at=now(),release_reason=$4,
       hold_reasons='',version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='HELD'`,
    [id, version, actorId ?? null, reason],
  );
  return done.rowCount === 1;
}

export async function cancelOrder(db, { id, version, reason }) {
  const done = await db.query(
    `UPDATE trade_orders SET status='CANCELLED',cancel_reason=$3,version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status IN ('DRAFT','HELD','PLACED')`,
    [id, version, reason],
  );
  return done.rowCount === 1;
}

// Marks a placed order as gone where the type said it should go.
export async function routeOrder(db, { id, version, externalRef }) {
  const done = await db.query(
    `UPDATE trade_orders SET status='ROUTED',routed_at=now(),external_ref=$3,
       version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='PLACED'`,
    [id, version, externalRef ?? ''],
  );
  return done.rowCount === 1;
}

const ORDERS_WHERE = `($1::uuid IS NULL OR o.customer_id=$1)
  AND ($2::uuid IS NULL OR o.rep_id=$2)
  AND ($3::text IS NULL OR o.status=$3)
  AND ($4::date IS NULL OR o.order_date >= $4)
  AND ($5::date IS NULL OR o.order_date <= $5)`;

export async function listOrders(
  db,
  {
    customerId = null,
    repId = null,
    status = null,
    from = null,
    to = null,
    limit = DEFAULT_PAGE_SIZE,
  },
) {
  const params = [customerId, repId, status, from, to];
  const total = await countRows(db, ORDER_FROM, ORDERS_WHERE, params);
  const items = (
    await db.query(
      `SELECT ${ORDER_COLUMNS} FROM ${ORDER_FROM} WHERE ${ORDERS_WHERE}
       ORDER BY o.order_date DESC, lower(o.order_no) DESC LIMIT $6`,
      [...params, limit],
    )
  ).rows.map(asOrder);
  const value = items.reduce((sum, o) => sum + (o.status === 'CANCELLED' ? 0 : o.total), 0);
  return { items, total, value: Math.round(value * 100) / 100 };
}

// ---------- Bills and collections ----------

// ---------- The number a bill raised here is given ----------

// Takes the next number from the company's series for a financial year, creating the series the
// first time it is used. The counter is read and advanced in one statement, so two people raising
// a bill at the same moment cannot be handed the same number — and because it is never decreased,
// a cancelled bill keeps its number used, which is what a gapless series means in practice.
export async function nextInvoiceNo(db, tenantId, { prefix, fy }) {
  const row = (
    await db.query(
      `INSERT INTO invoice_series(id,tenant_id,prefix,fy,next_no)
       VALUES($1,$2,$3,$4,2)
       ON CONFLICT (tenant_id,lower(prefix),fy)
         DO UPDATE SET next_no = invoice_series.next_no + 1, updated_at = now()
       RETURNING id, prefix, fy, width, next_no - 1 AS issued`,
      [crypto.randomUUID(), tenantId, prefix, fy],
    )
  ).rows[0];
  // On a first use the row is inserted with next_no 2, so `issued` reads 1 either way.
  const issued = Number(row.issued);
  return {
    series_id: row.id,
    number: `${row.prefix}/${row.fy}/${String(issued).padStart(Number(row.width), '0')}`,
    issued,
  };
}

// Raises a bill from an order: this module's own number, and the order's own lines at the price
// the order was taken at. Deliberately not re-priced now — a bill has to agree with the order it
// came from.
export async function raiseInvoiceFromOrder(
  db,
  tenantId,
  { id, order, series, invoiceDate, dueDate, actorId, note },
) {
  await db.query(
    `INSERT INTO trade_invoices(id,tenant_id,invoice_no,customer_id,order_id,invoice_date,due_date,
       amount,taxable,gst,source,series_id,raised_by,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'RAISED',$11,$12,$13)`,
    [
      id,
      tenantId,
      series.number,
      order.customer_id,
      order.id,
      invoiceDate,
      dueDate ?? null,
      order.total,
      order.taxable,
      order.gst,
      series.series_id,
      actorId ?? null,
      note ?? '',
    ],
  );
  let lineNo = 0;
  for (const line of order.lines) {
    lineNo += 1;
    await db.query(
      `INSERT INTO trade_invoice_lines(tenant_id,invoice_id,line_no,item_id,units,rate,gst_pct,
         taxable,gst,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        tenantId,
        id,
        lineNo,
        line.item_id,
        line.units,
        line.rate,
        line.gst_pct,
        line.taxable,
        line.gst,
        line.total,
      ],
    );
  }
  return id;
}

// Has this order already been billed? One open bill per order, so raising twice cannot happen by
// a double tap.
export async function invoiceForOrder(db, orderId) {
  const row = (
    await db.query(
      `SELECT id, invoice_no, status FROM trade_invoices WHERE order_id=$1 AND status='OPEN'`,
      [orderId],
    )
  ).rows[0];
  return row ?? null;
}

export async function recordInvoice(
  db,
  tenantId,
  {
    id,
    invoiceNo,
    customerId,
    orderId,
    invoiceDate,
    dueDate,
    amount,
    taxable,
    gst,
    source,
    note,
    lines = [],
  },
) {
  await db.query(
    `INSERT INTO trade_invoices(id,tenant_id,invoice_no,customer_id,order_id,invoice_date,
       due_date,amount,taxable,gst,source,note) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      tenantId,
      invoiceNo,
      customerId,
      orderId ?? null,
      invoiceDate,
      dueDate ?? null,
      amount,
      taxable ?? null,
      gst ?? null,
      source ?? 'MANUAL',
      note ?? '',
    ],
  );
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    // A recorded bill may know only what was sold and for how much; the rate and the tax split
    // are taken when the source gave them and left null when it did not.
    await db.query(
      `INSERT INTO trade_invoice_lines(tenant_id,invoice_id,line_no,item_id,units,rate,gst_pct,
         taxable,gst,total) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        tenantId,
        id,
        lineNo,
        line.item_id,
        line.units,
        line.rate ?? null,
        line.gst_pct ?? null,
        line.taxable ?? null,
        line.gst ?? null,
        line.total,
      ],
    );
  }
  return id;
}

export async function findInvoice(db, id) {
  const row = (
    await db.query(
      `SELECT v.id,v.version,v.invoice_no,v.status,v.amount,v.taxable,v.gst,v.source,v.series_id,
              v.order_id,v.customer_id,c.code AS customer,
              to_char(v.invoice_date,'YYYY-MM-DD') AS invoice_date
       FROM trade_invoices v JOIN trade_customers c ON c.id=v.customer_id WHERE v.id=$1`,
      [id],
    )
  ).rows[0];
  return row ? { ...row, version: Number(row.version), amount: Number(row.amount) } : null;
}

export async function cancelInvoice(db, { id, version, reason }) {
  const done = await db.query(
    `UPDATE trade_invoices SET status='CANCELLED',cancel_reason=$3,version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='OPEN'`,
    [id, version, reason],
  );
  return done.rowCount === 1;
}

export async function recordReceipt(
  db,
  tenantId,
  {
    id,
    receiptNo,
    customerId,
    repId,
    invoiceId,
    receivedOn,
    amount,
    mode,
    reference,
    fileId,
    at,
    note,
    clientRef,
  },
) {
  await db.query(
    `INSERT INTO trade_receipts(id,tenant_id,receipt_no,customer_id,rep_id,invoice_id,received_on,
       amount,mode,reference,file_id,latitude,longitude,note,client_ref)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      id,
      tenantId,
      receiptNo,
      customerId,
      repId ?? null,
      invoiceId ?? null,
      receivedOn,
      amount,
      mode,
      reference ?? '',
      fileId ?? null,
      at?.latitude ?? null,
      at?.longitude ?? null,
      note ?? '',
      clientRef ?? '',
    ],
  );
  return id;
}

// RCH-8: the collection a phone already sent. Two collections of the same amount from the same
// shop on the same day are ordinary, so nothing but the device's own reference can tell a retry
// from a second payment — and crediting a shop twice is the worst mistake this module could make.
export async function receiptByClientRef(db, clientRef) {
  const ref = String(clientRef ?? '').trim();
  if (!ref) return null;
  const row = (
    await db.query(
      `SELECT r.id, r.receipt_no, r.amount, r.mode, r.reference,
              to_char(r.received_on,'YYYY-MM-DD') AS received_on
         FROM trade_receipts r WHERE r.client_ref=$1`,
      [ref],
    )
  ).rows[0];
  return row ? { ...row, amount: Number(row.amount) } : null;
}

export async function findReceipt(db, id) {
  const row = (
    await db.query(
      `SELECT r.id,r.version,r.receipt_no,r.status,r.amount,r.customer_id,r.rep_id,
              c.code AS customer FROM trade_receipts r
       JOIN trade_customers c ON c.id=r.customer_id WHERE r.id=$1`,
      [id],
    )
  ).rows[0];
  return row ? { ...row, version: Number(row.version), amount: Number(row.amount) } : null;
}

// A collection is cancelled, never deleted: the money was recorded as received and that record
// stands, with the reason it was reversed beside it.
export async function cancelReceipt(db, { id, version, reason }) {
  const done = await db.query(
    `UPDATE trade_receipts SET status='CANCELLED',cancel_reason=$3,version=version+1,updated_at=now()
     WHERE id=$1 AND version=$2 AND status='RECORDED'`,
    [id, version, reason],
  );
  return done.rowCount === 1;
}

// ---------- How a shop is selling ----------

// Read from invoices rather than orders: an order is an intention and a cancelled one would
// flatter the number.
export async function salesFor(db, customerId, asOf, settings) {
  const invoices = (
    await db.query(
      `SELECT v.id,v.status,v.amount,to_char(v.invoice_date,'YYYY-MM-DD') AS invoice_date,
              coalesce(l.lines,'[]'::json) AS lines
       FROM trade_invoices v
       LEFT JOIN LATERAL (
         SELECT json_agg(json_build_object('item_id',li.item_id,'item',i.code,
                  'item_name',i.name,'units',li.units,'total',li.total)) AS lines
         FROM trade_invoice_lines li JOIN items i ON i.id=li.item_id WHERE li.invoice_id=v.id
       ) l ON true
       WHERE v.customer_id=$1`,
      [customerId],
    )
  ).rows;

  const summary = salesSummary({
    invoices,
    asOf,
    fyStartMonth: Number(settings.fy_start_month ?? 4),
  });
  // DSO is read over the company's own window, against what was sold in it.
  const days = Number(settings.dso_window_days ?? 90);
  const from = new Date(Date.parse(`${asOf}T00:00:00Z`) - (days - 1) * 86400000)
    .toISOString()
    .slice(0, 10);
  const windowSales = invoices
    .filter((i) => i.status !== 'CANCELLED' && i.invoice_date >= from && i.invoice_date <= asOf)
    .reduce((sum, i) => sum + Number(i.amount), 0);
  return {
    ...summary,
    dsoWindow: { from, to: asOf, days, sales: Math.round(windowSales * 100) / 100 },
  };
}

// ---------- One timeline ----------

// Everything that has happened to a shop, from whichever module recorded it. The question a rep
// asks at the counter is "what happened here?", not "what happened here in module four?".
export async function timelineFor(db, customerId, limit = 100) {
  const rows = (
    await db.query(
      `SELECT * FROM (
         SELECT v.checked_in_at AS at, 'VISIT' AS kind, coalesce(r.code,'') AS who,
                coalesce(f.code,'') AS ref,
                CASE WHEN v.out_of_fence THEN 'Visited, flagged '||v.distance_m||' m away'
                     ELSE 'Visited' END AS what, v.id AS record_id
         FROM visits v LEFT JOIN field_reps r ON r.id=v.rep_id
           LEFT JOIN beats f ON f.id=v.beat_id
         WHERE v.customer_id=$1
         UNION ALL
         SELECT o.created_at, 'ORDER', coalesce(r.code,''), o.order_no,
                'Order '||o.status||' for '||o.total, o.id
         FROM trade_orders o LEFT JOIN field_reps r ON r.id=o.rep_id WHERE o.customer_id=$1
         UNION ALL
         SELECT i.created_at, 'INVOICE', '', i.invoice_no,
                CASE WHEN i.status='CANCELLED' THEN 'Invoice cancelled'
                     ELSE 'Invoice for '||i.amount END, i.id
         FROM trade_invoices i WHERE i.customer_id=$1
         UNION ALL
         SELECT p.created_at, 'RECEIPT', coalesce(r.code,''), p.receipt_no,
                CASE WHEN p.status='CANCELLED' THEN 'Collection cancelled'
                     ELSE 'Collected '||p.amount||' by '||p.mode END, p.id
         FROM trade_receipts p LEFT JOIN field_reps r ON r.id=p.rep_id WHERE p.customer_id=$1
         UNION ALL
         SELECT d.uploaded_at, 'KYC', coalesce(u.name,''), k.code,
                k.code||' '||d.status, d.id
         FROM kyc_documents d JOIN kyc_types k ON k.id=d.kyc_type_id
           LEFT JOIN app_users u ON u.id=d.decided_by
         WHERE d.customer_id=$1
         UNION ALL
         SELECT g.created_at, 'GEO', coalesce(u.name,''), g.source,
                CASE WHEN g.status='PENDING' THEN 'Location change waiting for approval'
                     WHEN g.moved_m IS NULL THEN 'Location '||g.status
                     ELSE 'Location '||g.status||', moved '||g.moved_m||' m' END, g.id
         FROM customer_geo_log g LEFT JOIN app_users u ON u.id=g.requested_by
         WHERE g.customer_id=$1
       ) events ORDER BY at DESC LIMIT $2`,
      [customerId, limit],
    )
  ).rows.map((r) => ({ ...r, at: iso(r.at) }));
  return timeline(rows, limit);
}

// ---------- Everything at once ----------

// One read for the screen that answers "what is going on with this shop?".
export async function customer360(db, customerId, { asOf, settings }) {
  const customer = await tradeCustomer(db, customerId);
  if (!customer) return null;
  const [state, sales, story, visits] = await Promise.all([
    creditFor(db, customer, { asOf, orderValue: 0, settings }),
    salesFor(db, customerId, asOf, settings),
    timelineFor(db, customerId, 50),
    db.query(
      `SELECT count(*)::int AS visits, max(to_char(visit_date,'YYYY-MM-DD')) AS last_visit,
              count(*) FILTER (WHERE out_of_fence)::int AS flagged
       FROM visits WHERE customer_id=$1`,
      [customerId],
    ),
  ]);
  return {
    customer,
    credit: state.credit,
    outstanding: state.outstanding,
    kyc: state.kyc,
    sales,
    dso: dso({
      outstanding: state.outstanding.outstanding,
      sales: sales.dsoWindow.sales,
      days: sales.dsoWindow.days,
    }),
    visits: visits.rows[0],
    timeline: story,
  };
}
