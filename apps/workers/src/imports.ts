import { importKind, validateRows } from '../../../packages/schema/imports.mjs';
import { openWorkbook, headerColumns } from '../../../packages/engines/workbook.mjs';
import {
  isBlankRow,
  mapRow,
  reconcile,
  resolveMapping,
  rowPasses,
} from '../../../packages/engines/import-mapping.mjs';
import {
  decideAction,
  existingRecords,
  resolveReferences,
  upsertMasters,
} from '../../../packages/schema/masters-db.mjs';
import { GROUPED_IMPORTS, groupRows } from '../../../packages/schema/plant-model.mjs';
import {
  bomAction,
  checkBoms,
  checkResources,
  checkRoutings,
  plantScope,
  resourceAction,
  routingAction,
  writeBom,
  writeResource,
  writeRouting,
} from '../../../packages/schema/plant-model-db.mjs';
import { MOVEMENT_PERMISSIONS, ORDER_IMPORTS } from '../../../packages/schema/demand-stock.mjs';
import {
  checkDemandHistory,
  checkMovements,
  checkOrders,
  checkProductionOrders,
  checkStockLocations,
  orderAction,
  postMovements,
  stockLocationAction,
  writeDemandHistory,
  writeOrder,
  writeProductionOrders,
  writeStockLocation,
} from '../../../packages/schema/demand-stock-db.mjs';
import {
  bufferSettingAction,
  checkBufferSettings,
  writeBufferSettings,
} from '../../../packages/schema/planning-db.mjs';
import type { PoolClient } from 'pg';

const PAGE = 5000;
const CHUNK = 1000;

// Documents imported as one row per line: BOMs, routings, customer orders and purchase orders.
const DOCUMENTS: Record<string, any> = { ...GROUPED_IMPORTS, ...ORDER_IMPORTS };
const isOrder = (kind: string) => kind === 'sales_orders' || kind === 'purchase_orders';
const today = () => new Date().toISOString().slice(0, 10);
const PERMISSION_LABELS: Record<string, string> = {
  'inventory.adjust': 'Post opening stock, adjustments and reversals',
  'inventory.move': 'Post stock receipts and issues',
  'orders.update': 'Edit and cancel customer orders',
};

// Permissions of the uploader; null means platform access (every permission).
async function actorPermissions(db: PoolClient, actorId: string | null) {
  if (!actorId) return null;
  return new Set<string>(
    (
      await db.query(
        'SELECT rp.permission_code FROM app_users u JOIN role_permissions rp ON rp.role_id=u.role_id WHERE u.id=$1 AND u.active',
        [actorId],
      )
    ).rows.map((r) => r.permission_code),
  );
}

type Payload = { batchId: string; actorId: string | null; actorSubject: string | null };
type Result = { line: number; value: any; errors: { column: string; message: string }[] };

async function lockBatch(db: PoolClient, batchId: string, status: string) {
  const batch = (await db.query('SELECT * FROM import_batches WHERE id=$1 FOR UPDATE', [batchId]))
    .rows[0];
  // A cancelled, re-queued or already finished batch makes a replayed job a no-op.
  return batch && batch.status === status ? batch : null;
}

async function stagedRows(db: PoolClient, batchId: string, column: 'data' | 'value') {
  const rows: { line: number; payload: any }[] = [];
  for (let after = 0; ; ) {
    const page = (
      await db.query(
        `SELECT line_no,${column} AS payload FROM import_rows WHERE batch_id=$1 AND line_no>$2 ${column === 'value' ? 'AND value IS NOT NULL' : ''} ORDER BY line_no LIMIT $3`,
        [batchId, after, PAGE],
      )
    ).rows;
    for (const r of page) rows.push({ line: r.line_no, payload: r.payload });
    if (page.length < PAGE) break;
    after = page[page.length - 1].line_no;
  }
  return rows;
}

// Units predate the generic masters layer and keep their original comparison rules.
async function unitActions(db: PoolClient, results: Result[]) {
  const keys = results.filter((r) => !r.errors.length).map((r) => r.value.code.toLowerCase());
  const existing = new Map<string, any>();
  for (let i = 0; i < keys.length; i += CHUNK)
    for (const row of (
      await db.query('SELECT code,name,decimals FROM units WHERE lower(code)=ANY($1::text[])', [
        keys.slice(i, i + CHUNK),
      ])
    ).rows)
      existing.set(row.code.toLowerCase(), row);
  return results.map((r) => {
    if (r.errors.length) return null;
    const old = existing.get(r.value.code.toLowerCase());
    return !old
      ? 'create'
      : old.name === r.value.name && old.decimals === r.value.decimals
        ? 'unchanged'
        : 'update';
  });
}

