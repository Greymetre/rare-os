import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { assertDisposableStack } from './helpers/test-environment.mjs';
const cwd = resolve('/tmp/rare-test-fixture');
const project = 'rare-regression-example-12345678';
const env = {
  RARE_E2E_DISPOSABLE_STACK: 'true',
  COMPOSE_PROJECT_NAME: project,
  COMPOSE_FILE: resolve(cwd, 'compose.yaml'),
  COMPOSE_ENV_FILES: resolve(cwd, '.env'),
  RARE_E2E_NONCE: 'fixture',
};
const marker = { project, nonce: 'fixture' };
const urls = {
  APP_URL: 'http://localhost:4510',
  AUTH_URL: 'http://localhost:4511',
  MAILPIT_URL: 'http://localhost:4512',
};
test('regression accepts its private stack and rejects real development or live services', () => {
  assert.doesNotThrow(() => assertDisposableStack(env, marker, urls, cwd));
  for (const key of Object.keys(urls))
    for (const url of [
      'http://localhost:4310',
      'http://localhost:4311',
      'http://localhost:4312',
      'https://rare.greymetre.io',
      'http://example.test:4511',
    ])
      assert.throws(() => assertDisposableStack(env, marker, { ...urls, [key]: url }, cwd));
  assert.throws(() => assertDisposableStack(env, marker, { ...urls, AUTH_URL: urls.APP_URL }, cwd));
});
test('regression refuses missing marker, forged context and wrong Compose configuration', () => {
  for (const replacement of [
    { RARE_E2E_DISPOSABLE_STACK: '' },
    { COMPOSE_PROJECT_NAME: 'rare-os' },
    { COMPOSE_FILE: '/real/compose.yaml' },
    { COMPOSE_ENV_FILES: '/real/.env' },
    { RARE_E2E_NONCE: 'different' },
  ])
    assert.throws(() => assertDisposableStack({ ...env, ...replacement }, marker, urls, cwd));
  assert.throws(() => assertDisposableStack(env, {}, urls, cwd));
  assert.throws(() => assertDisposableStack(env, { ...marker, project: 'rare-os' }, urls, cwd));
});
