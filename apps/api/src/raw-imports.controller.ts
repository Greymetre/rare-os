// AV-12 raw imports (Nilkamal simulation handover, 21-Sep-2026: "Import contracts and source
// traps"). An ERP exports workbooks, not templates, so a file arrives as it is: the sheet is
// chosen, its columns are mapped to our fields, and the file itself is kept so any number can be
// traced back to the row it came from. Reading is masters.read; uploading, mapping and staging
// need imports.create plus the permission that import type already asks for.
//
// These live under imports/raw/... so that the template CSV route (imports/:kind) can never
// shadow them, whatever order the controllers are registered in.
import { Controller, Get, Post, Delete, Req, Param } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { access, scoped, fail } from './core.js';
import { id, body, mutate, audit } from './access.controller.js';
import { importKind } from '../../../packages/schema/imports.mjs';
import { openWorkbook, headerColumns, WorkbookError } from '../../../packages/engines/workbook.mjs';
import {
  FILTER_OPERATORS,
  headerFingerprint,
  resolveMapping,
  suggestMapping,
} from '../../../packages/engines/import-mapping.mjs';

// The real exports run to tens of megabytes: the sales history alone is 33.6 MB and 287,653 rows.
// The limit is on the rows an import carries; a sheet may hold a few title rows above its header.
export const MAX_WORKBOOK_BYTES = 40 * 1024 * 1024;
export const MAX_WORKBOOK_ROWS = 300000;
export const MAX_SHEET_ROWS = MAX_WORKBOOK_ROWS + 1000;
const PREVIEW_ROWS = 20;
const TRANSFORMS = new Set(['text', 'number', 'date', 'unit', 'upper']);
const DATE_FORMATS = new Set(['auto', 'dmy', 'mdy', 'ymd', 'serial']);
const DECIMALS = new Set(['auto', 'dot', 'comma']);