async function resourceActions(db: PoolClient, results: Result[], actorId: string | null) {
  const rows = results.map((r) => ({ ...r, existing: null as any }));
  await checkResources(
    db,
    rows.filter((r) => !r.errors.length),
    await plantScope(db, actorId),
  );
  return rows.map((r, i) => {
    results[i].errors = r.errors;
    return r.errors.length ? null : resourceAction(r.value, r.existing);
  });
}

type Doc = { value: any; errors: { column: string; message: string }[]; existing?: any };

// Groups row results into BOM/routing documents. A document with any error blocks all its rows.
async function groupedDocuments(
  db: PoolClient,
  kind: string,
  staged: { line: number; data: Record<string, string> }[],
  results: Result[],
  actorId: string | null,
) {
  const def = DOCUMENTS[kind];
  const byLine = new Map(results.map((r) => [r.line, r]));
  const docs: { doc: Doc; rows: Result[] }[] = [];
  for (const group of groupRows(def, staged)) {
    const rows = group.rows.map((r) => byLine.get(r.line)!);
    for (const [line, message] of group.mismatch)
      byLine.get(line)!.errors.push({ column: '*', message });
    const doc: Doc = { value: null, errors: [] };
    if (!rows.some((r) => r.errors.length)) {
      const checked = def.validate({
        ...rows[0].value,
        [def.linesKey]: rows.map((r) => r.value),
      });
      doc.value = checked.value;
      doc.errors.push(...checked.errors);
    }
    docs.push({ doc, rows });
  }
  const valid = docs.filter((d) => d.doc.value && !d.doc.errors.length).map((d) => d.doc);
  if (kind === 'boms') await checkBoms(db, valid);
  else if (isOrder(kind)) await checkOrders(db, kind, valid, await plantScope(db, actorId));
  else await checkRoutings(db, valid, await plantScope(db, actorId));
  return docs;
}

function markDocumentErrors(docs: { doc: Doc; rows: Result[] }[]) {
  for (const { doc, rows } of docs) {
    const first = rows[0];
    first.errors.push(...doc.errors);
    const failing = rows.find((r) => r.errors.length);
    if (failing)
      for (const r of rows)
        if (!r.errors.length)
          r.errors.push({
            column: '*',
            message: `This document has errors; see line ${failing.line}. Nothing from it will be saved.`,
          });
  }
}

async function masterActions(db: PoolClient, kind: string, results: Result[]) {
  const def = importKind(kind)!;
  await resolveReferences(db, kind, results);
  const valid = results.filter((r) => !r.errors.length);
  const existing = await existingRecords(db, kind, valid);
  return results.map((r) =>
    r.errors.length ? null : decideAction(kind, r.value, existing.get(def.key!(r.value))),
  );
}

