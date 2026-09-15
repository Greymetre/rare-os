import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
// Only versioned source is made readable. Never touch .env, overrides, keys or backups.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const directories = new Set();
for (const file of files) {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink()) continue;
  if (!stat.isFile()) continue;
  chmodSync(file, (stat.mode & 0o777) | 0o444);
  for (let dir = dirname(file); dir !== '.'; dir = dirname(dir)) directories.add(dir);
}
for (const dir of directories) {
  const stat = lstatSync(dir);
  if (stat.isDirectory() && !stat.isSymbolicLink()) chmodSync(dir, (stat.mode & 0o777) | 0o555);
}
console.log('Tracked source permissions ready; private configuration unchanged.');
