import { planningStatus } from '../../../packages/schema/planning-db.mjs';
import {
  leadTimeReality,
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

@Controller('api')
export class ScheduleController {
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
    };
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