// Validation is deterministic over the staged rows and current records, so retries converge.
// AV-12: a batch read from an uploaded workbook stages its own rows the first time it is
// validated. The mapping is applied here rather than in the request, because a real export runs
// to hundreds of thousands of rows.
const MAX_WORKBOOK_ROWS = 300000;
const MAX_SHEET_ROWS = MAX_WORKBOOK_ROWS + 1000;
async function stageFromFile(db: PoolClient, batch: any) {
  const already = (
    await db.query('SELECT count(*)::int AS n FROM import_rows WHERE batch_id=$1', [batch.id])
  ).rows[0].n;
  if (already) return Number(batch.source_rows ?? already);
  const file = (await db.query('SELECT content FROM import_files WHERE id=$1', [batch.file_id]))
    .rows[0];
  if (!file) throw Error('The uploaded file is no longer available');
  const mapping = batch.mapping ?? {};
  const headerRow = Number(batch.header_row ?? 1);
  const firstDataRow = Number(mapping.firstDataRow ?? headerRow + 1);
  const options = mapping.options ?? {};
  const workbook = openWorkbook(file.content, { maxRows: MAX_SHEET_ROWS });
  const filters = mapping.options?.filters ?? [];
  const removedBy = new Map<string, number>();
  // A sales export carries one row per invoice line; a demand history holds one row per day. When
  // the mapping says so, rows that repeat the same key are added up here, and the count of what
  // was combined is reported rather than lost.
  const combineBy: string[] = mapping.options?.combine ?? [];
  const sumField: string = mapping.options?.sum ?? '';
  // Stock rows carry no reference of their own, but the fields that make a row unique do: the
  // reference is built from them, so the same file imported twice cannot post the same stock twice.
  const referenceFrom: string[] = mapping.options?.referenceFrom ?? [];
  const combined = new Map<string, { row: number; values: Record<string, string>; rows: number }>();
  let combinedAway = 0;
  let resolved: any = null,
    sourceRows = 0,
    dataRows = 0,
    blankRows = 0,
    staged = 0;
  let lines: number[] = [],
    data: string[] = [];
  const flush = async () => {
    if (!lines.length) return;
    await db.query(
      `INSERT INTO import_rows(tenant_id,batch_id,line_no,data,source_row)
       SELECT $1,$2,v.line,v.data,v.line FROM unnest($3::int[],$4::jsonb[]) AS v(line,data)`,
      [batch.tenant_id, batch.id, lines, data],
    );
    lines = [];
    data = [];
  };
  for (const row of workbook.rows(batch.sheet || undefined)) {
    sourceRows++;
    if (row.row === headerRow) {
      resolved = resolveMapping(mapping, headerColumns(row.cells));
      if (resolved.problems.length)
        throw Error(
          `The mapping no longer fits this sheet: ${resolved.problems
            .map((p: any) => `${p.field}: ${p.message}`)
            .join(' ')}`,
        );
      continue;
    }
    if (row.row < firstDataRow || !resolved) continue;
    dataRows++;
    // SAP pads its sheets; an empty row is not an error, it is nothing at all.
    if (options.skipBlankRows !== false && isBlankRow(row.cells)) {
      blankRows++;
      continue;
    }
    const mapped = mapRow(resolved, row.cells, options);
    // Rows the mapping deliberately leaves out — another plant, a subtotal line, stock at zero —
    // are counted against the rule that removed them.
    const passes = rowPasses(mapped.values, filters);
    if (!passes.ok) {
      removedBy.set(passes.rule!, (removedBy.get(passes.rule!) ?? 0) + 1);
      continue;
    }
    if (referenceFrom.length)
      // The reference is a key, not a value: the fields are joined with a slash and anything a
      // reference may not carry becomes an underscore, so it stays the same on every import.
      mapped.values.external_ref = referenceFrom
        .map((f) =>
          String(mapped.values[f] ?? '')
            .trim()
            .replace(/[^A-Za-z0-9._-]+/g, '_'),
        )
        .join('/')
        .slice(0, 60);
    const payload: Record<string, unknown> = { ...mapped.values };
    if (mapped.issues.length)
      payload._mappingIssue = mapped.issues
        .map((i: any) => `${i.message} (column ${i.column})`)
        .join(' ');
    if (combineBy.length && !mapped.issues.length) {
      const key = combineBy.map((f) => String(mapped.values[f] ?? '').toLowerCase()).join('\u0000');
      const seen = combined.get(key);
      if (seen) {
        seen.rows++;
        combinedAway++;
        if (sumField)
          seen.values[sumField] = String(
            (Number(seen.values[sumField]) || 0) + (Number(mapped.values[sumField]) || 0),
          );
        continue;
      }
      combined.set(key, { row: row.row, values: { ...mapped.values }, rows: 1 });
      continue;
    }
    lines.push(row.row);
    data.push(JSON.stringify(payload));
    staged++;
    if (lines.length >= CHUNK) await flush();
  }
  // The combined rows are staged in the order their first source row appeared.
  for (const entry of combined.values()) {
    lines.push(entry.row);
    data.push(JSON.stringify(entry.values));
    staged++;
    if (lines.length >= CHUNK) await flush();
  }
  await flush();
  if (staged > MAX_WORKBOOK_ROWS)
    throw Error(
      `Sheet "${batch.sheet}" carries more than ${MAX_WORKBOOK_ROWS.toLocaleString('en-IN')} rows for this import. Split the export and import it in parts.`,
    );
  if (!staged)
    throw Error(
      `Sheet "${batch.sheet}" has no data rows under row ${headerRow}. Check the header row and the sheet.`,
    );
  await db.query('UPDATE import_batches SET total_rows=$2,source_rows=$3 WHERE id=$1', [
    batch.id,
    staged,
    sourceRows,
  ]);
  batch.total_rows = staged;
  batch.source_rows = sourceRows;
  batch.reading = {
    sheetRows: sourceRows,
    dataRows,
    blankRows,
    combined: combinedAway,
    filtered: [...removedBy.entries()].map(([rule, count]) => ({ rule, count })),
  };
  return batch.reading;
}

