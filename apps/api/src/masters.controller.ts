import { MASTER_KINDS, masterKind, validateMaster } from '../../../packages/schema/masters.mjs';
import {
  existingRecords,
  findMaster,
  listMasters,
  resolveReferences,
  updateMaster,
  upsertMasters,
} from '../../../packages/schema/masters-db.mjs';
import { Controller, Get, Post, Patch, Req, Param, HttpException } from '@nestjs/common';
import type { Request } from 'express';
import { access, scoped, fail } from './core.js';
import { id, body, version, mutate, audit } from './access.controller.js';

function kindOf(kind: string) {
  const def = masterKind(kind);
  if (!def) fail(404, 'MASTER_NOT_FOUND', 'This master data type is not available.');
  return def!;
}

function invalid(errors: { column: string; message: string }[]): never {
  throw new HttpException(
    {
      code: 'VALIDATION_ERROR',
      message: errors.map((e) => e.message).join(' '),
      fields: errors,
    },
    400,
  );
}

function cursorOf(req: Request) {
  if (req.query.cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(req.query.cursor), 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length >= 2 &&
      parsed.length <= 4 &&
      parsed.every((v) => typeof v === 'string' && v.length <= 80)
    )
      return parsed as string[];
  } catch {
    // fall through
  }
  return fail(400, 'INVALID_CURSOR', 'This page link is invalid. Return to the first page.');
}

@Controller('api')
export class MastersController {
  @Get('masters/:kind') async list(@Req() req: Request, @Param('kind') kind: string) {
    kindOf(kind);
    const actor = await access(req, 'masters.read');
    const q = req.query.q === undefined ? '' : String(req.query.q).trim().toLowerCase();
    if (q.length > 40) fail(400, 'VALIDATION_ERROR', 'Search must be at most 40 characters.');
    const cursor = cursorOf(req);
    return scoped(actor.tenant_id, async (db) => {
      const page = await listMasters(db, kind, { q, cursor, limit: 25 });
      return {
        items: page.items,
        nextCursor: page.nextCursor
          ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url')
          : null,
      };
    });
  }

  @Post('masters/:kind') async create(@Req() req: Request, @Param('kind') kind: string) {
    const def = kindOf(kind);
    const raw = body(
      req,
      def.fields.map((f) => f.name),
    );
    const checked = validateMaster(kind, raw);
    if (checked.errors.length) invalid(checked.errors);
    return mutate(req, def.permission, async (db, actor) => {
      const [row] = await resolveReferences(db, kind, [{ value: checked.value, errors: [] }]);
      if (row.errors.length) invalid(row.errors);
      const existing = (await existingRecords(db, kind, [row])).get(def.key(row.value));
      if (existing)
        fail(
          409,
          'ALREADY_EXISTS',
          `${def.title(row.value)} already exists. Edit the existing record instead.`,
        );
      await upsertMasters(db, kind, actor.tenant_id, [row.value]);
      const created = (await existingRecords(db, kind, [row])).get(def.key(row.value));
      await audit(db, actor, `${kind}.created`, kind, created.id, null, row.value);
      return { id: created.id, message: `${def.title(row.value)} created.` };
    });
  }

  @Patch('masters/:kind/:id') async edit(
    @Req() req: Request,
    @Param('kind') kind: string,
    @Param('id') recordId: string,
  ) {
    const def = kindOf(kind);
    id(recordId);
    const raw = body(req, [...def.fields.map((f) => f.name), 'active', 'version']);
    const v = version(raw.version);
    if (typeof raw.active !== 'boolean')
      fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
    return mutate(req, def.permission, async (db, actor) => {
      const old = await findMaster(db, kind, recordId);
      if (!old)
        fail(404, 'RECORD_NOT_FOUND', `This ${def.singular} was not found in your company.`);
      if (old.version !== v)
        fail(409, 'STALE_RECORD', `This ${def.singular} changed elsewhere. Refresh before saving.`);
      // Deactivation is always allowed, even when a referenced record is already inactive:
      // only the status changes and every other stored value is kept.
      if (!raw.active) {
        await updateMaster(db, kind, recordId, old, false);
        await audit(db, actor, `${kind}.deactivated`, kind, recordId, old, { active: false });
        return { message: `This ${def.singular} is now inactive.` };
      }
      // Identity fields (codes, item/supplier links, conversion units) cannot change on edit.
      const merged: Record<string, unknown> = { ...raw };
      for (const f of def.fields) if (f.immutable) merged[f.name] = old[f.name] || null;
      const checked = validateMaster(kind, merged);
      if (checked.errors.length) invalid(checked.errors);
      const [row] = await resolveReferences(db, kind, [{ value: checked.value, errors: [] }]);
      if (row.errors.length) invalid(row.errors);
      await updateMaster(db, kind, recordId, row.value, true);
      await audit(db, actor, `${kind}.updated`, kind, recordId, old, {
        ...row.value,
        active: true,
      });
      return { message: `${def.title(row.value)} saved.` };
    });
  }

  @Get('masters') async catalog(@Req() req: Request) {
    const actor = await access(req, 'masters.read');
    return {
      kinds: Object.entries(MASTER_KINDS).map(([kind, def]) => ({
        kind,
        label: def.label,
        singular: def.singular,
        canManage: actor.permissions.includes(def.permission),
        fields: def.fields.map(({ name, label, type, required, immutable, options, max }) => ({
          name,
          label,
          type,
          required: !!required,
          immutable: !!immutable,
          options,
          max,
        })),
      })),
    };
  }
}
