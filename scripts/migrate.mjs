import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const literal = (v) => "'" + v.replaceAll("'", "''") + "'";
try {
  await db.query('SELECT pg_advisory_lock(421109)');
  for (const [role, key] of [
    ['rare_app', 'APP_DB_PASSWORD'],
    ['rare_keycloak', 'KEYCLOAK_DB_PASSWORD'],
  ]) {
    if (!process.env[key]) throw Error(key + ' is required');
    const exists = await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
    if (!exists.rowCount)
      await db.query(`CREATE ROLE ${role} LOGIN PASSWORD ${literal(process.env[key])}`);
  }
  if (!(await db.query("SELECT 1 FROM pg_database WHERE datname='keycloak'")).rowCount)
    await db.query('CREATE DATABASE keycloak OWNER rare_keycloak');
  await db.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())',
  );
  for (const file of (await readdir('db/migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = await readFile('db/migrations/' + file, 'utf8'),
      sum = createHash('sha256').update(sql).digest('hex');
    const old = await db.query('SELECT checksum FROM schema_migrations WHERE name=$1', [file]);
    if (old.rowCount) {
      if (old.rows[0].checksum !== sum) throw Error('Applied migration changed: ' + file);
      continue;
    }
    await db.query('BEGIN');
    try {
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)', [file, sum]);
      await db.query('COMMIT');
      console.log('Applied ' + file);
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    }
  }
  console.log('Database migrations ready.');
} finally {
  await db.query('SELECT pg_advisory_unlock(421109)');
  await db.end();
}
