import { createReadStream } from 'node:fs';
import { mkdirSync, openSync, closeSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
// Private local backup; never a replacement for offsite backups.
async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dir = resolve('.local/backups/' + stamp);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const manifest = { createdAt: new Date().toISOString(), files: [] };
for (const name of ['rare_os', 'keycloak']) {
  const file = dir + '/' + name + '.dump',
    fd = openSync(file, 'wx', 0o600);
  try {
    const r = spawnSync(
      'docker',
      ['compose', 'exec', '-T', 'db', 'pg_dump', '-U', 'rare_owner', '-d', name, '-Fc'],
      { stdio: ['ignore', fd, 'pipe'] },
    );
    if (r.status !== 0) throw Error('Backup failed for ' + name);
  } finally {
    closeSync(fd);
  }
  const checkFd = openSync(file, 'r');
  let check = '';
  try {
    const r = spawnSync('docker', ['compose', 'exec', '-T', 'db', 'pg_restore', '--list'], {
      stdio: [checkFd, 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) throw Error('Invalid backup archive');
    check = r.stdout.toString();
  } finally {
    closeSync(checkFd);
  }
  if (!check.includes('TABLE DATA')) throw Error('Backup contains no data');
  manifest.files.push({
    database: name,
    file: name + '.dump',
    bytes: statSync(file).size,
    sha256: await hashFile(file),
  });
}
writeFileSync(dir + '/manifest.json', JSON.stringify(manifest, null, 2), { mode: 0o600 });
if (process.argv.includes('--verify'))
  process.stdout.write(
    execFileSync(process.execPath, ['scripts/restore-drill.mjs', dir], { encoding: 'utf8' }),
  );
console.log(dir);
