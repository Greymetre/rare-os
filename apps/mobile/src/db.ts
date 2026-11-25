// RCH-8: where a day lives while there is no network.
//
// The acceptance test closes the app and reopens it before anything has been sent, so none of
// this may live in memory. The handover names "a local SQLite ... and an outbox sync", and that
// is what this is: `expo-sqlite`, used directly, because what it is asked to do is small —
// two tables, read all, write a row, replace a row.
//
// Two things are kept, and they are kept for different reasons:
//
//   `outbox` — the rep's unsent work. Losing a row here loses a real order, so every write goes
//              through a transaction and the row is only ever replaced whole.
//   `day`    — what was downloaded before the rep left coverage, so the round can be worked with
//              no signal. Losing it costs a round-trip, nothing more.
//
// The refresh token is deliberately **not** here. It lives in the operating system's keystore
// (see `auth.ts`), which a database file cannot offer. That is one thing a real app can do that
// the browser version could not.

import * as SQLite from 'expo-sqlite';

// A queued piece of work, in the shape `packages/engines/sync-queue.mjs` creates and reads. The
// engine owns this shape; this file only knows how to put it in a table and take it back out.
export type Queued = {
  localId: string;
  kind: string;
  seq: number;
  payload: Record<string, unknown>;
  clientRef: string;
  state: 'QUEUED' | 'SENT' | 'BLOCKED';
  attempts: number;
  retryAfter: number;
  createdAt: number;
  sentAt: number | null;
  serverId: string | null;
  lastError: string;
  lastCode: string;
  // Only a photo has these. The bytes stay on the filesystem where the camera left them; copying
  // a few megabytes of JPEG into SQLite to read it straight back out again would be pointless.
  fileUri?: string | null;
  contentType?: string | null;
  needsSignIn?: boolean;
};

type Row = {
  local_id: string;
  kind: string;
  seq: number;
  payload: string;
  client_ref: string;
  state: string;
  attempts: number;
  retry_after: number;
  created_at: number;
  sent_at: number | null;
  server_id: string | null;
  last_error: string;
  last_code: string;
  file_uri: string | null;
  content_type: string | null;
};

let opening: Promise<SQLite.SQLiteDatabase> | null = null;

async function open(): Promise<SQLite.SQLiteDatabase> {
  if (!opening) {
    opening = (async () => {
      const db = await SQLite.openDatabaseAsync('rare-field.db');
      // WAL so that a write interrupted by the operating system killing a backgrounded app
      // cannot leave a torn row. This is the whole reason a day's work is in SQLite and not a
      // JSON file.
      await db.execAsync('PRAGMA journal_mode = WAL;');
      await db.execAsync(`
        CREATE TABLE IF NOT EXISTS outbox (
          local_id     TEXT PRIMARY KEY NOT NULL,
          kind         TEXT NOT NULL,
          seq          INTEGER NOT NULL DEFAULT 0,
          payload      TEXT NOT NULL DEFAULT '{}',
          client_ref   TEXT NOT NULL,
          state        TEXT NOT NULL DEFAULT 'QUEUED',
          attempts     INTEGER NOT NULL DEFAULT 0,
          retry_after  INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER NOT NULL,
          sent_at      INTEGER,
          server_id    TEXT,
          last_error   TEXT NOT NULL DEFAULT '',
          last_code    TEXT NOT NULL DEFAULT '',
          file_uri     TEXT,
          content_type TEXT
        );
        CREATE TABLE IF NOT EXISTS day (
          key   TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);
      return db;
    })();
  }
  return opening;
}

function toItem(row: Row): Queued {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  return {
    localId: row.local_id,
    kind: row.kind,
    seq: row.seq,
    payload,
    clientRef: row.client_ref,
    state: row.state as Queued['state'],
    attempts: row.attempts,
    retryAfter: row.retry_after,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    serverId: row.server_id,
    lastError: row.last_error,
    lastCode: row.last_code,
    fileUri: row.file_uri,
    contentType: row.content_type,
  };
}

// Oldest first. The engine decides what may go, but it is handed the queue in the order the rep
// did the work, because that is the order it has to go up in.
export async function allItems(): Promise<Queued[]> {
  const db = await open();
  const rows = await db.getAllAsync<Row>('SELECT * FROM outbox ORDER BY seq ASC, created_at ASC');
  return rows.map(toItem);
}

// Every item that changed in one pass, written in one transaction. Half a pass on disk is how a
// queue ends up with an order whose check-in it no longer knows about.
export async function putItems(items: Queued[]): Promise<void> {
  if (!items.length) return;
  const db = await open();
  await db.withExclusiveTransactionAsync(async (tx) => {
    for (const i of items) {
      await tx.runAsync(
        `INSERT INTO outbox (local_id, kind, seq, payload, client_ref, state, attempts,
                             retry_after, created_at, sent_at, server_id, last_error, last_code,
                             file_uri, content_type)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(local_id) DO UPDATE SET
           kind = excluded.kind, seq = excluded.seq, payload = excluded.payload,
           client_ref = excluded.client_ref, state = excluded.state, attempts = excluded.attempts,
           retry_after = excluded.retry_after, sent_at = excluded.sent_at,
           server_id = excluded.server_id, last_error = excluded.last_error,
           last_code = excluded.last_code, file_uri = excluded.file_uri,
           content_type = excluded.content_type`,
        [
          i.localId,
          i.kind,
          i.seq ?? 0,
          JSON.stringify(i.payload ?? {}),
          i.clientRef,
          i.state,
          i.attempts ?? 0,
          i.retryAfter ?? 0,
          i.createdAt,
          i.sentAt ?? null,
          i.serverId ?? null,
          i.lastError ?? '',
          i.lastCode ?? '',
          i.fileUri ?? null,
          i.contentType ?? null,
        ],
      );
    }
  });
}

// The next sequence number, read from storage rather than from React state. Two pushes inside one
// handler — a photo and the check-in that carries it — would otherwise be given the same number
// and the queue would have no way to tell which the rep did first.
export async function nextSeq(): Promise<number> {
  const db = await open();
  const row = await db.getFirstAsync<{ top: number | null }>('SELECT MAX(seq) AS top FROM outbox');
  return (row?.top ?? 0) + 1;
}

// Work that has gone up and is old enough that nothing can still be waiting on it. Kept for a
// week so a rep can be shown that yesterday did arrive.
export async function forgetSettled(olderThanMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const db = await open();
  await db.runAsync('DELETE FROM outbox WHERE state = ? AND sent_at IS NOT NULL AND sent_at < ?', [
    'SENT',
    Date.now() - olderThanMs,
  ]);
}

export async function readDay<T>(key: string): Promise<T | null> {
  const db = await open();
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM day WHERE key = ?', [
    key,
  ]);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export async function writeDay(key: string, value: unknown): Promise<void> {
  const db = await open();
  await db.runAsync(
    'INSERT INTO day (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value)],
  );
}

// Signing out clears the round, never the outbox. A rep who signs out with unsent work still has
// that work when they sign back in; throwing it away to tidy up would lose real orders.
export async function clearDay(): Promise<void> {
  const db = await open();
  await db.runAsync('DELETE FROM day');
}
