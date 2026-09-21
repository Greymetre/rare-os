import {
  MOVEMENT_PERMISSIONS,
  validateMovement,
  validatePurchaseOrder,
  validateSalesOrder,
  validateStockLocation,
} from '../../../packages/schema/demand-stock.mjs';
import {
  cancelOrder,
  closeProductionOrder,
  checkMovements,
  checkOrders,
  checkStockLocations,
  listBalances,
  listDemandHistory,
  listMovements,
  listOrders,
  listProductionOrders,
  listStockLocations,
  movementDetail,
  nextOrderNo,
  orderDetail,
  postMovements,
  productionOrderDetail,
  reversalFor,
  stockInLocation,
  writeOrder,
  writeStockLocation,
} from '../../../packages/schema/demand-stock-db.mjs';
import { Controller, Get, Post, Patch, Put, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { access, scoped, fail } from './core.js';
import { id, text, body, version, mutate, audit } from './access.controller.js';
import { requirePlant } from './plants.controller.js';
import {
  cursorOf,
  encode,
  invalid,
  loaded,
  sameVersion,
  search,
  today,
} from './plant-model.controller.js';

type Problem = { column: string; message: string };
type OrderKind = 'sales_orders' | 'purchase_orders';

const ORDERS = {
  sales_orders: {
    read: 'orders.read',
    create: 'orders.create',
    update: 'orders.update',
    noun: 'Order',
    no: 'order_no',
    header: ['customer', 'order_date', 'promise_date', 'allow_partial', 'customer_ref', 'lines'],
    validate: validateSalesOrder,
  },
  purchase_orders: {
    read: 'purchase.read',
    create: 'purchase.create',
    update: 'purchase.create',
    noun: 'Purchase order',
    no: 'po_no',
    header: ['supplier', 'order_date', 'lines'],
    validate: validatePurchaseOrder,
  },
} as const;

// Posting a movement that would take stock below zero is refused by the database itself.
function notEnoughStock(e: any): never {
  if (e?.constraint === 'stock_not_negative')
    fail(
      409,
      'NOT_ENOUGH_STOCK',
      'Not enough stock for this movement. Refresh the stock and try again.',
    );
  throw e;
}

// Received quantities on purchase orders come from goods receipts, never from the order form.
function receivedFromRecords(kind: OrderKind, raw: any, old: any) {
  if (kind !== 'purchase_orders' || !Array.isArray(raw.lines)) return;
  const existing = new Map<number, any>((old?.lines ?? []).map((l: any) => [Number(l.line_no), l]));
  for (const line of raw.lines) {
    if (!line || typeof line !== 'object') continue;
    const prior = existing.get(Number(line.line_no));
    line.received_quantity = prior ? String(Number(prior.received_quantity)) : '0';
    if (
      prior &&
      Number(prior.received_quantity) > 0 &&
      String(line.item ?? '').toLowerCase() !== prior.item.toLowerCase()
    )
      fail(
        409,
        'LINE_RECEIVED',
        `Line ${prior.line_no} already has goods received; its item cannot change. Add a new line instead.`,
      );
  }
}

function reasonOf(value: unknown) {
  return text(value, 'Reason', 3, 200);
}

@Controller('api')
export class DemandStockController {
  // ---------- Stock locations ----------
  @Get('plants/:plantId/stock-locations') async locations(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return { items: await listStockLocations(db, plant.id) };
    });
  }

  @Post('plants/:plantId/stock-locations') async createLocation(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    id(plantId);
    const raw = body(req, ['code', 'name', 'location_type', 'nettable']);
    return mutate(req, 'masters.manage', async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const checked = validateStockLocation({ ...raw, plant: plant.code });
      if (checked.errors.length) invalid(checked.errors);
      const [row] = await checkStockLocations(
        db,
        [{ value: checked.value, errors: [] as Problem[] }],
        null,
      );
      if (row.errors.length) invalid(row.errors);
      if (row.existing)
        fail(
          409,
          'ALREADY_EXISTS',
          `Location ${checked.value.code} already exists in plant ${plant.code}.`,
        );
      const locationId = await writeStockLocation(db, actor.tenant_id, row.value, null);
      await audit(
        db,
        actor,
        'stock_location.created',
        'stock_location',
        locationId,
        null,
        row.value,
      );
      return { id: locationId, message: `Location ${checked.value.code} created.` };
    });
  }

  @Patch('stock-locations/:id') async editLocation(
    @Req() req: Request,
    @Param('id') locationId: string,
  ) {
    id(locationId);
    const raw = body(req, ['name', 'location_type', 'nettable', 'active', 'version']);
    const v = version(raw.version);
    if (typeof raw.active !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    return mutate(req, 'masters.manage', async (db, actor) => {
      const old = (
        await db.query(
          'SELECT l.*,s.code AS plant FROM stock_locations l JOIN sites s ON s.id=l.site_id WHERE l.id=$1',
          [locationId],
        )
      ).rows[0];
      await loaded(old, 'stock location');
      await requirePlant(db, actor, old.site_id);
      sameVersion(old.version, v, 'stock location');
      if (old.active && !raw.active) {
        const stocked = await stockInLocation(db, locationId);
        if (stocked)
          fail(
            409,
            'LOCATION_HAS_STOCK',
            `Location ${old.code} still holds stock of ${stocked} item(s). Move or adjust that stock to zero first.`,
          );
      }
      const checked = validateStockLocation({ ...raw, plant: old.plant, code: old.code });
      if (checked.errors.length) invalid(checked.errors);
      await writeStockLocation(
        db,
        actor.tenant_id,
        { ...checked.value, site_id: old.site_id },
        old,
        raw.active,
      );
      await audit(db, actor, 'stock_location.updated', 'stock_location', locationId, old, {
        ...checked.value,
        active: raw.active,
      });
      return { message: `Location ${old.code} saved.` };
    });
  }

  // ---------- Stock ----------
  @Get('plants/:plantId/stock') async stock(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'inventory.read');
    const q = search(req),
      cursor = cursorOf(req, 2);
    const location = req.query.location === undefined ? null : id(String(req.query.location));
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const page = await listBalances(db, plant.id, { q, locationId: location, cursor });
      return { items: page.items, nextCursor: encode(page.nextCursor) };
    });
  }

  @Get('plants/:plantId/stock/movements') async movements(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'inventory.read');
    const q = search(req);
    const cursor =
      req.query.cursor === undefined
        ? null
        : /^[1-9][0-9]{0,17}$/.test(String(req.query.cursor))
          ? String(req.query.cursor)
          : fail(400, 'INVALID_CURSOR', 'This page link is invalid. Return to the first page.');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return listMovements(db, plant.id, { q, cursor });
    });
  }

  @Post('plants/:plantId/stock/movements') async post(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    id(plantId);
    const raw = body(req, [
      'location',
      'item',
      'movement_type',
      'quantity',
      'unit',
      'movement_date',
      'reference',
      'reason',
    ]);
    return mutate(req, 'inventory.read', async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const checked = validateMovement({ ...raw, plant: plant.code });
      if (checked.errors.length) invalid(checked.errors);
      const needed =
        MOVEMENT_PERMISSIONS[checked.value.movement_type as keyof typeof MOVEMENT_PERMISSIONS];
      if (!actor.permissions.includes(needed))
        fail(
          403,
          'PERMISSION_DENIED',
          needed === 'inventory.adjust'
            ? 'Opening stock and adjustments need the "Post opening stock, adjustments and reversals" permission.'
            : 'Receipts and issues need the "Post stock receipts and issues" permission.',
        );
      const [row] = await checkMovements(
        db,
        [{ value: checked.value, errors: [] as Problem[] }],
        null,
        {
          today: today(),
        },
      );
      if (row.errors.length) invalid(row.errors);
      const [posted] = await postMovements(
        db,
        actor.tenant_id,
        { id: actor.id, subject: actor.actor_subject },
        [row.value],
      ).catch(notEnoughStock);
      await audit(db, actor, 'stock_movement.posted', 'stock_movement', posted.id, null, row.value);
      return {
        id: posted.id,
        movementNo: posted.movement_no,
        message: `Movement #${posted.movement_no} posted: ${checked.value.movement_type} ${row.value.base_quantity} ${row.value.base_unit} of ${row.value.item} at ${row.value.location}.`,
      };
    });
  }

  @Post('stock-movements/:id/reverse') async reverse(
    @Req() req: Request,
    @Param('id') movementId: string,
  ) {
    id(movementId);
    const reason = reasonOf(body(req, ['reason']).reason);
    return mutate(req, 'inventory.adjust', async (db, actor) => {
      const original: any = await loaded(await movementDetail(db, movementId), 'stock movement');
      await requirePlant(db, actor, original.site_id);
      const reversal = await reversalFor(db, original, reason, today());
      if (reversal.error) fail(409, 'REVERSAL_NOT_ALLOWED', reversal.error);
      const [posted] = await postMovements(
        db,
        actor.tenant_id,
        { id: actor.id, subject: actor.actor_subject },
        [reversal.value],
      ).catch((e) => {
        if (e?.code === '23505')
          fail(
            409,
            'REVERSAL_NOT_ALLOWED',
            `Movement #${original.movement_no} was already reversed.`,
          );
        return notEnoughStock(e);
      });
      await audit(db, actor, 'stock_movement.reversed', 'stock_movement', original.id, original, {
        reversal: posted.movement_no,
        reason,
      });
      return {
        id: posted.id,
        message: `Movement #${original.movement_no} reversed by movement #${posted.movement_no}.`,
      };
    });
  }

  // ---------- Customer and purchase orders ----------
  private async list(req: Request, kind: OrderKind, plantId: string) {
    const actor = await access(req, ORDERS[kind].read);
    const q = search(req),
      cursor = cursorOf(req, 2);
    const status = req.query.status === undefined ? null : String(req.query.status);
    if (status && !['OPEN', 'CANCELLED'].includes(status))
      fail(400, 'VALIDATION_ERROR', 'Status must be OPEN or CANCELLED.');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const page = await listOrders(db, kind, plant.id, { q, status, cursor });
      return { items: page.items, nextCursor: encode(page.nextCursor) };
    });
  }

  private async detail(req: Request, kind: OrderKind, orderId: string) {
    const actor = await access(req, ORDERS[kind].read);
    return scoped(actor.tenant_id, async (db) => {
      const order: any = await loaded(
        await orderDetail(db, kind, id(orderId)),
        ORDERS[kind].noun.toLowerCase(),
      );
      await requirePlant(db, actor, order.site_id);
      return order;
    });
  }

  private async checked(db: PoolClient, kind: OrderKind, doc: any) {
    const [result] = await checkOrders(db, kind, [doc], null);
    if (result.errors.length) invalid(result.errors);
    return result;
  }

  private async create(req: Request, kind: OrderKind, plantId: string) {
    id(plantId);
    const o = ORDERS[kind];
    const raw = body(req, [o.no, ...o.header]);
    receivedFromRecords(kind, raw, null);
    return mutate(req, o.create, async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const checked = o.validate({ ...raw, plant: plant.code });
      if (checked.errors.length) invalid(checked.errors);
      const given = checked.value[o.no];
      if (!given) checked.value[o.no] = await nextOrderNo(db, kind);
      const doc = await this.checked(db, kind, { value: checked.value, errors: [] });
      if (doc.existing)
        fail(
          409,
          'ALREADY_EXISTS',
          `${o.noun} ${doc.existing.no} already exists. Open it to make changes.`,
        );
      const orderId = await writeOrder(db, kind, actor.tenant_id, doc);
      await audit(
        db,
        actor,
        `${kind.slice(0, -1)}.created`,
        kind.slice(0, -1),
        orderId,
        null,
        doc.value,
      );
      return {
        id: orderId,
        no: doc.value[o.no],
        message: `${o.noun} ${doc.value[o.no]} created with ${doc.value.lines.length} line(s).`,
      };
    });
  }

  private async update(req: Request, kind: OrderKind, orderId: string) {
    id(orderId);
    const o = ORDERS[kind];
    const raw = body(req, [...o.header, 'version']);
    const v = version(raw.version);
    return mutate(req, o.update, async (db, actor) => {
      const old: any = await loaded(await orderDetail(db, kind, orderId), o.noun.toLowerCase());
      await requirePlant(db, actor, old.site_id);
      sameVersion(old.version, v, o.noun.toLowerCase());
      const { version: _v, ...fields } = raw;
      receivedFromRecords(kind, fields, old);
      const checked = o.validate({ ...fields, plant: old.plant, [o.no]: old.no });
      if (checked.errors.length) invalid(checked.errors);
      const doc = await this.checked(db, kind, { id: orderId, value: checked.value, errors: [] });
      await writeOrder(db, kind, actor.tenant_id, doc);
      await audit(
        db,
        actor,
        `${kind.slice(0, -1)}.updated`,
        kind.slice(0, -1),
        orderId,
        old,
        doc.value,
      );
      return { message: `${o.noun} ${old.no} saved.` };
    });
  }

  private async cancel(req: Request, kind: OrderKind, orderId: string) {
    id(orderId);
    const o = ORDERS[kind];
    const raw = body(req, ['reason', 'version']);
    const v = version(raw.version);
    const reason = reasonOf(raw.reason);
    return mutate(req, o.update, async (db, actor) => {
      const old: any = await loaded(await orderDetail(db, kind, orderId), o.noun.toLowerCase());
      await requirePlant(db, actor, old.site_id);
      sameVersion(old.version, v, o.noun.toLowerCase());
      if (old.status === 'CANCELLED')
        fail(409, 'ALREADY_CANCELLED', `${o.noun} ${old.no} is already cancelled.`);
      await cancelOrder(db, kind, orderId, reason);
      await audit(db, actor, `${kind.slice(0, -1)}.cancelled`, kind.slice(0, -1), orderId, old, {
        reason,
      });
      return { message: `${o.noun} ${old.no} cancelled.` };
    });
  }

  @Get('plants/:plantId/sales-orders') salesOrders(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    return this.list(req, 'sales_orders', plantId);
  }
  @Post('plants/:plantId/sales-orders') createSalesOrder(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    return this.create(req, 'sales_orders', plantId);
  }
  @Get('sales-orders/:id') salesOrder(@Req() req: Request, @Param('id') orderId: string) {
    return this.detail(req, 'sales_orders', orderId);
  }
  @Put('sales-orders/:id') editSalesOrder(@Req() req: Request, @Param('id') orderId: string) {
    return this.update(req, 'sales_orders', orderId);
  }
  @Post('sales-orders/:id/cancel') cancelSalesOrder(
    @Req() req: Request,
    @Param('id') orderId: string,
  ) {
    return this.cancel(req, 'sales_orders', orderId);
  }

  @Get('plants/:plantId/purchase-orders') purchaseOrders(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    return this.list(req, 'purchase_orders', plantId);
  }
  @Post('plants/:plantId/purchase-orders') createPurchaseOrder(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    return this.create(req, 'purchase_orders', plantId);
  }
  @Get('purchase-orders/:id') purchaseOrder(@Req() req: Request, @Param('id') orderId: string) {
    return this.detail(req, 'purchase_orders', orderId);
  }
  @Put('purchase-orders/:id') editPurchaseOrder(@Req() req: Request, @Param('id') orderId: string) {
    return this.update(req, 'purchase_orders', orderId);
  }
  @Post('purchase-orders/:id/cancel') cancelPurchaseOrder(
    @Req() req: Request,
    @Param('id') orderId: string,
  ) {
    return this.cancel(req, 'purchase_orders', orderId);
  }

  // ---------- Demand history ----------
  @Get('plants/:plantId/demand-history') async demandHistory(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'orders.read');
    const q = search(req),
      cursor = cursorOf(req, 2);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const page = await listDemandHistory(db, plant.id, { q, cursor });
      return { items: page.items, nextCursor: encode(page.nextCursor) };
    });
  }

  // ---------- Production orders (imported; they consume components) ----------
  @Get('plants/:plantId/production-orders') async productionOrders(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'orders.read');
    const q = search(req),
      cursor = cursorOf(req, 2);
    const status = req.query.status === undefined ? 'OPEN' : String(req.query.status) || null;
    if (status && !['OPEN', 'CLOSED'].includes(status))
      fail(400, 'VALIDATION_ERROR', 'Unknown production order status.');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const page = await listProductionOrders(db, plant.id, { q, status, cursor });
      return { items: page.items, nextCursor: encode(page.nextCursor) };
    });
  }

  @Get('production-orders/:id') async productionOrder(
    @Req() req: Request,
    @Param('id') orderId: string,
  ) {
    const actor = await access(req, 'orders.read');
    return scoped(actor.tenant_id, async (db) => {
      const o: any = await loaded(
        await productionOrderDetail(db, id(orderId), today()),
        'production order',
      );
      await requirePlant(db, actor, o.site_id);
      return o;
    });
  }

  @Post('production-orders/:id/close') async closeProduction(
    @Req() req: Request,
    @Param('id') orderId: string,
  ) {
    id(orderId);
    const v = version(body(req, ['version']).version);
    return mutate(req, 'orders.update', async (db, actor) => {
      const o: any = await loaded(
        (await db.query('SELECT * FROM production_orders WHERE id=$1 FOR UPDATE', [orderId]))
          .rows[0],
        'production order',
      );
      await requirePlant(db, actor, o.site_id);
      sameVersion(o.version, v, 'production order');
      if (o.status !== 'OPEN')
        fail(409, 'ORDER_CLOSED', `Production order ${o.order_no} is already closed.`);
      await closeProductionOrder(db, o.id);
      await audit(db, actor, 'production_order.closed', 'production_order', o.id, o, {
        status: 'CLOSED',
      });
      return {
        message: `Production order ${o.order_no} closed. Its components are no longer reserved for it.`,
      };
    });
  }
}