export async function validateImport(db: PoolClient, payload: Payload) {
  const batch = await lockBatch(db, payload.batchId, 'validating');
  if (!batch) return;
  if (!importKind(batch.kind)) throw Error('Unsupported import kind');
  if (batch.file_id) await stageFromFile(db, batch);
  const staged = (await stagedRows(db, batch.id, 'data')).map(({ line, payload: data }) => {
    const { _columnCountError, _mappingIssue, ...rest } = data;
    return { line, data: rest, columnCountError: _columnCountError ?? _mappingIssue };
  });
  const results: Result[] = validateRows(batch.kind, staged);
  const summary: Record<string, number> = { create: 0, update: 0, unchanged: 0 };
  let actions: (string | null)[];
  if (batch.kind === 'units') actions = await unitActions(db, results);
  else if (batch.kind === 'resources')
    actions = await resourceActions(db, results, payload.actorId);
  else if (DEMAND_STOCK_ROWS.has(batch.kind))
    actions = await demandStockActions(db, batch.kind, results, payload.actorId);
  else if (DOCUMENTS[batch.kind]) {
    const docs = await groupedDocuments(db, batch.kind, staged, results, payload.actorId);
    const permissions = await actorPermissions(db, payload.actorId);
    const actionOf = new Map<Doc, string>();
    for (const { doc, rows } of docs) {
      if (!doc.value || doc.errors.length || rows.some((r) => r.errors.length)) continue;
      const action =
        batch.kind === 'boms'
          ? await bomAction(db, doc)
          : isOrder(batch.kind)
            ? await orderAction(db, batch.kind, doc)
            : await routingAction(db, doc);
      // Changing an existing customer order needs edit permission, not just create.
      if (
        action === 'update' &&
        batch.kind === 'sales_orders' &&
        permissions &&
        !permissions.has('orders.update')
      )
        doc.errors.push({
          column: 'order_no',
          message: `Order ${doc.value.order_no} already exists and would change. You need the "${PERMISSION_LABELS['orders.update']}" permission.`,
        });
      else actionOf.set(doc, action);
    }
    markDocumentErrors(docs);
    const byLine = new Map<number, string>();
    for (const { doc, rows } of docs) {
      const action = actionOf.get(doc);
      if (!action || rows.some((r) => r.errors.length)) continue;
      summary[action]++;
      for (const r of rows) byLine.set(r.line, action);
    }
    actions = results.map((r) => (r.errors.length ? null : (byLine.get(r.line) ?? null)));
  } else actions = await masterActions(db, batch.kind, results);
  // Grouped imports count documents; other imports count rows.
  if (!DOCUMENTS[batch.kind]) for (const a of actions) if (a) summary[a]++;
  for (let i = 0; i < results.length; i += CHUNK) {
    const part = results.slice(i, i + CHUNK);
    await db.query(
      'UPDATE import_rows r SET errors=v.errors,value=v.value,action=v.action FROM unnest($2::int[],$3::jsonb[],$4::jsonb[],$5::text[]) AS v(line_no,errors,value,action) WHERE r.batch_id=$1 AND r.line_no=v.line_no',
      [
        batch.id,
        part.map((r) => r.line),
        part.map((r) => JSON.stringify(r.errors)),
        part.map((r) => (r.errors.length ? null : JSON.stringify(r.value))),
        actions.slice(i, i + CHUNK),
      ],
    );
  }
  const errorRows = results.filter((r) => r.errors.length).length;
  // What the file had, what was read from it and what was left out: the reconciliation a person
  // reads before committing. Quantities are totalled per unit, never across units.
  const columns = importKind(batch.kind)!.columns;
  const reading = batch.reading ?? {};
  const report = batch.file_id
    ? {
        ...reconcile({
          // Everything under the header row: what was mapped, left blank, removed by a rule or
          // rejected has to add back up to this number.
          sourceRows: Number(reading.dataRows ?? results.length),
          rows: results.map((r) => ({ values: r.value ?? {}, errors: r.errors })),
          blankSkipped: Number(reading.blankRows ?? 0),
          combined: Number(reading.combined ?? 0),
          filtered: reading.filtered ?? [],
          quantityField: columns.includes('quantity') ? 'quantity' : '',
          unitField: columns.includes('unit') ? 'unit' : '',
        }),
        sheetRows: Number(reading.sheetRows ?? batch.source_rows ?? 0),
        sheet: batch.sheet,
        headerRow: batch.header_row,
        fileName: batch.file_name,
      }
    : {};
  await db.query(
    "UPDATE import_batches SET status='validated',valid_rows=$2,error_rows=$3,summary=$4,reconciliation=$5,validated_at=now(),error=NULL,version=version+1 WHERE id=$1",
    [
      batch.id,
      results.length - errorRows,
      errorRows,
      JSON.stringify(summary),
      JSON.stringify(report),
    ],
  );
}

