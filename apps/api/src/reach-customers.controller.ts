// RCH-1: the customer register, the location tag and the beat round.
//
// A customer is not a generic master: the questions it answers come from its type, so the form is
// read from the company's own configuration on every write and the answers are judged against it.
// The beat round follows from the register rather than being kept by hand — an active customer of
// a type that walks a beat is a stop on it, and nothing else can make it one.
import { Controller, Delete, Get, Param, Patch, Post, Put, Req, Res } from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { access, fail, limitOf, scoped } from './core.js';
import { audit, body, id, mutate, text, version } from './access.controller.js';
import { toCsv } from '../../../packages/schema/imports.mjs';
import { formSections } from '../../../packages/engines/customer-form.mjs';
import {
  beatOutlets,
  createCustomer,
  customerBlockers,
  customerTiles,
  customerType,
  customerTypes,
  decideTag,
  findCustomer,
  formFor,
  geoHistory,
  listCustomers,
  nearbyCustomers,
  pendingApprovals,
  pendingTag,
  reachSettings,
  removeCustomer,
  reorderBeat,
  saveReachSettings,
  setCustomerStatus,
  syncBeatMembership,
  tagCustomer,
  updateCustomer,
  validateAnswers,
} from '../../../packages/schema/customers-db.mjs';

const STATUSES = ['AWAITING_APPROVAL', 'ACTIVE', 'DORMANT', 'REJECTED'];
const GEO_FILTERS = ['', 'tagged', 'untagged', 'verified'];
const GEO_SOURCES = ['DEVICE', 'TYPED', 'PIN'];

function invalid(errors: { column: string; message: string }[]): never {
  throw new HttpException(
    { code: 'VALIDATION_ERROR', message: errors.map((e) => e.message).join(' '), fields: errors },
    400,
  );
}

function cursorOf(req: Request) {
  if (req.query.cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      parsed.every((v) => typeof v === 'string' && v.length <= 80)
    )
      return parsed as string[];
  } catch {
    // fall through
  }
  return fail(400, 'INVALID_CURSOR', 'This page link is invalid. Return to the first page.');
}

// The filters the register offers, checked here so a hand-made link cannot widen them.
function filtersOf(req: Request) {
  const word = (name: string, max = 40) => {
    const value = req.query[name] === undefined ? '' : String(req.query[name]).trim();
    if (value.length > max)
      fail(400, 'VALIDATION_ERROR', `${name} must be at most ${max} characters.`);
    return value;
  };
  const status = word('status', 20);
  if (status && !STATUSES.includes(status))
    fail(400, 'VALIDATION_ERROR', `Status must be one of: ${STATUSES.join(', ')}.`);
  const geo = word('geo', 10);
  if (!GEO_FILTERS.includes(geo))
    fail(400, 'VALIDATION_ERROR', 'Location filter must be tagged, untagged or verified.');
  return {
    q: word('q').toLowerCase(),
    type: word('type'),
    status,
    beat: word('beat'),
    territory: word('territory'),
    geo,
  };
}

// A number a caller sent as a coordinate. Refused rather than rounded: a shop in the wrong
// hemisphere is a typo someone has to see.
function coordinate(value: unknown, label: string, bound: number) {
  const n = Number(value);
  if (typeof value !== 'number' || !Number.isFinite(n) || Math.abs(n) > bound)
    fail(400, 'VALIDATION_ERROR', `${label} must be a number between -${bound} and ${bound}.`);
  return Number(n.toFixed(6));
}

