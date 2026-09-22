import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { test, expect, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
const env = loadTestEnvironment();
const sql = (q: string) =>
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
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      q,
    ],
    { encoding: 'utf8' },
  ).trim();
function otp(secret: string) {
  let bits = '';
  for (const c of secret.replace(/\s/g, '').toUpperCase())
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const hash = createHmac('sha1', key).update(counter).digest(),
    offset = hash[hash.length - 1] & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
test('admin MFA is mandatory across companies; recovery login works once; normal users can disable', async ({
  browser,
  request,
}) => {
  test.setTimeout(480000);
  // All identities and memberships below are disposable; never enroll or alter a real seed admin.
  const tenant = randomUUID(),
    other = randomUUID(),
    member = randomUUID(),
    otherMember = randomUUID(),
    role = randomUUID(),
    adminRole = randomUUID();
  const email = 'mandatory.' + Date.now() + '@example.test',
    password = 'Mandatory-Mfa-Test-2026!';
  let id = '',
    secret = '',
    previous = '';
  const contexts: any[] = [];
  const newToken = async () =>
    (
      await (
        await request.post(env.AUTH_URL + '/realms/rare-os/protocol/openid-connect/token', {
          form: {
            grant_type: 'client_credentials',
            client_id: 'rare-os-identity',
            client_secret: env.IDENTITY_CLIENT_SECRET,
          },
        })
      ).json()
    ).access_token;
  let token = await newToken();
  // The service token is short-lived and this test runs for minutes: renew it once when it expires.
  const kc = async (path: string, method = 'GET', data?: unknown) => {
    const send = () =>
      request.fetch(env.AUTH_URL + '/admin/realms/rare-os' + path, {
        method,
        headers: { Authorization: 'Bearer ' + token },
        data,
      });
    let r = await send();
    if (r.status() === 401) {
      token = await newToken();
      r = await send();
    }
    expect(r.ok(), `${method} ${path}: ${r.status()}`).toBe(true);
    return r;
  };
  const fresh = async () => {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    return ctx.newPage();
  };
  const start = async (p: Page, path = '/api/auth/login') => {
    await p.goto(path);
    await expect(p.locator('#password')).toBeVisible();
    if (await p.locator('#username').isVisible()) await p.locator('#username').fill(email);
    await p.locator('#password').fill(password);
    await p.locator('#kc-login').click();
  };
  const code = async () => {
    await expect.poll(() => otp(secret), { timeout: 35000, intervals: [500] }).not.toBe(previous);
    previous = otp(secret);
    return previous;
  };
  const verify = async (p: Page) => {
    await expect(p.locator('#otp')).toBeVisible();
    await p.locator('#otp').fill(await code());
    await p.locator('#kc-login').click();
  };
  const ready = async (p: Page) => {
    await expect(
      p.locator('.main > header').or(p.getByRole('heading', { name: 'Select your company' })),
    ).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => (await p.request.get('/api/me')).status()).toBe(200);
  };
  const creds = async () =>
    (await (await kc('/users/' + id + '/credentials')).json()).filter((c: any) => c.type === 'otp');
  try {
    await kc('/users', 'POST', {
      username: email,
      firstName: 'Policy',
      lastName: 'QA',
      email,
      enabled: true,
      emailVerified: true,
      credentials: [{ type: 'password', value: password, temporary: false }],
    });
    id = (await (await kc('/users?exact=true&username=' + encodeURIComponent(email))).json())[0].id;
    sql(
      `INSERT INTO tenants(id,name,code) VALUES('${tenant}','MFA policy QA','${tenant}'),('${other}','Other company MFA QA','${other}'); INSERT INTO roles(id,tenant_id,name,is_system) VALUES('${role}','${tenant}','Reader',false),('${adminRole}','${other}','Main Admin',true); INSERT INTO role_permissions VALUES('${tenant}','${role}','dashboard.read'),('${other}','${adminRole}','dashboard.read'); INSERT INTO app_users(id,tenant_id,identity_id,email,name,role_id,sync_state) VALUES('${member}','${tenant}','${id}','${email}','MFA QA','${role}','ready');`,
    );
    const old = await fresh();
    await start(old);
    await ready(old);
    expect((await (await old.request.get('/api/security')).json()).mfaRequired).toBe(false);
    // Admin in a second company: an existing password-only session must immediately lose access.
    sql(
      `INSERT INTO app_users(id,tenant_id,identity_id,email,name,role_id,sync_state) VALUES('${otherMember}','${other}','${id}','${email}','MFA QA','${adminRole}','ready');`,
    );
    expect((await old.request.get('/api/me')).status()).toBe(401);
    expect((await old.request.get('/api/session/companies')).status()).toBe(401);
    const p = await fresh();
    await start(p);
    await expect(
      p.getByText('MFA is required for your administrator access.', { exact: false }),
    ).toBeVisible();
    expect((await p.request.get('/api/me')).status()).toBe(401);
    await p.getByRole('link', { name: /unable to scan/i }).click();
    await expect(p.locator('#kc-totp-secret-key')).toBeVisible();
    secret = (await p.locator('#kc-totp-secret-key').innerText()).replace(/\s/g, '');
    await p.locator('#totp').fill('invalid');
    await p.getByRole('button', { name: /submit/i }).click();
    expect(await creds()).toHaveLength(0);
    await p.locator('#totp').fill(await code());
    await p.locator('#userLabel').fill('QA required phone');
    await p.getByRole('button', { name: /submit/i }).click();
    await ready(p);
    const security = await (await p.request.get('/api/security')).json();
    expect(security.mfaRequired).toBe(true);
    expect(security.mfaEnabled).toBe(true);
    await p.getByRole('button', { name: `MFA policy QA (${tenant})`, exact: true }).click();
    await p.getByRole('button', { name: 'Security', exact: true }).click();
    await expect(
      p.getByText('MFA is required for your administrator access,', { exact: false }),
    ).toBeVisible();
    await expect(p.getByRole('link', { name: 'Turn off MFA', exact: true })).toHaveCount(0);
    await p.screenshot({ path: '.local/admin-mfa-security.png', fullPage: true });
    const before = (await creds()).map((x: any) => x.id);
    // Direct AIA bypass cannot disable mandatory MFA.
    await start(p, '/api/auth/login?action=RARE_DISABLE_MFA');
    await verify(p);
    await p.locator('[name="confirmed"]').check();
    await expect(p.getByRole('button', { name: 'Turn off MFA', exact: true })).toBeDisabled();
    // Forge the disabled form submission to prove enforcement is server-side.
    await p.locator('form').evaluate((form: HTMLFormElement) => {
      const input = document.createElement('input');
      input.name = 'operation';
      input.value = 'disable';
      form.append(input);
      form.requestSubmit();
    });
    await expect(
      p.getByText('MFA is required for administrator access and cannot be turned off.', {
        exact: true,
      }),
    ).toBeVisible();
    expect((await creds()).map((x: any) => x.id)).toEqual(before);
    await p.getByRole('button', { name: 'Cancel', exact: true }).click();
    await ready(p);
    await start(p, '/api/auth/login?action=RARE_MANAGE_MFA');
    await verify(p);
    await p.locator('[name="confirmed"]').check();
    await p.getByRole('button', { name: 'Remove selected device', exact: true }).click();
    await expect(
      p.getByText(
        'Administrators must keep at least one authenticator. Add or replace a device before removing this one.',
        { exact: false },
      ),
    ).toBeVisible();
    expect(await creds()).toHaveLength(1);
    await p.getByRole('button', { name: 'Cancel', exact: true }).click();
    await ready(p);
    await start(p, '/api/auth/login?action=CONFIGURE_RECOVERY_AUTHN_CODES');
    await verify(p);
    // Codes are kept in memory only, never printed or captured in screenshots.
    const codes = await p.locator('#kc-recovery-codes-list li').allTextContents();
    expect(codes.length).toBeGreaterThan(1);
    const recovery = codes[0].replace(/^\s*\d+:\s*/, '').trim();
    await p.locator('#kcRecoveryCodesConfirmationCheck').check();
    await p.locator('#saveRecoveryAuthnCodesBtn').click();
    await ready(p);
    const recover = async (page: Page, value: string) => {
      await start(page);
      await page.getByRole('link', { name: /try another way/i }).click();
      await page.getByText('Recovery Authentication Code', { exact: true }).click();
      await page.locator('input[name="recoveryCodeInput"]').fill(value);
      await page.locator('#kc-login').click();
    };
    const r = await fresh();
    await recover(r, recovery);
    await ready(r);
    const replay = await fresh();
    await recover(replay, recovery);
    await expect(replay.locator('input[name="recoveryCodeInput"]')).toBeVisible();
    expect((await replay.request.get('/api/me')).status()).toBe(401);
    // Platform grant and delegated access permissions also require MFA; inactive memberships do not.
    sql(`UPDATE app_users SET active=false WHERE id='${otherMember}';`);
    expect(sql(`SELECT identity_requires_mfa('${id}')`)).toBe('f');
    sql(`INSERT INTO platform_admins(identity_id) VALUES('${id}');`);
    expect(sql(`SELECT identity_requires_mfa('${id}')`)).toBe('t');
    sql(
      `DELETE FROM platform_admins WHERE identity_id='${id}'; INSERT INTO role_permissions VALUES('${tenant}','${role}','roles.update');`,
    );
    expect(sql(`SELECT identity_requires_mfa('${id}')`)).toBe('t');
    sql(`DELETE FROM role_permissions WHERE role_id='${role}' AND permission_code='roles.update';`);
    expect(sql(`SELECT identity_requires_mfa('${id}')`)).toBe('f');
    await start(p, '/api/auth/login?action=RARE_DISABLE_MFA');
    await verify(p);
    await p.locator('[name="confirmed"]').check();
    await p.getByRole('button', { name: 'Turn off MFA', exact: true }).click();
    await ready(p);
    expect(await creds()).toHaveLength(0);
    const normal = await fresh();
    await start(normal);
    await ready(normal);
    expect((await (await normal.request.get('/api/security')).json()).mfaRequired).toBe(false);
    expect(
      sql(
        "SELECT has_function_privilege('rare_keycloak','identity_requires_mfa(text)','EXECUTE') AND NOT has_table_privilege('rare_keycloak','app_users','SELECT')",
      ),
    ).toBe('t');
    console.log(
      'PASS: mandatory enrollment, existing-session denial, cross-company requirement, disable/last-device denial, recovery login/reuse denial, platform and delegated policy, normal-user disable.',
    );
  } finally {
    for (const ctx of contexts) await ctx.close();
    if (id) {
      await kc('/users/' + id, 'DELETE');
      sql(`DELETE FROM platform_admins WHERE identity_id='${id}';`);
    }
    sql(
      `DELETE FROM audit_log WHERE tenant_id IN ('${tenant}','${other}'); DELETE FROM app_users WHERE tenant_id IN ('${tenant}','${other}'); DELETE FROM role_permissions WHERE tenant_id IN ('${tenant}','${other}'); DELETE FROM roles WHERE tenant_id IN ('${tenant}','${other}'); DELETE FROM tenants WHERE id IN ('${tenant}','${other}');`,
    );
  }
});
