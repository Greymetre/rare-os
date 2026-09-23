// AV-11 planning tools (Nilkamal simulation handover, 21-Sep-2026: Month Shape, Recommended
// Buffers, Buffer vs MTO, Events & Seasons, Scheme Intake, Target Mode, Space Mode, the network
// screens and the assumption register). Reading is planning.read; the records a planner keeps —
// events, schemes, targets, space limits and assumption notes — need planning.tools.
import {
  assumptionsView,
  bufferVsMtoView,
  eventCurveView,
  listEvents,
  listSchemes,
  monthShapeView,
  networkView,
  recommendedBuffersView,
  spaceView,
  targetView,
  whatIfView,
} from '../../../packages/schema/planning-tools-db.mjs';
import { Controller, Get, Post, Put, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { access, scoped, fail } from './core.js';
import { id, body, mutate, audit } from './access.controller.js';
import { requirePlant } from './plants.controller.js';

const SERVICES = [0.85, 0.9, 0.95, 0.98];
const serviceOf = (req: Request) => {
  const v = req.query.service === undefined ? 0.9 : Number(req.query.service);
  if (!SERVICES.includes(v))
    fail(400, 'VALIDATION_ERROR', `Service level must be one of ${SERVICES.join(', ')}.`);
  return v;
};
const code = (v: unknown, label: string) => {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/.test(s))
    fail(400, 'VALIDATION_ERROR', `${label} must be a short code (letters, digits, . _ -).`);
  return s;
};
const text = (v: unknown, label: string, max: number, required = true) => {
  const s = String(v ?? '').trim();
  if (required && !s) fail(400, 'VALIDATION_ERROR', `${label} is required.`);
  if (s.length > max) fail(400, 'VALIDATION_ERROR', `${label} is at most ${max} characters.`);
  return s;
};
const isoDate = (v: unknown, label: string) => {
  const s = String(v ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)))
    fail(400, 'VALIDATION_ERROR', `${label} must be a date (YYYY-MM-DD).`);
  return s;
};
const range = (v: unknown, label: string, min: number, max: number) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    fail(400, 'VALIDATION_ERROR', `${label} must be a number from ${min} to ${max}.`);
  return n;
};
async function itemsByCodes(db: PoolClient, codes: unknown) {
  const list = Array.isArray(codes) ? codes.map((c) => String(c).trim()).filter(Boolean) : [];
  if (!list.length) return [];
  const rows = (
    await db.query('SELECT id,code FROM items WHERE lower(code)=ANY($1::text[])', [
      list.map((c) => c.toLowerCase()),
    ])
  ).rows;
  const missing = list.filter((c) => !rows.some((r) => r.code.toLowerCase() === c.toLowerCase()));
  if (missing.length) fail(404, 'NOT_FOUND', `Unknown item(s): ${missing.join(', ')}.`);
  return rows.map((r) => r.id);
}

