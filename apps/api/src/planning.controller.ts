import { validateBufferProfile, validateBufferSetting } from '../../../packages/schema/buffers.mjs';
import {
  checkBufferSettings,
  listBoard,
  listBufferSettings,
  listProfiles,
  planningStatus,
  profileByCode,
  queueRun,
  writeBufferSettings,
  writeProfile,
} from '../../../packages/schema/planning-db.mjs';
import { Controller, Get, Post, Patch, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import { access, scoped, fail } from './core.js';
import { id, body, version, mutate, audit } from './access.controller.js';
import { requirePlant } from './plants.controller.js';
import {
  cursorOf,
  encode,
  invalid,
  loaded,
  sameVersion,
  search,
} from './plant-model.controller.js';

type Problem = { column: string; message: string };
const PROFILE_FIELDS = [
  'name',
  'red_base_pct',
  'red_safety_pct',
  'green_pct',
  'order_cycle_days',
  'spike_threshold_pct',
  'adu_window_days',
  'method',
  'zone_weeks',
  'cv_weeks',
  'order_multiple',
  'moq_adu_days',
];
const SETTING_FIELDS = ['policy', 'profile', 'lead_time_days', 'adu_override', 'reference_lot'];
const BOARD_FILTERS = ['breach', 'red', 'yellow', 'green', 'excess', 'missing', 'not_applicable'];

@Controller('api')
export class PlanningController {
  // ---------- Buffer profiles ----------
  @Get('buffer-profiles') async profiles(@Req() req: Request) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => ({ items: await listProfiles(db) }));
  }

  @Post('buffer-profiles') async createProfile(@Req() req: Request) {
    const raw = body(req, ['code', ...PROFILE_FIELDS]);
    const checked = validateBufferProfile(raw);
    if (checked.errors.length) invalid(checked.errors);
    return mutate(req, 'buffers.manage', async (db, actor) => {
      if (await profileByCode(db, checked.value.code))
        fail(409, 'ALREADY_EXISTS', `Buffer profile ${checked.value.code} already exists.`);
      const profileId = await writeProfile(db, actor.tenant_id, checked.value, null);
      await audit(
        db,
        actor,
        'buffer_profile.created',
        'buffer_profile',
        profileId,
        null,
        checked.value,
      );
      return { id: profileId, message: `Buffer profile ${checked.value.code} created.` };
    });
  }

  @Patch('buffer-profiles/:id') async editProfile(
    @Req() req: Request,
    @Param('id') profileId: string,
  ) {
    id(profileId);
    const raw = body(req, [...PROFILE_FIELDS, 'active', 'version']);
    const v = version(raw.version);
    if (typeof raw.active !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    return mutate(req, 'buffers.manage', async (db, actor) => {
      const old = (await db.query('SELECT * FROM buffer_profiles WHERE id=$1', [profileId]))
        .rows[0];
      await loaded(old, 'buffer profile');
      sameVersion(old.version, v, 'buffer profile');
      const checked = validateBufferProfile({ ...raw, code: old.code });
      if (checked.errors.length) invalid(checked.errors);
      if (old.active && !raw.active) {
        const used = Number(
          (
            await db.query(
              "SELECT count(*) FROM item_buffers WHERE profile_id=$1 AND active AND policy='BUFFER'",
              [profileId],
            )
          ).rows[0].count,
        );
        if (used)
          fail(
            409,
            'PROFILE_IN_USE',
            `Buffer profile ${old.code} is used by ${used} buffered item(s). Move them to another profile first.`,
          );
      }
      await writeProfile(db, actor.tenant_id, checked.value, old, raw.active);
      await audit(db, actor, 'buffer_profile.updated', 'buffer_profile', profileId, old, {
        ...checked.value,
        active: raw.active,
      });
      return { message: `Buffer profile ${old.code} saved. Buffers recalculate in a few seconds.` };
    });
  }

  // ---------- Buffer settings ----------
  @Get('plants/:plantId/buffer-settings') async settings(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const q = search(req),
      cursor = cursorOf(req, 2);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const page = await listBufferSettings(db, plant.id, { q, cursor });
      return { items: page.items, nextCursor: encode(page.nextCursor) };
    });
  }

  @Post('plants/:plantId/buffer-settings') async createSetting(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    id(plantId);
    const raw = body(req, ['item', ...SETTING_FIELDS]);
    return mutate(req, 'buffers.manage', async (db, actor) => {
      const plant = await requirePlant(db, actor, plantId);
      const checked = validateBufferSetting({ ...raw, plant: plant.code });
      if (checked.errors.length) invalid(checked.errors);
      const [row] = await checkBufferSettings(
        db,
        [{ value: checked.value, errors: [] as Problem[] }],
        null,
      );
      if (row.errors.length) invalid(row.errors);
      if (row.existing)
        fail(
          409,
          'ALREADY_EXISTS',
          `Item ${row.value.item} already has a buffer setting in plant ${plant.code}. Edit it instead.`,
        );
      await writeBufferSettings(db, actor.tenant_id, [row.value]);
      await audit(
        db,
        actor,
        'buffer_setting.created',
        'buffer_setting',
        row.value.item_id,
        null,
        row.value,
      );
      return {
        message: `${row.value.item} is now ${row.value.policy === 'BUFFER' ? 'buffered' : 'made or bought to order'} in plant ${plant.code}. Buffers recalculate in a few seconds.`,
      };
    });
  }

  @Patch('buffer-settings/:id') async editSetting(
    @Req() req: Request,
    @Param('id') settingId: string,
  ) {
    id(settingId);
    const raw = body(req, [...SETTING_FIELDS, 'active', 'version']);
    const v = version(raw.version);
    if (typeof raw.active !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    return mutate(req, 'buffers.manage', async (db, actor) => {
      const old = (
        await db.query(
          'SELECT b.*,s.code AS plant,i.code AS item FROM item_buffers b JOIN sites s ON s.id=b.site_id JOIN items i ON i.id=b.item_id WHERE b.id=$1',
          [settingId],
        )
      ).rows[0];
      await loaded(old, 'buffer setting');
      await requirePlant(db, actor, old.site_id);
      sameVersion(old.version, v, 'buffer setting');
      const checked = validateBufferSetting({ ...raw, plant: old.plant, item: old.item });
      if (checked.errors.length) invalid(checked.errors);
      const [row] = await checkBufferSettings(
        db,
        [{ value: checked.value, errors: [] as Problem[] }],
        null,
      );
      if (row.errors.length) invalid(row.errors);
      await writeBufferSettings(db, actor.tenant_id, [{ ...row.value, active: raw.active }]);
      await audit(db, actor, 'buffer_setting.updated', 'buffer_setting', settingId, old, {
        ...row.value,
        active: raw.active,
      });
      return {
        message: `Buffer setting for ${old.item} saved. Buffers recalculate in a few seconds.`,
      };
    });
  }

  // ---------- Planning runs and the buffer board ----------
  @Get('planning/status') async status(@Req() req: Request) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, (db) => planningStatus(db));
  }

  @Post('planning/runs') async run(@Req() req: Request) {
    body(req, []);
    return mutate(req, 'planning.run', async (db, actor) => {
      const { run, created } = await queueRun(db, actor.tenant_id, { trigger: 'manual', actor });
      if (created)
        await audit(db, actor, 'planning.run_requested', 'planning_run', run.id, null, {});
      return {
        id: run.id,
        message: created
          ? `Planning run #${run.run_no} queued. Results appear in a few seconds.`
          : `Planning run #${run.run_no} is already queued and will include the latest data.`,
      };
    });
  }

  @Get('plants/:plantId/buffers') async board(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const q = search(req),
      cursor = cursorOf(req, 3);
    const zone =
      req.query.zone === undefined || req.query.zone === '' ? null : String(req.query.zone);
    if (zone && !BOARD_FILTERS.includes(zone))
      fail(400, 'VALIDATION_ERROR', 'Unknown zone filter.');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const page = await listBoard(db, plant.id, { q, zone, cursor });
      return { ...page, nextCursor: encode(page.nextCursor) };
    });
  }
}
