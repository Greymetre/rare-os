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
  'packages/schema/imports.mjs',
  'packages/schema/masters.mjs',
  'packages/schema/masters-db.mjs',
  'packages/schema/quantity.mjs',
  'packages/schema/plant-model.mjs',
  'packages/schema/plant-model-db.mjs',
  'packages/engines/plant-model.mjs',
  'packages/schema/demand-stock.mjs',
  'packages/schema/demand-stock-db.mjs',
  'packages/schema/buffers.mjs',
  'packages/schema/planning-db.mjs',
  'packages/engines/ddmrp.mjs',
])
  await readFile(file);
console.log('Runtime source and migrations are readable.');
