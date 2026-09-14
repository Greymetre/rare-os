import { createReadStream } from 'node:fs';
import { readFileSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const dir = resolve(process.argv[2] || '');
if (!dir.startsWith(resolve('.local/backups') + '/'))
  throw Error('Provide a local backup folder under .local/backups');
const manifest = JSON.parse(readFileSync(dir + '/manifest.json', 'utf8'));
const results = [];
const run = (args) =>
  execFileSync('docker', ['compose', 'exec', '-T', 'db', ...args], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).trim();
for (const file of manifest.files) {
  if (!['rare_os', 'keycloak'].includes(file.database) || file.file !== file.database + '.dump')
    throw Error('Unexpected backup manifest');
  if ((await hashFile(dir + '/' + file.file)) !== file.sha256)
    throw Error('Backup checksum mismatch');
  const target = 'rare_restore_' + randomBytes(8).toString('hex');
  run(['createdb', '-U', 'rare_owner', target]);
  try {
    const fd = openSync(dir + '/' + file.file, 'r');
    try {
      const p = spawnSync(
        'docker',
        [
          'compose',
          'exec',
          '-T',
          'db',
          'pg_restore',
          '-U',
          'rare_owner',
          '--exit-on-error',
          '-d',
          target,
        ],
        { stdio: [fd, 'ignore', 'pipe'] },
      );
      if (p.status !== 0) throw Error('Restore failed for ' + file.database);
    } finally {
      closeSync(fd);
    }
    const query =
      file.database === 'rare_os'
        ? "SELECT json_build_object('companies',(SELECT count(*) FROM tenants),'users',(SELECT count(*) FROM app_users),'roles',(SELECT count(*) FROM roles),'migrations',(SELECT count(*) FROM schema_migrations))"
        : "SELECT json_build_object('realms',(SELECT count(*) FROM realm),'identities',(SELECT count(*) FROM user_entity))";
    const restored = run(['psql', '-U', 'rare_owner', '-d', target, '-At', '-c', query]);
    const source = run(['psql', '-U', 'rare_owner', '-d', file.database, '-At', '-c', query]);
    if (restored !== source)
      throw Error(
        'Counts differ; source may have changed since backup. Review before accepting drill.',
      );
    if (file.database === 'rare_os')
      run([
        'psql',
        '-U',
        'rare_owner',
        '-d',
        target,
        '-v',
        'ON_ERROR_STOP=1',
        '-At',
        '-c',
        "BEGIN; SET LOCAL ROLE rare_app; DO $$ BEGIN IF EXISTS(SELECT 1 FROM tenants) THEN RAISE EXCEPTION 'RLS missing after restore'; END IF; END $$; ROLLBACK;",
      ]);
    results.push({ database: file.database, counts: JSON.parse(restored), verified: true });
  } finally {
    run(['dropdb', '-U', 'rare_owner', target]);
  }
}
writeFileSync(
  dir + '/restore-drill.json',
  JSON.stringify({ verifiedAt: new Date().toISOString(), isolatedRestore: true, results }, null, 2),
  { mode: 0o600 },
);
console.log(
  'PASS isolated restore of app and identity databases; row counts matched and app RLS preserved. Temporary restore databases removed.',
);