@Controller('api')
export class PlanningToolsController {
  @Get('plants/:plantId/tools/month-shape') async monthShape(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return monthShapeView(db, plant.id);
    });
  }

  @Get('plants/:plantId/tools/buffer-vs-mto') async bufferVsMto(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return bufferVsMtoView(db, plant.id);
    });
  }

  @Get('plants/:plantId/tools/recommended-buffers') async recommended(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const service = serviceOf(req);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return recommendedBuffersView(db, plant.id, service);
    });
  }

  @Get('plants/:plantId/tools/space') async space(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const service = serviceOf(req);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return spaceView(db, plant.id, service);
    });
  }

  @Put('plants/:plantId/tools/space') async saveSpace(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['capacity', 'measure', 'note']);
    const capacity = range(raw.capacity, 'Capacity', 1, 1e12);
    const measure = String(raw.measure ?? 'UNITS');
    if (!['UNITS', 'VOLUME'].includes(measure))
      fail(400, 'VALIDATION_ERROR', 'Measure must be UNITS or VOLUME.');
    const note = text(raw.note, 'Note', 200, false);
    return mutate(req, 'planning.tools', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query(
        `INSERT INTO space_limits(id,tenant_id,site_id,measure,capacity,note)
         VALUES(gen_random_uuid(),$1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id,site_id,coalesce(location_id,'00000000-0000-0000-0000-000000000000'::uuid))
         DO UPDATE SET measure=excluded.measure,capacity=excluded.capacity,note=excluded.note,
           version=space_limits.version+1,updated_at=now()`,
        [actor.tenant_id, plant.id, measure, capacity, note],
      );
      await audit(db, actor, 'planning.space_limit', 'site', plant.id, null, { capacity, measure });
      return {
        message: `Space limit for plant ${plant.code} set to ${capacity} ${measure.toLowerCase()}.`,
      };
    });
  }

  // ---------- Events and seasons ----------
  @Get('plants/:plantId/tools/events') async events(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const item = req.query.item ? String(req.query.item) : null;
      return {
        items: await listEvents(db, plant.id),
        curve: item ? await eventCurveView(db, plant.id, item) : null,
      };
    });
  }

  @Post('plants/:plantId/tools/events') async saveEvent(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, [
      'code',
      'name',
      'kind',
      'from',
      'to',
      'uplift',
      'items',
      'family',
      'note',
      'active',
    ]);
    const value = {
      code: code(raw.code, 'Event code'),
      name: text(raw.name, 'Name', 120),
      kind: String(raw.kind ?? 'EVENT'),
      from: isoDate(raw.from, 'From date'),
      to: isoDate(raw.to, 'To date'),
      uplift: range(raw.uplift, 'Uplift %', -99, 1000),
      family: text(raw.family, 'Family', 60, false),
      note: text(raw.note, 'Note', 300, false),
      active: raw.active === undefined ? true : !!raw.active,
    };
    if (!['EVENT', 'SEASON'].includes(value.kind))
      fail(400, 'VALIDATION_ERROR', 'Kind must be EVENT or SEASON.');
    if (value.to < value.from) fail(400, 'VALIDATION_ERROR', 'The window ends before it starts.');
    return mutate(req, 'planning.tools', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const itemIds = await itemsByCodes(db, raw.items);
      await db.query(
        `INSERT INTO demand_events(id,tenant_id,site_id,code,name,kind,from_date,to_date,uplift_pct,item_ids,family,note,active)
         VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id,site_id,lower(code)) DO UPDATE SET name=excluded.name,kind=excluded.kind,
           from_date=excluded.from_date,to_date=excluded.to_date,uplift_pct=excluded.uplift_pct,
           item_ids=excluded.item_ids,family=excluded.family,note=excluded.note,active=excluded.active,
           version=demand_events.version+1,updated_at=now()`,
        [
          actor.tenant_id,
          plant.id,
          value.code,
          value.name,
          value.kind,
          value.from,
          value.to,
          value.uplift,
          itemIds,
          value.family,
          value.note,
          value.active,
        ],
      );
      await audit(db, actor, 'planning.event_saved', 'site', plant.id, null, value);
      return {
        message: `${value.kind === 'SEASON' ? 'Season' : 'Event'} ${value.code} saved: ${value.uplift > 0 ? '+' : ''}${value.uplift}% from ${value.from} to ${value.to}. Buffers recalculate in a few seconds.`,
      };
    });
  }

  // ---------- Scheme intake ----------
  @Get('plants/:plantId/tools/schemes') async schemes(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return { items: await listSchemes(db, plant.id) };
    });
  }

  @Post('plants/:plantId/tools/schemes') async saveScheme(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['code', 'name', 'item', 'from', 'to', 'units', 'note']);
    const value = {
      code: code(raw.code, 'Scheme code'),
      name: text(raw.name, 'Name', 120),
      from: isoDate(raw.from, 'From date'),
      to: isoDate(raw.to, 'To date'),
      units: range(raw.units, 'Expected units', 0.000001, 1e12),
      note: text(raw.note, 'Note', 300, false),
    };
    if (value.to < value.from) fail(400, 'VALIDATION_ERROR', 'The window ends before it starts.');
    return mutate(req, 'planning.tools', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const [itemId] = await itemsByCodes(db, [raw.item]);
      await db.query(
        `INSERT INTO demand_schemes(id,tenant_id,site_id,code,name,item_id,from_date,to_date,expected_units,note)
         VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (tenant_id,site_id,lower(code)) DO UPDATE SET name=excluded.name,item_id=excluded.item_id,
           from_date=excluded.from_date,to_date=excluded.to_date,expected_units=excluded.expected_units,
           note=excluded.note,version=demand_schemes.version+1,updated_at=now()`,
        [
          actor.tenant_id,
          plant.id,
          value.code,
          value.name,
          itemId,
          value.from,
          value.to,
          value.units,
          value.note,
        ],
      );
      await audit(db, actor, 'planning.scheme_saved', 'site', plant.id, null, value);
      return {
        message: `Scheme ${value.code} recorded for ${raw.item}: ${value.units} units between ${value.from} and ${value.to}. It is demand once you accept it.`,
      };
    });
  }

  @Post('plants/:plantId/tools/schemes/:schemeId/:decision') async decideScheme(
    @Req() req: Request,
    @Param('plantId') plantId: string,
    @Param('schemeId') schemeId: string,
    @Param('decision') decision: string,
  ) {
    if (!['accept', 'decline'].includes(decision)) fail(404, 'NOT_FOUND', 'Unknown decision.');
    const raw = body(req, ['version']);
    if (!Number.isInteger(raw.version) || raw.version < 1)
      fail(400, 'VERSION_REQUIRED', 'Record version is missing. Refresh before saving.');
    return mutate(req, 'planning.tools', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const s = (
        await db.query('SELECT * FROM demand_schemes WHERE id=$1 AND site_id=$2 FOR UPDATE', [
          id(schemeId),
          plant.id,
        ])
      ).rows[0];
      if (!s) fail(404, 'NOT_FOUND', 'Scheme not found.');
      if (s.version !== raw.version)
        fail(409, 'STALE_RECORD', 'The scheme changed after you opened it. Refresh and try again.');
      const state = decision === 'accept' ? 'accepted' : 'declined';
      await db.query(
        `UPDATE demand_schemes SET state=$2,decided_by=$3,decided_at=now(),version=version+1,updated_at=now() WHERE id=$1`,
        [s.id, state, actor.id],
      );
      await audit(
        db,
        actor,
        'planning.scheme_' + state,
        'site',
        plant.id,
        { state: s.state },
        { state },
      );
      return {
        message:
          state === 'accepted'
            ? `Scheme ${s.code} accepted: its volume inside the horizon is demand now. Buffers recalculate in a few seconds.`
            : `Scheme ${s.code} declined: it is not demand.`,
      };
    });
  }

  // ---------- Target mode ----------
  @Post('plants/:plantId/tools/target') async target(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const raw = body(req, ['family', 'from', 'to', 'units']);
    const target = {
      family: text(raw.family, 'Family', 60, false),
      from: isoDate(raw.from, 'From date'),
      to: isoDate(raw.to, 'To date'),
      targetUnits: range(raw.units, 'Target units', 0.000001, 1e12),
    };
    if (target.to < target.from) fail(400, 'VALIDATION_ERROR', 'The period ends before it starts.');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return targetView(db, plant.id, target);
    });
  }

  // ---------- The network ----------
  @Get('network') async network(@Req() req: Request) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const view = await networkView(db);
      // Only the plants this person can see.
      const mine = [];
      for (const p of view.plants)
        try {
          await requirePlant(db, actor, p.id);
          mine.push(p);
        } catch {
          /* not assigned: leave it out */
        }
      return { plants: mine };
    });
  }

  @Post('plants/:plantId/tools/what-if') async whatIf(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    const raw = body(req, ['resource', 'machines']);
    const machines = range(raw.machines, 'Machines', 0, 99);
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      const view = await whatIfView(db, plant.id, String(raw.resource ?? ''), machines);
      if (!view)
        fail(404, 'NOT_FOUND', `Resource ${raw.resource} is not on this plant's schedule.`);
      return view;
    });
  }

  // ---------- Assumptions ----------
  @Get('plants/:plantId/tools/assumptions') async assumptions(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const actor = await access(req, 'planning.read');
    return scoped(actor.tenant_id, async (db) => {
      const plant = await requirePlant(db, actor, id(plantId));
      return assumptionsView(db, plant.id);
    });
  }

  @Put('plants/:plantId/tools/assumptions') async saveAssumption(
    @Req() req: Request,
    @Param('plantId') plantId: string,
  ) {
    const raw = body(req, ['code', 'note', 'confirmed']);
    const value = {
      code: text(raw.code, 'Assumption', 40),
      note: text(raw.note, 'Note', 500, false),
      confirmed: !!raw.confirmed,
    };
    return mutate(req, 'planning.tools', async (db, actor) => {
      const plant = await requirePlant(db, actor, id(plantId));
      await db.query(
        `INSERT INTO planning_assumptions(tenant_id,site_id,code,note,confirmed,confirmed_by,confirmed_at)
         VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5 THEN now() ELSE NULL END)
         ON CONFLICT (tenant_id,site_id,code) DO UPDATE SET note=excluded.note,confirmed=excluded.confirmed,
           confirmed_by=excluded.confirmed_by,confirmed_at=excluded.confirmed_at,updated_at=now()`,
        [actor.tenant_id, plant.id, value.code, value.note, value.confirmed, actor.id],
      );
      await audit(db, actor, 'planning.assumption', 'site', plant.id, null, value);
      return {
        message: value.confirmed
          ? `${value.code} confirmed with the client.`
          : `${value.code} noted as an open assumption.`,
      };
    });
  }
}
