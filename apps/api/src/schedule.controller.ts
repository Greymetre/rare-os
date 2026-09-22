import { planningStatus } from '../../../packages/schema/planning-db.mjs';
import { compareClub, impact, snapshot } from '../../../packages/engines/decisions.mjs';
import { expediteRows } from '../../../packages/engines/materials-decisions.mjs';
import {
  decisionContext,
  describeImpact,
  describeScenario,
  leadTimeReality,
  listDecisions,
  planFromScenario,
  recordDecision,
  savePlan,
  scheduleWith,
  materialsContext,
  writeExpediteBundle,
  createOddSizeItem,
  describeInsert,
  insertItem,
  nextInsertRef,
  oddSizeFamilies,
  oddSizeItem,
  simulateInsertOrder,
  writeInsertedOrder,
  listSchedule,
  plantPlanning,
  savePlantPlanning,
  scheduleBlocks,
  scheduleResources,
  scheduleRun,
} from '../../../packages/schema/schedule-db.mjs';
import { Controller, Get, Post, Put, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { access, scoped, fail } from './core.js';
import { id, body, mutate, audit } from './access.controller.js';
import { requirePlant } from './plants.controller.js';
import { search, today } from './plant-model.controller.js';

const FILTERS = ['late', 'gated', 'unscheduled'];
const viewOf = (req: Request) => {
  const v = req.query.view === undefined ? 'current' : String(req.query.view);
  if (!['current', 'published'].includes(v))
    fail(400, 'VALIDATION_ERROR', 'Unknown schedule view.');
  return v;
};
const int = (value: unknown, label: string, min: number, max: number, fallback: number) => {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(400, 'VALIDATION_ERROR', `${label} must be a whole number from ${min} to ${max}.`);
  return n;
};

// The run a view reads: the current calculation or the published plan of the plant.
async function runFor(db: PoolClient, siteId: string, view: string) {
  const r = await scheduleRun(db, siteId, view);
  if (!r.runId)
    return {
      ...r,
      empty:
        view === 'published'
          ? 'No schedule has been published for this plant yet.'
          : 'No schedule yet: import open production orders and routings; the schedule is calculated with the buffers.',
    };
  return { ...r, empty: null };
}

// The planner acts on the calculation they reviewed: the planning run must be current and up to
// date, and the plant's decisions unchanged since the preview.
export async function freshContext(db: PoolClient, siteId: string, raw: any) {
  const status = await planningStatus(db);
  if (!status.upToDate)
    fail(
      409,
      'PLANNING_STALE',
      'The schedule is being recalculated after recent changes. Review it again in a few seconds.',
    );
  if (raw && Number(raw.runNo) !== Number(status.current.run_no))
    fail(
      409,
      'PLANNING_STALE',
      `Calculation #${raw.runNo} is no longer current. Review run #${status.current.run_no} again.`,
    );
  const dc: any = await decisionContext(db, siteId);
  if (!dc)
    fail(409, 'NO_SCHEDULE', 'This plant has no default calendar, so it cannot be scheduled.');
  const version = Number(dc.row?.version ?? 0);
  if (raw && Number(raw.version) !== version)
    fail(
      409,
      'PLAN_CHANGED',
      'Another planning decision was saved for this plant. Review the schedule again.',
    );
  return { dc, status, version, runNo: Number(status.current.run_no) };
}
const itemIdOf = (dc: any, code: unknown) => {
  const hit = [...dc.codes.entries()].find(
    ([, c]: any) => String(c).toLowerCase() === String(code ?? '').toLowerCase(),
  );
  if (!hit || !dc.book.some((b: any) => b.itemId === hit[0]))
    fail(404, 'NOT_FOUND', `Item ${code} has no open production orders in this plant.`);
  return hit![0] as string;
};

// ---------- Insert order (AV-7) ----------
const INSERT_FIELDS = [
  'mode',
  'item',
  'family',
  'length',
  'width',
  'thickness',
  'qty',
  'needDate',
  'intent',
  'customer',
];
function insertRequest(raw: any) {
  const mode = String(raw.mode ?? 'catalogue');
  if (!['catalogue', 'oddsize'].includes(mode))
    fail(400, 'VALIDATION_ERROR', 'Choose a catalogue item or an odd size.');
  const intent = String(raw.intent ?? 'dated');
  if (!['dated', 'rush'].includes(intent))
    fail(400, 'VALIDATION_ERROR', 'Choose a need-by date or ask for the earliest date.');
  const qty = Number(raw.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10_000_000)
    fail(400, 'VALIDATION_ERROR', 'Quantity must be a whole number from 1 to 10,000,000.');
  let needDate: string | null = null;
  if (intent === 'dated') {
    needDate = String(raw.needDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(needDate) || Number.isNaN(Date.parse(needDate)))
      fail(400, 'VALIDATION_ERROR', 'Need-by date must be a date (YYYY-MM-DD).');
  }
  const customer = String(raw.customer ?? '').trim();
  if (customer.length > 120) fail(400, 'VALIDATION_ERROR', 'Customer is at most 120 characters.');
  let dims: number[] = [];
  if (mode === 'oddsize') {
    dims = [raw.length, raw.width, raw.thickness].map(Number);
    if (dims.some((x) => !Number.isFinite(x) || x <= 0 || x > 999))
      fail(
        400,
        'VALIDATION_ERROR',
        'Length, width and thickness must be sizes in inches from 0 to 999.',
      );
    if (!String(raw.family ?? '').trim()) fail(400, 'VALIDATION_ERROR', 'Choose the family.');
  } else if (!String(raw.item ?? '').trim()) fail(400, 'VALIDATION_ERROR', 'Enter the item code.');
  return { mode, intent, qty, needDate, customer, dims, item: raw.item, family: raw.family };
}
// The item to insert and the line to simulate; refused items say why.
async function insertLine(db: PoolClient, dc: any, r: ReturnType<typeof insertRequest>) {
  const target: any =
    r.mode === 'oddsize'
      ? await oddSizeItem(db, dc, r.family, r.dims)
      : await insertItem(db, dc, r.item);
  if (target.refused) return { target, line: null };
  let needDay: number | null = null;
  if (r.needDate) {
    if (r.needDate <= dc.today)
      fail(400, 'VALIDATION_ERROR', `Need-by date must be after the planning date ${dc.today}.`);
    const last = dc.dates[dc.dates.length - 1];
    if (r.needDate > last)
      fail(400, 'VALIDATION_ERROR', `Need-by date must be on or before ${last}.`);
    needDay = Math.max(1, dc.dates.filter((d: string) => d <= r.needDate!).length);
  }
  return { target, line: { itemId: target.itemId, qty: r.qty, needDay } };
}
const targetView = (dc: any, t: any, qty: number) =>
  t.class === 'oddsize'
    ? {
        class: 'oddsize',
        code: t.code,
        exists: !!t.existing,
        family: t.family,
        source: t.source?.code,
        sourceSize: t.sourceSize,
        dims: t.dims,
        scale: t.scale,
        exactThickness: t.exactThickness,
        candidates: t.candidates,
        areaOperations: t.areaOps,
        operations: t.ops?.length,
        drumMinPerUnit: t.drumMinPerUnit,
        bomLines: t.bomLines?.length,
        refused: t.refused ?? null,
      }
    : {
        class: t.class ?? null,
        code: t.item?.code ?? null,
        name: t.item?.name ?? null,
        operations: t.operations,
        drumMinPerUnit: t.drumMinPerUnit,
        drum: dc.plant.resources.get(dc.ctx.drumId)?.code ?? null,
        buffer: t.buffer ? { ...t.buffer, after: t.buffer.after(qty) } : null,
        refused: t.refused ?? null,
      };

@Controller('api')
export class ScheduleController {
  @Get('plants/:plantId/insert/options') async insertOptions(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const dc: any = await decisionContext(db, plant.id);
      if (!dc) return { families: [], today: null, drum: null };
      return {
        today: dc.today,
        drum: dc.plant.resources.get(dc.ctx.drumId)?.code ?? null,
        areaOperations: dc.plant.settings.area_operations ?? [],
        families: await oddSizeFamilies(db, dc),
      };
    });
  }

  @Post('plants/:plantId/insert/preview') async insertPreview(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const r = insertRequest(body(req, INSERT_FIELDS));
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const { dc, version, runNo } = await freshContext(db, plant.id, null);
      const { target, line } = await insertLine(db, dc, r);
      if (!line) return { runNo, version, target: targetView(dc, target, r.qty), scenarios: [] };
      const res = simulateInsertOrder(dc, target, line, r.intent);
      return { runNo, version, target: targetView(dc, target, r.qty), ...describeInsert(dc, res) };
    });
  }

  @Post('plants/:plantId/insert/commit') async insertCommit(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, [...INSERT_FIELDS, 'key', 'lots', 'runNo', 'version']);
    const r = insertRequest(raw);
    return mutate(req, 'schedule.insert', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query('SELECT 1 FROM planning_state FOR UPDATE');
      const { dc, runNo } = await freshContext(db, plant.id, raw);
      const { target, line } = await insertLine(db, dc, r);
      if (!line) fail(422, 'CANNOT_INSERT', target.refused);
      const res = simulateInsertOrder(dc, target, line!, r.intent);
      const view = describeInsert(dc, res);
      const s: any = view.scenarios.find((x: any) => x.key === raw.key);
      if (!s || JSON.stringify(s.lots) !== JSON.stringify(raw.lots))
        fail(
          409,
          'PLANNING_STALE',
          'The scenario changed since the preview. Review the options again.',
        );
      if (!s.feasible) fail(409, 'NOT_FEASIBLE', 'This scenario has no complete placement.');
      const code = target.class === 'oddsize' ? target.code : target.item.code;
      const summary = {
        intent: r.intent,
        item: code,
        class: target.class,
        qty: r.qty,
        needDate: r.needDate,
        customer: r.customer,
        scenario: { key: s.key, label: s.label, recommended: s.key === view.recommended },
        lots: s.lots,
        finishDate: s.finishDate,
        quoteDate: s.quoteDate,
        materials: s.materials.status,
        promisesBroken: s.broken.length,
        broken: s.broken,
        changeoverMin: s.forwardChangeoverMin,
        carryUnits: s.forwardCarry,
        ...(target.class === 'oddsize'
          ? { estimatedFrom: target.source.code, scale: target.scale, dims: target.dims }
          : {}),
      };
      if (s.key === 'decline') {
        const d = await recordDecision(db, actor, plant.id, runNo, 'quote', [], summary);
        await audit(db, actor, 'schedule.quote', 'planning_decision', d.id, null, summary);
        return {
          decisionNo: d.no,
          message: `Decision #${d.no}: ${r.qty} ${code} declined for ${r.needDate}; quoted ${s.quoteDate} (full-route finish). Nothing was added to the schedule.`,
        };
      }
      const ref = await nextInsertRef(db);
      const d = await recordDecision(db, actor, plant.id, runNo, 'insert', [ref], {
        ...summary,
        order: ref,
      });
      let itemId = target.itemId;
      if (target.class === 'oddsize' && !target.existing)
        itemId = await createOddSizeItem(db, actor, dc, target);
      const needDate = r.intent === 'rush' ? s.quoteDate : r.needDate;
      await writeInsertedOrder(db, actor.tenant_id, plant.id, {
        ref,
        itemId,
        needDate,
        customer: r.customer,
        lots: s.lots,
        front: s.front,
        rush: r.intent === 'rush',
        rushBefore: s.rushBefore ?? null,
        decisionNo: d.no,
      });
      await audit(db, actor, 'schedule.insert', 'planning_decision', d.id, null, {
        ...summary,
        order: ref,
      });
      const gate = s.materials.gated
        ? ' Materials do not yet support it: ' +
          (s.materials.status === 'expedite'
            ? 'expedite or quote a later date.'
            : 'validate the missing stock / BOM evidence.')
        : '';
      const cap =
        s.meetsNeedBy === false
          ? ` Full-route finish ${s.finishDate} is after the need-by date.`
          : '';
      return {
        decisionNo: d.no,
        order: ref,
        message: `Decision #${d.no}: order ${ref} (${r.qty} ${code}) committed as "${s.label}": ${s.lots.map((l: any) => l.qty + ' on ' + l.date).join(' + ')}; promised ${needDate}.${cap}${gate} The schedule recalculates in a few seconds.`,
      };
    });
  }

  // ---------- Planning decisions (AV-7) ----------
  @Get('plants/:plantId/decisions') async decisions(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const row = (await db.query('SELECT * FROM plant_sequence WHERE site_id=$1', [plant.id]))
        .rows[0];
      return {
        version: Number(row?.version ?? 0),
        manual: !!row?.manual_order?.length,
        groups: row?.groups ?? [],
        items: await listDecisions(db, plant.id),
      };
    });
  }

  @Post('plants/:plantId/decisions/club-preview') async clubPreview(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const raw = body(req, ['item']);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const { dc, version, runNo } = await freshContext(db, plant.id, null);
      const itemId = itemIdOf(dc, raw.item);
      const c = compareClub(dc.units, dc.plan?.groups ?? [], itemId, dc.ctx);
      return {
        runNo,
        version,
        item: dc.codes.get(itemId),
        orders: c.ids,
        recommended: c.recommended,
        search: c.search,
        clubWindowDays: dc.ctx.clubWindowDays,
        scenarios: c.scenarios.map((s: any) => describeScenario(dc, s)),
      };
    });
  }

  @Post('plants/:plantId/decisions/club') async applyClub(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['item', 'key', 'orders', 'runNo', 'version']);
    if (!['recommended', 'partial', 'expedite', 'declub'].includes(String(raw.key)))
      fail(400, 'VALIDATION_ERROR', 'Choose a scenario to apply.');
    return mutate(req, 'schedule.plan', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query('SELECT 1 FROM planning_state FOR UPDATE');
      const { dc, runNo } = await freshContext(db, plant.id, raw);
      const itemId = itemIdOf(dc, raw.item);
      const c = compareClub(dc.units, dc.plan?.groups ?? [], itemId, dc.ctx);
      const s: any = c.scenarios.find((x: any) => x.key === raw.key);
      if (!s || !Array.isArray(raw.orders) || s.ids.join('|') !== raw.orders.join('|'))
        fail(
          409,
          'PLANNING_STALE',
          'The scenario changed since the preview. Review the options again.',
        );
      if (!s.normal && !s.conditional)
        fail(409, 'NOT_FEASIBLE', 'This scenario cannot be applied: see its reasons.');
      const kind = s.kind === 'declub' ? 'declub' : 'club';
      const summary = describeScenario(dc, s);
      const d = await recordDecision(db, actor, plant.id, runNo, kind, s.ids, {
        item: dc.codes.get(itemId),
        scenario: { ...summary, impact: undefined },
        impact: summary.impact,
      });
      await savePlan(db, actor.tenant_id, plant.id, planFromScenario(dc, c, s, d.no));
      // AV-8: a club that needs material is applied with a linked expedite request.
      let bundle: any = null;
      if (s.conditional && !s.normal) {
        await materialsContext(db, dc);
        const rows = expediteRows(s.after, s.ids, dc.ctx.supply, dc.today);
        bundle = await writeExpediteBundle(db, actor, dc, s.ids, rows, d.no);
      }
      await audit(db, actor, 'schedule.' + kind, 'planning_decision', d.id, null, {
        plant: plant.code,
        item: dc.codes.get(itemId),
        orders: s.ids,
        savedMin: s.savedMin,
        carryUnits: s.carryUnits,
      });
      return {
        decisionNo: d.no,
        message:
          kind === 'declub'
            ? `Decision #${d.no}: ${s.ids.length} order(s) of ${dc.codes.get(itemId)} back on their promise dates. The schedule recalculates in a few seconds.`
            : `Decision #${d.no}: ${s.ids.join(', ')} run together from ${summary.day}; ${Math.round(s.savedMin)} min of changeover saved.${bundle ? ` Material expedite EXP-${bundle.bundleNo} requested: the club stays conditional until the supplier confirms.` : ''} The schedule recalculates in a few seconds.`,
        impact: summary.impact,
      };
    });
  }

  @Post('plants/:plantId/decisions/move') async move(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['order', 'target', 'position', 'runNo', 'version']);
    if (!['before', 'after'].includes(String(raw.position)))
      fail(400, 'VALIDATION_ERROR', 'Choose before or after the target order.');
    return mutate(req, 'schedule.plan', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query('SELECT 1 FROM planning_state FOR UPDATE');
      const { dc, runNo } = await freshContext(db, plant.id, raw);
      const ids: string[] = [...new Set(dc.units.map((u: any) => u.oid ?? u.id))] as string[];
      const moving = String(raw.order ?? ''),
        target = String(raw.target ?? '');
      if (!ids.includes(moving))
        fail(404, 'NOT_FOUND', `Order ${moving} is not in the schedule (no routing or not open).`);
      if (!ids.includes(target) || target === moving)
        fail(400, 'VALIDATION_ERROR', 'Choose another scheduled order to move next to.');
      const from = ids.indexOf(moving) + 1;
      const next = ids.filter((x) => x !== moving);
      next.splice(next.indexOf(target) + (raw.position === 'after' ? 1 : 0), 0, moving);
      const plan = {
        ...dc.plan,
        manualOrder: next,
        groups: dc.plan?.groups ?? [],
        releases: dc.plan?.releases ?? new Map(),
      };
      const after = scheduleWith(dc, plan);
      const imp = impact(snapshot(dc.units, dc.ctx), snapshot(after.units, dc.ctx), moving);
      const to = [...new Set(after.units.map((u: any) => u.oid ?? u.id))].indexOf(moving) + 1;
      const row = dc.row ?? {};
      await savePlan(db, actor.tenant_id, plant.id, {
        manual_order: next,
        groups: row.groups ?? [],
        releases: row.releases ?? {},
      });
      const summary = describeImpact(dc, imp);
      const d = await recordDecision(db, actor, plant.id, runNo, 'move', [moving], {
        from,
        to,
        target,
        position: raw.position,
        impact: summary,
      });
      await audit(
        db,
        actor,
        'schedule.move',
        'planning_decision',
        d.id,
        { position: from },
        { position: to },
      );
      return {
        decisionNo: d.no,
        message: `Decision #${d.no}: ${moving} moved from #${from} to #${to}. ${summary.broken.length ? summary.broken.length + ' promise(s) now late: ' + summary.broken.map((b: any) => b.order).join(', ') + '.' : 'No promise breaks.'}`,
        impact: summary,
      };
    });
  }

  @Post('plants/:plantId/decisions/release-manual') async releaseManual(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['runNo', 'version']);
    return mutate(req, 'schedule.plan', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query('SELECT 1 FROM planning_state FOR UPDATE');
      const { dc, runNo } = await freshContext(db, plant.id, raw);
      if (!dc.row?.manual_order?.length)
        fail(409, 'NOT_MANUAL', 'The schedule already follows the computed order.');
      const plan = { ...dc.plan, manualOrder: null };
      const imp = impact(
        snapshot(dc.units, dc.ctx),
        snapshot(scheduleWith(dc, plan).units, dc.ctx),
      );
      await savePlan(db, actor.tenant_id, plant.id, {
        manual_order: null,
        groups: dc.row.groups ?? [],
        releases: dc.row.releases ?? {},
      });
      const summary = describeImpact(dc, imp);
      const d = await recordDecision(db, actor, plant.id, runNo, 'release_manual', [], {
        impact: summary,
      });
      await audit(db, actor, 'schedule.release_manual', 'planning_decision', d.id, null, {});
      return {
        decisionNo: d.no,
        message: `Decision #${d.no}: back to the computed order of work; pinned clubs stay. ${summary.changed} order(s) move.`,
        impact: summary,
      };
    });
  }

  @Get('plants/:plantId/schedule') async schedule(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const view = viewOf(req),
      q = search(req);
    const filter = req.query.filter ? String(req.query.filter) : null;
    if (filter && !FILTERS.includes(filter))
      fail(400, 'VALIDATION_ERROR', 'Unknown schedule filter.');
    const cursor = req.query.cursor === undefined ? null : String(req.query.cursor);
    if (cursor !== null && !/^[1-9][0-9]{0,8}$/.test(cursor))
      fail(400, 'VALIDATION_ERROR', 'Invalid page cursor.');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const r = await runFor(db, plant.id, view);
      const status = await planningStatus(db);
      if (!r.runId) return { ...r, status, items: [], nextCursor: null };
      const page = await listSchedule(db, plant.id, r.runId, { q, filter, cursor });
      return { ...r, status, ...page };
    });
  }

  @Get('plants/:plantId/schedule/resources') async resources(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const view = viewOf(req);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const r = await runFor(db, plant.id, view);
      return { ...r, items: r.runId ? await scheduleResources(db, plant.id, r.runId) : [] };
    });
  }

  @Get('plants/:plantId/schedule/gantt') async gantt(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const view = viewOf(req);
    const from = int(req.query.from, 'From day', 0, 3650, 0);
    const days = int(req.query.days, 'Days', 1, 31, 7);
    const resource = req.query.resource ? id(String(req.query.resource)) : null;
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const r = await runFor(db, plant.id, view);
      if (!r.runId || !r.header?.day_minutes)
        return { ...r, resources: [], blocks: [], truncated: false, from, days };
      const resources = await scheduleResources(db, plant.id, r.runId);
      const page = await scheduleBlocks(db, plant.id, r.runId, {
        dayMinutes: r.header.day_minutes,
        from,
        to: from + days,
        resourceId: resource,
      });
      return { ...r, resources, ...page, from, days };
    });
  }

  @Post('plants/:plantId/schedule/publish') async publish(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['runNo', 'note']);
    const runNo = Number(raw.runNo);
    if (!Number.isInteger(runNo) || runNo < 1)
      fail(400, 'VALIDATION_ERROR', 'Choose the calculation to publish.');
    const note = raw.note === undefined || raw.note === null ? '' : String(raw.note).trim();
    if (note.length > 200 || /[\x00-\x1f]/.test(note))
      fail(400, 'VALIDATION_ERROR', 'Note must be at most 200 characters on one line.');
    return mutate(req, 'schedule.publish', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query('SELECT 1 FROM planning_state FOR UPDATE');
      const status = await planningStatus(db);
      // Publish exactly what the planner reviewed: the current, up-to-date calculation.
      if (!status.upToDate)
        fail(
          409,
          'PLANNING_STALE',
          'The schedule is being recalculated after recent changes. Review it again in a few seconds.',
        );
      if (Number(status.current.run_no) !== runNo)
        fail(
          409,
          'PLANNING_STALE',
          `Calculation #${runNo} is no longer current. Review run #${status.current.run_no} and publish again.`,
        );
      const r = await scheduleRun(db, plant.id, 'current');
      if (!r.runId) fail(409, 'NO_SCHEDULE', 'This plant has no schedule to publish.');
      if (r.publication?.current)
        fail(409, 'ALREADY_PUBLISHED', `Run #${runNo} is already the published schedule.`);
      const pub = (
        await db.query(
          `INSERT INTO schedule_publications(id,tenant_id,site_id,run_id,run_no,note,published_by,published_by_subject)
           VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [actor.tenant_id, plant.id, r.runId, runNo, note, actor.id, actor.actor_subject],
        )
      ).rows[0].id;
      await audit(db, actor, 'schedule.published', 'schedule', pub, null, {
        plant: plant.code,
        runNo,
        orders: r.header.orders,
        late: r.header.late,
        note,
      });
      return { message: `Schedule of run #${runNo} published for plant ${plant.code}.` };
    });
  }

  @Get('plants/:plantId/lead-time/:itemId') async leadTime(
    @Req() req: Request,
    @Param('plantId') plantId: string,
    @Param('itemId') itemId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return { reality: await leadTimeReality(db, plant.id, id(itemId), today()) };
    });
  }

  // ---------- Plant planning policy ----------
  @Get('plants/:plantId/planning-settings') async settings(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return plantPlanning(db, plant.id);
    });
  }

  @Put('plants/:plantId/planning-settings') async saveSettings(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, [
      'club_window_days',
      'lead_time_basis',
      'day_weights',
      'profile_day',
      'area_operations',
      'version',
    ]);
    // Version 0: the plant still uses the defaults.
    if (!Number.isInteger(raw.version) || raw.version < 0)
      fail(400, 'VERSION_REQUIRED', 'Record version is missing. Refresh before saving.');
    const v = Number(raw.version);
    const value = {
      club_window_days: int(raw.club_window_days, 'Grouping window', 0, 30, 1),
      lead_time_basis: String(raw.lead_time_basis ?? 'FIXED'),
      profile_day: int(raw.profile_day, 'Profile day', 1, 31, 7),
      day_weights: null as number[] | null,
      area_operations: [] as string[],
    };
    if (raw.area_operations !== undefined && raw.area_operations !== null) {
      const ops = (
        Array.isArray(raw.area_operations)
          ? raw.area_operations
          : String(raw.area_operations).split(/[\s,]+/)
      )
        .map((x: unknown) => String(x).trim().toUpperCase())
        .filter(Boolean);
      if (ops.length > 50 || ops.some((x: string) => !/^[A-Z0-9][A-Z0-9_.-]{0,19}$/.test(x)))
        fail(
          400,
          'VALIDATION_ERROR',
          'Area operations must be operation codes, separated by commas.',
        );
      value.area_operations = [...new Set(ops)] as string[];
    }
    if (!['FIXED', 'PLANNED_LOAD'].includes(value.lead_time_basis))
      fail(400, 'VALIDATION_ERROR', 'Lead time basis must be FIXED or PLANNED_LOAD.');
    if (raw.day_weights !== null && raw.day_weights !== undefined && raw.day_weights !== '') {
      const list = Array.isArray(raw.day_weights)
        ? raw.day_weights
        : String(raw.day_weights)
            .split(/[\s,]+/)
            .filter(Boolean);
      const weights = list.map(Number);
      if (
        weights.length !== 31 ||
        weights.some((w: number) => !Number.isFinite(w) || w < 0 || w > 100)
      )
        fail(
          400,
          'VALIDATION_ERROR',
          'Day profile needs 31 shares from 0 to 100, one per day of the month.',
        );
      const total = weights.reduce((a: number, b: number) => a + b, 0);
      if (total < 95 || total > 105)
        fail(
          400,
          'VALIDATION_ERROR',
          `Day profile shares add up to ${total.toFixed(2)}; they should add up to about 100.`,
        );
      value.day_weights = weights;
    }
    return mutate(req, 'buffers.manage', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const old = await plantPlanning(db, plant.id);
      if (Number(old.version) !== v)
        fail(
          409,
          'VERSION_CONFLICT',
          'The planning settings changed after you opened them. Reload and try again.',
        );
      await savePlantPlanning(db, actor.tenant_id, plant.id, value);
      await audit(db, actor, 'plant_planning.updated', 'site', plant.id, old, value);
      return {
        message: `Planning settings saved for plant ${plant.code}. The schedule recalculates in a few seconds.`,
      };
    });
  }
}
