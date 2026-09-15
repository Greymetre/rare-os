import { Controller, Get, Post, Patch, Put, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { access, scoped, fail } from './core.js';
import {
  id,
  text,
  body,
  version,
  pagination,
  mutate,
  audit,
  account,
  role,
  canGrant,
} from './access.controller.js';
export function allPlants(actor: any) {
  return !!actor.is_system || actor.permissions.includes('sites.read_all');
}
// Reuse this check before every future plant-scoped business query/mutation.
export async function requirePlant(db: PoolClient, actor: any, plantId: string) {
  const row = (
    await db.query(
      'SELECT s.* FROM sites s WHERE s.id=$1 AND ($2::boolean OR (s.active AND EXISTS(SELECT 1 FROM user_sites us WHERE us.tenant_id=s.tenant_id AND us.site_id=s.id AND us.user_id=$3)))',
      [plantId, allPlants(actor), actor.id],
    )
  ).rows[0];
  if (!row)
    fail(
      404,
      'PLANT_NOT_FOUND',
      'Plant not found or not assigned to you. Contact your company administrator.',
    );
  return row;
}
function fields(req: Request, editing = false) {
  const b = body(
    req,
    editing
      ? ['name', 'location', 'timezone', 'active', 'version']
      : ['code', 'name', 'location', 'timezone'],
  );
  const name = text(b.name, 'Plant name', 2, 120),
    location = text(b.location, 'Location', 2, 200),
    timezone = text(b.timezone, 'Timezone', 3, 80);
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    fail(400, 'INVALID_TIMEZONE', 'Enter a valid timezone, for example Asia/Kolkata.');
  }
  if (editing && typeof b.active !== 'boolean')
    fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
  const code = editing ? undefined : text(b.code, 'Plant code', 2, 30).toUpperCase();
  if (code && !/^[A-Z0-9][A-Z0-9_-]+$/.test(code))
    fail(400, 'INVALID_CODE', 'Plant code can contain letters, numbers, hyphens or underscores.');
  return { ...b, name, location, timezone, code };
}
@Controller('api')
export class PlantsController {
  @Get('plants') async list(@Req() req: Request) {
    const actor = await access(req, 'sites.read'),
      { limit, after, q } = pagination(req);
    return scoped(actor.tenant_id, async (db) => {
      const rows = (
        await db.query(
          'SELECT s.* FROM sites s WHERE ($1::uuid IS NULL OR s.id>$1) AND starts_with(lower(s.name),$2) AND ($3::boolean OR (s.active AND EXISTS(SELECT 1 FROM user_sites us WHERE us.tenant_id=s.tenant_id AND us.site_id=s.id AND us.user_id=$4))) ORDER BY s.id LIMIT $5',
          [after, q, allPlants(actor), actor.id, limit + 1],
        )
      ).rows;
      return {
        items: rows.slice(0, limit),
        nextCursor: rows.length > limit ? rows[limit - 1].id : null,
      };
    });
  }
  @Get('plants/:id') async detail(@Req() req: Request, @Param('id') plantId: string) {
    const actor = await access(req, 'sites.read');
    return scoped(actor.tenant_id, (db) => requirePlant(db, actor, id(plantId)));
  }
  @Post('plants') async create(@Req() req: Request) {
    const b = fields(req);
    return mutate(req, 'sites.create', async (db, actor) => {
      const plantId = randomUUID();
      await db.query(
        'INSERT INTO sites(id,tenant_id,code,name,location,timezone) VALUES($1,$2,$3,$4,$5,$6)',
        [plantId, actor.tenant_id, b.code, b.name, b.location, b.timezone],
      );
      if (!allPlants(actor))
        await db.query('INSERT INTO user_sites(tenant_id,user_id,site_id) VALUES($1,$2,$3)', [
          actor.tenant_id,
          actor.id,
          plantId,
        ]);
      await audit(db, actor, 'plant.created', 'plant', plantId, null, b);
      return { id: plantId, message: 'Plant created. Assign users from Users → Plant access.' };
    });
  }
  @Patch('plants/:id') async edit(@Req() req: Request, @Param('id') plantId: string) {
    id(plantId);
    const b = fields(req, true),
      v = version(b.version);
    return mutate(req, 'sites.update', async (db, actor) => {
      const old = await requirePlant(db, actor, plantId);
      if (old.active !== b.active && !actor.permissions.includes('sites.change_status'))
        fail(403, 'PERMISSION_DENIED', 'Activate/deactivate plants permission is required.');
      if (old.version !== v)
        fail(409, 'STALE_RECORD', 'Plant changed elsewhere. Refresh before saving.');
      await db.query(
        'UPDATE sites SET name=$1,location=$2,timezone=$3,active=$4,version=version+1 WHERE id=$5',
        [b.name, b.location, b.timezone, b.active, plantId],
      );
      await audit(db, actor, 'plant.updated', 'plant', plantId, old, b);
      return { message: 'Plant updated. Inactive plants are unavailable to assigned staff.' };
    });
  }
  @Get('users/:id/plants') async grants(@Req() req: Request, @Param('id') userId: string) {
    const actor = await access(req, 'users.assign_plants');
    if (!actor.permissions.includes('sites.read_all'))
      fail(
        403,
        'PERMISSION_DENIED',
        'Access all company plants permission is required to assign plant access.',
      );
    return scoped(actor.tenant_id, async (db) => {
      const target = await account(db, id(userId));
      canGrant(actor, (await role(db, target.role_id)).permissions);
      return {
        userId: target.id,
        version: target.version,
        allPlants: allPlants({
          ...target,
          is_system: (await role(db, target.role_id)).is_system,
          permissions: (await role(db, target.role_id)).permissions,
        }),
        plantIds: (
          await db.query('SELECT site_id FROM user_sites WHERE user_id=$1', [userId])
        ).rows.map((r) => r.site_id),
      };
    });
  }
  @Put('users/:id/plants') async assign(@Req() req: Request, @Param('id') userId: string) {
    id(userId);
    const b = body(req, ['plantIds', 'version']),
      v = version(b.version);
    if (!Array.isArray(b.plantIds) || b.plantIds.length > 500)
      fail(400, 'INVALID_PLANTS', 'Select up to 500 plants.');
    const ids = [...new Set((b.plantIds as unknown[]).map(id))];
    return mutate(req, 'users.assign_plants', async (db, actor) => {
      if (!actor.permissions.includes('sites.read_all'))
        fail(
          403,
          'PERMISSION_DENIED',
          'Access all company plants permission is required to assign plant access.',
        );
      const target = await account(db, userId),
        targetRole = await role(db, target.role_id);
      canGrant(actor, targetRole.permissions);
      if (target.version !== v)
        fail(409, 'STALE_RECORD', 'User changed elsewhere. Reopen plant access.');
      if (
        allPlants({
          ...target,
          is_system: targetRole.is_system,
          permissions: targetRole.permissions,
        })
      )
        fail(
          409,
          'ALL_PLANT_ACCESS',
          'This role manages all company plants. Assign a limited role before selecting individual plants.',
        );
      const valid = await db.query('SELECT id FROM sites WHERE id=ANY($1::uuid[]) AND active', [
        ids,
      ]);
      if (valid.rowCount !== ids.length)
        fail(
          400,
          'INVALID_PLANTS',
          'One or more plants are inactive or belong to another company. Select active plants from this company.',
        );
      const before = (
        await db.query('SELECT site_id FROM user_sites WHERE user_id=$1', [userId])
      ).rows.map((r) => r.site_id);
      await db.query('DELETE FROM user_sites WHERE user_id=$1', [userId]);
      await db.query(
        'INSERT INTO user_sites(tenant_id,user_id,site_id) SELECT $1,$2,unnest($3::uuid[])',
        [actor.tenant_id, userId, ids],
      );
      await db.query('UPDATE app_users SET version=version+1 WHERE id=$1', [userId]);
      await audit(
        db,
        actor,
        'user.plants_assigned',
        'user',
        userId,
        { plantIds: before },
        { plantIds: ids },
      );
      return {
        message: ids.length
          ? 'Plant access saved. Changes apply on the next request.'
          : 'Plant access removed. This user cannot access any plant.',
      };
    });
  }
}
