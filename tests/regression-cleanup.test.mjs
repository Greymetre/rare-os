import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRegression } from '../scripts/regression-cleanup.mjs';
const project = 'rare-regression-example-12345678';
test('regression cleanup targets only its project volumes and exact image tags', async () => {
  const calls = [];
  await cleanupRegression(project, async (args) => {
    calls.push(args);
    return args[1] === 'ls' ? 'fixture-image' : '';
  });
  assert.deepEqual(calls[0], [
    'compose',
    '--project-name',
    project,
    '--profile',
    '*',
    'down',
    '--volumes',
    '--remove-orphans',
  ]);
  const removed = calls.filter((args) => args[1] === 'rm').map((args) => args[2]);
  assert.deepEqual(
    removed,
    ['api', 'worker', 'web', 'seed', 'migrate', 'keycloak', 'ops'].map(
      (name) => project + '-' + name,
    ),
  );
  assert.ok(
    calls.every(
      (args) => !args.includes('prune') && !args.includes('--rmi') && !args.includes('--force'),
    ),
  );
});
test('cleanup rejects normal project names and reports Docker failures without further deletion', async () => {
  let calls = 0;
  const failing = async () => {
    calls++;
    throw Error('Docker unavailable');
  };
  for (const name of ['rare-os', '', 'rare-regression-', project + ';echo'])
    await assert.rejects(() => cleanupRegression(name, failing), /Refusing/);
  assert.equal(calls, 0);
  await assert.rejects(() => cleanupRegression(project, failing), /Docker unavailable/);
  assert.equal(calls, 1);
});