// Everything a customer has whatever its type, plus the answers to its own form.
async function customerBody(db: PoolClient, req: Request, typeRow: any, editing: boolean) {
  const keys = [
    'name',
    'beat',
    'territory',
    'buys_from',
    'rep',
    'sales_customer',
    'town',
    'phone',
    'answers',
    ...(editing ? ['version'] : ['code', 'type']),
  ];
  const raw = body(req, keys);
  const form = await formFor(db, typeRow.id);
  const answers = validateAnswers(form, raw.answers ?? {});
  const errors = [...answers.errors];
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (!name || name.length > 160)
    errors.push({ column: 'name', message: 'Name must be 1-160 characters.' });
  const town = raw.town === undefined ? '' : String(raw.town).trim();
  if (town.length > 80)
    errors.push({ column: 'town', message: 'Town must be at most 80 characters.' });
  const phone = raw.phone === undefined ? '' : String(raw.phone).trim();
  if (phone.length > 20)
    errors.push({ column: 'phone', message: 'Phone must be at most 20 characters.' });
  // References are given as codes, as they are in every import and every other master.
  const refs: Record<string, string | null> = {};
  for (const [field, sql, noun] of [
    [
      'territory',
      'SELECT id FROM territories WHERE lower(code)=$1 AND deleted_at IS NULL',
      'Territory',
    ],
    ['beat', 'SELECT id FROM beats WHERE lower(code)=$1 AND deleted_at IS NULL', 'Beat'],
    ['rep', 'SELECT id FROM field_reps WHERE lower(code)=$1 AND deleted_at IS NULL', 'Field rep'],
    [
      'buys_from',
      'SELECT id FROM trade_customers WHERE lower(code)=$1 AND deleted_at IS NULL',
      'Customer',
    ],
    ['sales_customer', 'SELECT id FROM customers WHERE lower(code)=$1', 'Planning account'],
  ] as const) {
    const code = raw[field] === undefined || raw[field] === null ? '' : String(raw[field]).trim();
    if (!code) {
      refs[field] = null;
      continue;
    }
    const found = (await db.query(sql, [code.toLowerCase()])).rows[0];
    if (!found) errors.push({ column: field, message: `${noun} ${code} was not found.` });
    else refs[field] = found.id;
  }
  if (!refs.territory)
    errors.push({ column: 'territory', message: 'A customer belongs to a territory.' });
  // A type that walks a beat has to be on one, or it would never be visited.
  if (typeRow.on_beat_plan && !refs.beat)
    errors.push({
      column: 'beat',
      message: `A ${typeRow.name} is visited on a beat, so it needs one.`,
    });
  if (errors.length) invalid(errors);
  return {
    name,
    town,
    phone,
    attrs: answers.value,
    territory_id: refs.territory,
    beat_id: refs.beat,
    rep_id: refs.rep,
    buys_from_id: refs.buys_from,
    sales_customer_id: refs.sales_customer,
    version: editing ? version(raw.version) : 1,
    code: editing ? undefined : text(raw.code, 'Customer code', 1, 40),
  };
}

@Controller('api')
export class ReachCustomersController {
  // ---------- Reading ----------

