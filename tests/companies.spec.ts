import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const env = loadTestEnvironment();
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
  await completeTestMfa(page, env.SEED_ADMIN_EMAIL);
  await expect(
    page.getByRole('heading', { name: /Your operations start here.|Company management/ }),
  ).toBeVisible();
}
async function identityToken() {
  const r = await fetch(env.AUTH_URL + '/realms/rare-os/protocol/openid-connect/token', {
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
        const list = await (await request.get(env.MAILPIT_URL + '/api/v1/messages')).json();
        message = list.messages?.find((m: any) => m.To?.some((to: any) => to.Address === email));
        return !!message;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  const content = await (
    await request.get(env.MAILPIT_URL + '/api/v1/message/' + message.ID)
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
    mail = 'company.' + suffix + '@example.test',
    wrongMail = 'typo.' + suffix + '@example.test';
  const ids = [a, b];
  let identityId = '';
  let mistakenIdentityId = '';
  let smtpStopped = false;
  let customer: any, second: any;
  // Check the fresh-seed contract before creating shared memberships. A mismatch must
  // fail here, rather than time out at company switching and affect later login tests.
  expect(
    sql("SELECT code FROM tenants WHERE id='10000000-0000-4000-8000-000000000001'"),
    'Default workspace must be seeded with the stable RARE company code',
  ).toBe('RARE');
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
    await page.getByLabel('Admin email', { exact: true }).fill(wrongMail);
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
    mistakenIdentityId = identityId;
    // Contact edits must not silently change identity ownership or invitation destination.
    expect(
      (
        await call('platform/companies/' + company.id, 'PATCH', {
          name: company.name,
          contactEmail: mail,
          active: true,
          version: company.version,
        })
      ).ok(),
    ).toBe(true);
    company.version++;
    expect(
      (await (await call('platform/companies/' + company.id + '/onboarding')).json()).email,
    ).toBe(wrongMail);
    await mailLink(wrongMail, request);
    expect(
      (
        await call('platform/companies/' + company.id + '/admin-email', 'PATCH', {
          email: env.SEED_ADMIN_EMAIL,
          version: onboarding.version,
        })
      ).status(),
    ).toBe(409);
    const row = page.getByRole('row').filter({ hasText: company.name });
    await row.getByRole('button', { name: 'Admin setup', exact: true }).click();
    await page.getByLabel('Correct admin email', { exact: true }).fill(mail);
    await page.getByRole('button', { name: 'Save corrected email', exact: true }).click();
    await expect(
      page.getByText('Admin email corrected. Review the recipient, then send the invitation.', {
        exact: true,
      }),
    ).toBeVisible();
    const corrected = await (await call('platform/companies/' + company.id + '/onboarding')).json();
    expect(corrected.email).toBe(mail);
    expect(corrected.invitation_sent_at).toBeNull();
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${onboarding.id}'`);
    expect(identityId).not.toBe(mistakenIdentityId);
    expect(
      sql(
        `SELECT count(*) FROM session_memberships('${mistakenIdentityId}') WHERE tenant_id='${company.id}'`,
      ),
    ).toBe('0');
    expect(
      (
        await call('platform/companies/' + company.id + '/admin-email', 'PATCH', {
          email: 'stale.' + mail,
          version: onboarding.version,
        })
      ).status(),
    ).toBe(409);
    const identityHeaders = {
      Authorization: 'Bearer ' + (await identityToken()),
      'Content-Type': 'application/json',
    };
    expect(
      (
        await fetch(env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId, {
          method: 'PUT',
          headers: identityHeaders,
          body: JSON.stringify({ emailVerified: true }),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await call('platform/companies/' + company.id + '/admin-email', 'PATCH', {
          email: 'verified.' + mail,
          version: corrected.version,
        })
      ).status(),
    ).toBe(409);
    expect(
      (
        await fetch(env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId, {
          method: 'PUT',
          headers: identityHeaders,
          body: JSON.stringify({ emailVerified: false }),
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await fetch(env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId, {
          method: 'PUT',
          headers: identityHeaders,
          body: JSON.stringify({ email: 'mismatch.' + mail }),
        })
      ).ok,
    ).toBe(true);
    const mismatch = await (
      await call('platform/companies/' + company.id + '/invite', 'POST', {})
    ).json();
    expect(mismatch.emailFailed).toBe(true);
    expect(mismatch.message).toContain('do not match');
    expect(
      (
        await fetch(env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId, {
          method: 'PUT',
          headers: identityHeaders,
          body: JSON.stringify({ email: mail }),
        })
      ).ok,
    ).toBe(true);
    sql(
      `UPDATE app_users SET email_attempt_at=now()-interval '2 minutes' WHERE id='${onboarding.id}'`,
    );
    // Real local SMTP outage: no delivered status or timestamp may be reported.
    execFileSync('docker', ['compose', 'stop', 'mailpit'], { stdio: 'pipe' });
    smtpStopped = true;
    try {
      await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: /^Invitation failed for/ }),
      ).toBeVisible({ timeout: 25000 });
      const failed = await (await call('platform/companies/' + company.id + '/onboarding')).json();
      expect(failed.delivery.details.status).toBe('failed');
      expect(failed.invitation_sent_at).toBeNull();
    } finally {
      execFileSync('docker', ['compose', 'start', 'mailpit'], { stdio: 'pipe' });
      smtpStopped = false;
    }
    await expect
      .poll(
        async () => {
          try {
            return (await request.get(env.MAILPIT_URL + '/livez')).status();
          } catch {
            return 0;
          }
        },
        { timeout: 15000 },
      )
      .toBe(200);
    sql(
      `UPDATE app_users SET email_attempt_at=now()-interval '2 minutes' WHERE id='${onboarding.id}'`,
    );
    await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
    await expect(
      page.getByText('Company ready. Invitation captured in the local inbox.', { exact: true }),
    ).toBeVisible();
    expect((await call('platform/companies/' + company.id + '/invite', 'POST', {})).status()).toBe(
      429,
    );
    const sent = await (await call('platform/companies/' + company.id + '/onboarding')).json();
    expect(sent.delivery.details.recipient).toBe(mail);
    expect(sent.delivery.details.status).toBe('captured');
    const payload = {
      requestId: b,
      name: 'QA Shared ' + suffix,
      code: 'QB' + suffix,
      contactEmail: mail,
      adminName: 'Main Admin',
      adminEmail: env.SEED_ADMIN_EMAIL,
    };
    const sharedCreated = await call('platform/companies', 'POST', payload);
    expect(sharedCreated.ok()).toBe(true);
    const sharedResult = await sharedCreated.json();
    expect(sharedResult.sharedLogin).toBe(true);
    expect(sharedResult.message).toContain('Use the existing password');
    expect((await (await call('platform/companies/' + b + '/onboarding')).json()).sharedLogin).toBe(
      true,
    );
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
    await completeTestMfa(cp, mail);
    await expect(
      cp.locator('#username').or(cp.getByRole('link', { name: /back to application/i })),
    ).toBeVisible();
    const back = cp.getByRole('link', { name: /back to application/i });
    if (await back.isVisible()) await back.click();
    await cp.locator('#username').fill(mail);
    await cp.locator('#password').fill('Company-Password-2026!');
    await cp.locator('#kc-login').click();
    await completeTestMfa(cp, mail);
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
    expect(
      (
        await cc('platform/companies/' + company.id + '/admin-email', 'PATCH', {
          email: 'denied.' + mail,
          version: corrected.version,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await call('platform/companies/' + company.id + '/admin-email', 'PATCH', {
          email: 'activated.' + mail,
          version: corrected.version,
        })
      ).status(),
    ).toBe(409);
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
    if (smtpStopped) execFileSync('docker', ['compose', 'start', 'mailpit'], { stdio: 'pipe' });
    for (const cleanupId of [identityId, mistakenIdentityId].filter(Boolean))
      await fetch(env.AUTH_URL + '/admin/realms/rare-os/users/' + cleanupId, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer ' + (await identityToken()) },
      });
    for (const tenant of ids)
      sql(
        `DELETE FROM user_sites WHERE tenant_id='${tenant}'; DELETE FROM app_users WHERE tenant_id='${tenant}'; DELETE FROM role_permissions WHERE tenant_id='${tenant}'; DELETE FROM roles WHERE tenant_id='${tenant}'; DELETE FROM audit_log WHERE tenant_id='${tenant}'; DELETE FROM tenants WHERE id='${tenant}'; DELETE FROM platform_audit WHERE company_id='${tenant}';`,
      );
  }
});
