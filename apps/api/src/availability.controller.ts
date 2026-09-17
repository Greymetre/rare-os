import {
  CsvError,
  importKind,
  readImport,
  templateCsv,
  toCsv,
  MAX_IMPORT_ROWS,
} from '../../../packages/schema/imports.mjs';
import { Controller, Get, Post, Patch, Req, Res, Param } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { access, scoped, fail } from './core.js';
import { id, text, body, version, pagination, mutate, audit } from './access.controller.js';

const ROW_CHUNK = 1000;

function unitFields(req: Request, editing = false) {
  const b = body(
    req,
    editing ? ['name', 'decimals', 'active', 'version'] : ['code', 'name', 'decimals'],
  );
  const name = text(b.name, 'Unit name', 1, 60);
  if (!Number.isInteger(b.decimals) || b.decimals < 0 || b.decimals > 6)
    fail(400, 'VALIDATION_ERROR', 'Decimals must be a whole number from 0 to 6.');
  if (editing && typeof b.active !== 'boolean')
    fail(400, 'VALIDATION_ERROR', 'Choose active or inactive.');
  const code = editing ? undefined : text(b.code, 'Unit code', 1, 20).toUpperCase();
  if (code && !/^[A-Z0-9][A-Z0-9_.-]{0,19}$/.test(code))
    fail(
      400,
      'INVALID_CODE',
      'Unit code can contain letters, numbers, dot, hyphen or underscore (up to 20).',
    );
  return { ...b, name, code };
}

// Import types carry their own write permission in addition to imports.create.
function kindFor(actor: any, kind: string) {
  const def = importKind(kind);
  if (!def) fail(404, 'IMPORT_TYPE_NOT_FOUND', 'This import type is not available.');
  if (!actor.permissions.includes(def!.permission))
    fail(
      403,
      'PERMISSION_DENIED',
      `You need permission to maintain ${def!.label.toLowerCase()} before importing them.`,
    );
  return def!;
}

