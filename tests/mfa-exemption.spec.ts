import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { test, expect, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
const env = loadTestEnvironment();
const exemption = (...args: string[]) =>
  execFileSync(
    'docker',
    ['compose', 'run', '--rm', '--no-deps', 'seed', 'node', 'scripts/mfa-exemption.mjs', ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  ).trim();

async function signIn(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(env.APP_URL + '/api/auth/login');
  await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
  await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  return { context, page };
}

test('temporary MFA exemption: password-only sign-in, visible reminder, MFA back after removal', async ({
  browser,
}) => {
  test.setTimeout(240000);
  // The administrator has MFA before the exemption.
  let s = await signIn(browser);
  await completeTestMfa(s.page, env.SEED_ADMIN_EMAIL);
  await expect(s.page.locator('.main > header')).toBeVisible();
  await s.context.close();
  try {
    expect(exemption('add', env.SEED_ADMIN_EMAIL, '30', 'regression test')).toMatch(
      /MFA exemption for .* until .*Sign in with the password only/,
    );
    expect(exemption('list')).toContain('ACTIVE');
    // Password only: no code and no authenticator setup is asked for.
    s = await signIn(browser);
    await expect(s.page.locator('#otp')).toHaveCount(0);
    await expect(s.page.locator('#kc-totp-secret-qr-code')).toHaveCount(0);
    await expect(s.page.locator('.main > header')).toBeVisible();
    await expect(s.page.locator('.environment.warning')).toContainText('MFA OFF UNTIL');
    expect((await (await s.page.request.get('/api/security')).json()).mfaRequired).toBe(false);
    await s.context.close();
    // Longer than 60 days is refused.
    expect(() => exemption('add', env.SEED_ADMIN_EMAIL, '61', 'too long')).toThrow();
  } finally {
    expect(exemption('remove', env.SEED_ADMIN_EMAIL)).toMatch(/removed|had no MFA exemption/);
  }
  // After removal the next sign-in requires setting up an authenticator again.
  s = await signIn(browser);
  await expect(s.page.locator('#kc-totp-secret-qr-code')).toBeVisible();
  await completeTestMfa(s.page, env.SEED_ADMIN_EMAIL);
  await expect(s.page.locator('.main > header')).toBeVisible();
  await expect(s.page.locator('.environment.warning')).toHaveCount(0);
  expect(exemption('list')).toContain('No MFA exemptions');
  await s.context.close();
});
