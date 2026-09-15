import { readdir, readFile } from 'node:fs/promises';
// No database access: fail before stopping services if packaged source is unreadable.
for (const file of await readdir('db/migrations')) {
  if (file.endsWith('.sql')) await readFile('db/migrations/' + file);
}
for (const file of [
  'scripts/migrate.mjs',
  'scripts/seed.mjs',
  'apps/api/dist/main.js',
  'apps/workers/dist/main.js',
  'packages/schema/permissions.mjs',
])
  await readFile(file);
console.log('Runtime source and migrations are readable.');