async function batchFor(db: PoolClient, batchId: string, lock = false) {
  const row = (
    await db.query(`SELECT * FROM import_batches WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [
      batchId,
    ])
  ).rows[0];
  if (!row)
    fail(404, 'IMPORT_NOT_FOUND', 'Import not found in this company. Refresh the import list.');
  return row;
}

async function queue(db: PoolClient, actor: any, kind: string, payload: Record<string, unknown>) {
  await db.query('INSERT INTO outbox_events(tenant_id,kind,payload) VALUES($1,$2,$3)', [
    actor.tenant_id,
    kind,
    JSON.stringify({ ...payload, actorId: actor.id, actorSubject: actor.actor_subject ?? null }),
  ]);
}

const statusMessages: Record<string, string> = {
  validating: 'Checking rows in the background. This page updates automatically.',
  validated: 'Validation finished. Review the preview before committing.',
  committing: 'Saving rows in the background. Do not upload the same file again.',
  committed: 'Import committed.',
  failed: 'The import could not finish. Retry validation or upload the file again.',
  cancelled: 'Import cancelled. No records were changed.',
};
function present(b: any) {
  return { ...b, message: b.error || statusMessages[b.status] };
}

@Controller('api')
export class AvailabilityController {
  @Get('availability/readiness') async readiness(@Req() req: Request) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => {
      const counts = (
        await db.query(
          `SELECT (SELECT count(*) FROM sites WHERE active)::int AS plants,
            (SELECT count(*) FROM units WHERE active)::int AS units,
            (SELECT count(*) FROM items WHERE active AND item_type='FG')::int AS fg,
            (SELECT count(*) FROM items WHERE active AND item_type='RM')::int AS rm,
            (SELECT count(*) FROM items WHERE active)::int AS items,
            (SELECT count(*) FROM items i WHERE i.active AND i.make_buy='BUY' AND NOT EXISTS (SELECT 1 FROM item_suppliers x JOIN suppliers s ON s.id=x.supplier_id WHERE x.item_id=i.id AND x.active AND s.active))::int AS unsourced,
            (SELECT count(*) FROM suppliers WHERE active)::int AS suppliers,
            (SELECT count(*) FROM customers WHERE active)::int AS customers`,
        )
      ).rows[0];
      const upcoming = (key: string, title: string, milestone: string, detail: string) => ({
        key,
        title,
        status: 'upcoming',
        detail: `${detail} Available in ${milestone}.`,
      });
      return {
        items: [
          {
            key: 'plants',
            title: 'Plants',
            status: counts.plants ? 'ready' : 'missing',
            count: counts.plants,
            detail: counts.plants
              ? `${counts.plants} active plant(s).`
              : 'Create at least one active plant from Plants.',
          },
          {
            key: 'units',
            title: 'Units of measure',
            status: counts.units ? 'ready' : 'missing',
            count: counts.units,
            detail: counts.units
              ? `${counts.units} active unit(s).`
              : 'Add units such as NOS or KG, or import them from a CSV file.',
          },
          {
            key: 'items',
            title: 'Items',
            status: counts.fg && counts.rm ? 'ready' : 'missing',
            count: counts.items,
            detail:
              counts.fg && counts.rm
                ? `${counts.fg} finished good(s) and ${counts.rm} raw material(s).`
                : 'Add at least one finished good (FG) and one raw material (RM).',
          },
          {
            key: 'sourcing',
            title: 'Suppliers and sourcing',
            status: counts.suppliers && !counts.unsourced ? 'ready' : 'missing',
            count: counts.suppliers,
            detail: !counts.suppliers
              ? 'Add suppliers with their lead times.'
              : counts.unsourced
                ? `${counts.unsourced} bought item(s) have no active supplier. Add them in Item sourcing.`
                : `${counts.suppliers} supplier(s); every bought item has a source.`,
          },
          {
            key: 'customers',
            title: 'Customers',
            status: counts.customers ? 'ready' : 'missing',
            count: counts.customers,
            detail: counts.customers
              ? `${counts.customers} active customer(s).`
              : 'Add customers before entering orders.',
          },
          upcoming(
            'resources',
            'Resources, calendars, BOM and routing',
            'AV-2',
            'Machines, shifts and manufacturing steps.',
          ),
          upcoming('demand', 'Orders and stock', 'AV-3', 'Customer orders and stock ledger.'),
        ],
      };
    });
  }

  @Get('units') async units(@Req() req: Request) {
    const actor = await access(req, 'masters.read'),
      { limit, after, q } = pagination(req);
    return scoped(actor.tenant_id, async (db) => {
      const rows = (
        await db.query(
          'SELECT id,code,name,decimals,active,version,updated_at FROM units WHERE ($1::uuid IS NULL OR id>$1) AND (starts_with(lower(code),$2) OR starts_with(lower(name),$2)) ORDER BY id LIMIT $3',
          [after, q, limit + 1],
        )
      ).rows;
      return {
        items: rows.slice(0, limit),
        nextCursor: rows.length > limit ? rows[limit - 1].id : null,
      };
    });
  }

  @Post('units') async createUnit(@Req() req: Request) {
    const b = unitFields(req);
    return mutate(req, 'masters.manage', async (db, actor) => {
      if ((await db.query('SELECT 1 FROM units WHERE lower(code)=lower($1)', [b.code])).rowCount)
        fail(409, 'ALREADY_EXISTS', `Unit ${b.code} already exists. Edit it instead.`);
      const unitId = randomUUID();
      await db.query('INSERT INTO units(id,tenant_id,code,name,decimals) VALUES($1,$2,$3,$4,$5)', [
        unitId,
        actor.tenant_id,
        b.code,
        b.name,
        b.decimals,
      ]);
      await audit(db, actor, 'unit.created', 'unit', unitId, null, b);
      return { id: unitId, message: `Unit ${b.code} created.` };
    });
  }

  @Patch('units/:id') async editUnit(@Req() req: Request, @Param('id') unitId: string) {
    id(unitId);
    const b = unitFields(req, true),
      v = version(b.version);
    return mutate(req, 'masters.manage', async (db, actor) => {
      const old = (await db.query('SELECT * FROM units WHERE id=$1 FOR UPDATE', [unitId])).rows[0];
      if (!old) fail(404, 'UNIT_NOT_FOUND', 'Unit not found in this company. Refresh the list.');
      if (old.version !== v)
        fail(409, 'STALE_RECORD', 'Unit changed elsewhere. Refresh before saving.');
      if (old.active && !b.active) {
        const used = (
          await db.query(
            'SELECT (SELECT count(*) FROM items WHERE base_unit_id=$1 AND active)::int + (SELECT count(*) FROM item_suppliers WHERE purchase_unit_id=$1 AND active)::int AS n',
            [unitId],
          )
        ).rows[0].n;
        if (used)
          fail(
            409,
            'UNIT_IN_USE',
            `Unit ${old.code} is used by ${used} active item or sourcing record(s). Change or deactivate them first.`,
          );
      }
      await db.query(
        'UPDATE units SET name=$1,decimals=$2,active=$3,version=version+1,updated_at=now() WHERE id=$4',
        [b.name, b.decimals, b.active, unitId],
      );
      await audit(db, actor, 'unit.updated', 'unit', unitId, old, b);
      return { message: `Unit ${old.code} updated.` };
    });
  }

  @Get('imports/templates/:kind') async template(
    @Req() req: Request,
    @Res() res: Response,
    @Param('kind') kind: string,
  ) {
    const actor = await access(req, 'imports.create');
    kindFor(actor, kind);
    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="rare-os-${kind}-template.csv"`)
      .send(templateCsv(kind));
  }

  @Post('imports/:kind') async upload(@Req() req: Request, @Param('kind') kind: string) {
    if (typeof req.body !== 'string')
      fail(
        415,
        'CSV_REQUIRED',
        'Upload a CSV file (Content-Type text/csv). Download the template to start.',
      );
    const raw = req.body as string;
    const fileName = String(req.headers['x-file-name'] || 'upload.csv')
      .replace(/[^\w .()-]/g, '_')
      .slice(0, 120);
    return mutate(req, 'imports.create', async (db, actor) => {
      kindFor(actor, kind);
      let rows: ReturnType<typeof readImport> = [];
      try {
        rows = readImport(kind, raw);
      } catch (e) {
        if (e instanceof CsvError) fail(400, e.code, e.message);
        throw e;
      }
      const sha = createHash('sha256').update(raw).digest('hex');
      const duplicate = (
        await db.query(
          "SELECT batch_no,committed_at FROM import_batches WHERE kind=$1 AND file_sha256=$2 AND status='committed'",
          [kind, sha],
        )
      ).rows[0];
      if (duplicate)
        fail(
          409,
          'FILE_ALREADY_IMPORTED',
          `This exact file was already imported as batch #${duplicate.batch_no}. Nothing was changed.`,
        );
      const batchId = randomUUID();
      const batchNo = (await db.query("SELECT next_number('import_batch') AS n")).rows[0].n;
      await db.query(
        "INSERT INTO import_batches(id,tenant_id,batch_no,kind,file_name,file_sha256,status,total_rows,created_by,created_by_subject) VALUES($1,$2,$3,$4,$5,$6,'validating',$7,$8,$9)",
        [
          batchId,
          actor.tenant_id,
          batchNo,
          kind,
          fileName,
          sha,
          rows.length,
          actor.id,
          actor.actor_subject ?? null,
        ],
      );
      for (let i = 0; i < rows.length; i += ROW_CHUNK) {
        const chunk = rows.slice(i, i + ROW_CHUNK);
        await db.query(
          'INSERT INTO import_rows(tenant_id,batch_id,line_no,data) SELECT $1,$2,unnest($3::int[]),unnest($4::jsonb[])',
          [
            actor.tenant_id,
            batchId,
            chunk.map((r) => r.line),
            chunk.map((r) =>
              JSON.stringify(
                r.columnCountError ? { ...r.data, _columnCountError: r.columnCountError } : r.data,
              ),
            ),
          ],
        );
      }
      await queue(db, actor, 'import.validate', { batchId });
      await audit(db, actor, 'import.uploaded', 'import', batchId, null, {
        kind,
        fileName,
        rows: rows.length,
      });
      return {
        id: batchId,
        batchNo,
        message: `Batch #${batchNo}: ${rows.length} row(s) received. Validation is running in the background.`,
      };
    });
  }

  @Get('imports') async batches(@Req() req: Request) {
    const actor = await access(req, 'masters.read');
    const before =
      req.query.before === undefined
        ? null
        : /^[1-9][0-9]{0,17}$/.test(String(req.query.before))
          ? String(req.query.before)
          : fail(400, 'INVALID_CURSOR', 'This page link is invalid. Return to the first page.');
    return scoped(actor.tenant_id, async (db) => {
      const rows = (
        await db.query(
          'SELECT id,batch_no,kind,file_name,status,total_rows,valid_rows,error_rows,summary,error,created_at,validated_at,committed_at,version FROM import_batches WHERE ($1::bigint IS NULL OR batch_no<$1::bigint) ORDER BY batch_no DESC LIMIT 26',
          [before],
        )
      ).rows;
      return {
        items: rows.slice(0, 25).map(present),
        nextCursor: rows.length > 25 ? rows[24].batch_no : null,
      };
    });
  }

  @Get('imports/:id') async batch(@Req() req: Request, @Param('id') batchId: string) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => present(await batchFor(db, id(batchId))));
  }

  @Get('imports/:id/rows') async rows(@Req() req: Request, @Param('id') batchId: string) {
    const actor = await access(req, 'masters.read');
    const afterLine = req.query.afterLine === undefined ? 0 : Number(req.query.afterLine);
    if (!Number.isInteger(afterLine) || afterLine < 0 || afterLine > MAX_IMPORT_ROWS + 10)
      fail(400, 'INVALID_CURSOR', 'This page link is invalid. Return to the first page.');
    const errorsOnly = req.query.errors === 'true';
    return scoped(actor.tenant_id, async (db) => {
      await batchFor(db, id(batchId));
      const rows = (
        await db.query(
          `SELECT line_no,data,value,errors,action FROM import_rows WHERE batch_id=$1 AND line_no>$2 ${errorsOnly ? "AND errors<>'[]'" : ''} ORDER BY line_no LIMIT 51`,
          [batchId, afterLine],
        )
      ).rows;
      return {
        items: rows.slice(0, 50),
        nextCursor: rows.length > 50 ? rows[49].line_no : null,
      };
    });
  }

  @Get('imports/:id/errors.csv') async errorFile(
    @Req() req: Request,
    @Res() res: Response,
    @Param('id') batchId: string,
  ) {
    const actor = await access(req, 'masters.read');
    const csv = await scoped(actor.tenant_id, async (db) => {
      const batch = await batchFor(db, id(batchId));
      const def = importKind(batch.kind)!;
      const rows = (
        await db.query(
          "SELECT line_no,data,errors FROM import_rows WHERE batch_id=$1 AND errors<>'[]' ORDER BY line_no",
          [batchId],
        )
      ).rows;
      return toCsv([
        ['line', 'column', 'problem', ...def.columns],
        ...rows.flatMap((r) =>
          r.errors.map((e: any) => [
            r.line_no,
            e.column,
            e.message,
            ...def.columns.map((c) => r.data[c]),
          ]),
        ),
      ]);
    });
    res
      .status(200)
      .setHeader('Content-Type', 'text/csv; charset=utf-8')
      .setHeader('Content-Disposition', `attachment; filename="import-${batchId}-errors.csv"`)
      .send(csv);
  }

  @Post('imports/:id/commit') async commit(@Req() req: Request, @Param('id') batchId: string) {
    id(batchId);
    const v = version(body(req, ['version']).version);
    return mutate(req, 'imports.create', async (db, actor) => {
      const batch = await batchFor(db, batchId, true);
      kindFor(actor, batch.kind);
      if (batch.version !== v)
        fail(409, 'STALE_RECORD', 'This import changed. Refresh it before committing.');
      if (batch.status !== 'validated')
        fail(
          409,
          'IMPORT_NOT_READY',
          statusMessages[batch.status] || 'This import cannot be committed.',
        );
      if (batch.error_rows > 0)
        fail(
          409,
          'IMPORT_HAS_ERRORS',
          `${batch.error_rows} row(s) have errors. Download the error file, fix the rows and upload again. Nothing was saved.`,
        );
      await db.query(
        "UPDATE import_batches SET status='committing',error=NULL,version=version+1 WHERE id=$1",
        [batchId],
      );
      await queue(db, actor, 'import.commit', { batchId });
      return {
        message: `Batch #${batch.batch_no} is being saved in the background.`,
      };
    });
  }

  @Post('imports/:id/cancel') async cancel(@Req() req: Request, @Param('id') batchId: string) {
    id(batchId);
    const v = version(body(req, ['version']).version);
    return mutate(req, 'imports.create', async (db, actor) => {
      const batch = await batchFor(db, batchId, true);
      kindFor(actor, batch.kind);
      if (batch.version !== v)
        fail(409, 'STALE_RECORD', 'This import changed. Refresh it before cancelling.');
      if (!['validated', 'failed'].includes(batch.status))
        fail(409, 'IMPORT_NOT_CANCELLABLE', statusMessages[batch.status]);
      await db.query("UPDATE import_batches SET status='cancelled',version=version+1 WHERE id=$1", [
        batchId,
      ]);
      await audit(db, actor, 'import.cancelled', 'import', batchId, { status: batch.status }, null);
      return { message: `Batch #${batch.batch_no} cancelled. No records were changed.` };
    });
  }

  @Post('imports/:id/revalidate') async revalidate(
    @Req() req: Request,
    @Param('id') batchId: string,
  ) {
    id(batchId);
    const v = version(body(req, ['version']).version);
    return mutate(req, 'imports.create', async (db, actor) => {
      const batch = await batchFor(db, batchId, true);
      kindFor(actor, batch.kind);
      if (batch.version !== v)
        fail(409, 'STALE_RECORD', 'This import changed. Refresh it before retrying.');
      if (!['validated', 'failed'].includes(batch.status))
        fail(409, 'IMPORT_NOT_READY', statusMessages[batch.status]);
      await db.query(
        "UPDATE import_batches SET status='validating',error=NULL,version=version+1 WHERE id=$1",
        [batchId],
      );
      await queue(db, actor, 'import.validate', { batchId });
      return {
        message: `Batch #${batch.batch_no} is being checked again against current records.`,
      };
    });
  }
}
