import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
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
  const d = createHmac('sha1', key).update(counter).digest(),
    o = d[d.length - 1] & 15;
  return ((d.readUInt32BE(o) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
test('MFA reset keeps or replaces one device; authenticated management removes and disables', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const used = new Map<string, string>();
  async function code(secret: string) {
    await expect
      .poll(() => otp(secret), { timeout: 35000, intervals: [500] })
      .not.toBe(used.get(secret));
    const c = otp(secret);
    used.set(secret, c);
    return c;
  }
  const token = async () =>
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
  const kc = async (path: string, method = 'GET', data?: unknown) => {
    const r = await request.fetch(env.AUTH_URL + '/admin/realms/rare-os' + path, {
      method,
      headers: { Authorization: 'Bearer ' + (await token()) },
      data,
    });
    expect(r.ok()).toBe(true);
    return r;
  };
  await page.goto('/api/auth/login');
  await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
  await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  await completeTestMfa(page, env.SEED_ADMIN_EMAIL);
  await expect(page.locator('.main > header')).toBeVisible();
  const me = await (await page.request.get('/api/me')).json();
  const call = (path: string, method = 'GET', data?: unknown) =>
    page.request.fetch('/api/' + path, {
      method,
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
      data,
    });
  const role = await call('roles', 'POST', {
    name: 'MFA QA ' + Date.now(),
    permissions: ['dashboard.read'],
  });
  expect(role.ok()).toBe(true);
  const roleId = (await role.json()).id,
    userId = randomUUID(),
    email = 'mfa.' + Date.now() + '@example.test';
  let identityId = '';
  let password = 'Mfa-Test-Original-2026!';
  const contexts: any[] = [];
  const newPage = async () => {
    const ctx = await browser.newContext();
    contexts.push(ctx);
    return ctx.newPage();
  };
  const home = async (p: Page) => {
    await expect(p.locator('.main > header')).toBeVisible();
    await expect(p.getByText('Connected', { exact: true })).toBeVisible();
  };
  const credentials = async () =>
    (await (await kc('/users/' + identityId + '/credentials')).json()).filter(
      (x: any) => x.type === 'otp',
    );
  async function authenticate(p: Page, secret?: string, label?: string) {
    await expect(p.locator('#password')).toBeVisible();
    if (await p.locator('#username').isVisible()) await p.locator('#username').fill(email);
    await p.locator('#password').fill(password);
    await p.locator('#kc-login').click();
    if (secret) {
      await expect(p.locator('#otp')).toBeVisible();
      if (label && (await p.getByText(label, { exact: true }).isVisible()))
        await p.getByText(label, { exact: true }).click();
      await p.locator('#otp').fill(await code(secret));
      await p.locator('#kc-login').click();
    }
  }
  async function enroll(p: Page, label: string) {
    const manual = p.getByRole('link', { name: /unable to scan/i });
    if (await manual.isVisible()) await manual.click();
    await expect(p.locator('#kc-totp-secret-key')).toBeVisible();
    const secret = (await p.locator('#kc-totp-secret-key').innerText()).replace(/\s/g, '');
    await p.locator('#totp').fill(await code(secret));
    await p.locator('#userLabel').fill(label);
    await p.getByRole('button', { name: /submit/i }).click();
    return secret;
  }
  async function reset(p: Page, hasMfa = true) {
    const old = (
      await (await request.get(env.MAILPIT_URL + '/api/v1/messages')).json()
    ).messages.map((m: any) => m.ID);
    await p.goto('/api/auth/login');
    await p.getByRole('link', { name: /forgot password/i }).click();
    await p.locator('#username').fill(email);
    await p.getByRole('button', { name: /submit/i }).click();
    let id = '';
    await expect
      .poll(async () => {
        const msgs = (await (await request.get(env.MAILPIT_URL + '/api/v1/messages')).json())
          .messages;
        id = msgs.find(
          (m: any) => !old.includes(m.ID) && m.To?.some((x: any) => x.Address === email),
        )?.ID;
        return !!id;
      })
      .toBe(true);
    const msg = await (await request.get(env.MAILPIT_URL + '/api/v1/message/' + id)).json();
    const link = msg.HTML.match(/href="([^"]*login-actions\/action-token[^"]*)"/)[1].replaceAll(
      '&amp;',
      '&',
    );
    await p.goto(link);
    if (hasMfa)
      await expect(
        p.getByRole('heading', { name: 'Reset password — authenticator choice' }),
      ).toBeVisible();
    else await expect(p.locator('#password-new')).toBeVisible();
    return link;
  }
  async function changePassword(p: Page, next: string) {
    await expect(p.locator('#password-new')).toBeVisible();
    await p.locator('#password-new').fill(next);
    await p.locator('#password-confirm').fill(next);
    await p.getByRole('button', { name: /submit/i }).click();
    password = next;
  }
  async function adminReset(ar: Page) {
    const oldMessages = (
      await (await request.get(env.MAILPIT_URL + '/api/v1/messages')).json()
    ).messages.map((m: any) => m.ID);
    let resetResponse: any;
    // Creation sends an invitation. Respect the real one-minute email cooldown.
    await expect
      .poll(
        async () => {
          resetResponse = await call('users/' + userId + '/reset-password', 'POST', {});
          return resetResponse.status() !== 429;
        },
        { timeout: 65000, intervals: [1000, 3000, 5000] },
      )
      .toBe(true);
    expect(
      resetResponse.ok(),
      `Admin reset ${resetResponse.status()}: ${await resetResponse.text()}`,
    ).toBe(true);
    let adminMailId = '';
    await expect
      .poll(async () => {
        const msgs = (await (await request.get(env.MAILPIT_URL + '/api/v1/messages')).json())
          .messages;
        adminMailId = msgs.find(
          (m: any) => !oldMessages.includes(m.ID) && m.To?.some((x: any) => x.Address === email),
        )?.ID;
        return !!adminMailId;
      })
      .toBe(true);
    const adminMail = await (
      await request.get(env.MAILPIT_URL + '/api/v1/message/' + adminMailId)
    ).json();
    const adminLink = adminMail.HTML.match(
      /href="([^"]*login-actions\/action-token[^"]*)"/,
    )[1].replaceAll('&amp;', '&');
    await ar.goto(adminLink);
    const proceed = ar.getByRole('link', { name: /proceed/i });
    if (await proceed.isVisible()) await proceed.click();
  }
  try {
    expect(
      (await call('users', 'POST', { name: 'MFA Test', email, roleId, requestId: userId })).ok(),
    ).toBe(true);
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    await kc('/users/' + identityId, 'PUT', { emailVerified: true, requiredActions: [] });
    await kc('/users/' + identityId + '/reset-password', 'PUT', {
      type: 'password',
      value: password,
      temporary: false,
    });
    const p = await newPage();
    await p.goto('/api/auth/login');
    await authenticate(p);
    await home(p);
    await p.goto('/api/auth/login?action=CONFIGURE_TOTP');
    await authenticate(p);
    const first = await enroll(p, 'Original phone');
    await home(p);
    await p.goto('/api/auth/login?action=CONFIGURE_TOTP');
    await authenticate(p, first);
    const second = await enroll(p, 'Backup phone');
    await home(p);
    const initial = await credentials();
    expect(initial).toHaveLength(2);
    const original = initial.find((x: any) => x.userLabel === 'Original phone');
    const backup = initial.find((x: any) => x.userLabel === 'Backup phone');
    await p.getByRole('button', { name: 'Security', exact: true }).click();
    await expect(p.getByText('Original phone', { exact: true })).toBeVisible();
    await expect(p.getByRole('link', { name: 'Turn off MFA' })).toBeVisible();
    await p.screenshot({ path: '.local/mfa-security.png', fullPage: true });
    console.log('PASS: two authenticators enrolled and shown in Security');
    const r = await newPage();
    const consumedLink = await reset(r);
    await r.screenshot({ path: '.local/mfa-reset-choice.png', fullPage: true });
    await r.setViewportSize({ width: 390, height: 844 });
    expect(await r.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await r.screenshot({ path: '.local/mfa-reset-mobile.png', fullPage: true });
    await r.setViewportSize({ width: 1280, height: 720 });
    await r.locator('#selectedCredentialId').selectOption(original.id);
    await r.locator('#otp').fill('000000');
    await r.locator('#rare-reset-continue').click();
    await expect(r.locator('#password-new')).not.toBeVisible();
    await r.locator('#selectedCredentialId').selectOption(original.id);
    await r.locator('#otp').fill(await code(first));
    await r.locator('#rare-reset-continue').click();
    await changePassword(r, 'Mfa-Test-Changed-2026!');
    expect((await credentials()).map((x: any) => x.id).sort()).toEqual(
      initial.map((x: any) => x.id).sort(),
    );
    console.log('PASS: password-only reset verifies OTP and retains both devices');
    const replay = await newPage();
    await replay.goto(consumedLink);
    await expect(replay.locator('#password-new')).not.toBeVisible();
    await expect(replay.locator('#rare-reset-continue')).not.toBeVisible();
    const replacement = await newPage();
    await reset(replacement);
    await replacement.locator('#selectedCredentialId').selectOption(original.id);
    await replacement.locator('[value="replace"]').check();
    await replacement.locator('#rare-reset-continue').click();
    await expect(
      replacement.getByText(
        'Confirm that the selected old authenticator will stop working after replacement.',
      ),
    ).toBeVisible();
    await replacement.locator('#selectedCredentialId').selectOption(original.id);
    await replacement.locator('[value="replace"]').check();
    await replacement.locator('[name="confirmReplace"]').check();
    await replacement.locator('#rare-reset-continue').click();
    await changePassword(replacement, 'Mfa-Test-Replaced-2026!');
    await expect(replacement.locator('#totp')).toBeVisible();
    await replacement.locator('#totp').fill('000000');
    await replacement.locator('#userLabel').fill('Replacement phone');
    await replacement.getByRole('button', { name: /submit/i }).click();
    expect((await credentials()).map((x: any) => x.id)).toContain(original.id);
    let third = await enroll(replacement, 'Replacement phone');
    const updated = await credentials();
    expect(updated).toHaveLength(2);
    expect(updated.map((x: any) => x.id)).not.toContain(original.id);
    expect(updated.map((x: any) => x.id)).toContain(backup.id);
    console.log(
      'PASS: replacement verifies new QR before removing selected old device; backup retained',
    );
    // Admin reset email must not bypass the same MFA checks.
    const ar = await newPage();
    await adminReset(ar);
    await expect(ar.locator('#selectedCredentialId')).toBeVisible();
    await ar.locator('#selectedCredentialId').selectOption(backup.id);
    await ar.locator('#otp').fill('000000');
    await ar.locator('#rare-reset-continue').click();
    await expect(ar.getByText('Invalid authenticator code.', { exact: true })).toBeVisible();
    await ar.locator('#selectedCredentialId').selectOption(backup.id);
    await ar.locator('#otp').fill(await code(second));
    await ar.locator('#rare-reset-continue').click();
    await changePassword(ar, 'Mfa-Test-AdminReset-2026!');
    expect(await credentials()).toHaveLength(2);
    console.log('PASS: admin-issued reset also verifies existing OTP and preserves devices');
    const manage = await newPage();
    await manage.goto('/api/auth/login');
    await authenticate(manage, third, 'Replacement phone');
    await home(manage);
    await manage.route(
      '**/protocol/openid-connect/auth?**',
      async (route) => {
        const url = new URL(route.request().url());
        url.searchParams.delete('prompt');
        url.searchParams.delete('max_age');
        await route.continue({ url: url.toString() });
      },
      { times: 1 },
    );
    await manage.goto('/api/auth/login?action=RARE_MANAGE_MFA');
    await authenticate(manage, second, 'Backup phone');
    await expect(
      manage.getByRole('heading', { name: 'Manage authenticator devices' }),
    ).toBeVisible();
    await manage.getByRole('button', { name: 'Remove selected device' }).click();
    await expect(manage.getByText('Confirm the change before continuing.')).toBeVisible();
    expect(await credentials()).toHaveLength(2);
    // A forged device ID must never mutate any credential.
    await manage.locator('#deviceId').evaluate((el: HTMLSelectElement) => {
      el.add(new Option('Invalid device', '00000000-0000-4000-8000-000000000000'));
      el.value = '00000000-0000-4000-8000-000000000000';
    });
    await manage.locator('[name="confirmed"]').check();
    await manage.getByRole('button', { name: 'Remove selected device' }).click();
    await expect(manage.getByText('Device changed. Refresh and select your device.')).toBeVisible();
    expect(await credentials()).toHaveLength(2);
    await manage.locator('#deviceId').selectOption(backup.id);
    await manage.locator('[name="confirmed"]').check();
    await manage.getByRole('button', { name: 'Remove selected device' }).click();
    await home(manage);
    expect(await credentials()).toHaveLength(1);
    await manage.goto('/api/auth/login?action=RARE_MANAGE_MFA');
    await authenticate(manage, third);
    await manage.locator('[name="confirmed"]').check();
    await manage.getByRole('button', { name: 'Remove selected device' }).click();
    await expect(
      manage.getByText('Use Turn off MFA to remove the last authenticator.'),
    ).toBeVisible();
    await manage.getByRole('button', { name: 'Cancel', exact: true }).click();
    await home(manage);
    // The administrator-issued recovery path must replace, not append, as well.
    const adminReplace = await newPage();
    await adminReset(adminReplace);
    await expect(adminReplace.locator('#selectedCredentialId')).toBeVisible();
    const lastOldId = (await credentials())[0].id;
    await adminReplace.locator('#selectedCredentialId').selectOption(lastOldId);
    await adminReplace.locator('[value="replace"]').check();
    await adminReplace.locator('[name="confirmReplace"]').check();
    await adminReplace.locator('#rare-reset-continue').click();
    await changePassword(adminReplace, 'Mfa-Test-AdminReplace-2026!');
    third = await enroll(adminReplace, 'Final phone');
    expect(await credentials()).toHaveLength(1);
    expect((await credentials())[0].id).not.toBe(lastOldId);
    console.log('PASS: admin-issued reset replacement removes its selected original device');
    const otherSession = await newPage();
    await otherSession.goto('/api/auth/login');
    await authenticate(otherSession, third);
    await home(otherSession);
    await manage.goto('/api/auth/login?action=CONFIGURE_RECOVERY_AUTHN_CODES');
    await authenticate(manage, third);
    await manage.locator('#kcRecoveryCodesConfirmationCheck').check();
    await manage.locator('#saveRecoveryAuthnCodesBtn').click();
    await home(manage);
    const beforeDisable = await (await kc('/users/' + identityId + '/credentials')).json();
    expect(beforeDisable.some((x: any) => x.type === 'recovery-authn-codes')).toBe(true);
    await manage.goto('/api/auth/login?action=RARE_DISABLE_MFA');
    await authenticate(manage, third);
    await expect(manage.getByRole('heading', { name: 'Turn off MFA' })).toBeVisible();
    await manage.getByRole('button', { name: 'Turn off MFA', exact: true }).click();
    await expect(manage.getByText('Confirm the change before continuing.')).toBeVisible();
    await manage.locator('[name="confirmed"]').check();
    await manage.getByRole('button', { name: 'Turn off MFA', exact: true }).click();
    await home(manage);
    expect(await credentials()).toHaveLength(0);
    const afterDisable = await (await kc('/users/' + identityId + '/credentials')).json();
    expect(afterDisable.some((x: any) => x.type === 'recovery-authn-codes')).toBe(false);
    await expect.poll(async () => (await otherSession.request.get('/api/me')).status()).toBe(401);
    expect((await page.request.get('/api/me')).ok()).toBe(true);
    const fresh = await newPage();
    await fresh.goto('/api/auth/login');
    await authenticate(fresh);
    await home(fresh);
    console.log(
      'PASS: provider enforces fresh password+OTP, forged-device denial, confirmation, last-device guard and MFA off',
    );
    const noMfa = await newPage();
    await reset(noMfa, false);
    await changePassword(noMfa, 'Mfa-Test-WithoutOtp-2026!');
    expect(await credentials()).toHaveLength(0);
    const finalLogin = await newPage();
    await finalLogin.goto('/api/auth/login');
    await authenticate(finalLogin);
    await home(finalLogin);
    await finalLogin.getByRole('button', { name: 'Security', exact: true }).click();
    await expect(finalLogin.getByRole('link', { name: 'Set up authenticator' })).toBeVisible();
    console.log('PASS: no-MFA password reset skips enrollment and allows subsequent sign-in');
  } finally {
    for (const ctx of contexts) await ctx.close();
    if (identityId) await kc('/users/' + identityId, 'DELETE');
    sql(
      `DELETE FROM user_sites WHERE user_id='${userId}';DELETE FROM app_users WHERE id='${userId}';`,
    );
    const detail = await (await call('roles/' + roleId)).json();
    expect((await call('roles/' + roleId, 'DELETE', { version: detail.version })).ok()).toBe(true);
  }
});
