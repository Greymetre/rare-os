import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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
      '-c',
      query,
    ],
    { encoding: 'utf8' },
  );
async function login(page: any) {
  await page.goto('/');
  await page.getByRole('link', { name: /sign in securely/i }).click();
  await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
  await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
}
test('unauthenticated access, callback validation and security headers', async ({ request }) => {
  const r = await request.get('/api/me');
  expect(r.status()).toBe(401);
  expect((await r.json()).error.code).toBe('LOGIN_REQUIRED');
  expect(r.headers()['x-content-type-options']).toBe('nosniff');
  expect((await request.post('/api/auth/logout')).status()).toBe(403);
  const cb = await request.get('/api/auth/callback?state=forged&code=fake');
  expect(cb.url()).toContain('authError=expired');
});
test('real Keycloak login, seed UI, worker, permission denial, expiry and logout', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  const me = await (await page.request.get('/api/me')).json();
  expect(me.user.permissions).toHaveLength(23);
  const cookie = (await page.context().cookies()).find((x) => x.name === 'rare.sid');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await expect(page.getByRole('cell', { name: env.SEED_ADMIN_EMAIL })).toBeVisible();
  await page.getByRole('button', { name: 'Roles & permissions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Permission catalog' })).toBeVisible();
  await page.getByLabel('Filter permissions').fill('purchase.approve');
  await expect(page.getByText('Approve purchase proposals', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Availability', exact: true }).click();
  await expect(page.getByText('NOT CONFIGURED', { exact: true })).toBeVisible();
  expect((await page.request.get('/api/audit?limit=101')).status()).toBe(400);
  expect((await page.request.get('/api/audit?cursor=invalid')).status()).toBe(400);
  sql(
    "DELETE FROM role_permissions WHERE role_id='20000000-0000-4000-8000-000000000001' AND permission_code='audit.read'",
  );
  try {
    expect((await page.request.get('/api/audit')).status()).toBe(403);
  } finally {
    sql(
      "INSERT INTO role_permissions(tenant_id,role_id,permission_code) VALUES('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','audit.read') ON CONFLICT DO NOTHING",
    );
  }
  sql("UPDATE app_users SET active=false WHERE id='30000000-0000-4000-8000-000000000001'");
  try {
    expect((await page.request.get('/api/me')).status()).toBe(401);
  } finally {
    sql("UPDATE app_users SET active=true WHERE id='30000000-0000-4000-8000-000000000001'");
  }
  const rejected = await page.request.post('/api/auth/logout', {
    headers: { Origin: env.APP_URL, 'X-CSRF-Token': 'wrong' },
  });
  expect(rejected.status()).toBe(403);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('link', { name: /sign in securely/i })).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
});
test('responsive dashboard and real-browser screenshots', async ({ page }) => {
  await login(page);
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.local/dashboard-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/dashboard-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('link', { name: /sign in securely/i })).toBeVisible();
});

test('gateway outage explains retry and recovers', async ({ page }) => {
  await page.route('**/api/me', (route) =>
    route.fulfill({ status: 502, contentType: 'text/html', body: 'Bad Gateway' }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('The server is temporarily unavailable.');
  await page.unroute('**/api/me');
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(page.getByRole('alert')).not.toBeVisible();
  await expect(page.getByRole('link', { name: /sign in securely/i })).toBeVisible();
});
