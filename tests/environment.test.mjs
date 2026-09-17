import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocalHost } from '../apps/web/src/environment.ts';

test('LOCAL badge is limited to loopback hosts, never real domains', () => {
  for (const host of ['localhost', 'LOCALHOST', '127.0.0.1', '[::1]'])
    assert.equal(isLocalHost(host), true, host);
  for (const host of [
    'rare.greymetre.io',
    'auth.rare.greymetre.io',
    'localhost.evil.test',
    '10.0.0.5',
  ])
    assert.equal(isLocalHost(host), false, host);
});
