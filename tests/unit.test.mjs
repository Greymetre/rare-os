import test from 'node:test';
import assert from 'node:assert/strict';
import { permissions } from '../packages/schema/permissions.mjs';
test('permission catalog has unique action codes and descriptions', () => {
  assert.equal(new Set(permissions.map((x) => x[0])).size, permissions.length);
  for (const [code, module, description] of permissions) {
    assert.match(code, /^[a-z_]+\.[a-z_]+$/);
    assert.ok(module && description);
  }
});
test('critical approvals have their own permission', () => {
  for (const p of [
    'purchase.approve',
    'schedule.publish',
    'inventory.adjust',
    'users.assign_role',
    'users.reset_password',
    'roles.update',
  ])
    assert.ok(permissions.some((x) => x[0] === p));
});
