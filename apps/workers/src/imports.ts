import { importKind, validateRows } from '../../../packages/schema/imports.mjs';
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
import type { PoolClient } from 'pg';

const PAGE = 5000;
const CHUNK = 1000;

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
  const def = GROUPED_IMPORTS[kind];
  const byLine = new Map(results.map((r) => [r.line, r]));
  const docs: { doc: Doc; rows: Result[] }[] = [];
  for (const group of groupRows(kind, staged)) {
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
    r.errors.length ? null : decideAction(kind, r.value, existing.get(def.key(r.value))),
  );
}

// Validation is deterministic over the staged rows and current records, so retries converge.
export async function validateImport(db: PoolClient, payload: Payload) {
  const batch = await lockBatch(db, payload.batchId, 'validating');
  if (!batch) return;
  if (!importKind(batch.kind)) throw Error('Unsupported import kind');
  const staged = (await stagedRows(db, batch.id, 'data')).map(({ line, payload: data }) => {
    const { _columnCountError, ...rest } = data;
    return { line, data: rest, columnCountError: _columnCountError };
  });
  const results: Result[] = validateRows(batch.kind, staged);
  const summary: Record<string, number> = { create: 0, update: 0, unchanged: 0 };
  let actions: (string | null)[];
  if (batch.kind === 'units') actions = await unitActions(db, results);
  else if (batch.kind === 'resources')
    actions = await resourceActions(db, results, payload.actorId);
  else if (GROUPED_IMPORTS[batch.kind]) {
    const docs = await groupedDocuments(db, batch.kind, staged, results, payload.actorId);
    markDocumentErrors(docs);
    const byLine = new Map<number, string>();
    for (const { doc, rows } of docs) {
      if (rows.some((r) => r.errors.length)) continue;
      const action =
        batch.kind === 'boms' ? await bomAction(db, doc) : await routingAction(db, doc);
      summary[action]++;
      for (const r of rows) byLine.set(r.line, action);
    }
    actions = results.map((r) => (r.errors.length ? null : (byLine.get(r.line) ?? null)));
  } else actions = await masterActions(db, batch.kind, results);
  // Grouped imports count documents; other imports count rows.
  if (!GROUPED_IMPORTS[batch.kind]) for (const a of actions) if (a) summary[a]++;
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
  await db.query(
    "UPDATE import_batches SET status='validated',valid_rows=$2,error_rows=$3,summary=$4,validated_at=now(),error=NULL,version=version+1 WHERE id=$1",
    [batch.id, results.length - errorRows, errorRows, JSON.stringify(summary)],
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
  } else if (batch.kind === 'resources' || GROUPED_IMPORTS[batch.kind]) {
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
  const def = GROUPED_IMPORTS[batch.kind];
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
  else await checkRoutings(db, docs, scope);
  const changed = docs.find((d) => d.errors.length);
  if (changed) return failWith(changed.line, changed.errors[0].message);
  for (const doc of docs) {
    const action = batch.kind === 'boms' ? await bomAction(db, doc) : await routingAction(db, doc);
    if (action === 'unchanged') counts.unchanged++;
    else {
      if (batch.kind === 'boms') await writeBom(db, batch.tenant_id, doc);
      else await writeRouting(db, batch.tenant_id, doc);
      counts[action === 'create' ? 'created' : 'updated']++;
    }
  }
  return counts;
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
