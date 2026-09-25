import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { withRateLimitRetry } from './helpers/api';
import { test, expect } from '@playwright/test';
import { openScreen } from './helpers/nav';
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

test('AV-3 demand and stock: ledger, reversals, orders, imports, readiness, permissions and scale', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(480000);
  const suffix = Date.now().toString().slice(-6),
    p = 'D' + suffix,
    userId = randomUUID(),
    email = `store.${suffix}@example.test`;
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
  async function settled(batchId: string, timeout = 180000) {
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
  const errorsOf = async (batch: any) => (await call(`imports/${batch.id}/errors.csv`)).text();
  const plantOne = p + 'P1',
    plantTwo = p + 'P2';
  const plants: Record<string, string> = {};
  const balance = async (item: string, location = p + 'STORE') =>
    (await ok(`plants/${plants[plantOne]}/stock?q=${(p + item).toLowerCase()}`)).items
      .filter((b: any) => b.location === location)
      .map((b: any) => Number(b.quantity))[0] ?? 0;
  const move = (data: Record<string, string>) =>
    call(`plants/${plants[plantOne]}/stock/movements`, 'POST', {
      location: p + 'STORE',
      unit: '',
      movement_date: day(0),
      reference: '',
      reason: '',
      ...data,
    });
  const posted = async (data: Record<string, string>) => {
    const r = await move(data);
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(201);
    return body;
  };
  try {
    for (const [code, decimals] of [
      ['KG', 3],
      ['NOS', 0],
      ['BOX', 0],
    ] as const)
      await ok('units', 'POST', { code: p + code, name: code, decimals });
    for (const [code, type, makeBuy, unit] of [
      ['RM1', 'RM', 'BUY', 'KG'],
      ['RM2', 'RM', 'BUY', 'NOS'],
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
    await ok('masters/unit_conversions', 'POST', {
      from_unit: p + 'BOX',
      to_unit: p + 'KG',
      factor: '25',
    });
    await ok('masters/customers', 'POST', { code: p + 'C1', name: 'Customer one' });
    await ok('masters/suppliers', 'POST', {
      code: p + 'S1',
      name: 'Supplier one',
      lead_time_days: '7',
    });
    for (const code of [plantOne, plantTwo])
      plants[code] = (
        await ok('plants', 'POST', {
          code,
          name: 'Plant ' + code,
          location: 'Test',
          timezone: 'Asia/Kolkata',
        })
      ).id;

    // Stock locations: UI create, API rules.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(page, 'Stock locations');
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await page.getByRole('button', { name: 'Create location' }).click();
    await page.getByLabel('Location code *').fill(p + 'STORE');
    await page.getByLabel('Location name *').fill('Main store');
    await page.getByRole('button', { name: 'Save location' }).click();
    await expect(page.getByText(`Location ${p}STORE created.`)).toBeVisible();
    await ok(`plants/${plants[plantOne]}/stock-locations`, 'POST', {
      code: p + 'QC',
      name: 'Quality hold',
      location_type: 'QUARANTINE',
      nettable: false,
    });
    await rejected(
      `plants/${plants[plantOne]}/stock-locations`,
      'POST',
      {
        code: p.toLowerCase() + 'store',
        name: 'Duplicate',
        location_type: 'STORES',
        nettable: true,
      },
      409,
      /already exists/,
    );
    await ok(`plants/${plants[plantTwo]}/stock-locations`, 'POST', {
      code: p + 'STORE',
      name: 'Plant two store',
      location_type: 'STORES',
      nettable: true,
    });

    // Opening stock through the UI, then ledger rules through the API.
    await openScreen(page, 'Stock');
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await page.getByRole('button', { name: 'Post movement' }).click();
    await page.getByLabel('Movement type').selectOption('OPENING');
    await page.getByLabel('Stock location').selectOption(p + 'STORE');
    await page.getByLabel('Item code *').fill(p.toLowerCase() + 'rm1');
    await page.getByLabel('Quantity *').fill('100');
    await page.getByRole('button', { name: 'Post movement' }).click();
    await expect(page.getByText(/Movement #\d+ posted: OPENING 100 .*KG of .*RM1/)).toBeVisible();
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: p + 'RM1' })
        .first(),
    ).toContainText('100');
    const secondOpening = await move({ item: p + 'RM1', movement_type: 'OPENING', quantity: '5' });
    expect([secondOpening.status(), (await secondOpening.json()).error.message]).toEqual([
      400,
      expect.stringMatching(/already posted/),
    ]);
    const receipt = await posted({
      item: p + 'RM1',
      movement_type: 'RECEIPT',
      quantity: '2',
      unit: p + 'BOX',
      reference: 'GRN-1',
    });
    expect(receipt.message).toContain('RECEIPT 50');
    expect(await balance('RM1')).toBe(150);
    for (const [data, text] of [
      [
        { item: p + 'RM1', movement_type: 'ISSUE', quantity: '200' },
        /Not enough stock: .*RM1 at .*STORE has 150 .*KG available/,
      ],
      [{ item: p + 'RM1', movement_type: 'ISSUE', quantity: '1.2345' }, /at most 3 decimal/],
      [{ item: p + 'RM1', movement_type: 'ADJUSTMENT', quantity: '-1' }, /Reason is required/],
      [{ item: p + 'RM1', movement_type: 'RECEIPT', quantity: '-1' }, /cannot be negative/],
      [
        { item: p + 'RM1', movement_type: 'RECEIPT', quantity: '1', movement_date: day(3) },
        /cannot be in the future/,
      ],
      [
        { item: p + 'RM2', movement_type: 'RECEIPT', quantity: '1', unit: p + 'BOX' },
        /no conversion between/,
      ],
      [
        { item: p + 'RM1', movement_type: 'RECEIPT', quantity: '1', location: p + 'NOPE' },
        /was not found in plant/,
      ],
    ] as const) {
      const r = await move(data as any);
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(400);
      expect(body.error.message).toMatch(text);
    }
    await posted({ item: p + 'RM1', movement_type: 'ISSUE', quantity: '30.5', reference: 'WO-1' });
    await posted({
      item: p + 'RM1',
      movement_type: 'ADJUSTMENT',
      quantity: '-0.5',
      reason: 'Count difference',
    });
    expect(await balance('RM1')).toBe(119);

    // Reversals: once only, never of a reversal, never below zero.
    const ledger = (
      await ok(`plants/${plants[plantOne]}/stock/movements?q=${(p + 'rm1').toLowerCase()}`)
    ).items;
    const byRef = (ref: string) => ledger.find((m: any) => m.reference === ref);
    const reversed = await ok(`stock-movements/${byRef('GRN-1').id}/reverse`, 'POST', {
      reason: 'Wrong supplier delivery',
    });
    expect(await balance('RM1')).toBe(69);
    await rejected(
      `stock-movements/${byRef('GRN-1').id}/reverse`,
      'POST',
      { reason: 'Again' },
      409,
      /already reversed/,
    );
    await rejected(
      `stock-movements/${reversed.id}/reverse`,
      'POST',
      { reason: 'Undo' },
      409,
      /cannot be reversed/,
    );
    const opening = ledger.find((m: any) => m.movement_type === 'OPENING');
    await rejected(
      `stock-movements/${opening.id}/reverse`,
      'POST',
      { reason: 'Recount' },
      409,
      /already used/,
    );
    expect(
      sql(`SELECT b.quantity = (SELECT sum(m.quantity) FROM stock_movements m WHERE m.location_id=b.location_id AND m.item_id=b.item_id)
           FROM stock_balances b JOIN items i ON i.id=b.item_id WHERE i.code='${p}RM1'`),
    ).toBe('t');
    // Two simultaneous issues cannot both take the last stock.
    await posted({ item: p + 'RM2', movement_type: 'RECEIPT', quantity: '10' });
    const statuses = (
      await Promise.all(
        [6, 6].map((q) => move({ item: p + 'RM2', movement_type: 'ISSUE', quantity: String(q) })),
      )
    )
      .map((r) => r.status())
      .sort();
    expect(statuses).toEqual([201, 400]);
    expect(await balance('RM2')).toBe(4);
    const store = (await ok(`plants/${plants[plantOne]}/stock-locations`)).items.find(
      (l: any) => l.code === p + 'STORE',
    );
    await rejected(
      'stock-locations/' + store.id,
      'PATCH',
      {
        name: store.name,
        location_type: 'STORES',
        nettable: true,
        active: false,
        version: store.version,
      },
      409,
      /still holds stock/,
    );

    // Customer orders: UI create with a generated number, API rules, edit, stale edit, cancel.
    await openScreen(page, 'Customer orders');
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await page.getByRole('button', { name: 'Create order' }).click();
    await page.getByLabel('Customer code *').fill(p + 'C1');
    await page.getByLabel('Promise date *').fill(day(10));
    await page.getByLabel('Line 1 Item code').fill(p + 'FG1');
    await page.getByLabel('Line 1 Quantity').fill('1.5');
    await page.getByRole('button', { name: 'Save order' }).click();
    await expect(page.getByRole('alert')).toContainText('whole number');
    await page.getByLabel('Line 1 Quantity').fill('12');
    await page.getByRole('button', { name: 'Save order' }).click();
    await expect(page.getByText(/Order SO-\d{6} created with 1 line\(s\)\./)).toBeVisible();
    const order = (base: Record<string, unknown> = {}) => ({
      order_no: p + 'SO1',
      customer: p + 'C1',
      order_date: day(-2),
      promise_date: day(14),
      allow_partial: false,
      customer_ref: 'CPO-9',
      lines: [
        { line_no: '10', item: p + 'FG1', quantity: '20', line_promise_date: '' },
        { line_no: '20', item: p + 'FG2', quantity: '5', line_promise_date: day(21) },
      ],
      ...base,
    });
    const soPath = `plants/${plants[plantOne]}/sales-orders`;
    await rejected(
      soPath,
      'POST',
      order({ promise_date: day(-5) }),
      400,
      /Promise date must be on or after/,
    );
    await rejected(
      soPath,
      'POST',
      order({ customer: p + 'NOPE' }),
      400,
      /Customer .*NOPE was not found/,
    );
    await rejected(
      soPath,
      'POST',
      order({
        lines: [
          { line_no: '10', item: p + 'FG1', quantity: '1', line_promise_date: '' },
          { line_no: '10', item: p + 'FG2', quantity: '1', line_promise_date: '' },
        ],
      }),
      400,
      /Line number 10 is used more than once/,
    );
    const so = await ok(soPath, 'POST', order());
    await rejected(
      soPath,
      'POST',
      order({ order_no: p.toLowerCase() + 'so1' }),
      409,
      /already exists/,
    );
    let detail = await ok('sales-orders/' + so.id);
    expect(detail.lines.map((l: any) => [l.line_no, l.line_promise_date])).toEqual([
      [10, day(14)],
      [20, day(21)],
    ]);
    await ok('sales-orders/' + so.id, 'PUT', {
      customer: p + 'C1',
      order_date: day(-2),
      promise_date: day(14),
      allow_partial: false,
      customer_ref: 'CPO-9',
      lines: [{ line_no: '10', item: p + 'FG1', quantity: '25', line_promise_date: '' }],
      version: detail.version,
    });
    await rejected(
      'sales-orders/' + so.id,
      'PUT',
      { ...order(), order_no: undefined, version: detail.version },
      409,
      /changed elsewhere/,
    );
    detail = await ok('sales-orders/' + so.id);
    expect(detail.lines.map((l: any) => [l.line_no, Number(l.quantity), l.status])).toEqual([
      [10, 25, 'OPEN'],
      [20, 5, 'CANCELLED'],
    ]);
    const cancelled = await ok(soPath, 'POST', order({ order_no: p + 'SO2' }));
    await rejected(
      'sales-orders/' + cancelled.id + '/cancel',
      'POST',
      { reason: '', version: 1 },
      400,
      /Reason/,
    );
    await ok('sales-orders/' + cancelled.id + '/cancel', 'POST', {
      reason: 'Customer withdrew',
      version: 1,
    });
    const again = await ok('sales-orders/' + cancelled.id);
    await rejected(
      'sales-orders/' + cancelled.id,
      'PUT',
      { ...order(), order_no: undefined, version: again.version },
      400,
      /is cancelled/,
    );

    // Purchase orders: BUY items only, unit conversion, received within ordered.
    const poPath = `plants/${plants[plantOne]}/purchase-orders`;
    const po = (lines: any[]) => ({ po_no: '', supplier: p + 'S1', order_date: day(-1), lines });
    const poLine = (item: string, quantity: string, unit = '', received = '0') => ({
      line_no: '10',
      item: p + item,
      quantity,
      unit: unit && p + unit,
      due_date: day(7),
      received_quantity: received,
    });
    await rejected(poPath, 'POST', po([poLine('FG1', '5')]), 400, /is MAKE/);
    // Received quantities come from goods receipts (AV-5); the order form cannot set them.
    const ignored = await ok(poPath, 'POST', po([poLine('RM1', '5', 'BOX', '6')]));
    expect(Number((await ok('purchase-orders/' + ignored.id)).lines[0].received_quantity)).toBe(0);
    const created = await ok(poPath, 'POST', po([poLine('RM1', '8', 'BOX', '0')]));
    expect(created.no).toMatch(/^PO-\d{6}$/);
    const poDetail = await ok('purchase-orders/' + created.id);
    expect([
      poDetail.lines[0].unit,
      Number(poDetail.lines[0].unit_factor),
      poDetail.lines[0].base_unit,
    ]).toEqual([p + 'BOX', 25, p + 'KG']);

    // Imports: grouped orders, idempotent re-import, stock movements by external reference, demand history.
    const soHeader =
      'plant,order_no,customer,order_date,promise_date,allow_partial,customer_ref,line_no,item,quantity,line_promise_date';
    const soRows = (qty: string, customer = p + 'C1') => [
      `${plantOne},${p}IMP1,${customer},${day(-3)},${day(9)},yes,,1,${p}FG1,${qty},`,
      `${plantOne},${p}IMP1,${customer},${day(-3)},${day(9)},yes,,2,${p}FG2,4,${day(12)}`,
      `${plantOne},${p}IMP2,${p}C1,${day(-3)},${day(9)},no,REF-2,1,${p}FG2,7,`,
    ];
    const badOrders = await upload(
      'sales_orders',
      [soHeader, ...soRows('10', p + 'NOPE')].join('\n'),
      `so-bad-${suffix}.csv`,
    );
    expect([badOrders.valid_rows, badOrders.error_rows, badOrders.summary.create]).toEqual([
      1, 2, 1,
    ]);
    expect(await errorsOf(badOrders)).toContain('Nothing from it will be saved');
    const importedOrders = await commit(
      await upload('sales_orders', [soHeader, ...soRows('10')].join('\n'), `so-${suffix}.csv`),
    );
    expect(importedOrders.summary).toEqual({ created: 2, updated: 0, unchanged: 0 });
    const rerun = await upload(
      'sales_orders',
      [soHeader, ...soRows('11')].join('\n'),
      `so-again-${suffix}.csv`,
    );
    expect(rerun.summary).toEqual({ create: 0, update: 1, unchanged: 1 });
    expect((await commit(rerun)).summary).toEqual({ created: 0, updated: 1, unchanged: 1 });
    const sameFile = await call(
      'imports/sales_orders',
      'POST',
      [soHeader, ...soRows('11')].join('\n'),
      {
        'Content-Type': 'text/csv',
      },
    );
    expect(sameFile.status()).toBe(409);
    const poImport = await commit(
      await upload(
        'purchase_orders',
        [
          'plant,po_no,supplier,order_date,line_no,item,quantity,unit,due_date,received_quantity',
          `${plantOne},${p}PO1,${p}S1,${day(-5)},1,${p}RM1,4,${p}BOX,${day(5)},0`,
          `${plantOne},${p}PO1,${p}S1,${day(-5)},2,${p}RM2,100,,${day(9)},40`,
        ].join('\n'),
        `po-${suffix}.csv`,
      ),
    );
    expect(poImport.summary.created).toBe(1);

    const mvHeader =
      'plant,location,item,movement_type,quantity,unit,movement_date,reference,reason,external_ref';
    const badMoves = await upload(
      'stock_movements',
      [
        mvHeader,
        `${plantOne},${p}STORE,${p}FG1,OPENING,50,,${day(-1)},Count,,${p}-OPEN-FG1`,
        `${plantOne},${p}STORE,${p}FG1,ISSUE,60,,${day(0)},Dispatch,,${p}-ISS-1`,
        `${plantOne},${p}STORE,${p}FG2,RECEIPT,5,,${day(0)},,,`,
        `${plantOne},${p}STORE,${p}FG2,RECEIPT,5,,${day(0)},,,${p}-OPEN-FG1`,
      ].join('\n'),
      `moves-bad-${suffix}.csv`,
    );
    const moveErrors = await errorsOf(badMoves);
    expect(badMoves.error_rows).toBe(3);
    for (const text of [
      'Not enough stock',
      'External reference is required',
      'is repeated on line',
    ])
      expect(moveErrors).toContain(text);
    const moves = [
      mvHeader,
      `${plantOne},${p}STORE,${p}FG1,OPENING,50,,${day(-1)},Count,,${p}-OPEN-FG1`,
      `${plantOne},${p}STORE,${p}FG1,ISSUE,20,,${day(0)},Dispatch,,${p}-ISS-1`,
    ];
    expect(
      (await commit(await upload('stock_movements', moves.join('\n'), `moves-${suffix}.csv`)))
        .summary,
    ).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
    });
    expect(await balance('FG1')).toBe(30);
    const replay = await upload(
      'stock_movements',
      moves.join('\n') + '\n',
      `moves-replay-${suffix}.csv`,
    );
    expect([replay.error_rows, replay.summary]).toEqual([
      0,
      { create: 0, update: 0, unchanged: 2 },
    ]);
    expect((await commit(replay)).summary.created).toBe(0);
    expect(await balance('FG1')).toBe(30);
    const changed = await upload(
      'stock_movements',
      moves.join('\n').replace(',ISSUE,20,', ',ISSUE,21,'),
      `moves-changed-${suffix}.csv`,
    );
    expect(await errorsOf(changed)).toContain('Posted movements cannot be changed');
    // Stock used elsewhere between validation and commit: the file posts nothing.
    const staleMoves = await upload(
      'stock_movements',
      [mvHeader, `${plantOne},${p}STORE,${p}FG1,ISSUE,25,,${day(0)},Dispatch,,${p}-ISS-2`].join(
        '\n',
      ),
      `moves-stale-${suffix}.csv`,
    );
    expect(staleMoves.error_rows).toBe(0);
    expect((await move({ item: p + 'FG1', movement_type: 'ISSUE', quantity: '10' })).status()).toBe(
      201,
    );
    const stale = await commit(staleMoves);
    expect([stale.status, stale.error]).toEqual([
      'failed',
      expect.stringContaining('Data changed after validation'),
    ]);
    expect(await balance('FG1')).toBe(20);

    const dhHeader = 'plant,item,demand_date,quantity';
    const demand = await commit(
      await upload(
        'demand_history',
        [dhHeader, `${plantOne},${p}FG1,${day(-2)},12`, `${plantOne},${p}FG1,${day(-1)},8`].join(
          '\n',
        ),
        `demand-${suffix}.csv`,
      ),
    );
    expect(demand.summary).toEqual({ created: 2, updated: 0, unchanged: 0 });
    const demandAgain = await upload(
      'demand_history',
      [
        dhHeader,
        `${plantOne},${p}FG1,${day(-2)},12`,
        `${plantOne},${p}FG1,${day(-1)},9`,
        `${plantOne},${p}FG1,${day(2)},1`,
      ].join('\n'),
      `demand-again-${suffix}.csv`,
    );
    expect(await errorsOf(demandAgain)).toContain('cannot be in the future');
    const history = await ok(
      `plants/${plants[plantOne]}/demand-history?q=${(p + 'fg1').toLowerCase()}`,
    );
    expect(history.items.map((h: any) => [h.demand_date, Number(h.quantity)])).toEqual([
      [day(-1), 8],
      [day(-2), 12],
    ]);

    // What the demand itself says: the months, the shape of the year and the classes.
    const insight = await ok(`plants/${plants[plantOne]}/demand-insight`);
    expect(insight.months.length).toBeGreaterThan(0);
    expect(insight.total).toBe(20);
    expect(insight.book.invoicedLastYear).toBe(20);
    expect(insight.seasonal.some((x: any) => x.index !== null)).toBe(true);
    expect(insight.classes.items).toBeGreaterThan(0);
    expect(Object.values(insight.classes.grid).reduce((a: any, b: any) => a + b, 0)).toBe(
      insight.classes.items,
    );

    // Plant readiness includes stock locations, opening stock and demand.
    const readiness = Object.fromEntries(
      (await ok(`plants/${plants[plantOne]}/readiness`)).items.map((i: any) => [i.key, i.status]),
    );
    expect([
      readiness.stock_locations,
      readiness.stock,
      readiness.demand,
      readiness.supply,
    ]).toEqual(['ready', 'ready', 'ready', 'info']);
    const emptyPlant = Object.fromEntries(
      (await ok(`plants/${plants[plantTwo]}/readiness`)).items.map((i: any) => [i.key, i.status]),
    );
    expect([emptyPlant.stock, emptyPlant.demand]).toEqual(['missing', 'missing']);

    // Scale: 10,000 receipts posted from one file, then the ledger pages newest first.
    const bulk = [
      mvHeader,
      ...Array.from(
        { length: 10000 },
        (_, i) =>
          `${plantOne},${p}STORE,${p}RM2,RECEIPT,${(i % 9) + 1},,${day(0)},GRN,,${p}-BULK-${i}`,
      ),
    ].join('\n');
    const started = Date.now();
    const bulkBatch = await upload('stock_movements', bulk, `moves-bulk-${suffix}.csv`);
    expect([bulkBatch.error_rows, bulkBatch.summary.create]).toEqual([0, 10000]);
    expect((await commit(bulkBatch)).summary.created).toBe(10000);
    console.log(
      `PASS 10,000 stock movements validated and posted in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    expect(await balance('RM2')).toBe(
      4 + Array.from({ length: 10000 }, (_, i) => (i % 9) + 1).reduce((a, b) => a + b, 0),
    );
    const newest = await ok(
      `plants/${plants[plantOne]}/stock/movements?q=${(p + 'rm2').toLowerCase()}`,
    );
    expect([newest.items.length, newest.items[0].external_ref]).toEqual([25, `${p}-BULK-9999`]);
    const older = await ok(
      `plants/${plants[plantOne]}/stock/movements?q=${(p + 'rm2').toLowerCase()}&cursor=${newest.nextCursor}`,
    );
    expect(older.items[0].external_ref).toBe(`${p}-BULK-9974`);

    // A store keeper for plant one: receipts and issues only, no orders, no other plant.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Store keeper ' + suffix,
        permissions: [
          'dashboard.read',
          'sites.read',
          'masters.read',
          'inventory.read',
          'inventory.move',
          'imports.create',
        ],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Store Keeper', email, roleId });
    const grant = await ok('users/' + userId + '/plants');
    await ok('users/' + userId + '/plants', 'PUT', {
      version: grant.version,
      plantIds: [plants[plantOne]],
    });
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Store-Test-2026!', temporary: false },
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
    await up.locator('#password').fill('Store-Test-2026!');
    await up.locator('#kc-login').click();
    await completeTestMfa(up, email);
    await expect(up.locator('.main > header')).toBeVisible();
    const um = await (await up.request.get('/api/me')).json();
    const asStore = (
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
    const storeMove = (movement_type: string) =>
      asStore(`plants/${plants[plantOne]}/stock/movements`, 'POST', {
        location: p + 'STORE',
        item: p + 'RM1',
        movement_type,
        quantity: '1',
        unit: '',
        movement_date: day(0),
        reference: '',
        reason: 'x',
      });
    expect((await storeMove('RECEIPT')).status()).toBe(201);
    expect((await storeMove('OPENING')).status()).toBe(403);
    expect((await storeMove('ADJUSTMENT')).status()).toBe(403);
    expect(
      (await asStore(`stock-movements/${opening.id}/reverse`, 'POST', { reason: 'Nope' })).status(),
    ).toBe(403);
    expect((await asStore(`plants/${plants[plantTwo]}/stock`)).status()).toBe(404);
    expect((await asStore(`plants/${plants[plantOne]}/sales-orders`)).status()).toBe(403);
    const storeImport = await asStore(
      'imports/stock_movements',
      'POST',
      [
        mvHeader,
        `${plantOne},${p}STORE,${p}RM1,ADJUSTMENT,1,,${day(0)},,Found,${p}-ADJ-STORE`,
      ].join('\n'),
      { 'Content-Type': 'text/csv', 'X-File-Name': 'store-adjust.csv' },
    );
    expect(storeImport.status()).toBe(201);
    const storeBatch = await settled((await storeImport.json()).id);
    expect(await errorsOf(storeBatch)).toContain('ADJUSTMENT rows need the');
    await up.getByRole('button', { name: 'Availability', exact: true }).click();
    await expect(up.getByRole('tab', { name: 'Customer orders', exact: true })).toHaveCount(0);
    await openScreen(up, 'Stock');
    await up.getByRole('button', { name: 'Post movement' }).click();
    await expect(up.getByLabel('Movement type').locator('option')).toHaveText(['Receipt', 'Issue']);
    await expect(up.getByRole('button', { name: /^Reverse movement/ })).toHaveCount(0);
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
    const sites = `SELECT id FROM sites WHERE code LIKE '${p}%'`;
    sql(`DELETE FROM goods_receipt_lines WHERE receipt_id IN (SELECT id FROM goods_receipts WHERE site_id IN (${sites}));
      DELETE FROM goods_receipts WHERE site_id IN (${sites});
      UPDATE purchase_orders SET proposal_id=NULL WHERE site_id IN (${sites});
      DELETE FROM purchase_proposals WHERE site_id IN (${sites});`);
    sql(`DELETE FROM stock_balances WHERE site_id IN (${sites});
      DELETE FROM stock_movements WHERE reverses_id IS NOT NULL AND site_id IN (${sites});
      DELETE FROM stock_movements WHERE site_id IN (${sites});
      DELETE FROM demand_history WHERE site_id IN (${sites});
      DELETE FROM sales_order_lines WHERE order_id IN (SELECT id FROM sales_orders WHERE site_id IN (${sites}));
      DELETE FROM sales_orders WHERE site_id IN (${sites});
      DELETE FROM purchase_order_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE site_id IN (${sites}));
      DELETE FROM purchase_orders WHERE site_id IN (${sites});
      DELETE FROM stock_locations WHERE site_id IN (${sites});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM unit_conversions WHERE from_unit_id IN (SELECT id FROM units WHERE code LIKE '${p}%');
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM customers WHERE code LIKE '${p}%';
      DELETE FROM suppliers WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
