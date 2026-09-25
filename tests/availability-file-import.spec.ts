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

// AV-12 on synthetic data: a workbook that behaves like an ERP export — a title row above the
// header, a repeated header name, another plant's rows, a blank row, stock at zero and a cell that
// is not a number — read into the stock import through a mapping, reconciled, then committed.
test('AV-12 file import: a sheet is mapped, reconciled and committed, with its provenance kept', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'F' + suffix,
    userId = randomUUID(),
    email = `import.viewer.${suffix}@example.test`;
  const plant = p + 'P1',
    other = p + 'P2';
  let plantId = '',
    otherId = '',
    fileId = '',
    roleId = '',
    identityId = '',
    context: any;
  const token = (
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
  const kcHeaders = { Authorization: 'Bearer ' + token };
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
  const refused = async (
    path: string,
    method: string,
    data: unknown,
    status: number,
    text: RegExp,
    headers: Record<string, string> = {},
  ) => {
    const r = await call(path, method, data, headers);
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(status);
    expect(body.error.message).toMatch(text);
  };
  const upload = (bytes: Buffer, name = 'export.xlsx') =>
    call('imports/raw/files', 'POST', bytes, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'X-File-Name': name,
    });
  // Reading a sheet and saving its rows both run in the background: wait for the batch to settle.
  const batchAfter = async (id: string) => {
    let batch: any;
    await expect
      .poll(
        async () => {
          batch = await ok('imports/' + id);
          return ['validating', 'committing'].includes(batch.status);
        },
        { timeout: 120000, intervals: [1000, 2000] },
      )
      .toBe(false);
    return batch;
  };

  // The export: a title row, then the header on row 2, then rows an import has to account for.
  const bytes = workbook({
    MB52: [
      ['Stock on hand as at 21.09.2026', '', '', '', '', '', ''],
      ['Material', 'Plnt', 'SLoc', 'BUn', 'Unrestricted', 'Unrestricted', 'Stock type'],
      [p + 'RM1', plant, p + 'LOC', 'EA', '1,240.5', '0', 'UNRESTR'],
      [p + 'RM2', plant, p + 'LOC', 'EA', '60', '0', 'UNRESTR'],
      ['', '', '', '', '', '', ''],
      [p + 'RM1', other, p + 'LOC', 'EA', '99', '0', 'UNRESTR'],
      [p + 'RM2', plant, p + 'LOC', 'EA', '0', '0', 'UNRESTR'],
      [p + 'NOPE', plant, p + 'LOC', 'EA', '7', '0', 'UNRESTR'],
      [p + 'RM1', plant, p + 'LOC2', 'EA', 'n/a', '0', 'UNRESTR'],
    ],
    CT: [['Material', 'Cycle time']],
  });

  try {
    await ok('units', 'POST', { code: p + 'NOS', name: 'Numbers', decimals: 3 });
    for (const code of ['RM1', 'RM2'])
      await ok('masters/items', 'POST', {
        code: p + code,
        name: 'Item ' + code,
        item_type: 'RM',
        make_buy: 'BUY',
        base_unit: p + 'NOS',
        standard_cost: '10',
      });
    for (const [code, id] of [
      [plant, 'plantId'],
      [other, 'otherId'],
    ] as const) {
      const created = await ok('plants', 'POST', {
        code,
        name: 'Plant ' + code,
        location: 'Test',
        timezone: 'Asia/Kolkata',
      });
      if (id === 'plantId') plantId = created.id;
      else otherId = created.id;
    }
    for (const site of [plantId, otherId])
      for (const code of [p + 'LOC', p + 'LOC2'])
        await ok(`plants/${site}/stock-locations`, 'POST', {
          code,
          name: 'Store ' + code,
          location_type: 'STORES',
          nettable: true,
        });

    // A file that is not a workbook at all is refused before anything is stored.
    await refused(
      'imports/raw/files',
      'POST',
      Buffer.from('plant,item\n1,2\n'),
      400,
      /not an .xlsx or .xls workbook/,
      { 'Content-Type': 'application/vnd.ms-excel', 'X-File-Name': 'not-a-workbook.xls' },
    );

    const uploaded = await (await upload(bytes, 'MB52-' + suffix + '.xlsx')).json();
    fileId = uploaded.id;
    expect(uploaded.format).toBe('xlsx');
    expect(uploaded.sheets.map((s: any) => s.name)).toEqual(['MB52', 'CT']);
    // The same bytes are kept once: a second upload points at the file already here.
    const again = await (await upload(bytes, 'again.xlsx')).json();
    expect(again.id).toBe(fileId);
    expect(again.message).toMatch(/already here as file #/);

    // The sheet as the file has it: the header is on row 2, and it repeats a name.
    const preview = await ok(
      `imports/raw/files/${fileId}/preview?sheet=MB52&headerRow=2&kind=stock_movements`,
    );
    expect(preview.header.map((h: any) => h.name)).toEqual([
      'Material',
      'Plnt',
      'SLoc',
      'BUn',
      'Unrestricted',
      'Unrestricted',
      'Stock type',
    ]);
    expect(preview.duplicates).toEqual(['Unrestricted']);
    expect(preview.rows[0].row).toBe(3);
    // The suggestion finds the obvious columns and leaves the rest to a person.
    expect(
      Object.fromEntries(
        Object.entries(preview.suggestion.columns).map(([f, c]: any) => [f, c.index]),
      ),
    ).toMatchObject({ item: 0, plant: 1, location: 2, unit: 3 });
    expect(preview.suggestion.unmatched).toContain('movement_date');

    const columns = {
      item: { by: 'position', index: 0 },
      plant: { by: 'position', index: 1 },
      location: { by: 'position', index: 2 },
      unit: { by: 'position', index: 3, transform: 'unit' },
      // The repeated header is taken by its position: the first one, not the empty second.
      quantity: { by: 'position', index: 4, transform: 'number' },
      movement_type: { by: 'position', index: 6 },
      movement_date: { by: 'constant', value: day(0) },
    };
    const options = {
      decimal: 'auto',
      dateFormat: 'auto',
      uomAliases: { EA: p + 'NOS' },
      skipBlankRows: true,
      filters: [
        { field: 'plant', op: 'equals', value: plant },
        { field: 'quantity', op: 'not_zero' },
      ],
      // The sheet has no reference column: the fields that make a row unique become one.
      referenceFrom: ['item', 'location'],
      // What SAP calls this stock, and what this import calls it.
      valueMaps: { movement_type: { UNRESTR: 'OPENING' } },
    };

    // A mapping that does not fit the sheet is refused before any row is staged.
    await refused(
      `imports/raw/files/${fileId}/stage`,
      'POST',
      {
        kind: 'stock_movements',
        sheet: 'MB52',
        headerRow: 2,
        columns: { item: { by: 'name', name: 'Unrestricted' } },
      },
      400,
      /appears 2 times: choose which one by position/,
    );
    await refused(
      `imports/raw/files/${fileId}/stage`,
      'POST',
      { kind: 'stock_movements', sheet: 'MB52', headerRow: 2, columns: {} },
      400,
      /Map at least one column/,
    );

    const staged = await ok(`imports/raw/files/${fileId}/stage`, 'POST', {
      kind: 'stock_movements',
      sheet: 'MB52',
      headerRow: 2,
      firstDataRow: 3,
      columns,
      options,
      saveAs: p + 'MB52',
      saveName: 'SAP stock export',
    });
    const batch = await batchAfter(staged.id);
    expect(batch.status).toBe('validated');
    expect(batch.sheet).toBe('MB52');
    expect(batch.header_row).toBe(2);

    // Every row of the sheet is accounted for.
    const r = batch.reconciliation;
    expect(r.sheetRows).toBe(9);
    expect(r.sourceRows).toBe(7);
    expect(r.blank).toBe(1);
    expect(r.removed).toBe(2);
    expect(r.filtered).toEqual(
      expect.arrayContaining([
        { rule: `plant equals "${plant}"`, count: 1 },
        { rule: 'quantity not zero', count: 1 },
      ]),
    );
    expect(r.staged).toBe(4);
    expect(r.unaccounted).toBe(0);
    // Two rows are good, two are not: an unknown item and a quantity that is not a number.
    expect(r.mapped).toBe(2);
    expect(r.failed).toBe(2);
    expect(r.totals).toEqual([{ unit: p + 'NOS', rows: 2, quantity: 1300.5 }]);
    expect(r.reasons.map((x: any) => x.message).join(' ')).toMatch(/not a number/);
    const errors = await ok(`imports/${staged.id}/rows?errors=true`);
    expect(errors.items.map((x: any) => x.line_no)).toEqual([8, 9]);
    // The reason names the cell and the column it sits in.
    expect(errors.items[1].errors[0].message).toMatch(/n\/a.* is not a number\. \(column 5\)/);

    // The batch cannot be committed while rows are rejected: the file is fixed, not forced.
    await refused(
      `imports/${staged.id}/commit`,
      'POST',
      { version: batch.version },
      409,
      /row\(s\) have errors/,
    );

    // The same sheet, mapped again without the rows that cannot be read.
    const clean = await ok(`imports/raw/files/${fileId}/stage`, 'POST', {
      kind: 'stock_movements',
      sheet: 'MB52',
      headerRow: 2,
      firstDataRow: 3,
      columns,
      options: {
        ...options,
        filters: [
          ...options.filters,
          { field: 'item', op: 'not_equals', value: p + 'NOPE' },
          { field: 'quantity', op: 'not_equals', value: 'n/a' },
        ],
      },
    });
    const ready = await batchAfter(clean.id);
    expect([ready.status, ready.error_rows]).toEqual(['validated', 0]);
    expect(ready.reconciliation.staged).toBe(2);
    await ok(`imports/${clean.id}/commit`, 'POST', { version: ready.version });
    const committed = await batchAfter(clean.id);
    expect(committed.status).toBe('committed');

    // The stock is in the plant, in its own unit, and only for the plant the rule kept.
    const stock = await ok(`plants/${plantId}/stock?q=${p.toLowerCase()}rm`);
    expect(
      Object.fromEntries(
        stock.items
          .filter((s: any) => s.location === p + 'LOC')
          .map((s: any) => [s.item, Number(s.quantity)]),
      ),
    ).toEqual({ [p + 'RM1']: 1240.5, [p + 'RM2']: 60 });
    expect((await ok(`plants/${otherId}/stock`)).items).toEqual([]);

    // The same file, sheet and import type cannot be committed twice.
    await refused(
      `imports/raw/files/${fileId}/stage`,
      'POST',
      { kind: 'stock_movements', sheet: 'MB52', headerRow: 2, firstDataRow: 3, columns, options },
      409,
      /was already imported as batch #/,
    );
    // The file is kept because imports were read from it.
    await refused(`imports/raw/files/${fileId}`, 'DELETE', undefined, 409, /import\(s\) were read/);

    // The mapping was saved and is offered again for a sheet with the same columns.
    const mappings = await ok('imports/raw/mappings?kind=stock_movements');
    const saved = mappings.items.find((m: any) => m.code === p + 'MB52');
    expect(saved).toMatchObject({ kind: 'stock_movements', sheet: 'MB52', header_row: 2 });
    expect(saved.columns.quantity).toMatchObject({ by: 'position', index: 4 });
    const second = await ok(
      `imports/raw/files/${fileId}/preview?sheet=MB52&headerRow=2&kind=stock_movements`,
    );
    expect(second.mappings.find((m: any) => m.code === p + 'MB52').matches).toBe(true);

    // A viewer reads the files but cannot upload, map or stage.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Import viewer ' + suffix,
        permissions: ['dashboard.read', 'sites.read', 'masters.read', 'inventory.read'],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Import Viewer', email, roleId });
    const grant = await ok('users/' + userId + '/plants');
    await ok('users/' + userId + '/plants', 'PUT', { version: grant.version, plantIds: [plantId] });
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    for (const [path, data] of [
      ['/reset-password', { type: 'password', value: 'Viewer-Test-2026!', temporary: false }],
      ['', { emailVerified: true, requiredActions: [] }],
    ] as const)
      expect(
        (
          await request.put(env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId + path, {
            headers: kcHeaders,
            data,
          })
        ).ok(),
      ).toBe(true);
    context = await browser.newContext();
    const vp = await context.newPage();
    await vp.goto(env.APP_URL + '/api/auth/login');
    await vp.locator('#username').fill(email);
    await vp.locator('#password').fill('Viewer-Test-2026!');
    await vp.locator('#kc-login').click();
    await completeTestMfa(vp, email);
    await expect(vp.locator('.main > header')).toBeVisible();
    const vm = await (await vp.request.get('/api/me')).json();
    const asViewer = (path: string, method = 'GET', data?: unknown, headers = {}) =>
      vp.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': vm.csrfToken, ...headers },
        data,
      });
    expect((await asViewer('imports/raw/files')).status()).toBe(200);
    expect(
      (
        await asViewer('imports/raw/files', 'POST', bytes, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'X-File-Name': 'viewer.xlsx',
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await asViewer(`imports/raw/files/${fileId}/stage`, 'POST', {
          kind: 'stock_movements',
          sheet: 'MB52',
          headerRow: 2,
          columns,
        })
      ).status(),
    ).toBe(403);

    // The screen itself: upload, read the sheet, map it and read the reconciliation.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(page, 'File import');
    await expect(page.locator(`[data-file="MB52-${suffix}.xlsx"]`)).toBeVisible();
    await page
      .locator(`[data-file="MB52-${suffix}.xlsx"]`)
      .getByRole('button', { name: 'Choose' })
      .click();
    await page.getByLabel('Sheet').selectOption('MB52');
    await page.getByLabel('Header row').fill('2');
    await page.getByLabel('Import type').selectOption({ label: 'Stock movements' });
    await page.getByRole('button', { name: 'Read this sheet' }).click();
    await expect(page.locator('[data-column]')).toHaveCount(7);
    await expect(page.getByText(/repeats Unrestricted/)).toBeVisible();
    await expect(page.locator('[data-field="quantity"]')).toBeVisible();
  } finally {
    await context?.close();
    if (identityId)
      await request.delete(env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId, {
        headers: kcHeaders,
      });
    sql(
      `DELETE FROM user_sites WHERE user_id='${userId}'; DELETE FROM app_users WHERE id='${userId}';`,
    );
    if (roleId)
      sql(
        `DELETE FROM role_permissions WHERE role_id='${roleId}'; DELETE FROM roles WHERE id='${roleId}';`,
      );
    const sites = `SELECT id FROM sites WHERE code LIKE '${p}%'`,
      items = `SELECT id FROM items WHERE code LIKE '${p}%'`;
    sql(`DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE file_id IN (SELECT id FROM import_files WHERE file_name LIKE '%${suffix}%'));
      DELETE FROM import_batches WHERE file_id IN (SELECT id FROM import_files WHERE file_name LIKE '%${suffix}%');
      DELETE FROM import_files WHERE file_name LIKE '%${suffix}%';
      DELETE FROM import_mappings WHERE code LIKE '${p}%';
      DELETE FROM stock_movements WHERE site_id IN (${sites});
      DELETE FROM stock_balances WHERE site_id IN (${sites});
      DELETE FROM stock_locations WHERE site_id IN (${sites});
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
