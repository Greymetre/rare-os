import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { withRateLimitRetry } from './helpers/api';
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

test('AV-1 item masters: rules, sourcing, conversions, imports, scale, isolation and permissions', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(420000);
  const suffix = Date.now().toString().slice(-6),
    p = 'Y' + suffix,
    userId = randomUUID(),
    email = `sourcing.${suffix}@example.test`,
    otherCompany = randomUUID();
  let roleId = '',
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
  async function ok(path: string, method = 'GET', data?: unknown) {
    const r = await call(path, method, data);
    const body = await r.json();
    expect(r.ok(), JSON.stringify(body)).toBe(true);
    return body;
  }
  async function rejected(
    path: string,
    method: string,
    data: unknown,
    status: number,
    text: RegExp,
  ) {
    const r = await call(path, method, data);
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(status);
    expect(body.error.message).toMatch(text);
    return body.error;
  }
  const find = async (kind: string, q: string) =>
    (await ok(`masters/${kind}?q=${encodeURIComponent(q.toLowerCase())}`)).items;
  async function settled(batchId: string, timeout = 120000) {
    let batch: any;
    await expect
      .poll(
        async () => {
          batch = await (await call('imports/' + batchId)).json();
          return ['validated', 'committed', 'failed', 'cancelled'].includes(batch.status);
        },
        { timeout, intervals: [1000, 2000] },
      )
      .toBe(true);
    return batch;
  }
  const upload = async (kind: string, csv: string, name: string) => {
    const r = await call('imports/' + kind, 'POST', csv, {
      'Content-Type': 'text/csv',
      'X-File-Name': name,
    });
    const body = await r.json();
    expect(r.ok(), JSON.stringify(body)).toBe(true);
    return settled(body.id);
  };
  const commit = async (batch: any) => {
    await ok(`imports/${batch.id}/commit`, 'POST', { version: batch.version });
    return settled(batch.id);
  };
  try {
    for (const [code, decimals] of [
      ['KG', 3],
      ['NOS', 0],
      ['BOX', 0],
    ] as const)
      await ok('units', 'POST', { code: p + code, name: code, decimals });

    // Items through the UI, including a field-level reference error.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await page.getByRole('tab', { name: 'Items' }).click();
    await page.getByRole('button', { name: 'Create item' }).click();
    await page.getByLabel('Item code *').fill(p + 'RM1');
    await page.getByLabel('Name *').fill('Steel sheet');
    await page.getByLabel('Item type *').selectOption('RM');
    await page.getByLabel('Make or buy *').selectOption('BUY');
    await page.getByLabel('Base unit *').fill(p + 'XX');
    await page.getByRole('button', { name: 'Save item' }).click();
    await expect(page.locator('small.warning')).toHaveText(
      `Unit ${p}XX was not found. Create it first.`,
    );
    await page.getByLabel('Base unit *').fill(p.toLowerCase() + 'kg');
    await page.getByLabel('Standard cost').fill('82.5');
    await page.getByRole('button', { name: 'Save item' }).click();
    await expect(page.getByText(`Item ${p}RM1 created.`)).toBeVisible();
    await expect(page.getByRole('cell', { name: p + 'KG', exact: true })).toBeVisible();

    await ok('masters/items', 'POST', {
      code: p + 'FG1',
      name: 'Pump',
      item_type: 'FG',
      make_buy: 'MAKE',
      base_unit: p + 'NOS',
    });
    await rejected(
      'masters/items',
      'POST',
      {
        code: p.toLowerCase() + 'rm1',
        name: 'Dup',
        item_type: 'RM',
        make_buy: 'BUY',
        base_unit: p + 'KG',
      },
      409,
      /already exists/,
    );
    const fieldErr = await rejected(
      'masters/customers',
      'POST',
      { code: p + 'C1', name: 'Cust', email: 'not-an-email', phone: 'x' },
      400,
      /valid email/,
    );
    expect(fieldErr.fields.map((f: any) => f.column)).toEqual(['email', 'phone']);
    for (const n of [1, 2])
      await ok('masters/suppliers', 'POST', {
        code: `${p}S${n}`,
        name: 'Supplier ' + n,
        lead_time_days: '7',
      });

    // Sourcing rules.
    await rejected(
      'masters/item_suppliers',
      'POST',
      { item: p + 'FG1', supplier: p + 'S1' },
      400,
      /is MAKE/,
    );
    await rejected(
      'masters/item_suppliers',
      'POST',
      { item: p + 'RM1', supplier: p + 'S1', purchase_unit: p + 'BOX' },
      400,
      /No conversion between/,
    );
    await rejected(
      'masters/item_suppliers',
      'POST',
      { item: p + 'RM1', supplier: p + 'S1', moq: '100.0001', lot_multiple: '0.0001' },
      400,
      /at most 3 decimal/,
    );
    await ok('masters/unit_conversions', 'POST', {
      from_unit: p + 'BOX',
      to_unit: p + 'KG',
      factor: '25',
    });
    await rejected(
      'masters/unit_conversions',
      'POST',
      { from_unit: p + 'KG', to_unit: p + 'BOX', factor: '0.04' },
      400,
      /Keep one direction/,
    );
    await ok('masters/item_suppliers', 'POST', {
      item: p + 'RM1',
      supplier: p + 'S1',
      purchase_unit: p + 'BOX',
      moq: '10',
      lot_multiple: '5',
      preferred: true,
    });
    await ok('masters/item_suppliers', 'POST', {
      item: p + 'RM1',
      supplier: p + 'S2',
      preferred: true,
    });
    const sources = await find('item_suppliers', p + 'RM1');
    expect(sources.map((s: any) => [s.supplier, s.preferred, s.purchase_unit])).toEqual([
      [p + 'S1', false, p + 'BOX'],
      [p + 'S2', true, p + 'KG'],
    ]);

    // Edits: identity fields are immutable, versions are enforced, used units cannot be deactivated.
    const [rm1] = await find('items', p + 'RM1');
    await ok('masters/items/' + rm1.id, 'PATCH', {
      code: 'HACKED',
      name: 'Steel sheet 2mm',
      item_type: 'RM',
      make_buy: 'BUY',
      base_unit: rm1.base_unit,
      family: 'Metals',
      standard_cost: '82.5',
      demand_class: '',
      active: true,
      version: rm1.version,
    });
    const [edited] = await find('items', p + 'RM1');
    expect([edited.code, edited.name, edited.family]).toEqual([
      p + 'RM1',
      'Steel sheet 2mm',
      'Metals',
    ]);
    await rejected(
      'masters/items/' + rm1.id,
      'PATCH',
      {
        name: 'Stale',
        item_type: 'RM',
        make_buy: 'BUY',
        base_unit: rm1.base_unit,
        active: true,
        version: rm1.version,
      },
      409,
      /changed elsewhere/,
    );
    const kg = (await ok('units?q=' + p.toLowerCase() + 'kg')).items[0];
    await rejected(
      'units/' + kg.id,
      'PATCH',
      { name: 'KG', decimals: 3, active: false, version: kg.version },
      409,
      /used by/,
    );

    // Imports with reference errors, in-file duplicates and preferred conflicts.
    const badItems = await upload(
      'items',
      [
        'code,name,item_type,make_buy,base_unit,family,standard_cost,demand_class',
        `${p}RM2,Copper,RM,BUY,${p}KG,Metals,410,`,
        `${p}RM3,Missing unit,RM,BUY,${p}LTR,,,`,
        `${p.toLowerCase()}rm2,Duplicate,RM,BUY,${p}KG,,,`,
        `${p}FG2,Bad type,TOOL,MAKE,${p}NOS,,,`,
      ].join('\n'),
      `items-bad-${suffix}.csv`,
    );
    expect([badItems.valid_rows, badItems.error_rows]).toEqual([1, 3]);
    const errorCsv = await (await call(`imports/${badItems.id}/errors.csv`)).text();
    expect(errorCsv).toContain(`Unit ${p}LTR was not found`);
    expect(errorCsv).toContain('Duplicate code');
    expect(errorCsv).toContain('one of: RM, SFG, FG');
    const items = await commit(
      await upload(
        'items',
        [
          'code,name,item_type,make_buy,base_unit,family,standard_cost,demand_class',
          `${p}RM2,Copper,RM,BUY,${p}KG,Metals,410,`,
          `${p}RM1,Steel sheet 2mm,RM,BUY,${p}KG,Metals,82.5,`,
          `${p}FG2,Motor,FG,MAKE,${p}NOS,Motors,2500,runner`,
        ].join('\n'),
        `items-${suffix}.csv`,
      ),
    );
    expect([items.status, items.summary]).toEqual([
      'committed',
      { created: 2, updated: 0, unchanged: 1 },
    ]);
    const sourcingCsv = [
      'item,supplier,supplier_item_code,purchase_unit,lead_time_days,moq,lot_multiple,preferred',
      `${p}RM2,${p}S1,CU-1,,10,100,50,yes`,
      `${p}RM2,${p}S2,,,,,,yes`,
    ].join('\n');
    const conflicting = await upload('item_suppliers', sourcingCsv, `sourcing-bad-${suffix}.csv`);
    expect(conflicting.error_rows).toBe(1);
    const staleBatch = await upload(
      'item_suppliers',
      sourcingCsv.replace(/,yes$/, ',no'),
      `sourcing-${suffix}.csv`,
    );
    expect(staleBatch.error_rows).toBe(0);
    // Supplier deactivated between validation and commit: nothing is written.
    const [s2] = await find('suppliers', p + 'S2');
    await ok('masters/suppliers/' + s2.id, 'PATCH', {
      name: s2.name,
      lead_time_days: String(s2.lead_time_days),
      email: '',
      phone: '',
      active: false,
      version: s2.version,
    });
    const stale = await commit(staleBatch);
    expect(stale.status).toBe('failed');
    expect(stale.error).toContain('Data changed after validation');
    expect(await find('item_suppliers', p + 'RM2')).toHaveLength(0);

    // Readiness reflects unsourced bought items.
    const readiness = await ok('availability/readiness');
    expect(readiness.items.find((i: any) => i.key === 'sourcing').detail).toMatch(
      /no active supplier|every bought item/,
    );

    // Scale: 10,000 items validated and committed in the background, then paged in code order.
    const bulk = [
      'code,name,item_type,make_buy,base_unit,family,standard_cost,demand_class',
      ...Array.from(
        { length: 10000 },
        (_, i) => `${p}B${String(i).padStart(5, '0')},Bulk ${i},RM,BUY,${p}KG,Bulk,${i % 50}.25,`,
      ),
    ].join('\n');
    const started = Date.now();
    const bulkBatch = await upload('items', bulk, `items-bulk-${suffix}.csv`);
    expect([bulkBatch.error_rows, bulkBatch.summary.create]).toEqual([0, 10000]);
    const bulkDone = await commit(bulkBatch);
    expect(bulkDone.summary.created).toBe(10000);
    console.log(
      `PASS 10,000 items validated and committed in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    const first = await ok(`masters/items?q=${p.toLowerCase()}b`);
    expect(first.items).toHaveLength(25);
    expect(first.items[0].code).toBe(p + 'B00000');
    const second = await ok(`masters/items?q=${p.toLowerCase()}b&cursor=${first.nextCursor}`);
    expect(second.items[0].code).toBe(p + 'B00025');
    expect((await call('masters/items?cursor=not-a-cursor')).status()).toBe(400);
    expect((await call('masters/unknown')).status()).toBe(404);

    // Another company's records are invisible and cannot be edited.
    const hiddenItem = randomUUID();
    sql(`BEGIN;
      INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','AV1 isolation ${suffix}','AV1${suffix}');
      INSERT INTO units(id,tenant_id,code,name) VALUES('${randomUUID()}','${otherCompany}','HIDDEN','Hidden');
      INSERT INTO items(id,tenant_id,code,name,item_type,make_buy,base_unit_id) SELECT '${hiddenItem}','${otherCompany}','${p}HIDDEN','Hidden','RM','BUY',id FROM units WHERE tenant_id='${otherCompany}';
      COMMIT;`);
    expect(await find('items', p + 'HIDDEN')).toHaveLength(0);
    await rejected(
      'masters/items/' + hiddenItem,
      'PATCH',
      {
        name: 'x',
        item_type: 'RM',
        make_buy: 'BUY',
        base_unit: 'HIDDEN',
        active: true,
        version: 1,
      },
      404,
      /not found/,
    );

    // A purchase role maintains suppliers and sourcing only.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Purchase masters ' + suffix,
        permissions: ['dashboard.read', 'masters.read', 'suppliers.manage', 'imports.create'],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Purchase User', email, roleId });
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Sourcing-Test-2026!', temporary: false },
          },
        )
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.put(env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId, {
          headers: kcHeaders,
          data: { emailVerified: true, requiredActions: [] },
        })
      ).ok(),
    ).toBe(true);
    context = await browser.newContext();
    const up = await context.newPage();
    await up.goto(env.APP_URL + '/api/auth/login');
    await up.locator('#username').fill(email);
    await up.locator('#password').fill('Sourcing-Test-2026!');
    await up.locator('#kc-login').click();
    await completeTestMfa(up, email);
    await expect(up.locator('.main > header')).toBeVisible();
    const um = await (await up.request.get('/api/me')).json();
    const asBuyer = (
      path: string,
      method = 'GET',
      data?: unknown,
      headers: Record<string, string> = {},
    ) =>
      up.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': um.csrfToken, ...headers },
        data,
      });
    expect(
      (
        await asBuyer('masters/suppliers', 'POST', {
          code: p + 'S3',
          name: 'Buyer supplier',
          lead_time_days: '3',
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await asBuyer('masters/items', 'POST', {
          code: p + 'RM9',
          name: 'x',
          item_type: 'RM',
          make_buy: 'BUY',
          base_unit: p + 'KG',
        })
      ).status(),
    ).toBe(403);
    expect(
      (await asBuyer('masters/customers', 'POST', { code: p + 'C9', name: 'x' })).status(),
    ).toBe(403);
    expect(
      (await asBuyer('imports/items', 'POST', 'code\n', { 'Content-Type': 'text/csv' })).status(),
    ).toBe(403);
    expect(
      (
        await asBuyer(
          'imports/suppliers',
          'POST',
          `code,name,lead_time_days,email,phone\n${p}S4,Imported,4,,\n`,
          {
            'Content-Type': 'text/csv',
          },
        )
      ).status(),
    ).toBe(201);
    await up.getByRole('button', { name: 'Availability', exact: true }).click();
    await up.getByRole('tab', { name: 'Items' }).click();
    await expect(up.getByRole('button', { name: 'Create item' })).toHaveCount(0);
    await up.getByRole('tab', { name: 'Suppliers' }).click();
    await expect(up.getByRole('button', { name: 'Create supplier' })).toBeVisible();
    await up.getByRole('tab', { name: 'Imports' }).click();
    await expect(up.getByLabel('Import type').locator('option')).toHaveText([
      'Suppliers',
      'Item sourcing',
    ]);
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
    sql(
      `DELETE FROM items WHERE tenant_id='${otherCompany}'; DELETE FROM units WHERE tenant_id='${otherCompany}'; DELETE FROM tenants WHERE id='${otherCompany}';`,
    );
    sql(`DELETE FROM item_suppliers WHERE item_id IN (SELECT id FROM items WHERE code LIKE '${p}%');
      DELETE FROM unit_conversions WHERE from_unit_id IN (SELECT id FROM units WHERE code LIKE '${p}%');
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM suppliers WHERE code LIKE '${p}%';
      DELETE FROM customers WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
