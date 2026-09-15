import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    }),
);
test('unassigned identity can leave rejected SSO and sign in with another account', async ({
  page,
  request,
}) => {
  const email = 'recovery-' + randomUUID() + '@example.test';
  const tokenResponse = await request.post(
    'http://localhost:4311/realms/rare-os/protocol/openid-connect/token',
    {
      form: {
        grant_type: 'client_credentials',
        client_id: 'rare-os-identity',
        client_secret: env.IDENTITY_CLIENT_SECRET,
      },
    },
  );
  const token = (await tokenResponse.json()).access_token;
  const headers = { Authorization: 'Bearer ' + token };
  const created = await request.post('http://localhost:4311/admin/realms/rare-os/users', {
    headers,
    data: {
      username: email,
      email,
      enabled: true,
      emailVerified: true,
      firstName: 'Recovery',
      lastName: 'Test',
      credentials: [{ type: 'password', value: 'Recovery-Test-2026!', temporary: false }],
    },
  });
  expect(created.status()).toBe(201);
  const url = created.headers().location;
  try {
    await page.goto('/');
    await page.getByRole('link', { name: /sign in securely/i }).click();
    await page.locator('#username').fill(email);
    await page.locator('#password').fill('Recovery-Test-2026!');
    await page.locator('#kc-login').click();
    await expect(page.getByRole('alert')).toContainText('no active workspace membership');
    await page.getByRole('link', { name: 'Sign in with another account' }).click();
    await expect(page.locator('#username')).toBeVisible();
    await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
    await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
    await page.locator('#kc-login').click();
    await expect(page.locator('.main > header')).toBeVisible();
    expect((await page.request.get('/api/me')).ok()).toBe(true);
  } finally {
    const parsed = new URL(url);
    await request.delete('http://localhost:4311' + parsed.pathname, { headers });
  }
});
