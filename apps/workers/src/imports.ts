import { importKind, validateRows } from '../../../packages/schema/imports.mjs';
import {
  decideAction,
  existingRecords,
  resolveReferences,
  upsertMasters,
} from '../../../packages/schema/masters-db.mjs';
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
  const actions =
    batch.kind === 'units'
      ? await unitActions(db, results)
      : await masterActions(db, batch.kind, results);
  const summary: Record<string, number> = { create: 0, update: 0, unchanged: 0 };
  for (const a of actions) if (a) summary[a]++;
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