async function markFailed(db: PoolClient, batchId: string, message: string) {
  await db.query(
    "UPDATE import_batches SET status='failed',error=$2,version=version+1 WHERE id=$1",
    [batchId, message],
  );
}

export async function commitImport(db: PoolClient, payload: Payload) {
  const batch = await lockBatch(db, payload.batchId, 'committing');
  if (!batch) return;
  if (!importKind(batch.kind)) throw Error('Unsupported import kind');
  if (batch.error_rows > 0) throw Error('Batch has errors');
  const sameFile = (
    await db.query(
      "SELECT batch_no FROM import_batches WHERE kind=$1 AND file_sha256=$2 AND status='committed' AND id<>$3",
      [batch.kind, batch.file_sha256, batch.id],
    )
  ).rows[0];
  if (sameFile)
    return markFailed(
      db,
      batch.id,
      `This exact file was already imported as batch #${sameFile.batch_no}. Nothing was changed.`,
    );
  let summary: { created: number; updated: number; unchanged: number };
  if (batch.kind === 'units') {
    // Upsert in line order; unchanged rows are skipped by the WHERE clause, so replays add nothing.
    const written = (
      await db.query(
        `INSERT INTO units(id,tenant_id,code,name,decimals)
         SELECT gen_random_uuid(),r.tenant_id,r.value->>'code',r.value->>'name',(r.value->>'decimals')::smallint
         FROM import_rows r WHERE r.batch_id=$1 AND r.value IS NOT NULL ORDER BY r.line_no
         ON CONFLICT (tenant_id,lower(code)) DO UPDATE SET name=excluded.name,decimals=excluded.decimals,version=units.version+1,updated_at=now()
         WHERE (units.name,units.decimals) IS DISTINCT FROM (excluded.name,excluded.decimals)
         RETURNING (xmax=0) AS inserted`,
        [batch.id],
      )
    ).rows;
    const created = written.filter((r) => r.inserted).length;
    summary = {
      created,
      updated: written.length - created,
      unchanged: batch.valid_rows - written.length,
    };
  } else if (DEMAND_STOCK_ROWS.has(batch.kind)) {
    const counts = await commitDemandStock(db, batch, payload);
    if (!counts) return;
    summary = counts;
  } else if (batch.kind === 'resources' || DOCUMENTS[batch.kind]) {
    const counts = await commitPlantModel(db, batch, payload);
    if (!counts) return;
    summary = counts;
  } else {
    // References are re-checked against current data: a unit or supplier deactivated after
    // validation must not be written silently.
    const rows: Result[] = (await stagedRows(db, batch.id, 'value')).map((r) => ({
      line: r.line,
      value: r.payload,
      errors: [],
    }));
    await resolveReferences(db, batch.kind, rows);
    const changed = rows.filter((r) => r.errors.length);
    if (changed.length)
      return markFailed(
        db,
        batch.id,
        `Data changed after validation (line ${changed[0].line}: ${changed[0].errors[0].message}). Retry validation, then commit again. Nothing was changed.`,
      );
    summary = await upsertMasters(
      db,
      batch.kind,
      batch.tenant_id,
      rows.map((r) => r.value),
    );
  }
  await db.query(
    "UPDATE import_batches SET status='committed',summary=$2,committed_at=now(),version=version+1 WHERE id=$1",
    [batch.id, JSON.stringify(summary)],
  );
  await db.query(
    "INSERT INTO audit_log(tenant_id,actor_id,action,entity_type,entity_id,details,actor_subject) VALUES($1,$2,'import.committed','import',$3,$4,$5)",
    [
      batch.tenant_id,
      payload.actorId,
      batch.id,
      JSON.stringify({ after: { kind: batch.kind, batchNo: batch.batch_no, ...summary } }),
      payload.actorSubject,
    ],
  );
}

