// RCH-5: Customer 360 — the order, the bill, the collection and the paperwork.
//
// Four rules shape every route here.
//
// **An order is never refused for credit.** One that would take a shop past its limit, or that
// is placed against an account whose KYC is not verified, is **taken and held** with the reasons
// recorded. A rep told "no" with no record of why stops trusting the app — the same principle as
// a check-in from outside the fence. Releasing a hold is a separate right and needs a reason.
//
// **Nothing about what it adds up to is stored.** The outstanding, the hold and the KYC state are
// read from the evidence on every request, which is why a held order clears the moment a
// collection lands or a document is verified, with nothing to find and rewrite.
//
// **A bill arrives two ways, and the permission is the switch.** `reach.invoice` granted to
// nobody means no invoice can be raised in this system and bills only ever arrive from an ERP.
// Granted, this module issues its own numbers from a gapless per-year series. There is no setting
// to deploy and no path to turn on later.
//
// **The rep is the signed-in login.** A rep id in a request body is never read, so nobody takes
// an order or banks a collection in somebody else's name.
import { Controller, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { access, fail, scoped } from './core.js';
import { audit, body, id, mutate, text, version } from './access.controller.js';
import { datesBetween } from '../../../packages/engines/attendance.mjs';
import { financialYearStart, money, PAYMENT_MODES } from '../../../packages/engines/trade.mjs';
import { saveReachSettings } from '../../../packages/schema/customers-db.mjs';
import { repForUser, findRep, todayFor } from '../../../packages/schema/attendance-db.mjs';
import {
  cancelInvoice,
  cancelOrder,
  cancelReceipt,
  createOrder,
  creditFor,
  customer360,
  decideKyc,
  findInvoice,
  findKycDocument,
  findOrder,
  findReceipt,
  invoiceForOrder,
  kycFor,
  kycRequired,
  listKyc,
  listOrders,
  nextInvoiceNo,
  outstandingFor,
  priceBasket,
  raiseInvoiceFromOrder,
  ratesFor,
  recordInvoice,
  orderByClientRef,
  receiptByClientRef,
  recordReceipt,
  releaseOrder,
  routeOrder,
  saveTerms,
  timelineFor,
  tradeCustomer,
  tradeSettings,
  uploadKyc,
} from '../../../packages/schema/trade-db.mjs';

const KYC_DECISIONS = ['VERIFIED', 'REJECTED'];
const INVOICE_SOURCES = ['MANUAL', 'IMPORT', 'ERP'];
// One request may ask for a year of trade and no more.
const MAX_SPAN_DAYS = 366;
// A basket is a basket, not a bulk upload: a thousand-line order is somebody's mistake.
const MAX_LINES = 200;

function invalid(errors: { column: string; message: string }[]): never {
  throw new HttpException(
    { code: 'VALIDATION_ERROR', message: errors.map((e) => e.message).join(' '), fields: errors },
    400,
  );
}

function isoDate(value: unknown, label: string): string {
  const v = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || datesBetween(v, v).length !== 1)
    fail(400, 'VALIDATION_ERROR', `${label} must be a date written as YYYY-MM-DD.`);
  return v;
}

function spanOf(req: Request) {
  const from = isoDate(req.query.from, 'From');
  const to = isoDate(req.query.to, 'To');
  const days = datesBetween(from, to).length;
  if (!days) fail(400, 'VALIDATION_ERROR', 'The To date cannot be before the From date.');
  if (days > MAX_SPAN_DAYS)
    fail(400, 'RANGE_TOO_WIDE', `Ask for at most ${MAX_SPAN_DAYS} days at a time.`);
  return { from, to };
}

// Money a caller sends. Refused rather than rounded when it is not a number a bill could carry:
// a silent round is a rupee somebody has to explain later.
function amount(value: unknown, label: string, { min = 0.01 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > 999999999)
    fail(400, 'VALIDATION_ERROR', `${label} must be an amount of at least ${min}.`);
  if (money(n) !== n) fail(400, 'VALIDATION_ERROR', `${label} cannot be finer than a paisa.`);
  return n;
}

function quantity(value: unknown, label: string) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 9999999)
    fail(400, 'VALIDATION_ERROR', `${label} must be more than zero.`);
  return n;
}

// The lines of a basket, as sent. Which items may actually be ordered, and at what price, is the
// database layer's business — it is the only thing that knows this customer type's list.
function basketOf(raw: unknown) {
  if (!Array.isArray(raw) || !raw.length)
    fail(400, 'VALIDATION_ERROR', 'An order needs at least one line.');
  const rows = raw as any[];
  if (rows.length > MAX_LINES)
    fail(400, 'VALIDATION_ERROR', `An order may have at most ${MAX_LINES} lines.`);
  const seen = new Set<string>();
  return rows.map((line: any, index: number) => {
    if (!line || typeof line !== 'object')
      fail(400, 'VALIDATION_ERROR', `Line ${index + 1} is not a line.`);
    const itemId = id(line.item_id);
    if (seen.has(itemId))
      fail(400, 'VALIDATION_ERROR', 'The same item appears twice; add the quantities instead.');
    seen.add(itemId);
    return { item_id: itemId, units: quantity(line.units, `Line ${index + 1} quantity`) };
  });
}

