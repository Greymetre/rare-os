import { permissions } from '../packages/schema/permissions.mjs';
import pg from 'pg';
import assert from 'node:assert/strict';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const tenant = '10000000-0000-4000-8000-000000000001',
  other = '10000000-0000-4000-8000-000000000099';
try {
  const counts = await db.query(
    'SELECT (SELECT count(*) FROM app_users)::int users,(SELECT count(*) FROM roles)::int roles,(SELECT count(*) FROM permissions)::int permissions',
  );
  assert.ok(counts.rows[0].users >= 1);
  assert.ok(counts.rows[0].roles >= 1);
  assert.equal(counts.rows[0].permissions, permissions.length);
  console.log('PASS seed: admin/roles preserved, current permission catalog');
  await db.query('BEGIN');
  await db.query('INSERT INTO tenants(id,name) VALUES($1,$2)', [other, 'Isolation fixture']);
  await db.query(
    "INSERT INTO audit_log(tenant_id,action,entity_type) VALUES($1,'hidden.event','test')",
    [other],
  );
  await db.query(
    "INSERT INTO audit_log(tenant_id,action,entity_type) SELECT $1,'load.fixture','test' FROM generate_series(1,100000)",
    [tenant],
  );
  await db.query('ANALYZE audit_log');
  await db.query('SET LOCAL ROLE rare_app');
  assert.equal((await db.query('SELECT * FROM tenants')).rowCount, 0);
  await db.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
  assert.equal((await db.query('SELECT * FROM tenants')).rowCount, 1);
  assert.equal((await db.query('SELECT * FROM tenants WHERE id=$1', [other])).rowCount, 0);
  assert.equal((await db.query("SELECT * FROM audit_log WHERE action='hidden.event'")).rowCount, 0);
  await db.query('SAVEPOINT denied');
  await assert.rejects(
    () =>
      db.query("INSERT INTO audit_log(tenant_id,action,entity_type) VALUES($1,'bad','test')", [
        other,
      ]),
    (e) => e.code === '42501',
  );
  await db.query('ROLLBACK TO SAVEPOINT denied');
  await db.query('SAVEPOINT deniedrole');
  await assert.rejects(
    () => db.query('DELETE FROM permissions'),
    (e) => e.code === '42501',
  );
  await db.query('ROLLBACK TO SAVEPOINT deniedrole');
  const plan = await db.query(
    'EXPLAIN (ANALYZE,FORMAT JSON) SELECT id,action,entity_type,created_at FROM audit_log ORDER BY id DESC LIMIT 26',
  );
  const txt = JSON.stringify(plan.rows[0]);
  assert.match(txt, /Index/);
  console.log('PASS tenant isolation, cross-tenant write denial, runtime privilege restrictions');
  console.log(
    'PASS 100,000-row audit query uses an index; execution ms:',
    plan.rows[0]['QUERY PLAN'][0]['Execution Time'],
  );
  await db.query('ROLLBACK');
  assert.equal((await db.query('SELECT * FROM tenants WHERE id=$1', [other])).rowCount, 0);
  console.log('PASS fixtures rolled back; customer data unchanged');
} finally {
  await db.query('ROLLBACK');
  await db.end();
}