// Re-checks plant access and references at commit time, then writes resources or whole documents.
async function commitPlantModel(db: PoolClient, batch: any, payload: Payload) {
  const staged = await stagedRows(db, batch.id, 'value');
  const scope = await plantScope(db, payload.actorId);
  const counts = { created: 0, updated: 0, unchanged: 0 };
  const failWith = async (line: number, message: string) => {
    await markFailed(
      db,
      batch.id,
      `Data changed after validation (line ${line}: ${message}). Retry validation, then commit again. Nothing was changed.`,
    );
    return null;
  };
  if (batch.kind === 'resources') {
    const rows = staged.map((r) => ({
      line: r.line,
      value: r.payload,
      errors: [] as any[],
      existing: null as any,
    }));
    await checkResources(db, rows, scope);
    const bad = rows.find((r) => r.errors.length);
    if (bad) return failWith(bad.line, bad.errors[0].message);
    for (const r of rows) {
      const action = resourceAction(r.value, r.existing);
      if (action === 'unchanged') counts.unchanged++;
      else {
        await writeResource(db, batch.tenant_id, r.value, r.existing, true);
        counts[action === 'create' ? 'created' : 'updated']++;
      }
    }
    return counts;
  }
  const def = DOCUMENTS[batch.kind];
  const groups = new Map<string, { line: number; value: any }[]>();
  for (const r of staged) {
    const key = def.groupKey(r.payload);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ line: r.line, value: r.payload });
  }
  const docs = [...groups.values()].map((rows) => ({
    line: rows[0].line,
    ...(def.validate({ ...rows[0].value, [def.linesKey]: rows.map((r) => r.value) }) as Doc),
  }));
  const bad = docs.find((d) => d.errors.length);
  if (bad) return failWith(bad.line, bad.errors[0].message);
  if (batch.kind === 'boms') await checkBoms(db, docs);
  else if (isOrder(batch.kind)) await checkOrders(db, batch.kind, docs, scope);
  else await checkRoutings(db, docs, scope);
  const changed = docs.find((d) => d.errors.length);
  if (changed) return failWith(changed.line, changed.errors[0].message);
  for (const doc of docs) {
    const action =
      batch.kind === 'boms'
        ? await bomAction(db, doc)
        : isOrder(batch.kind)
          ? await orderAction(db, batch.kind, doc)
          : await routingAction(db, doc);
    if (action === 'unchanged') counts.unchanged++;
    else {
      if (batch.kind === 'boms') await writeBom(db, batch.tenant_id, doc);
      else if (isOrder(batch.kind)) await writeOrder(db, batch.kind, batch.tenant_id, doc);
      else await writeRouting(db, batch.tenant_id, doc);
      counts[action === 'create' ? 'created' : 'updated']++;
    }
  }
  return counts;
}

// ---------- Stock locations, stock movements and demand history (one record per row) ----------

const DEMAND_STOCK_ROWS = new Set([
  'stock_locations',
  'stock_movements',
  'demand_history',
  'buffer_settings',
  'production_orders',
]);

async function checkDemandStockRows(
  db: PoolClient,
  kind: string,
  rows: (Result & { existing?: any; action?: string })[],
  actorId: string | null,
) {
  const scope = await plantScope(db, actorId);
  if (kind === 'buffer_settings') {
    await checkBufferSettings(db, rows, scope);
    for (const r of rows) if (!r.errors.length) r.action = bufferSettingAction(r.value, r.existing);
  } else if (kind === 'stock_locations') {
    await checkStockLocations(db, rows, scope);
    for (const r of rows) if (!r.errors.length) r.action = stockLocationAction(r.value, r.existing);
  } else if (kind === 'demand_history')
    await checkDemandHistory(db, rows, scope, { today: today() });
  else if (kind === 'production_orders') await checkProductionOrders(db, rows, scope);
  else {
    // Opening stock and adjustments need more authority than receipts and issues.
    const permissions = await actorPermissions(db, actorId);
    for (const r of rows) {
      const needed =
        MOVEMENT_PERMISSIONS[r.value.movement_type as keyof typeof MOVEMENT_PERMISSIONS];
      if (!r.errors.length && permissions && needed && !permissions.has(needed))
        r.errors.push({
          column: 'movement_type',
          message: `${r.value.movement_type} rows need the "${PERMISSION_LABELS[needed]}" permission.`,
        });
    }
    await checkMovements(db, rows, scope, { today: today() });
    for (const r of rows) if (!r.errors.length) r.action = r.existing ? 'unchanged' : 'create';
  }
  return rows;
}