// The lines of a bill that was raised somewhere else. Unlike an order basket, these carry their
// own money: the document already said what each line came to, and sales reporting reads it. A
// line sent without its total would quietly make "top SKU" read zero for that item.
function billLinesOf(raw: unknown) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail(400, 'VALIDATION_ERROR', 'The lines must be a list.');
  const rows = raw as any[];
  if (rows.length > MAX_LINES)
    fail(400, 'VALIDATION_ERROR', `A bill may have at most ${MAX_LINES} lines.`);
  return rows.map((line: any, index: number) => {
    if (!line || typeof line !== 'object')
      fail(400, 'VALIDATION_ERROR', `Line ${index + 1} is not a line.`);
    return {
      item_id: id(line.item_id),
      units: quantity(line.units, `Line ${index + 1} quantity`),
      total: amount(line.total, `Line ${index + 1} total`, { min: 0 }),
      // The rate and the tax split are taken when the source gave them, and left unknown
      // rather than invented when it did not.
      rate:
        line.rate === undefined || line.rate === null
          ? null
          : amount(line.rate, `Line ${index + 1} rate`, { min: 0 }),
      gst_pct:
        line.gst_pct === undefined || line.gst_pct === null
          ? null
          : amount(line.gst_pct, `Line ${index + 1} GST %`, { min: 0 }),
      taxable:
        line.taxable === undefined || line.taxable === null
          ? null
          : amount(line.taxable, `Line ${index + 1} taxable`, { min: 0 }),
      gst:
        line.gst === undefined || line.gst === null
          ? null
          : amount(line.gst, `Line ${index + 1} GST`, { min: 0 }),
    };
  });
}

@Controller('api')
export class ReachTradeController {
  private async me(db: any, actor: { id: string }) {
    const rep = await repForUser(db, actor.id);
    if (!rep)
      fail(
        403,
        'NOT_A_FIELD_REP',
        'This login is not linked to a field rep, so it cannot take an order. Ask an administrator to link it.',
      );
    // `fail` always throws, but it carries no explicit `never`, so TypeScript cannot see that.
    return rep!;
  }

  // The shop, confirmed to exist. Reading a customer is reading Reach, so every route here is
  // gated on its own right and this only resolves the record.
  private async shop(db: any, customerId: string) {
    const customer = await tradeCustomer(db, customerId);
    if (!customer) fail(404, 'RECORD_NOT_FOUND', 'That customer was not found.');
    return customer!;
  }

  // ---------- The whole screen ----------

