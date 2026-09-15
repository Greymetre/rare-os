import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .trim()
    .split('\n')
    .map((x) => {
      const i = x.indexOf('=');
      return [x.slice(0, i), x.slice(i + 1)];
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
const adminId = '30000000-0000-4000-8000-000000000001',
  mainRole = '20000000-0000-4000-8000-000000000001';
async function login(page: any) {
  await page.goto('/');
  await page.getByRole('link', { name: /sign in securely/i }).click();
  await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
  await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
}
async function identityToken() {
  const r = await fetch('http://localhost:4311/realms/rare-os/protocol/openid-connect/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'rare-os-identity',
      client_secret: env.IDENTITY_CLIENT_SECRET,
    }),
  });
  return (await r.json()).access_token;
}
async function mailLink(email: string, request: any) {
  let message: any;
  await expect
    .poll(
      async () => {
        const list = await (await request.get('http://localhost:4312/api/v1/messages')).json();
        message = list.messages?.find((m: any) => m.To?.some((to: any) => to.Address === email));
        return !!message;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const content = await (
    await request.get('http://localhost:4312/api/v1/message/' + message.ID)
  ).json();
  const match = content.HTML.match(/href="([^"]*login-actions\/action-token[^"]*)"/);
  expect(match).toBeTruthy();
  return match![1].replaceAll('&amp;', '&');
}
test('role/user management, invitations, activation and safe access changes', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120000);
  const suffix = Date.now(),
    emailAddress = `qa.${suffix}@example.test`,
    roleName = `QA Access ${suffix}`;
  let roleId = '',
    userId = '',
    identityId = '';
  let userContext: any;
  const perms = ['dashboard.read', 'users.read', 'users.manage', 'roles.read', 'roles.manage'];
  await login(page);
  const me = await (await page.request.get('/api/me')).json();
  const call = (path: string, method = 'GET', data?: unknown) =>
    page.request.fetch('/api/' + path, {
      method,
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
      data,
    });
  try {
    await page.getByRole('button', { name: 'Roles & permissions', exact: true }).click();
    await page.getByRole('button', { name: 'Create role', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Create role' });
    await modal.getByLabel('Role name', { exact: true }).fill(roleName);
    for (const label of [
      'View company users',
      'Manage company users',
      'View roles and permissions',
      'Create, edit and delete custom roles',
    ])
      await modal.getByLabel(new RegExp(label)).check();
    await modal.getByLabel('Search modules or actions').fill('roles');
    await expect(modal.locator('fieldset')).toHaveCount(1);
    await modal.getByLabel('Search modules or actions').fill('');
    await expect(modal.getByText('Not implemented yet', { exact: true })).toHaveCount(0);
    await page.screenshot({ path: '.local/role-permissions-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await modal.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: '.local/role-permissions-mobile.png', fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await modal.getByRole('button', { name: 'Save role' }).click();
    await expect(modal).not.toBeVisible();
    await expect(page.getByText('Role created successfully.', { exact: true })).toBeVisible();
    const list = await (await call('roles?q=' + encodeURIComponent(roleName))).json();
    roleId = list.items[0].id;
    expect((await call('roles', 'POST', { name: roleName, permissions: perms })).status()).toBe(
      409,
    );
    expect(
      (
        await call('roles', 'POST', {
          name: 'Invalid role',
          permissions: ['dashboard.read', 'madeup.permission'],
        })
      ).status(),
    ).toBe(400);
    expect((await call('roles/' + mainRole, 'DELETE', { version: 1 })).status()).toBe(409);
    await page.getByRole('button', { name: 'Edit role ' + roleName }).click();
    await page
      .getByRole('dialog')
      .getByLabel('Role name', { exact: true })
      .fill(roleName + ' Updated');
    await page.getByRole('dialog').getByRole('button', { name: 'Save role' }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    expect(
      (
        await call('roles/' + roleId, 'PATCH', { name: roleName, permissions: perms, version: 1 })
      ).status(),
    ).toBe(409);
    await page.getByRole('button', { name: 'Users', exact: true }).click();
    await page.getByRole('button', { name: 'Create user', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Create user' });
    await form.getByLabel('Full name').fill('QA Access User');
    await form.getByLabel('Email address').fill(emailAddress);
    await expect(form.getByLabel('Assign role')).toBeEnabled();
    await form.getByLabel('Assign role').selectOption(roleId);
    await form.getByRole('button', { name: 'Create user', exact: true }).click();
    await expect(form).not.toBeVisible({ timeout: 30000 });
    const users = await (await call('users?q=' + encodeURIComponent(emailAddress))).json();
    userId = users.items[0].id;
    expect(users.items[0].sync_state).toBe('ready');
    expect(users.items[0].first_login_at).toBeNull();
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    const payload = { name: 'QA Access User', email: emailAddress, roleId, requestId: userId };
    expect((await call('users', 'POST', payload)).ok()).toBe(true);
    expect(
      (
        await call('users', 'POST', {
          ...payload,
          requestId: randomUUID(),
          email: emailAddress.toUpperCase(),
        })
      ).status(),
    ).toBe(409);
    const role = await (await call('roles/' + roleId)).json();
    expect((await call('roles/' + roleId, 'DELETE', { version: role.version })).status()).toBe(409);
    const admin = await (await call('users/' + adminId)).json();
    const denied = await call('users/' + adminId, 'PATCH', {
      name: admin.name,
      roleId: mainRole,
      active: false,
      version: admin.version,
    });
    expect(denied.status()).toBe(409);
    expect(['LAST_ADMIN', 'SELF_ACCESS_CHANGE']).toContain((await denied.json()).error.code);
    const link = await mailLink(emailAddress, request);
    userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    await userPage.goto(link);
    const proceed = userPage.getByRole('link', { name: /click here to proceed/i });
    if (await proceed.isVisible()) await proceed.click();
    await expect(userPage.locator('#password-new')).toBeVisible();
    await userPage.locator('#password-new').fill('Qa-Strong-Password-2026!');
    await userPage.locator('#password-confirm').fill('Qa-Strong-Password-2026!');
    await userPage.getByRole('button', { name: /submit/i }).click();
    const back = userPage.getByRole('link', { name: /back to application/i });
    if (await back.isVisible()) await back.click();
    await expect(userPage.getByLabel('Username or email')).toBeVisible();
    await userPage.getByLabel('Username or email').fill(emailAddress);
    await userPage.getByLabel('Password', { exact: true }).fill('Qa-Strong-Password-2026!');
    await userPage.getByRole('button', { name: 'Sign In', exact: true }).click();
    await expect(
      userPage.getByRole('heading', { name: 'Your operations start here.' }),
    ).toBeVisible({ timeout: 15000 });
    const userMe = await (await userPage.request.get('/api/me')).json();
    expect(userMe.user.role).toBe(roleName + ' Updated');
    expect((await (await call('users/' + userId)).json()).first_login_at).toBeTruthy();
    await page.getByRole('button', { name: /Refresh/ }).click();
    const row = page.getByRole('row').filter({ hasText: emailAddress });
    await expect(row.getByText('Onboarding complete', { exact: true })).toBeVisible();
    await expect(
      row.getByRole('button', { name: 'Send invitation to QA Access User', exact: true }),
    ).toHaveCount(0);
    const privileged = await userPage.request.post('/api/roles', {
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': userMe.csrfToken },
      data: { name: 'Escalated role', permissions: ['dashboard.read', 'purchase.approve'] },
    });
    expect(privileged.status()).toBe(403);
    await userPage.getByRole('button', { name: 'Roles & permissions', exact: true }).click();
    await userPage
      .getByRole('button', { name: 'View role ' + roleName + ' Updated', exact: true })
      .click();
    await expect(
      userPage.getByRole('dialog').getByText('This is your assigned role.', { exact: false }),
    ).toBeVisible();
    await expect(
      userPage.getByRole('dialog').getByRole('button', { name: 'Save role' }),
    ).toHaveCount(0);
    await userPage.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    const selfRole = await userPage.request.patch('/api/roles/' + roleId.toUpperCase(), {
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': userMe.csrfToken },
      data: { name: roleName, permissions: perms, version: role.version },
    });
    expect(selfRole.status()).toBe(409);
    expect((await selfRole.json()).error.code).toBe('SELF_ROLE_CHANGE');
    // Removing role access must hide navigation AND deny direct API reads/writes.
    const currentRole = await (await call('roles/' + roleId)).json();
    expect(
      (
        await call('roles/' + roleId, 'PATCH', {
          name: currentRole.name,
          permissions: ['dashboard.read'],
          version: currentRole.version,
        })
      ).ok(),
    ).toBe(true);
    await userPage.reload();
    await expect(
      userPage.getByRole('button', { name: 'Roles & permissions', exact: true }),
    ).toHaveCount(0);
    expect((await userPage.request.get('/api/roles')).status()).toBe(403);
    expect((await userPage.request.get('/api/permissions')).status()).toBe(403);
    expect(
      (
        await userPage.request.post('/api/roles', {
          headers: { Origin: env.APP_URL, 'X-CSRF-Token': userMe.csrfToken },
          data: { name: 'Forbidden', permissions: ['dashboard.read'] },
        })
      ).status(),
    ).toBe(403);
    const user = await (await call('users/' + userId)).json();
    expect(
      (
        await call('users/' + userId, 'PATCH', {
          name: user.name,
          roleId,
          active: false,
          version: user.version,
        })
      ).ok(),
    ).toBe(true);
    expect((await userPage.request.get('/api/me')).status()).toBe(401);
    const disabled = await (await call('users/' + userId)).json();
    expect(
      (
        await call('users/' + userId, 'PATCH', {
          name: disabled.name,
          roleId,
          active: true,
          version: disabled.version,
        })
      ).ok(),
    ).toBe(true);
    expect((await userPage.request.get('/api/me')).status()).toBe(401);
    sql(`UPDATE app_users SET email_attempt_at=NULL WHERE id='${userId}'`);
    expect((await call('users/' + userId + '/reset-password', 'POST', {})).ok()).toBe(true);
    expect((await call('users/' + userId + '/reset-password', 'POST', {})).status()).toBe(429);
    const audit = await (await call('audit?limit=100')).json();
    expect(
      audit.items.some(
        (x: any) =>
          x.entity_id === userId &&
          x.action === 'user.updated' &&
          x.details.before.active !== x.details.after.active,
      ),
    ).toBe(true);
    await page.screenshot({ path: '.local/users-management.png', fullPage: true });
  } finally {
    await userContext?.close();
    if (userId) {
      if (!identityId) identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
      if (identityId && !identityId.startsWith('pending:'))
        await fetch('http://localhost:4311/admin/realms/rare-os/users/' + identityId, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer ' + (await identityToken()) },
        });
      sql(
        `DELETE FROM user_sites WHERE user_id='${userId}'; DELETE FROM app_users WHERE id='${userId}';`,
      );
    }
    if (roleId) {
      const detail = await (await call('roles/' + roleId)).json();
      const deleted = await call('roles/' + roleId, 'DELETE', { version: detail.version });
      expect(deleted.ok()).toBe(true);
    }
  }
});
