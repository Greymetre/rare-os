import test from 'node:test';
import assert from 'node:assert/strict';
import { selectPermissions } from '../apps/web/src/permission-selection.ts';
const allowed = [
  'dashboard.read',
  'roles.read',
  'roles.manage',
  'users.read',
  'users.manage',
  'sites.read',
  'sites.manage',
];
test('manage selection includes all dependencies without granting role editing', () => {
  const selection = selectPermissions(['dashboard.read'], ['users.manage'], true, allowed);
  assert.deepEqual(
    new Set(selection),
    new Set(['dashboard.read', 'users.manage', 'users.read', 'roles.read']),
  );
  assert.ok(!selection.includes('roles.manage'));
});
test('removing role view removes dependent management and preserves dashboard', () => {
  const selection = selectPermissions(allowed, ['roles.read', 'dashboard.read'], false, allowed);
  assert.ok(selection.includes('dashboard.read'));
  for (const code of ['roles.read', 'roles.manage', 'users.manage'])
    assert.ok(!selection.includes(code));
  assert.ok(selection.includes('sites.manage'));
});
test('selection respects grant limits and keeps hidden future permissions', () => {
  const selection = selectPermissions(['dashboard.read', 'planning.read'], ['roles.manage'], true, [
    'dashboard.read',
  ]);
  assert.deepEqual(selection, ['dashboard.read', 'planning.read']);
});
