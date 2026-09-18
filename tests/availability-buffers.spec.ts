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
const day = (offset: number) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

test('AV-4 material buffers: zones from usage, net flow, recompute on order change, runs, permissions and scale', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'B' + suffix,
    userId = randomUUID(),
    email = `planner.view.${suffix}@example.test`;
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
  }
  async function settled(batchId: string) {
    let batch: any;
    await expect
      .poll(
        async () => {
          batch = await (await call('imports/' + batchId)).json();
          return ['validated', 'committed', 'failed', 'cancelled'].includes(batch.status);
        },
        { timeout: 180000, intervals: [1000, 2000] },
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
  // Waits until the buffers reflect every change made so far (a newer run is current and up to date).
  let lastRun = 0;
  async function recalculated(timeout = 60000) {
    let status: any;
    await expect
      .poll(
        async () => {
          status = await ok('planning/status');
          return status.upToDate && Number(status.current?.run_no) > lastRun;
        },
        { timeout, intervals: [1000, 2000] },
      )
      .toBe(true);
    lastRun = Number(status.current.run_no);
    return status;
  }
  const plantOne = p + 'P1',
    plantTwo = p + 'P2';
  const plants: Record<string, string> = {};
  const board = async (query = '', plant = plantOne) =>
    ok(`plants/${plants[plant]}/buffers?q=${encodeURIComponent(query.toLowerCase())}`);
  const rowOf = async (code: string) =>
    (await board(p + code)).items.find((r: any) => r.item === p + code);
  try {
    for (const [code, decimals] of [
      ['KG', 3],
      ['NOS', 0],
    ] as const)
      await ok('units', 'POST', { code: p + code, name: code, decimals });
    for (const [code, type, makeBuy, unit] of [
      ['RM1', 'RM', 'BUY', 'KG'],
      ['RM2', 'RM', 'BUY', 'KG'],
      ['FG1', 'FG', 'MAKE', 'NOS'],
      ['FG2', 'FG', 'MAKE', 'NOS'],
    ])
      await ok('masters/items', 'POST', {
        code: p + code,
        name: 'Item ' + code,
        item_type: type,
        make_buy: makeBuy,
        base_unit: p + unit,
      });
    await ok('masters/suppliers', 'POST', {
      code: p + 'S1',
      name: 'Supplier',
      lead_time_days: '10',
    });
    await ok('masters/item_suppliers', 'POST', {
      item: p + 'RM1',
      supplier: p + 'S1',
      moq: '100',
      lot_multiple: '50',
      preferred: true,
    });
    await ok('masters/customers', 'POST', { code: p + 'C1', name: 'Customer' });
    for (const code of [plantOne, plantTwo])
      plants[code] = (
        await ok('plants', 'POST', {
          code,
          name: 'Plant ' + code,
          location: 'Test',
          timezone: 'Asia/Kolkata',
        })
      ).id;
    for (const [parent, qty] of [
      ['FG1', '2'],
      ['FG2', '1'],
    ])
      await ok('boms', 'POST', {
        parent_item: p + parent,
        revision: 'V1',
        effective_from: '2020-01-01',
        effective_to: '',
        base_quantity: '1',
        lines: [{ component_item: p + 'RM1', quantity: qty, unit: '', scrap_pct: '0' }],
      });
    await ok(`plants/${plants[plantOne]}/stock-locations`, 'POST', {
      code: p + 'ST',
      name: 'Store',
      location_type: 'STORES',
      nettable: true,
    });
    for (const [item, qty] of [
      ['RM1', '100'],
      ['FG1', '50'],
    ])
      await ok(`plants/${plants[plantOne]}/stock/movements`, 'POST', {
        location: p + 'ST',
        item: p + item,
        movement_type: 'OPENING',
        quantity: qty,
        unit: '',
        movement_date: day(0),
        reference: '',
        reason: '',
      });
    // 30 days of FG1 sales at 10 a day: with a 30-day usage window, ADU = 10.
    await commit(
      await upload(
        'demand_history',
        [
          'plant,item,demand_date,quantity',
          ...Array.from({ length: 30 }, (_, i) => `${plantOne},${p}FG1,${day(-1 - i)},10`),
        ].join('\n'),
        `demand-${suffix}.csv`,
      ),
    );

    // Buffer profile through the UI.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await page.getByRole('tab', { name: 'Buffer profiles' }).click();
    await page.getByRole('button', { name: 'Create profile' }).click();
    await page.getByLabel('Profile code *').fill(p + 'BP');
    await page.getByLabel('Profile name *').fill('Half and half');
    await page.getByLabel('Usage window (days)').fill('30');
    await page.getByLabel('Green % of yellow *').fill('0');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByRole('alert')).toContainText('Green % of yellow must be greater than 0');
    await page.getByLabel('Green % of yellow *').fill('50');
    await page.getByRole('button', { name: 'Save profile' }).click();
    await expect(page.getByText(`Buffer profile ${p}BP created.`)).toBeVisible();

    // Settings: RM1 bought (supplier lead time), FG1 made with a lead time, FG2 to order.
    await rejected(
      `plants/${plants[plantOne]}/buffer-settings`,
      'POST',
      { item: p + 'FG1', policy: 'BUFFER', profile: p + 'BP' },
      400,
      /set its manufacturing lead time/,
    );
    await rejected(
      `plants/${plants[plantOne]}/buffer-settings`,
      'POST',
      { item: p + 'RM1', policy: 'BUFFER', profile: '' },
      400,
      /Choose a buffer profile/,
    );
    await ok(`plants/${plants[plantOne]}/buffer-settings`, 'POST', {
      item: p + 'RM1',
      policy: 'BUFFER',
      profile: p + 'BP',
    });
    await ok(`plants/${plants[plantOne]}/buffer-settings`, 'POST', {
      item: p + 'FG1',
      policy: 'BUFFER',
      profile: p + 'BP',
      lead_time_days: '5',
    });
    await page.getByRole('tab', { name: 'Buffer settings' }).first().click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await page.getByRole('button', { name: 'Add item' }).click();
    await page.getByLabel('Item code *').fill(p + 'FG2');
    await page.getByLabel('Policy').selectOption('MTO');
    await page.getByRole('button', { name: 'Save setting' }).click();
    await expect(page.getByText(`${p}FG2 is now made or bought to order`)).toBeVisible();
    // RM2 buffered but bought without a supplier: reported as missing data, never as zero.
    await ok(`plants/${plants[plantOne]}/buffer-settings`, 'POST', {
      item: p + 'RM2',
      policy: 'BUFFER',
      profile: p + 'BP',
    });

    // Zones from usage: FG1 ADU 10 x 5 days; RM1 ADU 20 (2 per FG1) x 10 days, MOQ 100.
    await recalculated();
    const fg1 = await rowOf('FG1');
    expect([
      Number(fg1.adu),
      fg1.dlt,
      Number(fg1.top_of_red),
      Number(fg1.top_of_yellow),
      Number(fg1.top_of_green),
      Number(fg1.nfp),
      fg1.zone,
      fg1.recommended_kind,
      Number(fg1.recommended_qty),
    ]).toEqual([10, 5, 25, 75, 100, 50, 'yellow', 'MAKE', 50]);
    const rm1 = await rowOf('RM1');
    expect([
      Number(rm1.adu),
      rm1.dlt,
      Number(rm1.top_of_green),
      Number(rm1.nfp),
      rm1.zone,
      Number(rm1.recommended_purchase_qty),
      rm1.supplier,
    ]).toEqual([20, 10, 400, 100, 'red', 300, p + 'S1']);
    const rm2 = await rowOf('RM2');
    expect([rm2.status, rm2.top_of_green]).toEqual(['missing', null]);
    expect(rm2.messages.join(' ')).toMatch(/No lead time/);
    expect((await rowOf('FG2')).status).toBe('not_applicable');

    // Exit condition: an order change recomputes and moves the zone. A make-to-order FG2 order of
    // 150 inside RM1's lead time qualifies 150 of RM1: 100 - 150 = -50, a stock-out risk.
    const order = await ok(`plants/${plants[plantOne]}/sales-orders`, 'POST', {
      order_no: p + 'SO1',
      customer: p + 'C1',
      order_date: day(0),
      promise_date: day(3),
      allow_partial: true,
      customer_ref: '',
      lines: [{ line_no: '10', item: p + 'FG2', quantity: '150', line_promise_date: '' }],
    });
    await recalculated();
    const breached = await rowOf('RM1');
    expect([Number(breached.qualified_demand), Number(breached.nfp), breached.zone]).toEqual([
      150,
      -50,
      'breach',
    ]);
    // Suggested order goes back to top of green in multiples of 50: 400 - (-50) = 450.
    expect(Number(breached.recommended_purchase_qty)).toBe(450);
    const first = (await board('', plantOne)).items[0];
    expect(first.item).toBe(p + 'RM1');
    // Open supply counts: a purchase order of 400 brings RM1 back to green.
    await ok(`plants/${plants[plantOne]}/purchase-orders`, 'POST', {
      po_no: p + 'PO1',
      supplier: p + 'S1',
      order_date: day(0),
      lines: [
        {
          line_no: '10',
          item: p + 'RM1',
          quantity: '400',
          unit: '',
          due_date: day(10),
          received_quantity: '0',
        },
      ],
    });
    await recalculated();
    expect([(await rowOf('RM1')).zone, Number((await rowOf('RM1')).nfp)]).toEqual(['green', 350]);
    await ok(`sales-orders/${order.id}/cancel`, 'POST', {
      reason: 'Customer withdrew',
      version: 1,
    });
    await recalculated();
    expect((await rowOf('RM1')).zone).toBe('excess');

    // Board in the UI: tiles, the zone pill and the details line.
    await page.getByRole('tab', { name: 'Buffer board' }).click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await expect(page.getByText('Up to date')).toBeVisible();
    const fgRow = page
      .getByRole('row')
      .filter({ hasText: p + 'FG1' })
      .first();
    await expect(fgRow).toContainText('Yellow');
    await expect(fgRow).toContainText('Make 50');
    await page.getByRole('button', { name: `Details for ${p}FG1` }).click();
    await expect(
      page.getByText('50 on hand + 0 open supply − 0 qualified demand = 50'),
    ).toBeVisible();
    await page.getByRole('button', { name: /Needs data/ }).click();
    await expect(page.getByRole('row').filter({ hasText: p + 'RM2' })).toContainText(
      'No lead time',
    );

    // Manual run: queued once, a second request joins the waiting run or queues the next one.
    const manual = await ok('planning/runs', 'POST', {});
    expect(manual.message).toMatch(/queued/);
    await recalculated();

    // Profile in use cannot be deactivated; buffer settings import with a bad row.
    const profile = (await ok('buffer-profiles')).items.find((x: any) => x.code === p + 'BP');
    await rejected(
      'buffer-profiles/' + profile.id,
      'PATCH',
      {
        name: profile.name,
        red_base_pct: '50',
        red_safety_pct: '0',
        green_pct: '50',
        order_cycle_days: '',
        spike_threshold_pct: '50',
        adu_window_days: '30',
        active: false,
        version: profile.version,
      },
      409,
      /used by 3 buffered item/,
    );
    const header = 'plant,item,policy,profile,lead_time_days,adu_override';
    const bad = await upload(
      'buffer_settings',
      [header, `${plantTwo},${p}RM1,BUFFER,${p}NOPE,,`, `${plantTwo},${p}FG1,BUFFER,${p}BP,,`].join(
        '\n',
      ),
      `buffers-bad-${suffix}.csv`,
    );
    expect(bad.error_rows).toBe(2);
    const errors = await (await call(`imports/${bad.id}/errors.csv`)).text();
    expect(errors).toContain(`Buffer profile ${p}NOPE was not found`);
    expect(errors).toContain('set its manufacturing lead time');

    // Scale: 10,000 bought items buffered in plant two with a usage override, planned in one run.
    const bulkItems = [
      'code,name,item_type,make_buy,base_unit,family,standard_cost,demand_class',
      ...Array.from(
        { length: 10000 },
        (_, i) => `${p}X${String(i).padStart(5, '0')},Bulk ${i},RM,BUY,${p}KG,,,`,
      ),
    ].join('\n');
    expect((await commit(await upload('items', bulkItems, `items-${suffix}.csv`))).status).toBe(
      'committed',
    );
    const bulkSettings = [
      header,
      ...Array.from(
        { length: 10000 },
        (_, i) => `${plantTwo},${p}X${String(i).padStart(5, '0')},BUFFER,${p}BP,7,${(i % 20) + 1}`,
      ),
    ].join('\n');
    const started = Date.now();
    const settingsBatch = await commit(
      await upload('buffer_settings', bulkSettings, `buffers-${suffix}.csv`),
    );
    expect(settingsBatch.summary.created).toBe(10000);
    const status = await recalculated(180000);
    console.log(
      `PASS 10,000 buffered items imported and planned in ${Math.round((Date.now() - started) / 1000)}s (run #${status.current.run_no})`,
    );
    const bulkBoard = await board(p + 'x', plantTwo);
    expect([bulkBoard.items.length, bulkBoard.counts.breach]).toEqual([25, 10000]);
    const next = await ok(
      `plants/${plants[plantTwo]}/buffers?q=${(p + 'x').toLowerCase()}&cursor=${bulkBoard.nextCursor}`,
    );
    expect(next.items[0].item > bulkBoard.items[24].item).toBe(true);
    expect((await call(`plants/${plants[plantTwo]}/buffers?zone=purple`)).status()).toBe(400);

    // A viewer limited to plant one sees its board only and cannot recalculate or change settings.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Buffer viewer ' + suffix,
        permissions: ['dashboard.read', 'sites.read', 'masters.read', 'planning.read'],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Buffer Viewer', email, roleId });
    const grant = await ok('users/' + userId + '/plants');
    await ok('users/' + userId + '/plants', 'PUT', {
      version: grant.version,
      plantIds: [plants[plantOne]],
    });
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
    const asViewer = (path: string, method = 'GET', data?: unknown) =>
      vp.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': vm.csrfToken },
        data,
      });
    expect((await asViewer(`plants/${plants[plantOne]}/buffers`)).status()).toBe(200);
    expect((await asViewer(`plants/${plants[plantTwo]}/buffers`)).status()).toBe(404);
    expect((await asViewer('planning/runs', 'POST', {})).status()).toBe(403);
    expect(
      (
        await asViewer('buffer-profiles', 'POST', {
          code: p + 'V',
          name: 'x',
          red_base_pct: '50',
          green_pct: '50',
        })
      ).status(),
    ).toBe(403);
    await vp.getByRole('button', { name: 'Availability', exact: true }).click();
    await vp.getByRole('tab', { name: 'Buffer board' }).click();
    await expect(
      vp
        .getByRole('row')
        .filter({ hasText: p + 'FG1' })
        .first(),
    ).toBeVisible();
    await expect(vp.getByRole('button', { name: 'Run now' })).toHaveCount(0);
    await vp.getByRole('tab', { name: 'Buffer profiles' }).click();
    await expect(vp.getByRole('button', { name: 'Create profile' })).toHaveCount(0);
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
    const items = `SELECT id FROM items WHERE code LIKE '${p}%'`,
      sites = `SELECT id FROM sites WHERE code LIKE '${p}%'`;
    sql(`DELETE FROM planning_results WHERE item_id IN (${items});
      DELETE FROM item_buffers WHERE item_id IN (${items});
      DELETE FROM buffer_profiles WHERE code LIKE '${p}%';
      DELETE FROM stock_balances WHERE site_id IN (${sites});
      DELETE FROM stock_movements WHERE site_id IN (${sites});
      DELETE FROM demand_history WHERE site_id IN (${sites});
      DELETE FROM sales_order_lines WHERE order_id IN (SELECT id FROM sales_orders WHERE site_id IN (${sites}));
      DELETE FROM sales_orders WHERE site_id IN (${sites});
      DELETE FROM purchase_order_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE site_id IN (${sites}));
      DELETE FROM purchase_orders WHERE site_id IN (${sites});
      DELETE FROM stock_locations WHERE site_id IN (${sites});
      DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM boms WHERE item_id IN (${items}));
      DELETE FROM boms WHERE item_id IN (${items});
      DELETE FROM item_suppliers WHERE item_id IN (${items});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM customers WHERE code LIKE '${p}%';
      DELETE FROM suppliers WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
