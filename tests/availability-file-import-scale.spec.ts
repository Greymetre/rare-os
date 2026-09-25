import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { withRateLimitRetry } from './helpers/api';
import { test, expect } from '@playwright/test';
import { openScreen } from './helpers/nav';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { workbook } from './helpers/workbook-fixture.mjs';
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
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

// AV-12 at the size the real exports are: the Nilkamal sales history is 287,653 rows, so the
// supported size is 300,000. One sheet of that size goes through upload, mapping, validation and
// commit, and the numbers it lands are checked against the file it came from.
test('AV-12 scale: a 300,000-row sheet is read, reconciled and committed', async ({ page }) => {
  test.setTimeout(1500000);
  const suffix = Date.now().toString().slice(-6),
    p = 'S' + suffix;
  const plant = p + 'P1';
  const ROWS = 300000;
  let plantId = '';
  await page.goto('/');
  await page.getByRole('link', { name: /sign in securely/i }).click();
  await page.locator('#username').fill(env.SEED_ADMIN_EMAIL);
  await page.locator('#password').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#kc-login').click();
  await completeTestMfa(page, env.SEED_ADMIN_EMAIL);
  await expect(page.locator('.main > header')).toBeVisible();
  const me = await (await page.request.get('/api/me')).json();
  const call = (
    path: string,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
  ) =>
    withRateLimitRetry(() =>
      page.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken, ...headers },
        data,
      }),
    );
  const ok = async (path: string, method = 'GET', data?: unknown) => {
    const r = await call(path, method, data);
    const body = await r.json();
    expect(r.ok(), `${method} ${path}: ${JSON.stringify(body)}`).toBe(true);
    return body;
  };
  const settled = async (id: string) => {
    let batch: any;
    await expect
      .poll(
        async () => {
          batch = await ok('imports/' + id);
          return ['validating', 'committing'].includes(batch.status);
        },
        { timeout: 900000, intervals: [2000, 5000] },
      )
      .toBe(false);
    return batch;
  };
  try {
    await ok('units', 'POST', { code: p + 'NOS', name: 'Numbers', decimals: 0 });
    await ok('masters/items', 'POST', {
      code: p + 'FG1',
      name: 'Item FG1',
      item_type: 'FG',
      make_buy: 'MAKE',
      base_unit: p + 'NOS',
      standard_cost: '10',
    });
    plantId = (
      await ok('plants', 'POST', {
        code: plant,
        name: 'Plant ' + plant,
        location: 'Test',
        timezone: 'Asia/Kolkata',
      })
    ).id;

    // A sheet the size of the real sales history: one invoice line per row, 250 days of it.
    const built = Date.now();
    const rows: string[][] = [['Plant', 'Material', 'Billing Date', 'Billing Qty']];
    for (let i = 0; i < ROWS; i++)
      rows.push([plant, p + 'FG1', day(-1 - (i % 250)), String((i % 9) + 1)]);
    const bytes = workbook({ SALES: rows });
    const buildSeconds = Math.round((Date.now() - built) / 100) / 10;
    expect(bytes.length).toBeLessThan(40 * 1024 * 1024);

    const uploadStarted = Date.now();
    const file = await (
      await call('imports/raw/files', 'POST', bytes, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'X-File-Name': `sales-${suffix}.xlsx`,
      })
    ).json();
    expect(file.id, JSON.stringify(file)).toBeTruthy();
    const uploadSeconds = Math.round((Date.now() - uploadStarted) / 100) / 10;

    const stagedAt = Date.now();
    const staged = await ok(`imports/raw/files/${file.id}/stage`, 'POST', {
      kind: 'demand_history',
      sheet: 'SALES',
      headerRow: 1,
      firstDataRow: 2,
      columns: {
        plant: { by: 'position', index: 0 },
        item: { by: 'position', index: 1 },
        demand_date: { by: 'position', index: 2, transform: 'date' },
        quantity: { by: 'position', index: 3, transform: 'number' },
      },
      options: {
        decimal: 'auto',
        dateFormat: 'auto',
        skipBlankRows: true,
        // A sales export is one row per invoice line; demand history holds one row per day, so the
        // lines of a day are added up as they are read.
        combine: ['plant', 'item', 'demand_date'],
        sum: 'quantity',
      },
    });
    const batch = await settled(staged.id);
    const readSeconds = Math.round((Date.now() - stagedAt) / 100) / 10;
    expect([batch.status, batch.error_rows, batch.error ?? '']).toEqual(['validated', 0, '']);
    // Every one of the 300,000 lines is accounted for: 250 days kept, the rest added into them.
    expect(batch.reconciliation.sheetRows).toBe(ROWS + 1);
    expect(batch.reconciliation.sourceRows).toBe(ROWS);
    expect(batch.reconciliation.combined).toBe(ROWS - 250);
    expect(batch.reconciliation.staged).toBe(250);
    expect(batch.reconciliation.unaccounted).toBe(0);
    expect(batch.total_rows).toBe(250);

    const commitStarted = Date.now();
    await ok(`imports/${staged.id}/commit`, 'POST', { version: batch.version });
    const committed = await settled(staged.id);
    const commitSeconds = Math.round((Date.now() - commitStarted) / 100) / 10;
    expect(committed.status).toBe('committed');

    // What landed is what the file said: 250 days, each with its own total.
    const demand = await ok(`plants/${plantId}/demand-history?q=${(p + 'FG1').toLowerCase()}`);
    expect(demand.items.length).toBeGreaterThan(0);
    const total = Number(
      sql(`SELECT coalesce(sum(quantity),0) FROM demand_history WHERE site_id='${plantId}'`),
    );
    let expected = 0;
    for (let i = 0; i < ROWS; i++) expected += (i % 9) + 1;
    expect(total).toBe(expected);
    console.log(
      `AV-12 scale: ${ROWS.toLocaleString('en-IN')} rows · file ${(bytes.length / 1048576).toFixed(1)} MB ` +
        `· built ${buildSeconds}s · uploaded ${uploadSeconds}s · read and validated ${readSeconds}s · committed ${commitSeconds}s`,
    );
    // A file this size has to go through while someone waits, not overnight.
    expect(readSeconds).toBeLessThan(300);
    expect(commitSeconds).toBeLessThan(300);
  } finally {
    const sites = `SELECT id FROM sites WHERE code LIKE '${p}%'`,
      items = `SELECT id FROM items WHERE code LIKE '${p}%'`;
    sql(`DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE file_name LIKE '%${suffix}%');
      DELETE FROM import_batches WHERE file_name LIKE '%${suffix}%';
      DELETE FROM import_files WHERE file_name LIKE '%${suffix}%';
      DELETE FROM demand_history WHERE site_id IN (${sites});
      DELETE FROM planning_results WHERE item_id IN (${items});
      DELETE FROM item_buffers WHERE item_id IN (${items});
      DELETE FROM plant_planning WHERE site_id IN (${sites});
      DELETE FROM plant_sequence WHERE site_id IN (${sites});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