  @Get('reach/customer-types') async types(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => ({ items: await customerTypes(db) }));
  }

  @Get('reach/customer-form/:typeId') async form(
    @Req() req: Request,
    @Param('typeId') typeId: string,
  ) {
    id(typeId);
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const type = await customerType(db, typeId);
      if (!type) fail(404, 'RECORD_NOT_FOUND', 'This customer type was not found.');
      const form = await formFor(db, typeId);
      return { type, sections: formSections(form) };
    });
  }

  @Get('reach/customers') async list(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    const filters = filtersOf(req);
    const cursor = cursorOf(req);
    const limit = limitOf(req);
    return scoped(actor.tenant_id, async (db) => {
      const page = await listCustomers(db, { ...filters, cursor, limit });
      return {
        items: page.items,
        total: page.total,
        pageSize: limit,
        tiles: await customerTiles(db),
        nextCursor: page.nextCursor
          ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url')
          : null,
      };
    });
  }

  // The register as a file, with the filters the reader is looking at, so what downloads is what
  // is on screen. Capped, because this is a report and not a way to pull the whole database.
  @Get('reach/customers.csv') async csv(@Req() req: Request, @Res() res: Response) {
    const actor = await access(req, 'reach.read');
    const filters = filtersOf(req);
    return scoped(actor.tenant_id, async (db) => {
      const page = await listCustomers(db, { ...filters, limit: 5000 });
      const rows = [
        [
          'code',
          'name',
          'type',
          'status',
          'territory',
          'beat',
          'beat_sequence',
          'town',
          'phone',
          'rep',
          'buys_from',
          'latitude',
          'longitude',
          'location_verified',
        ],
        ...page.items.map((c) => [
          c.code,
          c.name,
          c.type,
          c.status,
          c.territory,
          c.beat ?? '',
          c.beat_sequence ?? '',
          c.town,
          c.phone,
          c.rep ?? '',
          c.buys_from ?? '',
          c.latitude ?? '',
          c.longitude ?? '',
          c.geo_verified ? 'yes' : 'no',
        ]),
      ];
      res
        .setHeader('Content-Type', 'text/csv; charset=utf-8')
        .setHeader('Content-Disposition', 'attachment; filename="rare-os-customers.csv"')
        .send(toCsv(rows));
    });
  }

  @Get('reach/customers/:id') async one(@Req() req: Request, @Param('id') customerId: string) {
    id(customerId);
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const customer = await findCustomer(db, customerId);
      if (!customer) fail(404, 'RECORD_NOT_FOUND', 'This customer was not found in your company.');
      const form = await formFor(db, customer.type_id);
      return {
        customer,
        sections: formSections(form),
        geo: {
          pending: await pendingTag(db, customerId),
          history: await geoHistory(db, customerId),
          settings: await reachSettings(db),
        },
        beat: customer.beat_id ? await beatOutlets(db, customer.beat_id) : [],
      };
    });
  }

  // ---------- Writing ----------

  @Post('reach/customers') async create(@Req() req: Request) {
    return mutate(req, 'reach.manage', async (db, actor) => {
      const typeCode = req.body?.type === undefined ? '' : String(req.body.type).trim();
      if (!typeCode) fail(400, 'VALIDATION_ERROR', 'Choose a customer type.');
      const type = (
        await db.query(
          'SELECT * FROM customer_types WHERE lower(code)=$1 AND deleted_at IS NULL AND active',
          [typeCode.toLowerCase()],
        )
      ).rows[0];
      if (!type)
        fail(404, 'RECORD_NOT_FOUND', `Customer type ${typeCode} was not found, or is inactive.`);
      const value = await customerBody(db, req, type, false);
      const exists = (
        await db.query(
          'SELECT code FROM trade_customers WHERE lower(code)=$1 AND deleted_at IS NULL',
          [value.code!.toLowerCase()],
        )
      ).rowCount;
      if (exists)
        fail(409, 'ALREADY_EXISTS', `Customer ${value.code} already exists. Edit it instead.`);
      // A type that asks for approval starts its life waiting for one; nothing else does.
      const status = type.needs_approval ? 'AWAITING_APPROVAL' : 'ACTIVE';
      const newId = await createCustomer(db, actor.tenant_id, {
        ...value,
        type_id: type.id,
        status,
      });
      const created = await findCustomer(db, newId);
      const beat = await syncBeatMembership(db, actor.tenant_id, created);
      // The sync is what writes the beat row, so the stop number does not exist until it has
      // run; the record is read again afterwards rather than reporting the empty one.
      const saved = beat === 'added' ? await findCustomer(db, newId) : created;
      await audit(db, actor, 'trade_customers.created', 'trade_customers', newId, null, {
        code: value.code,
        type: type.code,
        status,
        beat,
      });
      return {
        id: newId,
        status,
        message:
          status === 'AWAITING_APPROVAL'
            ? `${value.code} created and sent for approval.`
            : beat === 'added'
              ? `${value.code} created and added to beat ${saved.beat} at stop ${saved.beat_sequence}.`
              : `${value.code} created.`,
      };
    });
  }

  @Patch('reach/customers/:id') async edit(@Req() req: Request, @Param('id') customerId: string) {
    id(customerId);
    return mutate(req, 'reach.manage', async (db, actor) => {
      const old = await findCustomer(db, customerId);
      if (!old) fail(404, 'RECORD_NOT_FOUND', 'This customer was not found in your company.');
      const type = await customerType(db, old.type_id);
      const value = await customerBody(db, req, type, true);
      if (old.version !== value.version)
        fail(409, 'STALE_RECORD', 'This customer changed elsewhere. Refresh before saving.');
      if (value.buys_from_id === customerId)
        fail(400, 'VALIDATION_ERROR', 'A customer cannot buy from itself.');
      await updateCustomer(db, customerId, value);
      const saved = await findCustomer(db, customerId);
      const beat = await syncBeatMembership(db, actor.tenant_id, saved);
      await audit(db, actor, 'trade_customers.updated', 'trade_customers', customerId, old, {
        ...value,
        beat,
      });
      return { message: `${old.code} saved.` };
    });
  }

  @Delete('reach/customers/:id') async remove(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const raw = body(req, ['version', 'reason']);
    const v = version(raw.version);
    const reason = raw.reason === undefined ? '' : text(raw.reason, 'Reason', 0, 200);
    return mutate(req, 'reach.delete', async (db, actor) => {
      const old = await findCustomer(db, customerId);
      if (!old) fail(404, 'RECORD_NOT_FOUND', 'This customer was not found in your company.');
      if (old.version !== v)
        fail(409, 'STALE_RECORD', 'This customer changed elsewhere. Refresh and try again.');
      const blockers = await customerBlockers(db, customerId);
      if (blockers.length)
        fail(409, 'RECORD_IN_USE', `This customer cannot be removed: ${blockers.join(', ')}.`);
      if (!(await removeCustomer(db, customerId, actor.id, reason)))
        fail(409, 'STALE_RECORD', 'This customer was already removed.');
      // Off the register means off the round.
      await syncBeatMembership(db, actor.tenant_id, { ...old, status: 'REJECTED' });
      await audit(db, actor, 'trade_customers.removed', 'trade_customers', customerId, old, {
        removed: true,
        reason,
      });
      return { message: `${old.code} removed. It is off the register but kept in the records.` };
    });
  }

  // Active or dormant. Approving an account that is waiting is a decision, not a status change,
  // so it goes through the approvals route and its own permission.
  @Post('reach/customers/:id/status') async status(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const raw = body(req, ['status', 'version']);
    const v = version(raw.version);
    if (!['ACTIVE', 'DORMANT'].includes(raw.status))
      fail(400, 'VALIDATION_ERROR', 'A customer is made active or dormant here.');
    return mutate(req, 'reach.manage', async (db, actor) => {
      const old = await findCustomer(db, customerId);
      if (!old) fail(404, 'RECORD_NOT_FOUND', 'This customer was not found in your company.');
      if (old.version !== v)
        fail(409, 'STALE_RECORD', 'This customer changed elsewhere. Refresh and try again.');
      if (old.status === 'AWAITING_APPROVAL')
        fail(
          409,
          'AWAITING_APPROVAL',
          'This account is waiting for approval. Decide it on the Approvals screen.',
        );
      await setCustomerStatus(db, customerId, raw.status);
      const beat = await syncBeatMembership(db, actor.tenant_id, {
        ...old,
        status: raw.status,
      });
      await audit(
        db,
        actor,
        'trade_customers.status',
        'trade_customers',
        customerId,
        { status: old.status },
        { status: raw.status, beat },
      );
      return {
        message:
          raw.status === 'DORMANT'
            ? `${old.code} is now dormant and off its beat.`
            : `${old.code} is active again.`,
      };
    });
  }

  // ---------- The location tag ----------

  @Post('reach/customers/:id/geo') async geo(@Req() req: Request, @Param('id') customerId: string) {
    id(customerId);
    const raw = body(req, ['latitude', 'longitude', 'source', 'accuracy_m', 'reason']);
    const latitude = coordinate(raw.latitude, 'Latitude', 90);
    const longitude = coordinate(raw.longitude, 'Longitude', 180);
    if (!GEO_SOURCES.includes(raw.source))
      fail(400, 'VALIDATION_ERROR', 'A tag comes from a device, typed coordinates or a pin.');
    let accuracy: number | null = null;
    if (raw.accuracy_m !== undefined && raw.accuracy_m !== null) {
      if (!Number.isInteger(raw.accuracy_m) || raw.accuracy_m < 0 || raw.accuracy_m > 100000)
        fail(400, 'VALIDATION_ERROR', 'Accuracy must be a whole number of metres.');
      accuracy = raw.accuracy_m;
    }
    // Only a device fix carries an accuracy; a typed point has no measured error.
    if (raw.source !== 'DEVICE' && accuracy !== null)
      fail(400, 'VALIDATION_ERROR', 'Only a device fix has an accuracy.');
    const reason = raw.reason === undefined ? '' : text(raw.reason, 'Reason', 0, 300);
    return mutate(req, 'reach.manage', async (db, actor) => {
      const customer = await findCustomer(db, customerId);
      if (!customer) fail(404, 'RECORD_NOT_FOUND', 'This customer was not found in your company.');
      if (await pendingTag(db, customerId))
        fail(
          409,
          'RETAG_PENDING',
          'This shop already has a move waiting for approval. Decide that one first.',
        );
      const settings = await reachSettings(db);
      const next = { latitude, longitude, source: raw.source, accuracy_m: accuracy, reason };
      const result = await tagCustomer(db, actor.tenant_id, actor, customer, next, settings);
      const nearby = await nearbyCustomers(db, next, settings.duplicate_within_m, customerId);
      await audit(
        db,
        actor,
        'trade_customers.tagged',
        'trade_customers',
        customerId,
        {
          latitude: customer.latitude,
          longitude: customer.longitude,
        },
        { ...next, ...result },
      );
      return {
        ...result,
        nearby,
        message:
          result.status === 'PENDING'
            ? `This moves the shop ${result.moved} m, more than the ${settings.retag_approval_m} m allowed, so it is waiting for approval.`
            : result.verified
              ? 'Location saved and verified by the device fix.'
              : 'Location saved.',
      };
    });
  }

  // ---------- The approvals queue ----------

  @Get('reach/approvals') async approvals(@Req() req: Request) {
    const actor = await access(req, 'reach.approve');
    return scoped(actor.tenant_id, async (db) => ({
      ...(await pendingApprovals(db)),
      settings: await reachSettings(db),
    }));
  }

  @Post('reach/approvals/accounts/:id') async decideAccount(
    @Req() req: Request,
    @Param('id') customerId: string,
  ) {
    id(customerId);
    const raw = body(req, ['approve', 'reason', 'version']);
    const v = version(raw.version);
    if (typeof raw.approve !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Approve or reject this account.');
    const reason = raw.reason === undefined ? '' : text(raw.reason, 'Reason', 0, 300);
    if (!raw.approve && !reason)
      fail(400, 'REASON_REQUIRED', 'Say why the account is rejected; the field force will see it.');
    return mutate(req, 'reach.approve', async (db, actor) => {
      const customer = await findCustomer(db, customerId);
      if (!customer) fail(404, 'RECORD_NOT_FOUND', 'This customer was not found in your company.');
      if (customer.status !== 'AWAITING_APPROVAL')
        fail(
          409,
          'ALREADY_DECIDED',
          `${customer.code} is already ${customer.status.toLowerCase()}.`,
        );
      if (customer.version !== v)
        fail(409, 'STALE_RECORD', 'This customer changed elsewhere. Refresh and try again.');
      const status = raw.approve ? 'ACTIVE' : 'REJECTED';
      await setCustomerStatus(db, customerId, status, { actorId: actor.id, reason });
      const beat = await syncBeatMembership(db, actor.tenant_id, { ...customer, status });
      await audit(
        db,
        actor,
        raw.approve ? 'trade_customers.approved' : 'trade_customers.rejected',
        'trade_customers',
        customerId,
        { status: customer.status },
        { status, reason, beat },
      );
      return {
        message: raw.approve
          ? beat === 'added'
            ? `${customer.code} approved and added to beat ${customer.beat}.`
            : `${customer.code} approved.`
          : `${customer.code} rejected.`,
      };
    });
  }

  @Post('reach/approvals/retags/:id') async decideRetag(
    @Req() req: Request,
    @Param('id') requestId: string,
  ) {
    id(requestId);
    const raw = body(req, ['approve', 'reason']);
    if (typeof raw.approve !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Approve or reject this move.');
    const reason = raw.reason === undefined ? '' : text(raw.reason, 'Reason', 0, 300);
    if (!raw.approve && !reason)
      fail(400, 'REASON_REQUIRED', 'Say why the move is rejected; the rep who asked will see it.');
    return mutate(req, 'reach.approve', async (db, actor) => {
      const request = (
        await db.query("SELECT * FROM customer_geo_log WHERE id=$1 AND status='PENDING'", [
          requestId,
        ])
      ).rows[0];
      if (!request)
        fail(404, 'RECORD_NOT_FOUND', 'This request was not found, or has already been decided.');
      const customer = await findCustomer(db, request.customer_id);
      if (!customer) fail(404, 'RECORD_NOT_FOUND', 'This customer was not found in your company.');
      const settings = await reachSettings(db);
      await decideTag(db, actor, request, customer, raw.approve, reason, settings);
      await audit(
        db,
        actor,
        raw.approve ? 'trade_customers.retag_approved' : 'trade_customers.retag_rejected',
        'trade_customers',
        customer.id,
        { latitude: customer.latitude, longitude: customer.longitude },
        {
          latitude: request.latitude,
          longitude: request.longitude,
          moved_m: request.moved_m,
          reason,
        },
      );
      return {
        message: raw.approve
          ? `${customer.code} moved ${request.moved_m} m to where the rep tagged it.`
          : `The move of ${customer.code} was rejected; its location is unchanged.`,
      };
    });
  }

  // ---------- The round ----------

  @Get('reach/beats/:id/outlets') async outlets(@Req() req: Request, @Param('id') beatId: string) {
    id(beatId);
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => {
      const beat = (
        await db.query(
          `SELECT b.id,b.code,b.name,b.frequency,b.run_days,b.week_parity,t.code AS territory,
             coalesce(r.code,'') AS rep,coalesce(r.name,'') AS rep_name
           FROM beats b JOIN territories t ON t.id=b.territory_id
             LEFT JOIN beat_assignments a ON a.beat_id=b.id AND a.deleted_at IS NULL
               AND a.to_date IS NULL
             LEFT JOIN field_reps r ON r.id=a.rep_id
           WHERE b.id=$1 AND b.deleted_at IS NULL`,
          [beatId],
        )
      ).rows[0];
      if (!beat) fail(404, 'RECORD_NOT_FOUND', 'This beat was not found in your company.');
      return { beat, items: await beatOutlets(db, beatId) };
    });
  }

  // The walking order, as the reader arranged it. Every stop of the beat has to be in the list:
  // a partial order would leave the rest of the round at positions nobody chose.
  @Put('reach/beats/:id/outlets') async reorder(@Req() req: Request, @Param('id') beatId: string) {
    id(beatId);
    const raw = body(req, ['order']);
    if (!Array.isArray(raw.order) || raw.order.length > 500)
      fail(400, 'VALIDATION_ERROR', 'Send the stops in the order they should be walked.');
    const order = raw.order.map((value: unknown) => id(value));
    if (new Set(order).size !== order.length)
      fail(400, 'VALIDATION_ERROR', 'The same stop appears twice in this order.');
    return mutate(req, 'reach.manage', async (db, actor) => {
      const current = await beatOutlets(db, beatId);
      if (!current.length) fail(409, 'EMPTY_BEAT', 'This beat has no stops to put in order.');
      const known = new Set(current.map((o) => o.customer_id));
      if (order.length !== known.size || order.some((customerId: string) => !known.has(customerId)))
        fail(
          409,
          'BEAT_CHANGED',
          'The stops on this beat changed while you were arranging them. Refresh and try again.',
        );
      await reorderBeat(db, beatId, order);
      await audit(
        db,
        actor,
        'beats.reordered',
        'beats',
        beatId,
        { order: current.map((o) => o.code) },
        { stops: order.length },
      );
      return { message: `The round now has ${order.length} stops in this order.` };
    });
  }

  // ---------- Setup ----------

  @Get('reach/settings') async settings(@Req() req: Request) {
    const actor = await access(req, 'reach.read');
    return scoped(actor.tenant_id, async (db) => ({
      settings: await reachSettings(db),
      canEdit: actor.permissions.includes('reach.setup'),
    }));
  }

  @Put('reach/settings') async saveSettings(@Req() req: Request) {
    const bounds = {
      gps_verified_m: [5, 1000],
      duplicate_within_m: [5, 1000],
      retag_approval_m: [10, 5000],
      kyc_reminder_days: [1, 365],
    } as const;
    const raw = body(req, [...Object.keys(bounds), 'version']);
    // Version 0 is a company that has never saved these settings, so the usual check, which
    // starts at 1, does not apply here.
    if (!Number.isInteger(raw.version) || raw.version < 0)
      fail(400, 'VERSION_REQUIRED', 'Settings version is missing. Refresh before saving.');
    const v = Number(raw.version);
    const value: Record<string, number> = {};
    const errors: { column: string; message: string }[] = [];
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
    return mutate(req, 'reach.setup', async (db, actor) => {
      const current = await reachSettings(db);
      if (current.version !== v)
        fail(409, 'STALE_RECORD', 'These settings changed elsewhere. Refresh before saving.');
      await saveReachSettings(db, actor.tenant_id, value);
      await audit(db, actor, 'reach.settings', 'reach_settings', actor.tenant_id, current, value);
      return { message: 'Reach settings saved.' };
    });
  }
}
