import pg from 'pg';
import { Queue, Worker, createNodeRedisClient } from 'bullmq';
import { createClient } from 'redis';
const env = process.env;
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 3, statement_timeout: 5000 });
const redis = createClient({ url: env.REDIS_URL });
redis.on('error', () => console.error('Worker Redis unavailable'));
await redis.connect();
const connection = createNodeRedisClient(redis);
const queue = new Queue('rare-foundation', { connection });
// Explicit single-tenant pilot. Extend through a reviewed tenant registry before multi-tenant workers.
const tenant = env.WORKER_TENANT_ID || '10000000-0000-4000-8000-000000000001';
async function tx<T>(run: (db: pg.PoolClient) => Promise<T>) {
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
const worker = new Worker(
  'rare-foundation',
  async (job) => {
    if (job.data.tenantId !== tenant) throw Error('Tenant mismatch');
    if (job.name !== 'foundation.seeded') throw Error('Unsupported event');
    await tx(async (db) => {
      await db.query(
        'INSERT INTO processed_events(tenant_id,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [tenant, job.data.eventId],
      );
    });
  },
  { connection, concurrency: 2 },
);
worker.on('failed', (job) => console.error('Foundation job failed', job?.id));
let stopping = false,
  dispatching = false;
async function dispatch() {
  if (stopping || dispatching) return;
  dispatching = true;
  try {
    const events = await tx((db) =>
      db.query('SELECT id,kind FROM outbox_events WHERE delivered_at IS NULL ORDER BY id LIMIT 50'),
    );
    for (const e of events.rows) {
      await queue.add(
        e.kind,
        { tenantId: tenant, eventId: e.id },
        {
          jobId: 'outbox-' + e.id,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { age: 86400, count: 1000 },
          removeOnFail: { count: 1000 },
        },
      );
      await tx((db) => db.query('UPDATE outbox_events SET delivered_at=now() WHERE id=$1', [e.id]));
    }
    await redis.set('rare:worker:heartbeat', new Date().toISOString(), { EX: 20 });
  } catch {
    console.error('Outbox dispatch unavailable; retrying in 5 seconds');
  } finally {
    dispatching = false;
  }
}
await dispatch();
const timer = setInterval(dispatch, 5000);
console.log('Foundation worker ready; Availability engines are not yet installed.');
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
