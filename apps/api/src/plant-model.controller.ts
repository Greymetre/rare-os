import {
  validateBom,
  validateCalendar,
  validateResource,
  validateRouting,
} from '../../../packages/schema/plant-model.mjs';
import {
  bomDetail,
  calendarDetail,
  checkBoms,
  checkResources,
  checkRoutings,
  listBoms,
  listCalendars,
  listResources,
  listRoutings,
  plantReadiness,
  routingDetail,
  saveCalendar,
  writeBom,
  writeResource,
  writeRouting,
} from '../../../packages/schema/plant-model-db.mjs';
import { Controller, Get, Post, Patch, Put, Req, Param, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { access, scoped, fail } from './core.js';
import { id, body, version, mutate, audit } from './access.controller.js';
import { requirePlant } from './plants.controller.js';

type Problem = { column: string; message: string };

function invalid(errors: Problem[]): never {
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
      parsed.length === 3 &&
      parsed.every((v) => typeof v === 'string' && v.length <= 80)
    )
      return parsed as string[];
  } catch {
    // fall through
  }
  return fail(400, 'INVALID_CURSOR', 'This page link is invalid. Return to the first page.');
}
const encode = (cursor: string[] | null) =>
  cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null;
const search = (req: Request) => {
  const q = req.query.q === undefined ? '' : String(req.query.q).trim().toLowerCase();
  if (q.length > 40) fail(400, 'VALIDATION_ERROR', 'Search must be at most 40 characters.');
  return q;
};

async function loaded<T>(value: T | null, what: string): Promise<T> {
  if (!value) fail(404, 'RECORD_NOT_FOUND', `This ${what} was not found in your company.`);
  return value!;
}
function sameVersion(current: number, expected: number, what: string) {
  if (current !== expected)
    fail(409, 'STALE_RECORD', `This ${what} changed elsewhere. Refresh before saving.`);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}

