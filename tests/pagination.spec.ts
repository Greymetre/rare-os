// Every table footer answers the same three questions: where am I, how long is the list, and how
// much of it do I want on screen at once. The Units table is the one used here because it is the
// easiest to fill with a known number of rows; the footer itself is shared by every table.
import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { withRateLimitRetry } from './helpers/api';
import { test, expect } from '@playwright/test';
import { openScreen } from './helpers/nav';
import { execFileSync } from 'node:child_process';
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

test('a table says where the reader is, how long the list is, and how much to show', async ({
  page,
}) => {
  test.setTimeout(180000);
  const prefix = 'P' + Date.now().toString().slice(-6);
  await page.goto('/');
  await page.getByRole('link', { name: /sign in securely/i }).click();
  await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
  await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  await completeTestMfa(page, env.SEED_ADMIN_EMAIL);
  await expect(page.locator('.main > header')).toBeVisible();
  const me = await (await page.request.get('/api/me')).json();
  const call = (path: string, method = 'GET', data?: unknown) =>
    withRateLimitRetry(() =>
      page.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
        data,
      }),
    );
  try {
    // Twelve rows: enough that ten of them is a page and a bit, which is the interesting case.
    for (let n = 1; n <= 12; n++)
      expect(
        (
          await call('units', 'POST', {
            code: prefix + String(n).padStart(2, '0'),
            name: 'Paging unit ' + n,
            decimals: 0,
          })
        ).ok(),
      ).toBe(true);

    // The count comes back with the page, and it counts the whole list, not the page.
    const first = await (await call(`units?q=${prefix.toLowerCase()}&limit=10`)).json();
    expect(first.items.length).toBe(10);
    expect(first.total).toBe(12);
    expect(first.pageSize).toBe(10);
    const second = await (
      await call(`units?q=${prefix.toLowerCase()}&limit=10&after=` + first.nextCursor)
    ).json();
    expect(second.items.length).toBe(2);
    expect(second.total).toBe(12, 'the total is of the list, so it does not shrink on page two');
    expect(second.nextCursor).toBeNull();
    expect((await call('units?limit=101')).status()).toBe(400);

    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(page, 'Units');
    await page.getByLabel('Unit search').fill(prefix);
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    const footer = page.locator('.table-footer');
    const rows = page.getByRole('row').filter({ hasText: prefix });

    await footer.getByLabel('Rows per page').selectOption('10');
    await expect(footer.getByRole('status')).toHaveText('Showing 1–10 of 12 units · Page 1 of 2', {
      timeout: 15000,
    });
    await expect(rows).toHaveCount(10);
    // On the first page there is nowhere to go back to.
    await expect(footer.getByRole('button', { name: 'First page' })).toBeDisabled();
    await expect(footer.getByRole('button', { name: 'Previous page' })).toBeDisabled();

    await footer.getByRole('button', { name: 'Next page' }).click();
    await expect(footer.getByRole('status')).toHaveText('Showing 11–12 of 12 units · Page 2 of 2');
    await expect(rows).toHaveCount(2);
    await expect(footer.getByRole('button', { name: 'Next page' })).toBeDisabled();

    await footer.getByRole('button', { name: 'Previous page' }).click();
    await expect(footer.getByRole('status')).toHaveText('Showing 1–10 of 12 units · Page 1 of 2');

    // A bigger page swallows the whole list, and the reader is put back at the top of it.
    await footer.getByRole('button', { name: 'Next page' }).click();
    await expect(footer.getByRole('status')).toHaveText('Showing 11–12 of 12 units · Page 2 of 2');
    await footer.getByLabel('Rows per page').selectOption('25');
    await expect(footer.getByRole('status')).toHaveText('Showing 1–12 of 12 units · Page 1 of 1');
    await expect(rows).toHaveCount(12);
    await expect(footer.getByRole('button', { name: 'Next page' })).toBeDisabled();

    // A search that matches nothing says so, rather than showing a page of nothing.
    await page.getByLabel('Unit search').fill(prefix + 'ZZZ');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(footer.getByRole('status')).toHaveText('No units');
  } finally {
    sql(`DELETE FROM units WHERE code LIKE '${prefix}%'`);
  }
});
