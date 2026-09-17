import pg from 'pg';
import { Queue, Worker, createNodeRedisClient } from 'bullmq';
import { createClient } from 'redis';
import { commitImport, failImport, validateImport } from './imports.js';
const env = process.env;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5, statement_timeout: 30000 });
const redis = createClient({ url: env.REDIS_URL });
redis.on('error', () => console.error('Worker Redis unavailable'));
await redis.connect();
const connection = createNodeRedisClient(redis);
const queue = new Queue('rare-foundation', { connection });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTEMPTS = 5;

// Every event runs inside its own company's RLS context; the runtime role never bypasses RLS.
async function tx<T>(tenant: string, run: (db: pg.PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
    const r = await run(db);
    await db.query('COMMIT');
    return r;
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}

const handlers: Record<string, (db: pg.PoolClient, payload: any) => Promise<void>> = {
  'foundation.seeded': async () => {},
  'import.validate': validateImport,
  'import.commit': commitImport,
};

const worker = new Worker(
  'rare-foundation',
  async (job) => {
    const { tenantId, eventId } = job.data;
    if (!uuid.test(tenantId) || !Number.isInteger(eventId)) throw Error('Invalid job');
    await tx(tenantId, async (db) => {
      const event = (
        await db.query('SELECT kind,payload FROM outbox_events WHERE id=$1', [eventId])
      ).rows[0];
      if (!event || event.kind !== job.name) throw Error('Event not found for this company');
      const handler = handlers[event.kind];
      if (!handler) throw Error('Unsupported event');
      // The ledger insert and the business change commit together, so a replay is skipped.
      const claimed = await db.query(
        'INSERT INTO processed_events(tenant_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [tenantId, eventId],
      );
      if (!claimed.rowCount) return;
      await handler(db, event.payload);
    });
  },
  { connection, concurrency: 2 },
);
worker.on('failed', (job, error) => {
  console.error(
    JSON.stringify({
      event: 'job.failed',
      jobId: job?.id,
      kind: job?.name,
      attempt: job?.attemptsMade,
      error: error.message.slice(0, 200),
    }),
  );
  if (!job || job.attemptsMade < ATTEMPTS || !job.name.startsWith('import.')) return;
  void tx(job.data.tenantId, async (db) => {
    const event = (
      await db.query('SELECT payload FROM outbox_events WHERE id=$1', [job.data.eventId])
    ).rows[0];
    if (event) await failImport(db, event.payload, job.name);
  }).catch(() => console.error('Could not record failed import status'));
});

let stopping = false,
  dispatching = false;
async function dispatch() {
  if (stopping || dispatching) return;
  dispatching = true;
  try {
    const events = (await pool.query('SELECT id,tenant_id,kind FROM outbox_pending(200)')).rows;
    for (const e of events) {
      await queue.add(
        e.kind,
        { tenantId: e.tenant_id, eventId: Number(e.id) },
        {
          jobId: 'outbox-' + e.id,
          attempts: ATTEMPTS,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { count: 1000 },
        },
      );
      await tx(e.tenant_id, (db) =>
        db.query('UPDATE outbox_events SET delivered_at=now() WHERE id=$1', [e.id]),
      );
    }
    await redis.set('rare:worker:heartbeat', new Date().toISOString(), { EX: 20 });
  } catch {
    console.error('Outbox dispatch unavailable; retrying shortly');
  } finally {
    dispatching = false;
  }
}
await dispatch();
const timer = setInterval(dispatch, 1000);
console.log('Availability worker ready: outbox dispatch and import jobs for all companies.');
for (const sig of ['SIGTERM', 'SIGINT'])
  process.once(sig, async () => {
    stopping = true;
    clearInterval(timer);
    await worker.close();
    await queue.close();
    await redis.quit();
    await pool.end();
    process.exit(0);
  });