const text = (v: unknown, label: string, max: number, required = true) => {
  const s = String(v ?? '').trim();
  if (required && !s) fail(400, 'VALIDATION_ERROR', `${label} is required.`);
  if (s.length > max) fail(400, 'VALIDATION_ERROR', `${label} is at most ${max} characters.`);
  return s;
};
const code = (v: unknown, label: string) => {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,29}$/.test(s))
    fail(400, 'VALIDATION_ERROR', `${label} must be a short code (letters, digits, . _ -).`);
  return s;
};
const rowNumber = (v: unknown, label: string, fallback: number | null = null) => {
  if (v === undefined || v === null || String(v).trim() === '') {
    if (fallback !== null) return fallback;
    fail(400, 'VALIDATION_ERROR', `${label} is required.`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WORKBOOK_ROWS)
    fail(400, 'VALIDATION_ERROR', `${label} must be a row number in the sheet.`);
  return n;
};

// Import types carry their own write permission, exactly as the template imports do.
function kindFor(actor: any, kind: string) {
  const def = importKind(kind);
  if (!def) fail(404, 'IMPORT_TYPE_NOT_FOUND', 'This import type is not available.');
  if (
    ![def!.permission, ...(def!.alsoAllowed ?? [])].some((p: string) =>
      actor.permissions.includes(p),
    )
  )
    fail(
      403,
      'PERMISSION_DENIED',
      `You need permission to maintain ${def!.label.toLowerCase()} before importing them.`,
    );
  return def!;
}

async function fileFor(db: PoolClient, fileId: string, withContent = false) {
  const row = (
    await db.query(
      `SELECT id,file_no,file_name,file_format,byte_size,sha256,sheets,note,uploaded_at${withContent ? ',content' : ''} FROM import_files WHERE id=$1`,
      [fileId],
    )
  ).rows[0];
  if (!row) fail(404, 'FILE_NOT_FOUND', 'This file is not in this company. Refresh the file list.');
  return row;
}

// Read one sheet's header and the rows under it, stopping as soon as enough have been seen.
function readSheet(content: Buffer, sheet: string, headerRow: number, limit: number) {
  try {
    const workbook = openWorkbook(content, { maxRows: MAX_SHEET_ROWS });
    const iterator = workbook.rows(sheet || undefined);
    let header: string[] = [];
    const rows: { row: number; cells: string[] }[] = [];
    for (const row of iterator) {
      if (row.row < headerRow) continue;
      if (row.row === headerRow || !header.length) {
        header = row.cells;
        continue;
      }
      rows.push(row);
      if (rows.length >= limit) break;
    }
    return { workbook, header: headerColumns(header), rows };
  } catch (e) {
    if (e instanceof WorkbookError) fail(400, e.code, e.message);
    throw e;
  }
}

// A mapping as a person sent it, checked against the fields this import type actually has.
function readMapping(raw: any, def: any) {
  const columns: Record<string, any> = {};
  const fields: string[] = def.columns;
  for (const [field, source] of Object.entries(raw?.columns ?? {})) {
    if (!fields.includes(field))
      fail(400, 'VALIDATION_ERROR', `"${field}" is not a column of this import type.`);
    const s = source as any;
    if (s === null || s === undefined || s === '') continue;
    const by = String(s.by ?? 'position');
    const transform = String(s.transform ?? 'text');
    if (!TRANSFORMS.has(transform))
      fail(400, 'VALIDATION_ERROR', `"${transform}" is not a conversion this import can make.`);
    if (s.format !== undefined && s.format !== '' && !DATE_FORMATS.has(String(s.format)))
      fail(400, 'VALIDATION_ERROR', `"${s.format}" is not a date format.`);
    if (by === 'constant') {
      columns[field] = { by, value: text(s.value, `Value for ${field}`, 120, false) };
      continue;
    }
    if (by === 'position') {
      const index = Number(s.index);
      if (!Number.isInteger(index) || index < 0 || index > 1023)
        fail(400, 'VALIDATION_ERROR', `Column position for "${field}" is not a column.`);
      columns[field] = { by, index, transform, ...(s.format ? { format: String(s.format) } : {}) };
      continue;
    }
    if (by !== 'name') fail(400, 'VALIDATION_ERROR', `"${by}" is not a way to find a column.`);
    columns[field] = {
      by,
      name: text(s.name, `Column name for ${field}`, 200),
      ...(s.occurrence ? { occurrence: Number(s.occurrence) } : {}),
      transform,
      ...(s.format ? { format: String(s.format) } : {}),
    };
  }
  if (!Object.keys(columns).length)
    fail(400, 'VALIDATION_ERROR', 'Map at least one column before staging the sheet.');
  const rawOptions = raw?.options ?? {};
  const decimal = String(rawOptions.decimal ?? 'auto');
  const dateFormat = String(rawOptions.dateFormat ?? 'auto');
  if (!DECIMALS.has(decimal)) fail(400, 'VALIDATION_ERROR', `"${decimal}" is not a decimal style.`);
  if (!DATE_FORMATS.has(dateFormat))
    fail(400, 'VALIDATION_ERROR', `"${dateFormat}" is not a date format.`);
  const uomAliases: Record<string, string> = {};
  for (const [from, to] of Object.entries(rawOptions.uomAliases ?? {})) {
    const alias = text(from, 'Unit alias', 20);
    uomAliases[alias.toUpperCase()] = text(to, `Unit for ${alias}`, 20).toUpperCase();
  }
  // Rows this import deliberately leaves out: another plant, a subtotal line, stock at zero.
  const rawFilters = rawOptions.filters ?? [];
  if (!Array.isArray(rawFilters) || rawFilters.length > 10)
    fail(400, 'VALIDATION_ERROR', 'A mapping can leave out rows with at most 10 rules.');
  const filters = rawFilters.map((f: any) => {
    const field = String(f?.field ?? '');
    if (!Object.hasOwn(columns, field))
      fail(
        400,
        'VALIDATION_ERROR',
        `A rule can only use a column this mapping fills; "${field}" is not one.`,
      );
    const op = String(f?.op ?? '');
    if (!FILTER_OPERATORS.includes(op))
      fail(400, 'VALIDATION_ERROR', `"${op}" is not a rule this import understands.`);
    return { field, op, value: text(f?.value, 'Rule value', 120, false) };
  });
  // A sales export has one row per invoice line; a demand history holds one per day. The mapping
  // can say which fields make a row the same row, and which column is added up when they are.
  const combine = (Array.isArray(rawOptions.combine) ? rawOptions.combine : []).map(
    (f: unknown) => {
      const field = String(f ?? '');
      if (!Object.hasOwn(columns, field))
        fail(
          400,
          'VALIDATION_ERROR',
          `Rows can only be combined on a column this mapping fills; "${field}" is not one.`,
        );
      return field;
    },
  );
  const sum = String(rawOptions.sum ?? '');
  if (sum && !Object.hasOwn(columns, sum))
    fail(400, 'VALIDATION_ERROR', `"${sum}" is not a column this mapping fills.`);
  if (sum && columns[sum]?.transform !== 'number')
    fail(400, 'VALIDATION_ERROR', `Only a column read as a number can be added up.`);
  // Combining without a column to add up keeps the first row and counts the repeats: that is how a
  // master list is read out of a transaction sheet.
  // A stock sheet has no reference column; the fields that make a row unique become one.
  const referenceFrom = (
    Array.isArray(rawOptions.referenceFrom) ? rawOptions.referenceFrom : []
  ).map((f: unknown) => {
    const field = String(f ?? '');
    if (!Object.hasOwn(columns, field))
      fail(
        400,
        'VALIDATION_ERROR',
        `A reference can only be built from a column this mapping fills; "${field}" is not one.`,
      );
    return field;
  });
  if (referenceFrom.length && !def.columns.includes('external_ref'))
    fail(400, 'VALIDATION_ERROR', 'This import type has no reference to build.');
  // What the source calls a value, and what this import calls it: FERT is FG, ROH is RM.
  const valueMaps: Record<string, Record<string, string>> = {};
  for (const [field, pairs] of Object.entries(rawOptions.valueMaps ?? {})) {
    if (!Object.hasOwn(columns, field))
      fail(
        400,
        'VALIDATION_ERROR',
        `Values can only be translated for a column this mapping fills; "${field}" is not one.`,
      );
    const map: Record<string, string> = {};
    for (const [from, to] of Object.entries((pairs ?? {}) as Record<string, string>))
      map[text(from, `Value in the file for ${field}`, 60)] = text(
        to,
        `Value for ${field}`,
        60,
        false,
      );
    if (Object.keys(map).length > 100)
      fail(400, 'VALIDATION_ERROR', `At most 100 translations for "${field}".`);
    valueMaps[field] = map;
  }
  if (referenceFrom.length && Object.hasOwn(columns, 'external_ref'))
    fail(
      400,
      'VALIDATION_ERROR',
      'The reference is either taken from a column or built from fields, not both.',
    );
  return {
    columns,
    options: {
      decimal,
      dateFormat,
      uomAliases,
      filters,
      combine,
      sum,
      referenceFrom,
      valueMaps,
      skipBlankRows: rawOptions.skipBlankRows !== false,
    },
  };
}

@Controller('api')
export class RawImportsController {
  // ---------- the file as it arrived ----------

  @Post('imports/raw/files') async upload(@Req() req: Request) {
    const content = req.body;
    if (!Buffer.isBuffer(content) || !content.length)
      fail(
        415,
        'WORKBOOK_REQUIRED',
        'Upload an .xlsx or .xls file (Content-Type application/vnd.openxmlformats-officedocument.spreadsheetml.sheet or application/vnd.ms-excel).',
      );
    if (content.length > MAX_WORKBOOK_BYTES)
      fail(
        413,
        'FILE_TOO_LARGE',
        `This file is larger than ${Math.round(MAX_WORKBOOK_BYTES / 1048576)} MB. Split it or export fewer columns.`,
      );
    const fileName = String(req.headers['x-file-name'] || 'upload.xlsx')
      .replace(/[^\w .()-]/g, '_')
      .slice(0, 120);
    let format: string, sheets: { name: string; hidden: boolean }[];
    try {
      const workbook = openWorkbook(content);
      format = workbook.format;
      sheets = workbook.sheets;
    } catch (e) {
      if (e instanceof WorkbookError) fail(400, e.code, e.message);
      throw e;
    }
    const sha = createHash('sha256').update(content).digest('hex');
    return mutate(req, 'imports.create', async (db, actor) => {
      const existing = (
        await db.query('SELECT id,file_no,file_name FROM import_files WHERE sha256=$1', [sha])
      ).rows[0];
      if (existing)
        return {
          id: existing.id,
          fileNo: existing.file_no,
          fileName: existing.file_name,
          format,
          sheets,
          message: `This file is already here as file #${existing.file_no}; its sheets can be mapped again.`,
        };
      const fileId = randomUUID();
      const fileNo = (await db.query("SELECT next_number('import_file') AS n")).rows[0].n;
      await db.query(
        `INSERT INTO import_files(id,tenant_id,file_no,file_name,file_format,byte_size,sha256,content,sheets,uploaded_by,uploaded_by_subject)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          fileId,
          actor.tenant_id,
          fileNo,
          fileName,
          format,
          content.length,
          sha,
          content,
          JSON.stringify(sheets),
          actor.id,
          actor.actor_subject ?? null,
        ],
      );
      await audit(db, actor, 'import.file_uploaded', 'import_file', fileId, null, {
        fileName,
        format,
        bytes: content.length,
        sheets: sheets.length,
      });
      return {
        id: fileId,
        fileNo,
        fileName,
        format,
        sheets,
        message: `${fileName} uploaded as file #${fileNo}: ${sheets.length} sheet(s).`,
      };
    });
  }

  @Get('imports/raw/files') async files(@Req() req: Request) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => ({
      items: (
        await db.query(
          `SELECT f.id,f.file_no,f.file_name,f.file_format,f.byte_size,f.sha256,f.sheets,f.uploaded_at,
             (SELECT count(*) FROM import_batches b WHERE b.file_id=f.id)::int AS batches
           FROM import_files f ORDER BY f.uploaded_at DESC, f.id LIMIT 50`,
        )
      ).rows,
    }));
  }

  @Get('imports/raw/files/:id') async file(@Req() req: Request, @Param('id') fileId: string) {
    const actor = await access(req, 'masters.read');
    return scoped(actor.tenant_id, async (db) => fileFor(db, id(fileId)));
  }

  @Delete('imports/raw/files/:id') async remove(@Req() req: Request, @Param('id') fileId: string) {
    id(fileId);
    return mutate(req, 'imports.create', async (db, actor) => {
      const file = await fileFor(db, fileId);
      const used = (
        await db.query(
          "SELECT count(*)::int AS n FROM import_batches WHERE file_id=$1 AND status<>'cancelled'",
          [fileId],
        )
      ).rows[0].n;
      if (used)
        fail(
          409,
          'FILE_IN_USE',
          `${used} import(s) were read from this file. It is kept so those numbers can be traced back.`,
        );
      await db.query('DELETE FROM import_files WHERE id=$1', [fileId]);
      await audit(db, actor, 'import.file_deleted', 'import_file', fileId, null, {
        fileName: file.file_name,
      });
      return { message: `File #${file.file_no} removed.` };
    });
  }

  // ---------- what a sheet looks like, and how it could be mapped ----------

  @Get('imports/raw/files/:id/preview') async preview(
    @Req() req: Request,
    @Param('id') fileId: string,
  ) {
    const actor = await access(req, 'masters.read');
    const sheet = String(req.query.sheet ?? '');
    const headerRow = rowNumber(req.query.headerRow, 'Header row', 1);
    const kind = String(req.query.kind ?? '');
    const def = kind ? importKind(kind) : null;
    if (kind && !def) fail(404, 'IMPORT_TYPE_NOT_FOUND', 'This import type is not available.');
    return scoped(actor.tenant_id, async (db) => {
      const file = await fileFor(db, id(fileId), true);
      const { workbook, header, rows } = readSheet(file.content, sheet, headerRow, PREVIEW_ROWS);
      const fingerprint = headerFingerprint(header);
      const saved = def
        ? (
            await db.query(
              'SELECT id,code,name,sheet,header_row,first_data_row,columns,options,fingerprint,version FROM import_mappings WHERE kind=$1 ORDER BY lower(code)',
              [kind],
            )
          ).rows.map((m) => ({ ...m, matches: m.fingerprint === fingerprint }))
        : [];
      return {
        file: {
          id: file.id,
          fileNo: file.file_no,
          fileName: file.file_name,
          format: file.file_format,
        },
        sheets: workbook.sheets,
        sheet: sheet || workbook.sheets[0]?.name,
        headerRow,
        header,
        rows,
        fingerprint,
        kind: kind || null,
        fields: def ? def.columns : [],
        suggestion: def ? suggestMapping(def.columns, header) : null,
        mappings: saved,
        duplicates: header.filter((h) => h.duplicate).map((h) => h.name),
      };
    });
  }

  // ---------- staging a sheet through a mapping ----------

  @Post('imports/raw/files/:id/stage') async stage(
    @Req() req: Request,
    @Param('id') fileId: string,
  ) {
    id(fileId);
    const raw = body(req, [
      'kind',
      'sheet',
      'headerRow',
      'firstDataRow',
      'columns',
      'options',
      'saveAs',
      'saveName',
    ]);
    const kind = String(raw.kind ?? '');
    const headerRow = rowNumber(raw.headerRow, 'Header row', 1);
    const firstDataRow = rowNumber(raw.firstDataRow, 'First data row', headerRow + 1);
    if (firstDataRow <= headerRow)
      fail(400, 'VALIDATION_ERROR', 'The first data row must come after the header row.');
    return mutate(req, 'imports.create', async (db, actor) => {
      const def = kindFor(actor, kind);
      const file = await fileFor(db, fileId, true);
      const sheet = text(raw.sheet, 'Sheet', 120, false) || file.sheets[0]?.name || '';
      const mapping = readMapping(raw, def);
      // The mapping has to fit this sheet before anything is staged.
      const { header } = readSheet(file.content, sheet, headerRow, 1);
      const resolved = resolveMapping(mapping, header);
      if (resolved.problems.length)
        fail(
          400,
          'MAPPING_DOES_NOT_FIT',
          resolved.problems.map((p: any) => `${p.field}: ${p.message}`).join(' '),
        );
      const committed = (
        await db.query(
          "SELECT batch_no FROM import_batches WHERE kind=$1 AND file_sha256=$2 AND sheet=$3 AND status='committed'",
          [kind, file.sha256, sheet],
        )
      ).rows[0];
      if (committed)
        fail(
          409,
          'FILE_ALREADY_IMPORTED',
          `Sheet "${sheet}" of this file was already imported as batch #${committed.batch_no}. Nothing was changed.`,
        );
      if (raw.saveAs) {
        const mappingCode = code(raw.saveAs, 'Mapping code');
        await db.query(
          `INSERT INTO import_mappings(id,tenant_id,code,name,kind,sheet,header_row,first_data_row,columns,options,fingerprint,created_by)
           VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (tenant_id,lower(code)) DO UPDATE SET name=excluded.name,kind=excluded.kind,sheet=excluded.sheet,
             header_row=excluded.header_row,first_data_row=excluded.first_data_row,columns=excluded.columns,
             options=excluded.options,fingerprint=excluded.fingerprint,updated_at=now(),version=import_mappings.version+1`,
          [
            actor.tenant_id,
            mappingCode,
            text(raw.saveName, 'Mapping name', 120, false) || mappingCode,
            kind,
            sheet,
            headerRow,
            firstDataRow,
            JSON.stringify(mapping.columns),
            JSON.stringify(mapping.options),
            headerFingerprint(header),
            actor.id,
          ],
        );
      }
      const batchId = randomUUID();
      const batchNo = (await db.query("SELECT next_number('import_batch') AS n")).rows[0].n;
      await db.query(
        `INSERT INTO import_batches(id,tenant_id,batch_no,kind,file_name,file_sha256,status,total_rows,created_by,created_by_subject,
           file_id,sheet,header_row,mapping)
         VALUES($1,$2,$3,$4,$5,$6,'validating',0,$7,$8,$9,$10,$11,$12)`,
        [
          batchId,
          actor.tenant_id,
          batchNo,
          kind,
          file.file_name,
          file.sha256,
          actor.id,
          actor.actor_subject ?? null,
          fileId,
          sheet,
          headerRow,
          JSON.stringify({ ...mapping, firstDataRow }),
        ],
      );
      await db.query('INSERT INTO outbox_events(tenant_id,kind,payload) VALUES($1,$2,$3)', [
        actor.tenant_id,
        'import.validate',
        JSON.stringify({
          batchId,
          actorId: actor.id,
          actorSubject: actor.actor_subject ?? null,
        }),
      ]);
      await audit(db, actor, 'import.staged', 'import', batchId, null, {
        kind,
        sheet,
        fileName: file.file_name,
        headerRow,
      });
      return {
        id: batchId,
        batchNo,
        message: `Sheet "${sheet}" is being read into batch #${batchNo}. This page updates as it goes.`,
      };
    });
  }

  // ---------- saved mappings ----------

  @Get('imports/raw/mappings') async mappings(@Req() req: Request) {
    const actor = await access(req, 'masters.read');
    const kind = String(req.query.kind ?? '');
    return scoped(actor.tenant_id, async (db) => ({
      items: (
        await db.query(
          `SELECT id,code,name,kind,sheet,header_row,first_data_row,columns,options,fingerprint,updated_at,version
           FROM import_mappings WHERE ($1='' OR kind=$1) ORDER BY kind, lower(code)`,
          [kind],
        )
      ).rows,
    }));
  }

  @Post('imports/raw/mappings') async saveMapping(@Req() req: Request) {
    const raw = body(req, [
      'code',
      'name',
      'kind',
      'sheet',
      'headerRow',
      'firstDataRow',
      'columns',
      'options',
      'fingerprint',
    ]);
    const mappingCode = code(raw.code, 'Mapping code');
    const kind = String(raw.kind ?? '');
    const headerRow = rowNumber(raw.headerRow, 'Header row', 1);
    const firstDataRow = rowNumber(raw.firstDataRow, 'First data row', headerRow + 1);
    return mutate(req, 'imports.create', async (db, actor) => {
      const def = kindFor(actor, kind);
      const mapping = readMapping(raw, def);
      const saved = await db.query(
        `INSERT INTO import_mappings(id,tenant_id,code,name,kind,sheet,header_row,first_data_row,columns,options,fingerprint,created_by)
         VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (tenant_id,lower(code)) DO UPDATE SET name=excluded.name,kind=excluded.kind,sheet=excluded.sheet,
           header_row=excluded.header_row,first_data_row=excluded.first_data_row,columns=excluded.columns,
           options=excluded.options,fingerprint=excluded.fingerprint,updated_at=now(),version=import_mappings.version+1
         RETURNING id`,
        [
          actor.tenant_id,
          mappingCode,
          text(raw.name, 'Mapping name', 120, false) || mappingCode,
          kind,
          text(raw.sheet, 'Sheet', 120, false),
          headerRow,
          firstDataRow,
          JSON.stringify(mapping.columns),
          JSON.stringify(mapping.options),
          text(raw.fingerprint, 'Header signature', 4000, false),
          actor.id,
        ],
      );
      await audit(db, actor, 'import.mapping_saved', 'import_mapping', saved.rows[0].id, null, {
        code: mappingCode,
        kind,
      });
      return { message: `Mapping ${mappingCode} saved for ${def.label.toLowerCase()}.` };
    });
  }

  @Delete('imports/raw/mappings/:id') async deleteMapping(
    @Req() req: Request,
    @Param('id') mappingId: string,
  ) {
    id(mappingId);
    return mutate(req, 'imports.create', async (db, actor) => {
      const row = (await db.query('SELECT code FROM import_mappings WHERE id=$1', [mappingId]))
        .rows[0];
      if (!row) fail(404, 'MAPPING_NOT_FOUND', 'This mapping is not in this company.');
      await db.query('DELETE FROM import_mappings WHERE id=$1', [mappingId]);
      await audit(db, actor, 'import.mapping_deleted', 'import_mapping', mappingId, null, {
        code: row.code,
      });
      return { message: `Mapping ${row.code} removed.` };
    });
  }
}
