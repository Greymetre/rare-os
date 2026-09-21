import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { withRateLimitRetry } from './helpers/api';
import { test, expect } from '@playwright/test';
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
const DAY = 86400000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

// Weekly (Nilkamal) method, synthetic data: see docs/NILKAMAL_HINGLISH.md for the rules.
test('Nilkamal rules: weekly buffers, repeated BOM lines, production orders, planned make demand and unknown stock', async ({
  page,
}) => {
  test.setTimeout(420000);
  const suffix = Date.now().toString().slice(-6),
    p = 'N' + suffix;
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
  const upload = async (kind: string, csv: string) => {
    const batch = await (
      await call('imports/' + kind, 'POST', csv, {
        'Content-Type': 'text/csv',
        'X-File-Name': `${kind}-${suffix}-${Math.random().toString(36).slice(2)}.csv`,
      })
    ).json();
    let staged: any;
    await expect
      .poll(
        async () => {
          staged = await ok('imports/' + batch.id);
          return staged.status;
        },
        { timeout: 60000, intervals: [1000, 2000] },
      )
      .toBe('validated');
    return staged;
  };
  const commit = async (staged: any) => {
    await ok(`imports/${staged.id}/commit`, 'POST', { version: staged.version });
    await expect
      .poll(async () => (await ok('imports/' + staged.id)).status, {
        timeout: 60000,
        intervals: [1000, 2000],
      })
      .toBe('committed');
  };
  let lastRun = 0;
  const recalculated = async () => {
    let status: any;
    await expect
      .poll(
        async () => {
          status = await ok('planning/status');
          return status.upToDate && Number(status.current?.run_no) > lastRun;
        },
        { timeout: 90000, intervals: [1000, 2000] },
      )
      .toBe(true);
    lastRun = Number(status.current.run_no);
  };
  const plant = p + 'P1';
  let plantId = '';
  const rowOf = async (code: string) =>
    (await ok(`plants/${plantId}/buffers?q=${encodeURIComponent(code.toLowerCase())}`)).items.find(
      (r: any) => r.item === code,
    );
  try {
    for (const [code, decimals] of [
      ['KG', 3],
      ['NOS', 0],
    ] as const)
      await ok('units', 'POST', { code: p + code, name: code, decimals });
    // SAP material codes can carry an inch mark.
    const quoted = p + 'TP"Q';
    for (const [code, type, makeBuy, unit] of [
      ['FG1', 'FG', 'MAKE', 'NOS'],
      ['RM1', 'RM', 'BUY', 'KG'],
      ['RM2', 'RM', 'BUY', 'KG'],
    ])
      await ok('masters/items', 'POST', {
        code: p + code,
        name: 'Item ' + code,
        item_type: type,
        make_buy: makeBuy,
        base_unit: p + unit,
      });
    await ok('masters/items', 'POST', {
      code: quoted,
      name: 'Tape 12 grams 40 inch',
      item_type: 'RM',
      make_buy: 'BUY',
      base_unit: p + 'KG',
    });
    await ok('masters/suppliers', 'POST', {
      code: p + 'S1',
      name: 'Foam Co',
      lead_time_days: '10',
    });
    for (const item of [p + 'RM1', p + 'RM2', quoted])
      await ok('masters/item_suppliers', 'POST', {
        item,
        supplier: p + 'S1',
        purchase_unit: p + 'KG',
        moq: '50',
        lot_multiple: '50',
        preferred: true,
      });
    plantId = (
      await ok('plants', 'POST', {
        code: plant,
        name: 'Plant ' + plant,
        location: 'Test',
        timezone: 'Asia/Kolkata',
      })
    ).id;
    // RM1 repeats on two lines (2.5 + 0.5 = 3 kg per FG), as SAP BOMs do.
    await ok('boms', 'POST', {
      parent_item: p + 'FG1',
      revision: 'V1',
      effective_from: '2020-01-01',
      effective_to: '',
      base_quantity: '1',
      lines: [
        { component_item: p + 'RM1', quantity: '2.5', unit: '', scrap_pct: '0' },
        { component_item: p + 'RM2', quantity: '1', unit: '', scrap_pct: '0' },
        { component_item: p + 'RM1', quantity: '0.5', unit: '', scrap_pct: '0' },
        { component_item: quoted, quantity: '1', unit: '', scrap_pct: '0' },
      ],
    });
    await ok(`plants/${plantId}/stock-locations`, 'POST', {
      code: p + 'ST',
      name: 'Stores',
      location_type: 'STORES',
      nettable: true,
    });
    for (const [item, qty] of [
      ['FG1', '5'],
      ['RM1', '700'],
      ['RM2', '5000'],
    ])
      await ok(`plants/${plantId}/stock/movements`, 'POST', {
        location: p + 'ST',
        item: p + item,
        movement_type: 'OPENING',
        quantity: qty,
        unit: '',
        movement_date: day(0),
        reference: '',
        reason: '',
      });
    // 10 a day for 400 days, and one day long ago with more returns than sales.
    await commit(
      await upload(
        'demand_history',
        [
          'plant,item,demand_date,quantity',
          ...Array.from({ length: 400 }, (_, i) => `${plant},${p}FG1,${day(-1 - i)},10`),
          `${plant},${p}FG1,${day(-420)},-3`,
        ].join('\n'),
      ),
    );
    // Weekly profile: a minimum order needs an order multiple.
    const profile = {
      code: p + 'NK',
      name: 'Nilkamal weekly',
      red_base_pct: '50',
      red_safety_pct: '0',
      green_pct: '100',
      order_cycle_days: '7',
      spike_threshold_pct: '50',
      adu_window_days: '91',
      method: 'WEEKLY',
      zone_weeks: '13',
      cv_weeks: '52',
      order_multiple: '',
      moq_adu_days: '1.5',
    };
    const refused = await call('buffer-profiles', 'POST', profile);
    expect(refused.status()).toBe(400);
    expect(JSON.stringify(await refused.json())).toMatch(/Set an order multiple too/);
    await ok('buffer-profiles', 'POST', { ...profile, order_multiple: '10' });
    for (const [item, lead] of [
      [p + 'FG1', '2'],
      [p + 'RM1', ''],
      [p + 'RM2', ''],
      [quoted, ''],
    ])
      await ok(`plants/${plantId}/buffer-settings`, 'POST', {
        item,
        policy: 'BUFFER',
        profile: p + 'NK',
        lead_time_days: lead,
      });

    // Production orders: a bought item is refused; WO1 finishes inside RM lead time, WO2 after it.
    const header = 'plant,order_no,item,quantity,start_date,due_date,order_type,reference';
    const bad = await upload(
      'production_orders',
      [header, `${plant},${p}-WO9,${p}RM1,5,,${day(3)},PCMT,`].join('\n'),
    );
    expect(bad.error_rows).toBe(1);
    expect(JSON.stringify(await ok(`imports/${bad.id}/rows?errors=true`))).toMatch(
      /bought; production orders are for made items/,
    );
    await commit(
      await upload(
        'production_orders',
        [
          header,
          `${plant},${p}-WO1,${p}FG1,40,${day(0)},${day(3)},PCMT,SAP COOIS`,
          `${plant},${p}-WO2,${p}FG1,30,,${day(14)},PCMT,`,
        ].join('\n'),
      ),
    );
    await recalculated();

    // Weekly zones for a steady 10 a day: CV 0 -> 30% safety; 10 days rounds to one week.
    const lastDay = new Date(Date.now() - DAY);
    const sinceMonday = ((lastDay.getUTCDay() + 6) % 7) + 1; // days of the current, partial week
    const mean = (12 * 70 + sinceMonday * 10) / 13;
    const fg = await rowOf(p + 'FG1');
    const fgAdu = Math.round((mean / 7) * 1000) / 1000;
    expect([Number(fg.cv), Number(fg.safety_pct), fg.zone_days, Number(fg.adu)]).toEqual([
      0,
      30,
      7,
      fgAdu,
    ]);
    // Made item: qualified demand = ADU x lead time; production orders are not its supply.
    expect([Number(fg.lead_time_demand), Number(fg.open_supply)]).toEqual([
      Math.round(fgAdu * 2 * 10) / 10,
      0,
    ]);
    expect(Number(fg.top_of_red)).toBe(Math.round(Math.round(mean * 0.65 * 10) / 10));
    const makeQty = Number(fg.recommended_qty);
    expect(fg.recommended_kind).toBe('MAKE');
    expect(makeQty % 10 === 0 || fg.zone === 'yellow').toBe(true);

    // RM1: WO1 (40 x 3 kg) qualifies; WO2 is beyond the 10-day lead time; the FG recommendation
    // beyond the 70 already scheduled is needed now.
    const rm1 = await rowOf(p + 'RM1');
    expect(Number(rm1.production_demand)).toBe(120);
    expect(Number(rm1.outside_horizon)).toBe(90);
    expect(Number(rm1.planned_make_demand)).toBe(Math.max(0, makeQty - 70) * 3);
    expect(rm1.drivers.map((d: any) => d.kind + ':' + d.ref)).toContain(`production:${p}-WO1`);
    // An item with no stock record at all is unknown, never zero.
    const tape = await rowOf(quoted);
    expect(tape.status).toBe('missing');
    expect(tape.messages.join(' ')).toMatch(/No stock position/);

    // The order's full BOM against the current buffers; the repeated line stays separate.
    const orders = await ok(`plants/${plantId}/production-orders`);
    expect(orders.items.map((o: any) => o.order_no)).toEqual([p + '-WO1', p + '-WO2']);
    const wo1 = await ok('production-orders/' + orders.items[0].id);
    expect(
      wo1.lines.map((l: any) => [l.component, Number(l.requirement), l.required_date]),
    ).toEqual([
      [p + 'RM1', 100, day(-7)],
      [p + 'RM2', 40, day(-7)],
      [p + 'RM1', 20, day(-7)],
      [quoted, 40, day(-7)],
    ]);
    expect(wo1.lines[3]).toMatchObject({ on_hand: null, verdict: 'No stock position' });

    // Closing the order releases its components.
    await ok(`production-orders/${wo1.id}/close`, 'POST', { version: wo1.version });
    const again = await call(`production-orders/${wo1.id}/close`, 'POST', {
      version: wo1.version + 1,
    });
    expect(again.status()).toBe(409);
    await recalculated();
    expect(Number((await rowOf(p + 'RM1')).production_demand)).toBe(0);

    // Screens: production orders with their materials, the weekly profile and board details.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await page.getByRole('tab', { name: 'Production orders' }).click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plant} (${plant})` });
    await page.getByRole('button', { name: `Materials for ${p}-WO2` }).click();
    const materials = page.locator('.order-materials');
    await expect(materials).toContainText(`BOM V1: 4 line(s) for 30 ${p}NOS`);
    await expect(materials.getByRole('row').filter({ hasText: 'Tape 12 grams' })).toContainText(
      'not available',
    );
    await page.getByRole('tab', { name: 'Buffer profiles' }).click();
    await expect(page.getByRole('row').filter({ hasText: p + 'NK' })).toContainText('Weekly');
    await page.getByRole('tab', { name: 'Buffer board' }).click();
    await page.getByLabel('Buffer board search').fill((p + 'RM1').toLowerCase());
    await page.getByRole('button', { name: 'Search' }).click();
    await page.getByRole('button', { name: `Details for ${p}RM1` }).click();
    await expect(page.getByText('CV 0 → red safety 30%')).toBeVisible();
    await expect(page.getByText('Of which planned make orders')).toBeVisible();
  } finally {
    const items = `SELECT id FROM items WHERE code LIKE '${p}%'`,
      sites = `SELECT id FROM sites WHERE code LIKE '${p}%'`;
    sql(`DELETE FROM purchase_proposals WHERE site_id IN (${sites});
      DELETE FROM planning_results WHERE item_id IN (${items});
      DELETE FROM item_buffers WHERE item_id IN (${items});
      DELETE FROM buffer_profiles WHERE code LIKE '${p}%';
      DELETE FROM production_orders WHERE site_id IN (${sites});
      DELETE FROM stock_balances WHERE site_id IN (${sites});
      DELETE FROM stock_movements WHERE site_id IN (${sites});
      DELETE FROM demand_history WHERE site_id IN (${sites});
      DELETE FROM stock_locations WHERE site_id IN (${sites});
      DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM boms WHERE item_id IN (${items}));
      DELETE FROM boms WHERE item_id IN (${items});
      DELETE FROM item_suppliers WHERE item_id IN (${items});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM suppliers WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
