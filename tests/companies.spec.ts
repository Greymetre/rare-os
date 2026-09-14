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
  await expect(
    page.getByRole('heading', { name: /Your operations start here.|Company management/ }),
  ).toBeVisible();
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
test('SaaS onboarding, company isolation, switching and status', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(120000);
  const suffix = Date.now().toString(),
    a = randomUUID(),
    b = randomUUID(),
    mail = 'company.' + suffix + '@example.test';
  const ids = [a, b];
  let identityId = '';
  let customer: any, second: any;
  await login(page);
  const me = await (await page.request.get('/api/me')).json();
  const call = (path: string, method = 'GET', data?: unknown) =>
    page.request.fetch('/api/' + path, {
      method,
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
      data,
    });
  try {
    await page.getByRole('button', { name: 'Companies', exact: true }).click();
    await page.getByRole('button', { name: 'Create company', exact: true }).click();
    await page.getByLabel('Company name', { exact: true }).fill('QA Company ' + suffix);
    await page.getByLabel('Company code', { exact: true }).fill('QA' + suffix);
    await page.getByLabel('Contact email', { exact: true }).fill(mail);
    await page.getByLabel('Admin full name', { exact: true }).fill('Company Admin');
    await page.getByLabel('Admin email', { exact: true }).fill(mail);
    await page.getByRole('button', { name: 'Save company' }).click();
    await expect(
      page.getByText('Company ready. Invitation captured in the local inbox.', { exact: true }),
    ).toBeVisible();
    const company = (
      await (
        await call('platform/companies?q=' + encodeURIComponent('QA Company ' + suffix))
      ).json()
    ).items[0];
    ids[0] = company.id;
    const onboarding = await (
      await call('platform/companies/' + company.id + '/onboarding')
    ).json();
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${onboarding.id}'`);
    const payload = {
      requestId: b,
      name: 'QA Shared ' + suffix,
      code: 'QB' + suffix,
      contactEmail: mail,
      adminName: 'Main Admin',
      adminEmail: env.SEED_ADMIN_EMAIL,
    };
    expect((await call('platform/companies', 'POST', payload)).ok()).toBe(true);
    expect((await call('platform/companies', 'POST', payload)).ok()).toBe(true);
    expect(
      (await call('platform/companies', 'POST', { ...payload, requestId: randomUUID() })).status(),
    ).toBe(409);
    customer = await browser.newContext();
    const cp = await customer.newPage();
    await cp.goto(await mailLink(mail, request));
    const proceed = cp.getByRole('link', { name: /click here to proceed/i });
    if (await proceed.isVisible()) await proceed.click();
    await cp.locator('#password-new').fill('Company-Password-2026!');
    await cp.locator('#password-confirm').fill('Company-Password-2026!');
    await cp.getByRole('button', { name: /submit/i }).click();
    await expect(
      cp.locator('#username').or(cp.getByRole('link', { name: /back to application/i })),
    ).toBeVisible();
    const back = cp.getByRole('link', { name: /back to application/i });
    if (await back.isVisible()) await back.click();
    await cp.locator('#username').fill(mail);
    await cp.locator('#password').fill('Company-Password-2026!');
    await cp.locator('#kc-login').click();
    await expect(cp.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
    const cm = await (await cp.request.get('/api/me')).json();
    expect(cm.user.tenant_id).toBe(company.id);
    expect(cm.platformAdmin).toBe(false);
    expect(
      (await (await call('platform/companies/' + company.id + '/onboarding')).json())
        .first_login_at,
    ).toBeTruthy();
    const cc = (path: string, method = 'GET', data?: unknown) =>
      cp.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': cm.csrfToken },
        data,
      });
    const self = await (await cc('users/' + cm.user.id)).json();
    const last = await cc('users/' + self.id, 'PATCH', {
      name: self.name,
      roleId: self.role_id,
      active: false,
      version: self.version,
    });
    expect(last.status()).toBe(409);
    expect((await last.json()).error.code).toBe('LAST_ADMIN');
    expect((await cc('platform/companies')).status()).toBe(403);
    expect((await cc('platform/companies', 'POST', payload)).status()).toBe(403);
    expect((await cc('roles/' + mainRole)).status()).toBe(404);
    expect((await cc('users/' + adminId)).status()).toBe(404);
    expect((await cc('session/company', 'POST', { companyId: b })).status()).toBe(403);
    const role = await (
      await cc('roles', 'POST', { name: 'Company-specific role', permissions: ['dashboard.read'] })
    ).json();
    expect(role.id).toBeTruthy();
    const users = await (await cc('users')).json();
    expect(users.items).toHaveLength(1);
    expect(users.items[0].email).toBe(mail);
    second = await browser.newContext();
    const sp = await second.newPage();
    await login(sp);
    await expect(
      sp.getByRole('heading', { name: 'Company management', exact: true }),
    ).toBeVisible();
    await sp
      .getByRole('button', { name: 'QA Shared ' + suffix + ' (QB' + suffix + ')', exact: true })
      .click();
    await expect(sp.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
    const sm = await (await sp.request.get('/api/me')).json();
    expect(sm.user.tenant_id).toBe(b);
    expect(
      (await (await call('platform/companies/' + b + '/onboarding')).json()).first_login_at,
    ).toBeTruthy();
    expect((await sp.request.get('/api/roles/' + role.id)).status()).toBe(404);
    await sp.getByRole('button', { name: 'Companies', exact: true }).click();
    await sp.getByRole('button', { name: 'RARE OS Workspace (RARE)', exact: true }).click();
    await expect(sp.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
    expect((await (await sp.request.get('/api/me')).json()).user.tenant_id).toBe(
      '10000000-0000-4000-8000-000000000001',
    );
    const update = {
      name: company.name,
      contactEmail: mail,
      active: false,
      version: company.version,
    };
    expect((await call('platform/companies/' + company.id, 'PATCH', update)).ok()).toBe(true);
    expect((await cc('users')).status()).toBe(401);
    expect((await call('platform/companies/' + company.id, 'PATCH', update)).status()).toBe(409);
    expect(
      (
        await call('platform/companies/' + company.id, 'PATCH', {
          ...update,
          active: true,
          version: company.version + 1,
        })
      ).ok(),
    ).toBe(true);
    expect((await cc('users')).status()).toBe(401);
    expect((await cc('session/company', 'POST', { companyId: company.id })).status()).toBe(403);
    await page.screenshot({ path: '.local/company-management.png', fullPage: true });
  } finally {
    test.setTimeout(150000);
    if (identityId)
      await fetch('http://localhost:4311/admin/realms/rare-os/users/' + identityId, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + (await identityToken()) },
      });
    for (const tenant of ids)
      sql(
        `DELETE FROM user_sites WHERE tenant_id='${tenant}'; DELETE FROM app_users WHERE tenant_id='${tenant}'; DELETE FROM role_permissions WHERE tenant_id='${tenant}'; DELETE FROM roles WHERE tenant_id='${tenant}'; DELETE FROM audit_log WHERE tenant_id='${tenant}'; DELETE FROM tenants WHERE id='${tenant}'; DELETE FROM platform_audit WHERE company_id='${tenant}';`,
      );
  }
});