@Controller('api')
export class PlantModelController {
  // ---------- Readiness ----------
  @Get('plants/:plantId/readiness') async readiness(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return {
        plant: { id: plant.id, code: plant.code, name: plant.name },
        items: await plantReadiness(db, plant.id, today()),
      };
    });
  }

  // ---------- Calendars ----------
  @Get('plants/:plantId/calendars') async calendars(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return { items: await listCalendars(db, plant.id) };
    });
  }

  @Get('calendars/:id') async calendar(@Req() req: Request, @Param('id') calendarId: string) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => {
      const cal: any = await loaded(await calendarDetail(db, id(calendarId)), 'calendar');
      await requirePlant(db, actor, cal.site_id);
      return cal;
    });
  }

  @Post('plants/:plantId/calendars') async createCalendar(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    id(plantId);
    const raw = body(req, ['code', 'name', 'working_days', 'is_default', 'shifts', 'holidays']);
    const checked = validateCalendar(raw);
    if (checked.errors.length) invalid(checked.errors);
    return mutate(req, 'masters.manage', async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const hasDefault = (await listCalendars(db, plant.id)).some(
        (c: any) => c.is_default && c.active,
      );
      // The first calendar of a plant becomes its default automatically.
      if (!hasDefault) checked.value.is_default = true;
      const saved = await saveCalendar(db, actor.tenant_id, plant.id, checked.value, null);
      if (saved.errors.length) invalid(saved.errors);
      await audit(db, actor, 'calendar.created', 'calendar', saved.id, null, checked.value);
      return {
        id: saved.id,
        message: `Calendar ${checked.value.code} created${checked.value.is_default ? ' as the plant default' : ''}.`,
      };
    });
  }

  @Put('calendars/:id') async editCalendar(@Req() req: Request, @Param('id') calendarId: string) {
    id(calendarId);
    const raw = body(req, [
      'name',
      'working_days',
      'is_default',
      'shifts',
      'holidays',
      'active',
      'version',
    ]);
    const v = version(raw.version);
    if (typeof raw.active !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    return mutate(req, 'masters.manage', async (db, actor) => {
      const old: any = await loaded(await calendarDetail(db, calendarId), 'calendar');
      await requirePlant(db, actor, old.site_id);
      sameVersion(old.version, v, 'calendar');
      const checked = validateCalendar({ ...raw, code: old.code });
      if (checked.errors.length) invalid(checked.errors);
      const saved = await saveCalendar(
        db,
        actor.tenant_id,
        old.site_id,
        { ...checked.value, active: raw.active },
        old,
      );
      if (saved.errors.length) invalid(saved.errors);
      await audit(db, actor, 'calendar.updated', 'calendar', calendarId, old, {
        ...checked.value,
        active: raw.active,
      });
      return { message: `Calendar ${old.code} saved.` };
    });
  }

  // ---------- Resources ----------
  @Get('plants/:plantId/resources') async resources(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return { items: await listResources(db, plant.id) };
    });
  }

  @Post('plants/:plantId/resources') async createResource(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    id(plantId);
    const raw = body(req, [
      'code',
      'name',
      'resource_type',
      'machine_count',
      'efficiency_pct',
      'changeover_minutes',
      'calendar',
    ]);
    return mutate(req, 'masters.manage', async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const checked = validateResource({ ...raw, plant: plant.code });
      if (checked.errors.length) invalid(checked.errors);
      const [row] = await checkResources(
        db,
        [{ value: checked.value, errors: [] as Problem[] }],
        null,
      );
      if (row.errors.length) invalid(row.errors);
      if (row.existing)
        fail(
          409,
          'ALREADY_EXISTS',
          `Resource ${checked.value.code} already exists in plant ${plant.code}.`,
        );
      const resourceId = await writeResource(db, actor.tenant_id, row.value, null);
      await audit(db, actor, 'resource.created', 'resource', resourceId, null, row.value);
      return { id: resourceId, message: `Resource ${checked.value.code} created.` };
    });
  }

  @Patch('resources/:id') async editResource(@Req() req: Request, @Param('id') resourceId: string) {
    id(resourceId);
    const raw = body(req, [
      'name',
      'resource_type',
      'machine_count',
      'efficiency_pct',
      'changeover_minutes',
      'calendar',
      'active',
      'version',
    ]);
    const v = version(raw.version);
    if (typeof raw.active !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    return mutate(req, 'masters.manage', async (db, actor) => {
      const old = (
        await db.query(
          'SELECT r.*,s.code AS plant FROM resources r JOIN sites s ON s.id=r.site_id WHERE r.id=$1',
          [resourceId],
        )
      ).rows[0];
      await loaded(old, 'resource');
      await requirePlant(db, actor, old.site_id);
      sameVersion(old.version, v, 'resource');
      if (old.active && !raw.active) {
        const used = Number(
          (
            await db.query(
              'SELECT count(*) FROM routing_operations o JOIN routings r ON r.id=o.routing_id WHERE o.resource_id=$1 AND r.active',
              [resourceId],
            )
          ).rows[0].count,
        );
        if (used)
          fail(
            409,
            'RESOURCE_IN_USE',
            `Resource ${old.code} is used by ${used} operation(s) in active routings. Change those routings first.`,
          );
      }
      const checked = validateResource({ ...raw, plant: old.plant, code: old.code });
      if (checked.errors.length) invalid(checked.errors);
      const [row] = await checkResources(
        db,
        [{ value: checked.value, errors: [] as Problem[] }],
        null,
      );
      if (row.errors.length) invalid(row.errors);
      await writeResource(db, actor.tenant_id, row.value, old, raw.active);
      await audit(db, actor, 'resource.updated', 'resource', resourceId, old, {
        ...row.value,
        active: raw.active,
      });
      return { message: `Resource ${old.code} saved.` };
    });
  }

  // ---------- BOMs ----------
  @Get('boms') async boms(@Req() req: Request) {
    const actor = await access(req, 'masters.read');
    const q = search(req),
      cursor = cursorOf(req);
    return scoped(actor.tenant_id, async (db) => {
      const page = await listBoms(db, { q, cursor });
      return { items: page.items, nextCursor: encode(page.nextCursor) };
    });
  }

  @Get('boms/:id') async bom(@Req() req: Request, @Param('id') bomId: string) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => loaded(await bomDetail(db, id(bomId)), 'BOM'));
  }

  @Post('boms') async createBom(@Req() req: Request) {
    const raw = body(req, [
      'parent_item',
      'revision',
      'effective_from',
      'effective_to',
      'base_quantity',
      'lines',
    ]);
    const checked = validateBom(raw);
    if (checked.errors.length) invalid(checked.errors);
    return mutate(req, 'masters.manage', async (db, actor) => {
      const doc = await this.checkedBom(db, { value: checked.value, errors: [] as Problem[] });
      if (doc.existing)
        fail(
          409,
          'ALREADY_EXISTS',
          `BOM ${doc.value.parent_item} ${doc.value.revision} already exists. Edit it instead.`,
        );
      const bomId = await writeBom(db, actor.tenant_id, doc);
      await audit(db, actor, 'bom.created', 'bom', bomId, null, doc.value);
      return {
        id: bomId,
        message: `BOM ${doc.value.parent_item} ${doc.value.revision} created with ${doc.value.lines.length} line(s).`,
      };
    });
  }

  @Put('boms/:id') async editBom(@Req() req: Request, @Param('id') bomId: string) {
    id(bomId);
    const raw = body(req, [
      'effective_from',
      'effective_to',
      'base_quantity',
      'lines',
      'active',
      'version',
    ]);
    const v = version(raw.version);
    if (typeof raw.active !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    return mutate(req, 'masters.manage', async (db, actor) => {
      const old: any = await loaded(await bomDetail(db, bomId), 'BOM');
      sameVersion(old.version, v, 'BOM');
      const checked = validateBom({ ...raw, parent_item: old.parent_item, revision: old.revision });
      if (checked.errors.length) invalid(checked.errors);
      const doc = await this.checkedBom(db, {
        id: bomId,
        value: { ...checked.value, active: raw.active },
        errors: [] as Problem[],
      });
      await writeBom(db, actor.tenant_id, doc);
      await audit(db, actor, 'bom.updated', 'bom', bomId, old, doc.value);
      return { message: `BOM ${old.parent_item} ${old.revision} saved.` };
    });
  }

  private async checkedBom(db: PoolClient, doc: any) {
    const [checked] = await checkBoms(db, [doc]);
    if (checked.errors.length) invalid(checked.errors);
    return checked;
  }

  // ---------- Routings ----------
  @Get('plants/:plantId/routings') async routings(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'masters.read');
    const q = search(req),
      cursor = cursorOf(req);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const page = await listRoutings(db, plant.id, { q, cursor });
      return { items: page.items, nextCursor: encode(page.nextCursor) };
    });
  }

  @Get('routings/:id') async routing(@Req() req: Request, @Param('id') routingId: string) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => {
      const r: any = await loaded(await routingDetail(db, id(routingId)), 'routing');
      await requirePlant(db, actor, r.site_id);
      return r;
    });
  }

  @Post('plants/:plantId/routings') async createRouting(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    id(plantId);
    const raw = body(req, ['item', 'revision', 'effective_from', 'effective_to', 'operations']);
    return mutate(req, 'masters.manage', async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const checked = validateRouting({ ...raw, plant: plant.code });
      if (checked.errors.length) invalid(checked.errors);
      const [doc] = await checkRoutings(
        db,
        [{ value: checked.value, errors: [] as Problem[] }],
        null,
      );
      if (doc.errors.length) invalid(doc.errors);
      if (doc.existing)
        fail(
          409,
          'ALREADY_EXISTS',
          `Routing ${doc.value.item} ${doc.value.revision} already exists in plant ${plant.code}. Edit it instead.`,
        );
      const routingId = await writeRouting(db, actor.tenant_id, doc);
      await audit(db, actor, 'routing.created', 'routing', routingId, null, doc.value);
      return {
        id: routingId,
        message: `Routing ${doc.value.item} ${doc.value.revision} created with ${doc.value.operations.length} operation(s).`,
      };
    });
  }

  @Put('routings/:id') async editRouting(@Req() req: Request, @Param('id') routingId: string) {
    id(routingId);
    const raw = body(req, ['effective_from', 'effective_to', 'operations', 'active', 'version']);
    const v = version(raw.version);
    if (typeof raw.active !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    return mutate(req, 'masters.manage', async (db, actor) => {
      const old: any = await loaded(await routingDetail(db, routingId), 'routing');
      await requirePlant(db, actor, old.site_id);
      sameVersion(old.version, v, 'routing');
      const checked = validateRouting({
        ...raw,
        plant: old.plant,
        item: old.item,
        revision: old.revision,
      });
      if (checked.errors.length) invalid(checked.errors);
      const [doc] = await checkRoutings(
        db,
        [
          {
            id: routingId,
            value: { ...checked.value, active: raw.active },
            errors: [] as Problem[],
          },
        ],
        null,
      );
      if (doc.errors.length) invalid(doc.errors);
      await writeRouting(db, actor.tenant_id, doc);
      await audit(db, actor, 'routing.updated', 'routing', routingId, old, doc.value);
      return { message: `Routing ${old.item} ${old.revision} saved.` };
    });
  }
}
