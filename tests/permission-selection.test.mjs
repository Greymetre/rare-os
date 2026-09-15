import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPermissions } from '../apps/web/src/permission-selection.ts';
import { permissions } from '../packages/schema/permissions.mjs';
const allowed = permissions.map(([code]) => code);
test('user editing includes view dependencies without granting role or status changes', () => {
  const selection = selectPermissions(['dashboard.read'], ['users.update'], true, allowed);
  assert.deepEqual(
    new Set(selection),
    new Set(['dashboard.read', 'users.update', 'users.read', 'roles.read']),
  );
  for (const code of ['roles.update', 'users.assign_role', 'users.change_status'])
    assert.ok(!selection.includes(code));
});
test('removing required view transitively removes dependent actions and preserves dashboard', () => {
  const selection = selectPermissions(allowed, ['roles.read', 'dashboard.read'], false, allowed);
  assert.ok(selection.includes('dashboard.read'));
  for (const code of [
    'roles.read',
    'roles.update',
    'users.update',
    'users.assign_role',
    'users.change_status',
  ])
    assert.ok(!selection.includes(code));
  assert.ok(selection.includes('sites.update'));
});
test('cannot select an action without grantable dependencies; hidden future permissions survive', () => {
  const selection = selectPermissions(
    ['dashboard.read', 'planning.read'],
    ['users.assign_role'],
    true,
    ['dashboard.read', 'users.assign_role', 'users.read', 'users.update'],
  );
  assert.deepEqual(selection, ['dashboard.read', 'planning.read']);
});
test('create, edit and delete selection are independent', () => {
  for (const action of ['create', 'update', 'delete']) {
    const selection = selectPermissions(['dashboard.read'], ['roles.' + action], true, allowed);
    assert.deepEqual(
      new Set(selection),
      new Set(['dashboard.read', 'roles.read', 'roles.' + action]),
    );
  }
});
