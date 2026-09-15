import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
const sql = (query: string) =>
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'db',
      'psql',
      '-U',
      'rare_owner',
      '-d',
      'rare_os',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  ).trim();
const tenant = '10000000-0000-4000-8000-000000000001';
test('legacy role grants migrate without adding plant assignment to user-only managers', () => {
  const company = randomUUID(),
    userRole = randomUUID(),
    bothRole = randomUUID();
  sql(`BEGIN;
    INSERT INTO tenants(id,name,code) VALUES('${company}','Migration fixture','${company}');
    INSERT INTO roles(id,tenant_id,name) VALUES('${userRole}','${company}','Users only'),('${bothRole}','${company}','Users and plants');
    INSERT INTO permissions(code,module,description) VALUES('users.manage','Users','Legacy'),('sites.manage','Plants','Legacy') ON CONFLICT DO NOTHING;
    INSERT INTO role_permissions(tenant_id,role_id,permission_code) VALUES('${company}','${userRole}','users.manage'),('${company}','${bothRole}','users.manage'),('${company}','${bothRole}','sites.manage');
    ${readFileSync('db/migrations/009_action_permissions.sql', 'utf8')}
    DO $$ BEGIN
      IF EXISTS(SELECT 1 FROM role_permissions WHERE role_id='${userRole}' AND permission_code IN ('users.assign_plants','sites.read_all')) THEN RAISE EXCEPTION 'Unexpected plant access'; END IF;
      IF NOT EXISTS(SELECT 1 FROM role_permissions WHERE role_id='${bothRole}' AND permission_code='users.assign_plants') THEN RAISE EXCEPTION 'Plant assignment lost'; END IF;
      IF (SELECT count(*) FROM role_permissions WHERE role_id='${userRole}' AND permission_code IN ('users.create','users.update','users.change_status','users.assign_role','users.invite','users.reset_password','users.retry_setup')) <> 7 THEN RAISE EXCEPTION 'Legacy actions lost'; END IF;
      IF EXISTS(SELECT 1 FROM permissions WHERE code IN ('users.manage','roles.manage','sites.manage')) THEN RAISE EXCEPTION 'Legacy permission still grantable'; END IF;
    END $$;
    ROLLBACK;`);
});
test('independent role actions, user-sensitive actions and plant scope enforced in UI and API', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120000);
  const suffix = Date.now(),
    userId = randomUUID(),
    email = `action.${suffix}@example.test`;
  let roleId = '',
    identityId = '',
    targetRole = '',
    siteId = '',
    otherSite = '';
  let context: any;
  const token = (
    await (
      await request.post('http://localhost:4311/realms/rare-os/protocol/openid-connect/token', {
        form: {
          grant_type: 'client_credentials',
          client_id: 'rare-os-identity',
          client_secret: env.IDENTITY_CLIENT_SECRET,
        },
      })
    ).json()
  ).access_token;
  const kcHeaders = { Authorization: 'Bearer ' + token };
  await page.goto('/');
  await page.getByRole('link', { name: /sign in securely/i }).click();
  await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
  await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page.locator('.main > header')).toBeVisible();
  const me = await (await page.request.get('/api/me')).json();
  const call = (path: string, method = 'GET', data?: unknown) =>
    page.request.fetch('/api/' + path, {
      method,
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
      data,
    });
  const grants = async (codes: string[]) => {
    const r = await (await call('roles/' + roleId)).json();
    expect(
      (
        await call('roles/' + roleId, 'PATCH', {
          name: r.name,
          version: r.version,
          permissions: ['dashboard.read', ...codes],
        })
      ).ok(),
    ).toBe(true);
  };
  try {
    roleId = (
      await (
        await call('roles', 'POST', {
          name: 'Action test ' + suffix,
          permissions: ['dashboard.read', 'roles.read', 'roles.create'],
        })
      ).json()
    ).id;
    expect(roleId).toBeTruthy();
    const created = await call('users', 'POST', {
      requestId: userId,
      name: 'Action User',
      email,
      roleId,
    });
    expect(created.ok()).toBe(true);
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    expect(
      (
        await request.put(
          'http://localhost:4311/admin/realms/rare-os/users/' + identityId + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Action-Test-2026!', temporary: false },
          },
        )
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.put('http://localhost:4311/admin/realms/rare-os/users/' + identityId, {
          headers: kcHeaders,
          data: { emailVerified: true, requiredActions: [] },
        })
      ).ok(),
    ).toBe(true);
    context = await browser.newContext();
    const up = await context.newPage();
    await up.goto('http://localhost:4310/api/auth/login');
    await up.locator('#username').fill(email);
    await up.locator('#password').fill('Action-Test-2026!');
    await up.locator('#kc-login').click();
    await expect(up.locator('.main > header')).toBeVisible();
    const um = await (await up.request.get('/api/me')).json();
    const act = (path: string, method = 'GET', data?: unknown) =>
      up.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': um.csrfToken },
        data,
      });
    await up.getByRole('button', { name: 'Roles & permissions', exact: true }).click();
    await expect(up.getByRole('button', { name: 'Create role', exact: true })).toBeVisible();
    targetRole = (
      await (
        await act('roles', 'POST', {
          name: 'Created only ' + suffix,
          permissions: ['dashboard.read'],
        })
      ).json()
    ).id;
    expect(targetRole).toBeTruthy();
    expect(
      (
        await act('roles/' + targetRole, 'PATCH', {
          name: 'Denied edit',
          permissions: ['dashboard.read'],
          version: 1,
        })
      ).status(),
    ).toBe(403);
    expect((await act('roles/' + targetRole, 'DELETE', { version: 1 })).status()).toBe(403);
    await grants(['roles.read', 'roles.update']);
    await up.reload();
    await up.getByRole('button', { name: 'Roles & permissions', exact: true }).click();
    await expect(up.getByRole('button', { name: 'Create role', exact: true })).toHaveCount(0);
    await expect(
      up.getByRole('button', { name: 'Edit role Created only ' + suffix, exact: true }),
    ).toBeVisible();
    await expect(up.getByRole('button', { name: /Delete role/ })).toHaveCount(0);
    expect(
      (
        await act('roles', 'POST', { name: 'Denied create', permissions: ['dashboard.read'] })
      ).status(),
    ).toBe(403);
    expect(
      (
        await act('roles/' + targetRole, 'PATCH', {
          name: 'Edited only ' + suffix,
          permissions: ['dashboard.read'],
          version: 1,
        })
      ).ok(),
    ).toBe(true);
    const own = await (await call('roles/' + roleId)).json();
    expect(
      (
        await act('roles/' + roleId, 'PATCH', {
          name: own.name,
          permissions: own.permissions,
          version: own.version,
        })
      ).status(),
    ).toBe(409);
    await grants(['roles.read', 'roles.delete']);
    expect((await act('roles/' + targetRole, 'DELETE', { version: 2 })).ok()).toBe(true);
    targetRole = '';
    await grants(['users.read', 'roles.read', 'users.update']);
    const self = await (await act('users/' + userId)).json();
    const payload = { name: 'Action User edited', roleId, active: true, version: self.version };
    expect((await act('users/' + userId, 'PATCH', { ...payload, active: false })).status()).toBe(
      403,
    );
    expect(
      (await act('users/' + userId, 'PATCH', { ...payload, roleId: randomUUID() })).status(),
    ).toBe(404);
    const plainRole = (
      await (
        await call('roles', 'POST', {
          name: 'Target plain ' + suffix,
          permissions: ['dashboard.read'],
        })
      ).json()
    ).id;
    targetRole = plainRole;
    expect(
      (await act('users/' + userId, 'PATCH', { ...payload, roleId: plainRole })).status(),
    ).toBe(403);
    for (const endpoint of ['invite', 'reset-password', 'retry'])
      expect((await act('users/' + userId + '/' + endpoint, 'POST', {})).status()).toBe(403);
    expect(
      (
        await act('users/' + userId + '/plants', 'PUT', { plantIds: [], version: self.version })
      ).status(),
    ).toBe(403);
    expect(
      (
        await act('users', 'POST', {
          requestId: randomUUID(),
          name: 'Denied User',
          email: 'denied-' + email,
          roleId,
        })
      ).status(),
    ).toBe(403);
    expect((await act('users/' + userId, 'PATCH', payload)).ok()).toBe(true);
    await up.reload();
    await up.getByRole('button', { name: 'Users', exact: true }).click();
    await expect(up.getByRole('button', { name: 'Create user', exact: true })).toHaveCount(0);
    await up.getByRole('button', { name: 'Edit user Action User edited', exact: true }).click();
    await expect(up.getByRole('combobox', { name: 'Assign role', exact: true })).toBeDisabled();
    await expect(up.getByRole('combobox', { name: 'Account status', exact: true })).toBeDisabled();
    await grants(['sites.read', 'sites.create']);
    const plant = {
      code: 'ACT' + suffix,
      name: 'Own plant',
      location: 'Test',
      timezone: 'Asia/Kolkata',
    };
    siteId = (await (await act('plants', 'POST', plant)).json()).id;
    expect(siteId).toBeTruthy();
    expect((await act('plants/' + siteId)).ok()).toBe(true);
    const edit = {
      name: 'Edited plant',
      location: 'Test',
      timezone: 'Asia/Kolkata',
      active: true,
      version: 1,
    };
    expect((await act('plants/' + siteId, 'PATCH', edit)).status()).toBe(403);
    otherSite = (await (await call('plants', 'POST', { ...plant, code: 'OTHER' + suffix })).json())
      .id;
    await grants(['sites.read', 'sites.update']);
    expect((await act('plants', 'POST', { ...plant, code: 'DENIED' + suffix })).status()).toBe(403);
    expect((await act('plants/' + otherSite, 'PATCH', edit)).status()).toBe(404);
    expect((await act('plants/' + siteId, 'PATCH', { ...edit, active: false })).status()).toBe(403);
    expect((await act('plants/' + siteId, 'PATCH', edit)).ok()).toBe(true);
    const visible = await (await act('plants')).json();
    expect(visible.items.map((p: any) => p.id)).toEqual([siteId]);
  } finally {
    await context?.close();
    if (identityId)
      await request.delete('http://localhost:4311/admin/realms/rare-os/users/' + identityId, {
        headers: kcHeaders,
      });
    sql(
      `DELETE FROM user_sites WHERE user_id='${userId}'; DELETE FROM app_users WHERE id='${userId}';`,
    );
    for (const id of [roleId, targetRole].filter(Boolean))
      sql(
        `DELETE FROM role_permissions WHERE role_id='${id}'; DELETE FROM roles WHERE id='${id}';`,
      );
    for (const id of [siteId, otherSite].filter(Boolean))
      sql(`DELETE FROM user_sites WHERE site_id='${id}'; DELETE FROM sites WHERE id='${id}';`);
  }
});