  @Get('reach/trade/customer/:id') async view(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await tradeSettings(db);
      const asOf = await todayFor(db, settings);
      const view = await customer360(db, customerId, { asOf, settings });
      if (!view) fail(404, 'RECORD_NOT_FOUND', 'That customer was not found.');
      return {
        ...view!,
        asOf,
        can: {
          order: actor.permissions.includes('reach.order'),
          collect: actor.permissions.includes('reach.collect'),
          kyc: actor.permissions.includes('reach.kyc'),
          credit: actor.permissions.includes('reach.credit'),
          // The switch, read by the screen so it does not offer a button nothing will accept.
          invoice: actor.permissions.includes('reach.invoice'),
          terms: actor.permissions.includes('reach.setup'),
        },
      };
    });
  }

  @Get('reach/trade/customer/:id/timeline') async story(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      await this.shop(db, customerId);
      return { items: await timelineFor(db, customerId, 200) };
    });
  }

  @Get('reach/trade/customer/:id/outstanding') async owing(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await tradeSettings(db);
      await this.shop(db, customerId);
      const asOf =
        req.query.as_of === undefined
          ? await todayFor(db, settings)
          : isoDate(req.query.as_of, 'As of');
      return { asOf, ...(await outstandingFor(db, customerId, asOf, settings)) };
    });
  }

  // ---------- Terms ----------

  @Put('reach/trade/customer/:id/terms') async terms(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const raw = body(req, ['credit_limit', 'credit_days', 'hold_days', 'version']);
    const v = version(raw.version);
    // Null is the answer that hands the question back to the customer type, so it is accepted
    // where a number is: "no override" and "a limit of zero" are different instructions.
    const optional = (value: unknown, label: string, max: number) => {
      if (value === null || value === undefined || value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > max)
        fail(400, 'VALIDATION_ERROR', `${label} must be a number from 0 to ${max}, or blank.`);
      return n;
    };
    const limit = optional(raw.credit_limit, 'Credit limit', 999999999);
    const days = optional(raw.credit_days, 'Credit days', 365);
    const hold = optional(raw.hold_days, 'Hold after days', 365);

    return mutate(req, 'reach.setup', async (db, actor) => {
      const customer = await this.shop(db, customerId);
      if (!(await saveTerms(db, { customerId, version: v, limit, days, hold })))
        fail(409, 'STALE_RECORD', 'This customer changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'trade.terms_changed', 'trade_customers', customerId, null, {
        customer: customer.code,
        credit_limit: limit,
        credit_days: days,
        hold_days: hold,
      });
      return { message: `Terms saved for ${customer.code}.` };
    });
  }

  // ---------- KYC ----------

  @Get('reach/trade/customer/:id/kyc') async kyc(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const customer = await this.shop(db, customerId);
      return {
        ...(await kycFor(db, customer)),
        asked: await kycRequired(db, customer.type_id),
        canDecide: actor.permissions.includes('reach.kyc'),
      };
    });
  }

  @Post('reach/trade/customer/:id/kyc') async upload(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const raw = body(req, ['kyc_type_id', 'file_id', 'number', 'valid_to']);
    const kycTypeId = id(raw.kyc_type_id);
    const fileId = raw.file_id === undefined || raw.file_id === null ? null : id(raw.file_id);
    const number = raw.number === undefined ? '' : text(raw.number, 'Number', 0, 40);
    const validTo =
      raw.valid_to === undefined || raw.valid_to === null
        ? null
        : isoDate(raw.valid_to, 'Valid until');

    return mutate(req, 'reach.kyc', async (db, actor) => {
      const customer = await this.shop(db, customerId);
      // Only a document this customer's type actually asks for may be uploaded against it.
      const asked = await kycRequired(db, customer.type_id);
      const want = asked.find((a: any) => a.id === kycTypeId);
      if (!want)
        fail(404, 'RECORD_NOT_FOUND', 'That document is not one this customer type asks for.');
      // A document with a number to check is checked by the same validator the customer form
      // uses, so there is one idea of a valid GSTIN in the system.
      if (want!.number_check !== 'none' && !number)
        invalid([{ column: 'number', message: `${want!.name} needs its number.` }]);
      if (
        want!.number_check === 'gstin' &&
        !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z][Z][0-9A-Z]$/.test(number)
      )
        invalid([{ column: 'number', message: 'That is not a valid GSTIN.' }]);
      if (want!.number_check === 'pan' && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(number))
        invalid([{ column: 'number', message: 'That is not a valid PAN.' }]);

      const docId = crypto.randomUUID();
      await uploadKyc(db, actor.tenant_id, {
        id: docId,
        customerId,
        kycTypeId,
        fileId,
        number,
        validTo,
        actorId: actor.id,
      });
      await audit(db, actor, 'kyc.uploaded', 'kyc_documents', docId, null, {
        customer: customer.code,
        kyc_type: want!.code,
      });
      return { id: docId, message: `${want!.name} uploaded for ${customer.code}.` };
    });
  }

  @Get('reach/trade/kyc') async kycQueue(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    const status =
      req.query.status === undefined ? 'PENDING' : text(req.query.status, 'Status', 0, 20);
    return scoped(actor.tenant_id, async (db) => ({
      ...(await listKyc(db, { status: status || null })),
      canDecide: actor.permissions.includes('reach.kyc'),
    }));
  }

  @Post('reach/trade/kyc/:id/decide') async decideDocument(
    @Req() req: Request,
    @Param('id') docId: string,
  ) {
    id(docId);
    const raw = body(req, ['status', 'reason', 'version']);
    const status = String(raw.status ?? '');
    if (!KYC_DECISIONS.includes(status))
      fail(400, 'VALIDATION_ERROR', 'A document is either verified or rejected.');
    const reason =
      raw.reason === undefined && status !== 'REJECTED'
        ? ''
        : text(raw.reason, 'Reason', status === 'REJECTED' ? 1 : 0, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.kyc', async (db, actor) => {
      const doc = await findKycDocument(db, docId);
      if (!doc) fail(404, 'RECORD_NOT_FOUND', 'That document was not found.');
      if (doc!.status !== 'PENDING')
        fail(409, 'STALE_RECORD', 'This document was already decided.');
      if (!(await decideKyc(db, actor.id, { id: docId, version: v, status, reason })))
        fail(409, 'STALE_RECORD', 'This document was already decided, or changed elsewhere.');
      await audit(db, actor, 'kyc.decided', 'kyc_documents', docId, null, {
        customer: doc!.customer,
        kyc_type: doc!.kyc_type,
        status,
        reason,
      });
      return { message: status === 'VERIFIED' ? 'Document verified.' : 'Document rejected.' };
    });
  }

  // ---------- Price ----------

  @Get('reach/trade/customer/:id/price') async price(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const actor = await access(req, 'reach.order');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await tradeSettings(db);
      const customer = await this.shop(db, customerId);
      const date = await todayFor(db, settings);
      // The list travels with the screen. Reading the price master needs reach.read, and a rep
      // taking an order is not given the right to read every other type's rates.
      return { date, items: await ratesFor(db, customer.type_id, date) };
    });
  }

  // Prices a basket without taking the order, so a rep sees the total and the hold before they
  // commit to it.
  @Post('reach/trade/customer/:id/quote') async quote(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const lines = basketOf(body(req, ['lines']).lines);
    const actor = await access(req, 'reach.order');
    return scoped(actor.tenant_id, async (db) => {
      const settings = await tradeSettings(db);
      const customer = await this.shop(db, customerId);
      const date = await todayFor(db, settings);
      const priced = await priceBasket(db, { typeId: customer.type_id, date, lines });
      if (priced.missing.length)
        fail(
          400,
          'NO_PRICE',
          `${priced.missing.length} ${priced.missing.length === 1 ? 'item has' : 'items have'} no price for ${customer.type} today.`,
        );
      const state = await creditFor(db, customer, {
        asOf: date,
        orderValue: priced.totals.total,
        settings,
      });
      return { date, ...priced, credit: state.credit, kyc: state.kyc.status };
    });
  }

  // ---------- The order ----------

  @Post('reach/trade/customer/:id/order') async order(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const raw = body(req, ['lines', 'visit_id', 'note', 'client_ref']);
    const lines = basketOf(raw.lines);
    const visitId = raw.visit_id === undefined || raw.visit_id === null ? null : id(raw.visit_id);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);
    // RCH-8: the phone's own name for this order, minted before it was ever sent.
    const clientRef = raw.client_ref === undefined ? '' : text(raw.client_ref, 'Reference', 0, 80);

    return mutate(req, 'reach.order', async (db, actor) => {
      // A rep may take two identical orders at one counter in one morning, so nothing in the
      // content can tell a retry from a second order. The reference can, and this runs inside
      // the same transaction and tenant lock as the write, so two retries racing each other
      // still produce one order.
      const already = clientRef ? await orderByClientRef(db, clientRef) : null;
      if (already)
        return {
          id: already.id,
          order_no: already.order_no,
          status: already.status,
          total: already.total,
          credit: { hold: already.status === 'HELD', reasons: [], message: '' },
          repeat: true,
          message: `Order ${already.order_no} was already taken.`,
        };
      const settings = await tradeSettings(db);
      const rep = await this.me(db, actor);
      const customer = await this.shop(db, customerId);
      const date = await todayFor(db, settings);

      const priced = await priceBasket(db, { typeId: customer.type_id, date, lines });
      if (priced.missing.length)
        fail(400, 'NO_PRICE', `Some items have no price for ${customer.type} today.`);

      // The live decision, taken now. A hold does not refuse the order: it is taken, saved and
      // waits for somebody with the right to release it.
      const state = await creditFor(db, customer, {
        asOf: date,
        orderValue: priced.totals.total,
        settings,
      });

      const orderId = crypto.randomUUID();
      const orderNo = `${customer.code}-${Date.now().toString(36).toUpperCase()}`;
      await createOrder(db, actor.tenant_id, {
        id: orderId,
        orderNo,
        customerId,
        repId: rep.id,
        visitId,
        orderDate: date,
        route: customer.terms.order_route,
        note,
        priced,
        credit: state.credit,
        clientRef,
      });
      await audit(
        db,
        actor,
        state.credit.hold ? 'trade.order_held' : 'trade.order_placed',
        'trade_orders',
        orderId,
        null,
        {
          customer: customer.code,
          rep: rep.code,
          total: priced.totals.total,
          reasons: state.credit.reasons,
        },
      );
      return {
        id: orderId,
        order_no: orderNo,
        status: state.credit.hold ? 'HELD' : 'PLACED',
        total: priced.totals.total,
        credit: state.credit,
        // A held order is recorded, not refused, and the message says which it was.
        message: state.credit.hold
          ? `Order ${orderNo} taken and held. ${state.credit.message}`
          : `Order ${orderNo} placed for ${priced.totals.total}.`,
      };
    });
  }

  @Get('reach/trade/orders') async orders(@Req() req: Request) {
    const actor = await access(req, 'reach.order');
    const { from, to } = spanOf(req);
    const status = req.query.status === undefined ? null : text(req.query.status, 'Status', 0, 20);
    const customerId = req.query.customer === undefined ? null : id(req.query.customer);
    const wanted = req.query.rep === undefined ? null : id(req.query.rep);
    return scoped(actor.tenant_id, async (db) => {
      // Without reach.read a person sees the orders they took and nobody else's.
      let repId = wanted;
      if (!actor.permissions.includes('reach.read')) {
        const own = await repForUser(db, actor.id);
        if (wanted && wanted !== own?.id)
          fail(403, 'FORBIDDEN', 'You may only read your own orders.');
        repId = own?.id ?? null;
        if (!repId) fail(403, 'NOT_A_FIELD_REP', 'This login is not linked to a field rep.');
      } else if (wanted) {
        if (!(await findRep(db, wanted)))
          fail(404, 'RECORD_NOT_FOUND', 'That field rep was not found.');
      }
      return {
        ...(await listOrders(db, { customerId, repId, status: status || null, from, to })),
        canRelease: actor.permissions.includes('reach.credit'),
        canInvoice: actor.permissions.includes('reach.invoice'),
      };
    });
  }

  @Get('reach/trade/orders/:id') async oneOrder(@Req() req: Request, @Param('id') orderId: string) {
    id(orderId);
    const actor = await access(req, 'reach.order');
    return scoped(actor.tenant_id, async (db) => {
      const order = await findOrder(db, orderId);
      if (!order) fail(404, 'RECORD_NOT_FOUND', 'That order was not found.');
      const own = await repForUser(db, actor.id);
      if (own?.id !== order!.rep_id && !actor.permissions.includes('reach.read'))
        fail(403, 'FORBIDDEN', 'You may only read your own orders.');
      return { ...order, billed: await invoiceForOrder(db, orderId) };
    });
  }

  // Releasing a hold is its own right, and the reason is required: somebody owns this decision.
  @Post('reach/trade/orders/:id/release') async release(
    @Req() req: Request,
    @Param('id') orderId: string,
  ) {
    id(orderId);
    const raw = body(req, ['reason', 'version']);
    const reason = text(raw.reason, 'Reason', 1, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.credit', async (db, actor) => {
      const order = await findOrder(db, orderId);
      if (!order) fail(404, 'RECORD_NOT_FOUND', 'That order was not found.');
      if (order!.status !== 'HELD') fail(409, 'NOT_HELD', 'This order is not on hold.');
      if (!(await releaseOrder(db, actor.id, { id: orderId, version: v, reason })))
        fail(409, 'STALE_RECORD', 'This order changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'trade.order_released', 'trade_orders', orderId, null, {
        customer: order!.customer,
        order_no: order!.order_no,
        was: order!.hold_reasons,
        reason,
      });
      return { message: `Order ${order!.order_no} released.` };
    });
  }

  @Post('reach/trade/orders/:id/route') async route(
    @Req() req: Request,
    @Param('id') orderId: string,
  ) {
    id(orderId);
    const raw = body(req, ['external_ref', 'version']);
    const externalRef =
      raw.external_ref === undefined ? '' : text(raw.external_ref, 'Reference', 0, 60);
    const v = version(raw.version);

    return mutate(req, 'reach.order', async (db, actor) => {
      const order = await findOrder(db, orderId);
      if (!order) fail(404, 'RECORD_NOT_FOUND', 'That order was not found.');
      if (order!.status !== 'PLACED') fail(409, 'NOT_PLACED', 'Only a placed order is sent on.');
      if (!(await routeOrder(db, { id: orderId, version: v, externalRef })))
        fail(409, 'STALE_RECORD', 'This order changed elsewhere. Refresh and try again.');
      await audit(db, actor, 'trade.order_routed', 'trade_orders', orderId, null, {
        order_no: order!.order_no,
        route: order!.route,
        external_ref: externalRef,
      });
      return { message: `Order ${order!.order_no} sent to ${order!.route}.` };
    });
  }

  @Patch('reach/trade/orders/:id/cancel') async scrapOrder(
    @Req() req: Request,
    @Param('id') orderId: string,
  ) {
    id(orderId);
    const raw = body(req, ['reason', 'version']);
    const reason = text(raw.reason, 'Reason', 1, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.order', async (db, actor) => {
      const order = await findOrder(db, orderId);
      if (!order) fail(404, 'RECORD_NOT_FOUND', 'That order was not found.');
      const own = await repForUser(db, actor.id);
      // A rep cancels their own order; cancelling somebody else's is a manager's act.
      if (own?.id !== order!.rep_id && !actor.permissions.includes('reach.read'))
        fail(403, 'FORBIDDEN', 'You may only cancel your own order.');
      if (!(await cancelOrder(db, { id: orderId, version: v, reason })))
        fail(409, 'STALE_RECORD', 'This order was already cancelled, or changed elsewhere.');
      await audit(db, actor, 'trade.order_cancelled', 'trade_orders', orderId, null, {
        order_no: order!.order_no,
        reason,
      });
      return { message: `Order ${order!.order_no} cancelled.` };
    });
  }

  // ---------- Bills ----------

  // Raises a bill from an order, with this module's own number. Gated by `reach.invoice`: granted
  // to nobody, this route is simply never reachable and every bill arrives from an ERP instead.
  @Post('reach/trade/orders/:id/invoice') async raise(
    @Req() req: Request,
    @Param('id') orderId: string,
  ) {
    id(orderId);
    const raw = body(req, ['prefix', 'invoice_date', 'due_date', 'note']);
    const prefix = raw.prefix === undefined ? 'INV' : text(raw.prefix, 'Prefix', 1, 20);
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,19}$/.test(prefix))
      invalid([{ column: 'prefix', message: 'A series prefix is letters, numbers and - _ . /' }]);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);

    return mutate(req, 'reach.invoice', async (db, actor) => {
      const settings = await tradeSettings(db);
      const order = await findOrder(db, orderId);
      if (!order) fail(404, 'RECORD_NOT_FOUND', 'That order was not found.');
      if (!['PLACED', 'ROUTED'].includes(order!.status))
        fail(409, 'NOT_BILLABLE', 'Only a placed or routed order can be billed.');
      const already = await invoiceForOrder(db, orderId);
      if (already)
        fail(409, 'ALREADY_EXISTS', `This order is already billed as ${already.invoice_no}.`);

      const invoiceDate =
        raw.invoice_date === undefined
          ? await todayFor(db, settings)
          : isoDate(raw.invoice_date, 'Invoice date');
      const dueDate =
        raw.due_date === undefined || raw.due_date === null
          ? null
          : isoDate(raw.due_date, 'Due date');
      if (dueDate && dueDate < invoiceDate)
        invalid([
          { column: 'due_date', message: 'The due date cannot be before the invoice date.' },
        ]);

      // The series restarts each financial year, which is how a GST series runs.
      const fy = financialYearStart(invoiceDate, Number(settings.fy_start_month ?? 4));
      const series = await nextInvoiceNo(db, actor.tenant_id, { prefix, fy });
      const invoiceId = crypto.randomUUID();
      await raiseInvoiceFromOrder(db, actor.tenant_id, {
        id: invoiceId,
        order: order!,
        series,
        invoiceDate,
        dueDate,
        actorId: actor.id,
        note,
      });
      await audit(db, actor, 'trade.invoice_raised', 'trade_invoices', invoiceId, null, {
        customer: order!.customer,
        order_no: order!.order_no,
        invoice_no: series.number,
        amount: order!.total,
      });
      return {
        id: invoiceId,
        invoice_no: series.number,
        amount: order!.total,
        message: `Invoice ${series.number} raised for ${order!.total}.`,
      };
    });
  }

  // Records a bill that was raised somewhere else. The number is whatever that document says; no
  // series is touched, so the two numbering authorities stay told apart for ever.
  @Post('reach/trade/customer/:id/invoice') async record(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const raw = body(req, [
      'invoice_no',
      'invoice_date',
      'due_date',
      'amount',
      'taxable',
      'gst',
      'source',
      'order_id',
      'note',
      'lines',
    ]);
    const invoiceNo = text(raw.invoice_no, 'Invoice number', 1, 40);
    const invoiceDate = isoDate(raw.invoice_date, 'Invoice date');
    const dueDate =
      raw.due_date === undefined || raw.due_date === null
        ? null
        : isoDate(raw.due_date, 'Due date');
    const value = amount(raw.amount, 'Amount');
    const taxable =
      raw.taxable === undefined || raw.taxable === null
        ? null
        : amount(raw.taxable, 'Taxable', { min: 0 });
    const gst =
      raw.gst === undefined || raw.gst === null ? null : amount(raw.gst, 'GST', { min: 0 });
    const source = String(raw.source ?? 'MANUAL');
    if (!INVOICE_SOURCES.includes(source))
      fail(
        400,
        'VALIDATION_ERROR',
        'A recorded bill came from an ERP, an import or was entered by hand.',
      );
    const orderId = raw.order_id === undefined || raw.order_id === null ? null : id(raw.order_id);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);
    if (dueDate && dueDate < invoiceDate)
      invalid([{ column: 'due_date', message: 'The due date cannot be before the invoice date.' }]);
    const lines = billLinesOf(raw.lines);
    // The lines, where they were given, have to agree with what the bill says it came to.
    if (lines.length) {
      const sum = lines.reduce((total: number, l) => total + l.total, 0);
      if (money(sum) !== value)
        invalid([
          {
            column: 'lines',
            message: `The lines come to ${money(sum)}, but the bill says ${value}.`,
          },
        ]);
    }

    return mutate(req, 'reach.invoice', async (db, actor) => {
      const customer = await this.shop(db, customerId);
      if (orderId) {
        const order = await findOrder(db, orderId);
        if (!order || order.customer_id !== customerId)
          fail(404, 'RECORD_NOT_FOUND', 'That order is not one of this customer’s.');
      }
      const invoiceId = crypto.randomUUID();
      try {
        await recordInvoice(db, actor.tenant_id, {
          id: invoiceId,
          invoiceNo,
          customerId,
          orderId,
          invoiceDate,
          dueDate,
          amount: value,
          taxable,
          gst,
          source,
          note,
          lines,
        });
      } catch (e: any) {
        if (e?.code === '23505')
          fail(409, 'ALREADY_EXISTS', `Invoice ${invoiceNo} is already recorded.`);
        throw e;
      }
      await audit(db, actor, 'trade.invoice_recorded', 'trade_invoices', invoiceId, null, {
        customer: customer.code,
        invoice_no: invoiceNo,
        amount: value,
        source,
      });
      return { id: invoiceId, message: `Invoice ${invoiceNo} recorded for ${customer.code}.` };
    });
  }

  @Patch('reach/trade/invoices/:id/cancel') async scrapInvoice(
    @Req() req: Request,
    @Param('id') invoiceId: string,
  ) {
    id(invoiceId);
    const raw = body(req, ['reason', 'version']);
    const reason = text(raw.reason, 'Reason', 1, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.invoice', async (db, actor) => {
      const invoice = await findInvoice(db, invoiceId);
      if (!invoice) fail(404, 'RECORD_NOT_FOUND', 'That invoice was not found.');
      if (!(await cancelInvoice(db, { id: invoiceId, version: v, reason })))
        fail(409, 'STALE_RECORD', 'This invoice was already cancelled, or changed elsewhere.');
      await audit(db, actor, 'trade.invoice_cancelled', 'trade_invoices', invoiceId, null, {
        customer: invoice!.customer,
        invoice_no: invoice!.invoice_no,
        reason,
      });
      // The number stays used. That is what a gapless series means in practice.
      return { message: `Invoice ${invoice!.invoice_no} cancelled. Its number stays used.` };
    });
  }

  // ---------- Collections ----------

  @Post('reach/trade/customer/:id/receipt') async collect(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const raw = body(req, [
      'amount',
      'mode',
      'reference',
      'invoice_id',
      'received_on',
      'file_id',
      'latitude',
      'longitude',
      'note',
      'client_ref',
    ]);
    const value = amount(raw.amount, 'Amount');
    const mode = String(raw.mode ?? '');
    if (!PAYMENT_MODES.includes(mode as any))
      fail(400, 'VALIDATION_ERROR', 'That is not a way this system records money.');
    const reference = raw.reference === undefined ? '' : text(raw.reference, 'Reference', 0, 60);
    // A cheque or a transfer without its number cannot be traced to a bank line.
    if (['CHEQUE', 'NEFT', 'UPI'].includes(mode) && !reference)
      invalid([{ column: 'reference', message: `A ${mode.toLowerCase()} needs its number.` }]);
    const invoiceId =
      raw.invoice_id === undefined || raw.invoice_id === null ? null : id(raw.invoice_id);
    const fileId = raw.file_id === undefined || raw.file_id === null ? null : id(raw.file_id);
    const note = raw.note === undefined ? '' : text(raw.note, 'Note', 0, 300);
    // RCH-8: the phone's own name for this collection, minted before it was ever sent.
    const clientRef = raw.client_ref === undefined ? '' : text(raw.client_ref, 'Reference', 0, 80);
    const place = (value: unknown, label: string, bound: number) => {
      if (value === undefined || value === null || value === '') return null;
      const n = Number(value);
      if (!Number.isFinite(n) || n < -bound || n > bound)
        fail(400, 'VALIDATION_ERROR', `${label} must be a number between -${bound} and ${bound}.`);
      return n;
    };
    const at = {
      latitude: place(raw.latitude, 'Latitude', 90),
      longitude: place(raw.longitude, 'Longitude', 180),
    };
    if ((at.latitude === null) !== (at.longitude === null))
      fail(400, 'VALIDATION_ERROR', 'A location needs both a latitude and a longitude.');

    return mutate(req, 'reach.collect', async (db, actor) => {
      // Two collections of the same amount from the same shop on the same day are ordinary, so
      // only the device's own reference can tell a retry from a second payment. Crediting a shop
      // twice is the worst mistake this module could make, and this is what prevents it.
      const repeated = clientRef ? await receiptByClientRef(db, clientRef) : null;
      if (repeated) {
        const settled = await tradeSettings(db);
        const on = await todayFor(db, settled);
        const now = await outstandingFor(db, customerId, on, settled);
        return {
          id: repeated.id,
          receipt_no: repeated.receipt_no,
          outstanding: now.outstanding,
          repeat: true,
          message: `${repeated.amount} from this device was already recorded as ${repeated.receipt_no}.`,
        };
      }
      const settings = await tradeSettings(db);
      const customer = await this.shop(db, customerId);
      const own = await repForUser(db, actor.id);
      const today = await todayFor(db, settings);
      const receivedOn =
        raw.received_on === undefined ? today : isoDate(raw.received_on, 'Received on');
      // Money cannot be collected tomorrow.
      if (receivedOn > today)
        invalid([
          { column: 'received_on', message: 'A collection cannot be dated in the future.' },
        ]);
      if (invoiceId) {
        const invoice = await findInvoice(db, invoiceId);
        if (!invoice || invoice.customer_id !== customerId)
          fail(404, 'RECORD_NOT_FOUND', 'That bill is not one of this customer’s.');
        if (invoice!.status === 'CANCELLED')
          fail(409, 'INVOICE_CANCELLED', 'That bill was cancelled.');
      }

      const receiptId = crypto.randomUUID();
      const receiptNo = `${customer.code}-R${Date.now().toString(36).toUpperCase()}`;
      await recordReceipt(db, actor.tenant_id, {
        id: receiptId,
        receiptNo,
        customerId,
        repId: own?.id ?? null,
        invoiceId,
        receivedOn,
        amount: value,
        mode,
        reference,
        fileId,
        at,
        note,
        clientRef,
      });
      await audit(db, actor, 'trade.collected', 'trade_receipts', receiptId, null, {
        customer: customer.code,
        amount: value,
        mode,
        reference,
      });
      // The outstanding is read again afterwards, so the rep sees the effect of what they just
      // banked rather than having to trust it.
      const after = await outstandingFor(db, customerId, today, settings);
      return {
        id: receiptId,
        receipt_no: receiptNo,
        outstanding: after.outstanding,
        message: `${value} collected from ${customer.code}. ${after.outstanding} still outstanding.`,
      };
    });
  }

  @Patch('reach/trade/receipts/:id/cancel') async scrapReceipt(
    @Req() req: Request,
    @Param('id') receiptId: string,
  ) {
    id(receiptId);
    const raw = body(req, ['reason', 'version']);
    const reason = text(raw.reason, 'Reason', 1, 300);
    const v = version(raw.version);

    return mutate(req, 'reach.collect', async (db, actor) => {
      const receipt = await findReceipt(db, receiptId);
      if (!receipt) fail(404, 'RECORD_NOT_FOUND', 'That receipt was not found.');
      const own = await repForUser(db, actor.id);
      // A rep reverses their own receipt; reversing somebody else's is a manager's act.
      if (own?.id !== receipt!.rep_id && !actor.permissions.includes('reach.read'))
        fail(403, 'FORBIDDEN', 'You may only cancel your own receipt.');
      if (!(await cancelReceipt(db, { id: receiptId, version: v, reason })))
        fail(409, 'STALE_RECORD', 'This receipt was already cancelled, or changed elsewhere.');
      await audit(db, actor, 'trade.collection_cancelled', 'trade_receipts', receiptId, null, {
        customer: receipt!.customer,
        receipt_no: receipt!.receipt_no,
        amount: receipt!.amount,
        reason,
      });
      return { message: `Receipt ${receipt!.receipt_no} cancelled. The amount is owed again.` };
    });
  }

  // ---------- Setup ----------

  @Put('reach/trade/settings') async saveSettings(@Req() req: Request) {
    const raw = body(req, ['ageing_buckets', 'fy_start_month', 'dso_window_days', 'version']);
    if (!Number.isInteger(raw.version) || raw.version < 0)
      fail(400, 'VERSION_REQUIRED', 'Settings version is missing. Refresh before saving.');
    const errors: { column: string; message: string }[] = [];
    const buckets = String(raw.ageing_buckets ?? '').trim();
    if (!/^[0-9]{1,3}(,[0-9]{1,3}){0,4}$/.test(buckets))
      errors.push({
        column: 'ageing_buckets',
        message: 'Write the buckets as days separated by commas, for example 30,60,90.',
      });
    else {
      const edges = buckets.split(',').map(Number);
      if (edges.some((e) => e < 1))
        errors.push({ column: 'ageing_buckets', message: 'A bucket is at least one day.' });
      // Out of order, the buckets would overlap and a bill would fall in two of them.
      if (edges.some((e, i) => i > 0 && e <= edges[i - 1]))
        errors.push({
          column: 'ageing_buckets',
          message: 'Each bucket has to be larger than the one before it.',
        });
    }
    const bounds = { fy_start_month: [1, 12], dso_window_days: [7, 730] } as const;
    const value: Record<string, unknown> = {};
    for (const [key, [low, high]] of Object.entries(bounds)) {
      const given = raw[key];
      if (!Number.isInteger(given) || given < low || given > high)
        errors.push({
          column: key,
          message: `This must be a whole number from ${low} to ${high}.`,
        });
      else value[key] = given;
    }
    if (errors.length) invalid(errors);
    value.ageing_buckets = buckets;

    return mutate(req, 'reach.setup', async (db, actor) => {
      const current = await tradeSettings(db);
      if (current.version !== Number(raw.version))
        fail(409, 'STALE_RECORD', 'These settings changed elsewhere. Refresh before saving.');
      await saveReachSettings(db, actor.tenant_id, value);
      await audit(
        db,
        actor,
        'reach.settings_changed',
        'reach_settings',
        actor.tenant_id,
        null,
        value,
      );
      return { message: 'Customer 360 settings saved.' };
    });
  }
}