async function demandStockActions(
  db: PoolClient,
  kind: string,
  results: Result[],
  actorId: string | null,
) {
  const rows = results.map((r) => ({ ...r, existing: null as any, action: undefined as any }));
  await checkDemandStockRows(db, kind, rows, actorId);
  return rows.map((r, i) => {
    results[i].errors = r.errors;
    return r.errors.length ? null : r.action;
  });
}

async function commitDemandStock(db: PoolClient, batch: any, payload: Payload) {
  const rows = (await stagedRows(db, batch.id, 'value')).map((r) => ({
    line: r.line,
    value: r.payload,
    errors: [] as { column: string; message: string }[],
    existing: null as any,
    action: undefined as any,
  }));
  await checkDemandStockRows(db, batch.kind, rows, payload.actorId);
  const bad = rows.find((r) => r.errors.length);
  if (bad) {
    await markFailed(
      db,
      batch.id,
      `Data changed after validation (line ${bad.line}: ${bad.errors[0].message}). Retry validation, then commit again. Nothing was changed.`,
    );
    return null;
  }
  if (batch.kind === 'production_orders')
    return writeProductionOrders(
      db,
      batch.tenant_id,
      rows.filter((r) => r.action !== 'unchanged').map((r) => r.value),
    ).then((c) => ({
      ...c,
      unchanged: c.unchanged + rows.filter((r) => r.action === 'unchanged').length,
    }));
  if (batch.kind === 'demand_history')
    return writeDemandHistory(
      db,
      batch.tenant_id,
      rows.map((r) => r.value),
    );
  const counts = { created: 0, updated: 0, unchanged: 0 };
  if (batch.kind === 'buffer_settings') {
    const changed = rows.filter((r) => r.action !== 'unchanged');
    await writeBufferSettings(
      db,
      batch.tenant_id,
      changed.map((r) => r.value),
    );
    for (const r of rows)
      counts[r.action === 'create' ? 'created' : r.action === 'update' ? 'updated' : 'unchanged']++;
    return counts;
  }
  if (batch.kind === 'stock_locations') {
    for (const r of rows) {
      if (r.action === 'unchanged') counts.unchanged++;
      else {
        await writeStockLocation(db, batch.tenant_id, r.value, r.existing, true);
        counts[r.action === 'create' ? 'created' : 'updated']++;
      }
    }
    return counts;
  }
  const fresh = rows.filter((r) => r.action === 'create').map((r) => r.value);
  // A concurrent issue elsewhere can still empty the stock; the savepoint keeps the failure status.
  await db.query('SAVEPOINT post_movements');
  try {
    await postMovements(
      db,
      batch.tenant_id,
      { id: payload.actorId, subject: payload.actorSubject },
      fresh,
      batch.id,
    );
  } catch (e: any) {
    if (e?.constraint !== 'stock_not_negative') throw e;
    await db.query('ROLLBACK TO SAVEPOINT post_movements');
    await markFailed(
      db,
      batch.id,
      'Data changed after validation: stock was used elsewhere and a movement would take it below zero. Retry validation, then commit again. Nothing was changed.',
    );
    return null;
  }
  return { created: fresh.length, updated: 0, unchanged: rows.length - fresh.length };
}

// Called once retries are exhausted: surface a clear status instead of a batch stuck in progress.
export async function failImport(db: PoolClient, payload: Payload, kind: string) {
  await db.query(
    "UPDATE import_batches SET status='failed',error=$2,version=version+1 WHERE id=$1 AND status=$3",
    [
      payload.batchId,
      kind === 'import.commit'
        ? 'Saving did not finish and nothing was changed. Retry validation, then commit again.'
        : 'Validation did not finish. Retry validation. If it fails again, contact support with the batch number.',
      kind === 'import.commit' ? 'committing' : 'validating',
    ],
  );
}
