import { openScreen } from './helpers/nav';
import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { withRateLimitRetry } from './helpers/api';
import { test, expect, type Page } from '@playwright/test';
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

function api(page: Page, csrf: string) {
  const call = (
    path: string,
    method = 'GET',
    data?: unknown,
    headers: Record<string, string> = {},
  ) =>
    withRateLimitRetry(() =>
      page.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': csrf, ...headers },
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
    text?: RegExp,
  ) => {
    const r = await call(path, method, data);
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(status);
    if (text) expect(body.error.message).toMatch(text);
    return body.error;
  };
  return { call, ok, refused };
}

test('AV-5 purchase loop: order to shortage to proposal to approval to purchase order to receipt to stock', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'P' + suffix,
    userId = randomUUID(),
    email = `approver.${suffix}@example.test`;
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
  const { call, ok, refused } = api(page, me.csrfToken);
  let lastRun = 0;
  async function recalculated() {
    let status: any;
    await expect
      .poll(
        async () => {
          status = await ok('planning/status');
          return status.upToDate && Number(status.current?.run_no) > lastRun;
        },
        { timeout: 60000, intervals: [1000, 2000] },
      )
      .toBe(true);
    lastRun = Number(status.current.run_no);
  }
  const plants: Record<string, string> = {};
  const plantOne = p + 'P1',
    plantTwo = p + 'P2';
  const proposals = async (status = 'PROPOSED') =>
    (await ok(`plants/${plants[plantOne]}/purchase-proposals?status=${status}`)).items.filter(
      (x: any) => x.item.startsWith(p),
    );
  const rm1 = async () =>
    (await ok(`plants/${plants[plantOne]}/buffers?q=${(p + 'rm1').toLowerCase()}`)).items[0];
  const mtoOrder = async (no: string, qty: string) =>
    ok(`plants/${plants[plantOne]}/sales-orders`, 'POST', {
      order_no: p + no,
      customer: p + 'C1',
      order_date: day(0),
      promise_date: day(3),
      allow_partial: true,
      customer_ref: '',
      lines: [{ line_no: '10', item: p + 'FG2', quantity: qty, line_promise_date: '' }],
    });
  try {
    // Setup: RM1 bought in boxes of 25 kg (MOQ 4 boxes, multiples of 2), used by FG1 (2 kg) and
    // FG2 (1 kg, made to order). FG1 sells 10 a day, so RM1 uses 20 kg a day over a 10-day lead time.
    for (const [code, decimals] of [
      ['KG', 3],
      ['NOS', 0],
      ['BOX', 0],
    ] as const)
      await ok('units', 'POST', { code: p + code, name: code, decimals });
    for (const [code, type, makeBuy, unit] of [
      ['RM1', 'RM', 'BUY', 'KG'],
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
    await ok('masters/suppliers', 'POST', {
      code: p + 'S1',
      name: 'Steel Co',
      lead_time_days: '10',
    });
    await ok('masters/item_suppliers', 'POST', {
      item: p + 'RM1',
      supplier: p + 'S1',
      purchase_unit: p + 'BOX',
      moq: '4',
      lot_multiple: '2',
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
      name: 'Raw store',
      location_type: 'STORES',
      nettable: true,
    });
    await ok(`plants/${plants[plantOne]}/stock/movements`, 'POST', {
      location: p + 'ST',
      item: p + 'RM1',
      movement_type: 'OPENING',
      quantity: '100',
      unit: '',
      movement_date: day(0),
      reference: '',
      reason: '',
    });
    const upload = await call(
      'imports/demand_history',
      'POST',
      [
        'plant,item,demand_date,quantity',
        ...Array.from({ length: 30 }, (_, i) => `${plantOne},${p}FG1,${day(-1 - i)},10`),
      ].join('\n'),
      { 'Content-Type': 'text/csv', 'X-File-Name': `demand-${suffix}.csv` },
    );
    const batch = await upload.json();
    let staged: any;
    await expect
      .poll(async () => {
        staged = await ok('imports/' + batch.id);
        return staged.status;
      })
      .toBe('validated');
    await ok(`imports/${batch.id}/commit`, 'POST', { version: staged.version });
    await ok('buffer-profiles', 'POST', {
      code: p + 'BP',
      name: 'Half',
      red_base_pct: '50',
      green_pct: '50',
      adu_window_days: '30',
    });
    for (const [item, lead] of [
      ['RM1', ''],
      ['FG1', '5'],
    ])
      await ok(`plants/${plants[plantOne]}/buffer-settings`, 'POST', {
        item: p + item,
        policy: 'BUFFER',
        profile: p + 'BP',
        lead_time_days: lead,
      });
    await ok(`plants/${plants[plantOne]}/buffer-settings`, 'POST', {
      item: p + 'FG2',
      policy: 'MTO',
    });

    // Shortage -> proposal: RM1 NFP 100 kg (red), TOG 400 -> 300 kg = 12 boxes (multiple of 2, MOQ 4).
    await recalculated();
    let [first] = await proposals();
    expect([first.source, Number(first.quantity), first.unit, first.supplier, first.zone]).toEqual([
      'SYSTEM',
      12,
      p + 'BOX',
      p + 'S1',
      'red',
    ]);
    expect(first.due_date).toBe(day(10));
    expect((await rm1()).pending_proposal_no).toBe(first.proposal_no);

    // A person who changes a proposal cannot approve it.
    await ok(`purchase-proposals/${first.id}`, 'PATCH', {
      quantity: '14',
      due_date: day(10),
      note: 'Round up for the truck',
      version: first.version,
    });
    first = await ok(`purchase-proposals/${first.id}`);
    await refused(
      `purchase-proposals/${first.id}/approve`,
      'POST',
      { version: first.version },
      409,
      /someone else must approve/,
    );

    // The approver: purchase approval for plant one only, no receiving, no raising.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Purchase approver ' + suffix,
        permissions: [
          'dashboard.read',
          'sites.read',
          'masters.read',
          'purchase.read',
          'purchase.approve',
        ],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Purchase Approver', email, roleId });
    const grant = await ok('users/' + userId + '/plants');
    await ok('users/' + userId + '/plants', 'PUT', {
      version: grant.version,
      plantIds: [plants[plantOne]],
    });
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    for (const [path, data] of [
      ['/reset-password', { type: 'password', value: 'Approver-Test-2026!', temporary: false }],
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
    const ap = await context.newPage();
    await ap.goto(env.APP_URL + '/api/auth/login');
    await ap.locator('#username').fill(email);
    await ap.locator('#password').fill('Approver-Test-2026!');
    await ap.locator('#kc-login').click();
    await completeTestMfa(ap, email);
    await expect(ap.locator('.main > header')).toBeVisible();
    const approver = api(ap, (await (await ap.request.get('/api/me')).json()).csrfToken);

    // Approval creates a purchase order: incoming supply, not stock.
    const approved = await approver.ok(`purchase-proposals/${first.id}/approve`, 'POST', {
      version: first.version,
    });
    expect(approved.message).toMatch(new RegExp(`Purchase order PO-\\d{6} created for 14 ${p}BOX`));
    await approver.refused(
      `purchase-proposals/${first.id}/approve`,
      'POST',
      { version: first.version },
      409,
      /already approved|changed after/,
    );
    const po = await ok('purchase-orders/' + approved.poId);
    expect([
      po.source,
      po.lines[0].unit,
      Number(po.lines[0].quantity),
      Number(po.lines[0].unit_factor),
    ]).toEqual(['PROPOSAL', p + 'BOX', 14, 25]);
    await recalculated();
    let row = await rm1();
    expect([
      Number(row.on_hand),
      Number(row.open_supply),
      Number(row.nfp),
      row.pending_proposal_no,
    ]).toEqual([100, 350, 450, null]);
    expect(await proposals()).toHaveLength(0);
    expect((await proposals('APPROVED'))[0].po_no).toBe(po.po_no);

    // A new shortage: a 500 kg make-to-order demand inside RM1's lead time.
    const order = await mtoOrder('SO1', '500');
    await recalculated();
    let [second] = await proposals();
    // NFP 100 + 350 - 500 = -50 -> 450 kg to top of green = 18 boxes.
    expect([Number(second.quantity), second.zone]).toEqual([18, 'breach']);
    // Stale: someone changes it after the approver opened it.
    await ok(`purchase-proposals/${second.id}`, 'PATCH', {
      quantity: '20',
      due_date: day(10),
      note: '',
      version: second.version,
    });
    await approver.refused(
      `purchase-proposals/${second.id}/approve`,
      'POST',
      { version: second.version },
      409,
      /changed after you opened it/,
    );
    second = await ok(`purchase-proposals/${second.id}`);
    // Inputs changed and not yet recalculated: approval waits for the new calculation.
    await ok(`plants/${plants[plantOne]}/stock/movements`, 'POST', {
      location: p + 'ST',
      item: p + 'RM1',
      movement_type: 'RECEIPT',
      quantity: '1',
      unit: '',
      movement_date: day(0),
      reference: 'Sample',
      reason: '',
    });
    await approver.refused(
      `plants/${plants[plantOne]}/purchase-proposals/approve`,
      'POST',
      { items: [{ id: second.id, version: second.version }] },
      409,
      /being recalculated/,
    );
    await recalculated();
    // The manual change is kept by planning; the approver approves from the screen.
    second = await ok(`purchase-proposals/${second.id}`);
    expect(Number(second.quantity)).toBe(20);
    await ap.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(ap, 'Proposed Orders');
    await expect(ap.getByRole('tab', { name: /Waiting for approval/ })).toContainText('1');
    await ap.getByLabel(`Select proposal ${second.proposal_no}`).check();
    await ap.getByRole('button', { name: 'Approve selected' }).click();
    await expect(
      ap.getByText(/1 proposal\(s\) approved\. Purchase orders PO-\d{6} created/),
    ).toBeVisible();
    await expect(ap.getByRole('button', { name: 'Raise proposal' })).toHaveCount(0);
    const secondPo = (await proposals('APPROVED')).find((x: any) => x.id === second.id).po_id;

    // Withdrawn when the need goes away; rejected with a reason; manual proposals need another approver.
    const extra = await mtoOrder('SO2', '600');
    await recalculated();
    const [third] = await proposals();
    await ok(`sales-orders/${extra.id}/cancel`, 'POST', {
      reason: 'Customer withdrew',
      version: 1,
    });
    await recalculated();
    expect((await proposals('WITHDRAWN')).map((x: any) => x.id)).toContain(third.id);
    const manual = await ok(`plants/${plants[plantOne]}/purchase-proposals`, 'POST', {
      item: p + 'RM1',
      quantity: '4',
      due_date: day(20),
      note: 'Trial lot',
    });
    await refused(
      `plants/${plants[plantOne]}/purchase-proposals`,
      'POST',
      { item: p + 'RM1', quantity: '4', due_date: day(20), note: '' },
      409,
      /already pending/,
    );
    const manualRow = await ok('purchase-proposals/' + manual.id);
    expect(manualRow.source).toBe('MANUAL');
    await approver.refused(
      `purchase-proposals/${manual.id}/reject`,
      'POST',
      { version: manualRow.version, reason: '' },
      400,
      /Reason/,
    );
    await approver.ok(`purchase-proposals/${manual.id}/reject`, 'POST', {
      version: manualRow.version,
      reason: 'Not needed',
    });
    expect((await proposals('REJECTED')).find((x: any) => x.id === manual.id).decision_note).toBe(
      'Not needed',
    );

    // Receipts: partial, repeated request, too much, then the rest. Stock follows receipts only.
    const receive = (poId: string, requestId: string, quantity: string) =>
      call(`purchase-orders/${poId}/receipts`, 'POST', {
        request_id: requestId,
        location: p + 'ST',
        receipt_date: day(0),
        reference: 'DN-' + quantity,
        lines: [{ line_no: 10, quantity }],
      });
    const stockOf = async () =>
      Number(
        (await ok(`plants/${plants[plantOne]}/stock?q=${(p + 'rm1').toLowerCase()}`)).items[0]
          .quantity,
      );
    const before = await stockOf();
    const requestA = randomUUID();
    expect((await receive(approved.poId, requestA, '6')).status()).toBe(201);
    expect(await stockOf()).toBe(before + 150);
    const again = await (await receive(approved.poId, requestA, '6')).json();
    expect(again.message).toMatch(/already recorded/);
    expect(await stockOf()).toBe(before + 150);
    const tooMuch = await (await receive(approved.poId, randomUUID(), '9')).json();
    expect(tooMuch.error.message).toMatch(/only 8 is still due/);
    await approver.refused(
      `purchase-orders/${approved.poId}/receipts`,
      'POST',
      {
        request_id: randomUUID(),
        location: p + 'ST',
        receipt_date: day(0),
        reference: '',
        lines: [{ line_no: 10, quantity: '1' }],
      },
      403,
    );
    // The rest through the screen.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(page, 'Buffers & POs');
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await page.getByRole('button', { name: `Open purchase order ${po.po_no}` }).click();
    await expect(page.getByText('GRN-')).toBeVisible();
    await page.getByRole('button', { name: 'Receive goods' }).click();
    await expect(page.getByLabel('Line 10 received now')).toHaveValue('8');
    await page.getByRole('button', { name: 'Post receipt' }).click();
    await expect(page.getByText(/Receipt GRN-\d+ posted against/)).toBeVisible();
    expect(await stockOf()).toBe(before + 350);
    const receipts = (await ok(`purchase-orders/${approved.poId}/receipts`)).items;
    expect(receipts.map((r: any) => Number(r.lines[0].quantity))).toEqual([6, 8]);
    const closed = await ok('purchase-orders/' + approved.poId);
    expect(Number(closed.lines[0].received_quantity)).toBe(14);
    // A line with receipts cannot change item; received quantities are not taken from the form.
    await refused(
      'purchase-orders/' + approved.poId,
      'PUT',
      {
        supplier: p + 'S1',
        order_date: closed.order_date,
        lines: [
          {
            line_no: '10',
            item: p + 'FG1',
            quantity: '14',
            unit: '',
            due_date: day(10),
            received_quantity: '0',
          },
        ],
        version: closed.version,
      },
      409,
      /already has goods received/,
    );
    // Stock moved from open supply to on hand; net flow unchanged by the receipt itself.
    await recalculated();
    row = await rm1();
    expect([Number(row.on_hand), Number(row.open_supply)]).toEqual([before + 350, 500]);
    expect(
      sql(`SELECT count(*) FROM purchase_orders WHERE id='${secondPo}' AND source='PROPOSAL'`),
    ).toBe('1');

    // Plant scope and the approver's view.
    expect((await approver.call(`plants/${plants[plantTwo]}/purchase-proposals`)).status()).toBe(
      404,
    );
    expect(
      (
        await approver.call(`plants/${plants[plantOne]}/purchase-proposals`, 'POST', {
          item: p + 'RM1',
          quantity: '4',
          due_date: day(20),
          note: '',
        })
      ).status(),
    ).toBe(403);
    await ok(`sales-orders/${order.id}/cancel`, 'POST', { reason: 'Test done', version: 1 });
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
    sql(`DELETE FROM goods_receipt_lines WHERE receipt_id IN (SELECT id FROM goods_receipts WHERE site_id IN (${sites}));
      DELETE FROM goods_receipts WHERE site_id IN (${sites});
      UPDATE purchase_orders SET proposal_id=NULL WHERE site_id IN (${sites});
      DELETE FROM purchase_proposals WHERE site_id IN (${sites});
      DELETE FROM planning_results WHERE item_id IN (${items});
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
      DELETE FROM unit_conversions WHERE from_unit_id IN (SELECT id FROM units WHERE code LIKE '${p}%');
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM customers WHERE code LIKE '${p}%';
      DELETE FROM suppliers WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
