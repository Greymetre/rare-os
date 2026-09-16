import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
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
async function login(page: any) {
  await page.goto('/');
  await page.getByRole('link', { name: /sign in securely/i }).click();
  await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
  await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  await completeTestMfa(page, env.SEED_ADMIN_EMAIL);
  await expect(page.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
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
function otp(secret: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of secret.replace(/\s/g, '').toUpperCase())
    bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
test('authenticator enrollment, OTP login and identity logout revoke app sessions', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(90000);
  let roleId = '',
    userId = '',
    identityId = '';
  let ctx: any;
  await login(page);
  const me = await (await page.request.get('/api/me')).json();
  const call = (path: string, method = 'GET', data?: unknown) =>
    page.request.fetch('/api/' + path, {
      method,
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
      data,
    });
  const email = 'security.' + Date.now() + '@example.test',
    password = 'Security-Test-Password-2026!';
  const kc = async (path: string, method = 'GET', data?: unknown) => {
    const r = await fetch(env.AUTH_URL + '/admin/realms/rare-os' + path, {
      method,
      headers: {
        Authorization: 'Bearer ' + (await identityToken()),
        'Content-Type': 'application/json',
      },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    expect(r.ok || (method === 'DELETE' && r.status === 404)).toBe(true);
    return r;
  };
  try {
    const r = await call('roles', 'POST', {
      name: 'Security QA ' + Date.now(),
      permissions: ['dashboard.read'],
    });
    expect(r.ok()).toBe(true);
    roleId = (await r.json()).id;
    userId = randomUUID();
    expect(
      (
        await call('users', 'POST', { name: 'Security Test', email, roleId, requestId: userId })
      ).ok(),
    ).toBe(true);
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    await kc('/users/' + identityId, 'PUT', { emailVerified: true, requiredActions: [] });
    await kc('/users/' + identityId + '/reset-password', 'PUT', {
      type: 'password',
      value: password,
      temporary: false,
    });
    ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto('/api/auth/login');
    await p.locator('#username').fill(email);
    await p.locator('#password').fill(password);
    await p.locator('#kc-login').click();
    await expect(p.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
    await p.getByRole('button', { name: 'Security', exact: true }).click();
    await expect(p.getByText('Not configured', { exact: true })).toBeVisible();
    await p.getByRole('link', { name: 'Set up authenticator' }).click();
    const username = p.locator('#username');
    await expect(
      p
        .locator('#password')
        .or(p.locator('#kc-totp-secret-key'))
        .or(p.getByRole('link', { name: /unable to scan/i })),
    ).toBeVisible();
    if (await p.locator('#password').isVisible()) {
      if (await username.isVisible()) await username.fill(email);
      await p.locator('#password').fill(password);
      await p.locator('#kc-login').click();
    }
    const manual = p.getByRole('link', { name: /unable to scan/i });
    if (await manual.isVisible()) await manual.click();
    await expect(p.locator('#kc-totp-secret-key')).toBeVisible();
    const secret = (await p.locator('#kc-totp-secret-key').innerText()).replace(/\s/g, '');
    const enrollmentCode = otp(secret);
    await p.locator('#totp').fill(enrollmentCode);
    const label = p.locator('#userLabel');
    if (await label.isVisible()) await label.fill('QA authenticator');
    await p.getByRole('button', { name: /submit/i }).click();
    await expect(p.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
    expect((await (await p.request.get('/api/security')).json()).mfaEnabled).toBe(true);
    await p.getByRole('button', { name: 'Sign out', exact: true }).click();
    await p.getByRole('link', { name: /sign in securely/i }).click();
    await p.locator('#username').fill(email);
    await p.locator('#password').fill(password);
    await p.locator('#kc-login').click();
    await expect(p.locator('#otp')).toBeVisible();
    await expect(p.locator('.rare-story')).toBeVisible();
    await p.screenshot({
      path: '.local/login-theme-mfa.png',
      fullPage: true,
      animations: 'disabled',
    });
    await expect
      .poll(() => otp(secret), { timeout: 35000, intervals: [500] })
      .not.toBe(enrollmentCode);
    await p.locator('#otp').fill(otp(secret));
    await p.locator('#kc-login').click();
    await expect(p.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
    expect(
      (
        await request.post('/api/auth/backchannel-logout', {
          form: { logout_token: 'forged.token.value' },
        })
      ).status(),
    ).toBe(400);
    await kc('/users/' + identityId + '/logout', 'POST');
    await expect.poll(async () => (await p.request.get('/api/me')).status()).toBe(401);
    await p.reload();
    await expect(p.getByRole('link', { name: /sign in securely/i })).toBeVisible();
  } finally {
    await ctx?.close();
    if (identityId) await kc('/users/' + identityId, 'DELETE');
    if (userId)
      sql(
        `DELETE FROM user_sites WHERE user_id='${userId}';DELETE FROM app_users WHERE id='${userId}';`,
      );
    if (roleId) {
      const detail = await (await call('roles/' + roleId)).json();
      expect((await call('roles/' + roleId, 'DELETE', { version: detail.version })).ok()).toBe(
        true,
      );
    }
  }
});
