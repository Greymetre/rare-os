// RCH-5 Customer 360. Its own acceptance is: an order that would take a shop past its credit
// limit, or placed before its paperwork is verified, is **taken and held** with the reason
// recorded — and the hold clears the moment the reason does, with nothing stored to rewrite.
//
// Around that: both ways a bill arrives and the permission that is the only switch between them,
// the gapless number series, collections and their reversal, the ageing, and the boundaries —
// a rep reads their own orders and nobody else's, a login without the invoice right cannot raise
// or record a bill at all, and what one company may see of another.
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

test('RCH-5 Customer 360: the held order, both kinds of bill, collections and the boundaries', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'K' + suffix,
    repUserId = randomUUID(),
    repEmail = `traderep.${suffix}@example.test`,
    otherCompany = randomUUID();
  let repRole = '',
    tenantId = '',
    repIdentity = '',
    repContext: any,
    settingsBefore: any = null;

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

  const call = (path: string, method = 'GET', data?: unknown) =>
    withRateLimitRetry(() =>
      page.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
        data,
      }),
    );
  async function ok(path: string, method = 'GET', data?: unknown) {
    const r = await call(path, method, data);
    const body = await r.json();
    expect(r.ok(), `${method} ${path}: ${JSON.stringify(body)}`).toBe(true);
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

  try {
    settingsBefore = (await ok('reach/settings')).settings;
    tenantId = me.user.tenant_id;
    expect(tenantId, 'the signed-in company is needed to clean up safely').toMatch(
      /^[0-9a-f-]{36}$/,
    );

    // ---------- What a trading shop stands on ----------
    await ok('units', 'POST', { code: p + 'NOS', name: 'Pieces', decimals: 0 });
    for (const [code, name] of [
      ['CHAIR', 'Moulded chair'],
      ['TABLE', 'Centre table'],
    ])
      await ok('masters/items', 'POST', {
        code: p + code,
        name,
        item_type: 'FG',
        make_buy: 'MAKE',
        base_unit: p + 'NOS',
      });

    await ok('masters/territories', 'POST', { code: p + 'T', name: 'Trade territory' });
    await ok('masters/rep_grades', 'POST', { code: p + 'G', name: 'Officer', rank: 1 });
    // A retailer may owe 50,000, is sold on 30 days, and stops being sold to once a bill is 45
    // days old. Its paperwork has to be verified before it may order at all.
    await ok('masters/customer_types', 'POST', {
      code: p + 'RET',
      name: 'Retailer',
      checkin_radius_m: 75,
      // This milestone is about what the shop owes, not the round it sits on, so the type is
      // kept off the beat plan and the customer needs no beat to exist.
      on_beat_plan: false,
      needs_approval: false,
      kyc_before_order: true,
      order_route: 'ERP',
      credit_limit: '50000.00',
      credit_days: 30,
      hold_days: 45,
    });
    // A type that asks for nothing and lends nothing: used to prove the engine does not invent
    // a limit or a document where the company set none.
    await ok('masters/customer_types', 'POST', {
      code: p + 'CASH',
      name: 'Cash counter',
      checkin_radius_m: 75,
      on_beat_plan: false,
      needs_approval: false,
      kyc_before_order: false,
      order_route: 'NONE',
    });

    // The paperwork a retailer is asked for: a GSTIN that blocks, a PAN that does not.
    await ok('masters/kyc_types', 'POST', {
      code: p + 'GST',
      name: 'GST certificate',
      number_check: 'gstin',
    });
    await ok('masters/kyc_types', 'POST', {
      code: p + 'PAN',
      name: 'PAN card',
      number_check: 'pan',
    });
    await ok('masters/kyc_rules', 'POST', {
      type: p + 'RET',
      kyc_type: p + 'GST',
      requirement: 'R',
    });
    await ok('masters/kyc_rules', 'POST', {
      type: p + 'RET',
      kyc_type: p + 'PAN',
      requirement: 'O',
    });

    // The price list this type buys on, and a scheme that starts at 50 chairs. A rate opened long
    // ago is the one in force today, which is what "the latest list that has opened" means.
    const startOfTime = '2020-01-01';
    await ok('masters/price_list_items', 'POST', {
      type: p + 'RET',
      item: p + 'CHAIR',
      rate: '240.0000',
      gst_pct: '18.00',
      from_date: startOfTime,
    });
    await ok('masters/price_list_items', 'POST', {
      type: p + 'RET',
      item: p + 'TABLE',
      rate: '2000.0000',
      gst_pct: '18.00',
      from_date: startOfTime,
    });
    await ok('masters/trade_schemes', 'POST', {
      code: p + 'S50',
      name: 'Fifty chairs',
      item: p + 'CHAIR',
      min_quantity: '50',
      discount_pct: '5.00',
      free_quantity: '2',
      from_date: startOfTime,
    });
    // A scheme that gives nothing is somebody's mistake, and the master says so.
    await rejected(
      'masters/trade_schemes',
      'POST',
      {
        code: p + 'S0',
        name: 'Gives nothing',
        item: p + 'CHAIR',
        min_quantity: '10',
        from_date: startOfTime,
      },
      400,
      /discount|free/i,
    );

    const repId = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'R',
        name: 'Kiran Trade',
        grade: p + 'G',
        territory: p + 'T',
      })
    ).id;
    const shop = (
      await ok('reach/customers', 'POST', {
        code: p + 'C1',
        type: p + 'RET',
        name: 'Rohtak retail',
        territory: p + 'T',
        town: 'Rohtak',
      })
    ).id;
    const counter = (
      await ok('reach/customers', 'POST', {
        code: p + 'C2',
        type: p + 'CASH',
        name: 'Cash counter',
        territory: p + 'T',
        town: 'Rohtak',
      })
    ).id;

    // ---------- The rep's own session ----------
    repRole = (
      await ok('roles', 'POST', {
        name: 'Trade rep ' + suffix,
        permissions: ['dashboard.read', 'reach.order', 'reach.collect'],
      })
    ).id;
    await ok('users', 'POST', {
      requestId: repUserId,
      name: 'Trade Rep',
      email: repEmail,
      roleId: repRole,
    });
    sql(`UPDATE field_reps SET user_id='${repUserId}' WHERE id='${repId}'`);
    repIdentity = sql(`SELECT identity_id FROM app_users WHERE id='${repUserId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + repIdentity + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Reach-Trade-2026!', temporary: false },
          },
        )
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.put(env.AUTH_URL + '/admin/realms/rare-os/users/' + repIdentity, {
          headers: kcHeaders,
          data: { emailVerified: true, requiredActions: [] },
        })
      ).ok(),
    ).toBe(true);

    repContext = await browser.newContext();
    const repPage = await repContext.newPage();
    await repPage.goto('/');
    await repPage.getByRole('link', { name: /sign in securely/i }).click();
    await repPage.locator('#username').fill(repEmail);
    await repPage.locator('#password').fill('Reach-Trade-2026!');
    await repPage.locator('#kc-login').click();
    await completeTestMfa(repPage, repEmail);
    await expect(repPage.locator('.main > header')).toBeVisible();
    const repMe = await (await repPage.request.get('/api/me')).json();
    const asRep = (path: string, method = 'GET', data?: unknown) =>
      withRateLimitRetry(() =>
        repPage.request.fetch('/api/' + path, {
          method,
          headers: { Origin: env.APP_URL, 'X-CSRF-Token': repMe.csrfToken },
          data,
        }),
      );
    async function okRep(path: string, method = 'GET', data?: unknown) {
      const r = await asRep(path, method, data);
      const body = await r.json();
      expect(r.ok(), `${method} ${path} as rep: ${JSON.stringify(body)}`).toBe(true);
      return body;
    }
    async function rejectedRep(
      path: string,
      method: string,
      data: unknown,
      status: number,
      text: RegExp,
    ) {
      const r = await asRep(path, method, data);
      const body = await r.json();
      expect(r.status(), JSON.stringify(body)).toBe(status);
      expect(body.error.message).toMatch(text);
    }

    // ---------- The price list travels with the screen ----------
    const price = await okRep(`reach/trade/customer/${shop}/price`);
    const chair = price.items.find((i: any) => i.item === p + 'CHAIR');
    const table = price.items.find((i: any) => i.item === p + 'TABLE');
    expect(Number(chair.rate)).toBe(240);
    // Reading the price master itself is a different right, and this rep does not have it.
    expect((await asRep('masters/price_list_items')).status()).toBe(403);

    // The quote prices the scheme without taking anything: 50 chairs earn 5% and two free.
    const quote = await okRep(`reach/trade/customer/${shop}/quote`, 'POST', {
      lines: [{ item_id: chair.item_id, units: 50 }],
    });
    expect(quote.lines[0].discount_pct).toBe(5);
    expect(quote.lines[0].free_units).toBe(2);
    // 50 × 240 = 12,000, less 5% is 11,400, plus 18% GST is 13,452. The two free chairs are
    // given, not billed.
    expect(quote.totals.taxable).toBe(11400);
    expect(quote.totals.total).toBe(13452);
    expect(quote.kyc).toBe('MISSING');

    // ---------- The milestone acceptance: held, not refused ----------
    const heldForKyc = await okRep(`reach/trade/customer/${shop}/order`, 'POST', {
      lines: [{ item_id: chair.item_id, units: 50 }],
    });
    expect(heldForKyc.status).toBe('HELD');
    expect(heldForKyc.credit.reasons).toEqual(['KYC']);
    // The order exists. A rep told "no" with no record of why stops trusting the app.
    expect(heldForKyc.message).toMatch(/taken and held/);
    expect((await ok(`reach/trade/orders/${heldForKyc.id}`)).total).toBe(13452);

    // Uploading is one act; deciding is another, and the rep may do neither.
    await rejectedRep(
      `reach/trade/customer/${shop}/kyc`,
      'POST',
      { kyc_type_id: randomUUID(), number: 'x' },
      403,
      /permission|not allowed|forbidden/i,
    );
    const asked = (await ok(`reach/trade/customer/${shop}/kyc`)).asked;
    const gstType = asked.find((a: any) => a.code === p + 'GST');
    // A GSTIN is checked by the same rule the customer form uses.
    await rejected(
      `reach/trade/customer/${shop}/kyc`,
      'POST',
      { kyc_type_id: gstType.id, number: 'NOTAGSTIN' },
      400,
      /valid GSTIN/,
    );
    const gstDoc = await ok(`reach/trade/customer/${shop}/kyc`, 'POST', {
      kyc_type_id: gstType.id,
      number: '06AABCU9603R1ZM',
    });

    // Uploaded is not verified: the order is still held, and nothing about it was rewritten.
    let view = await ok(`reach/trade/customer/${shop}`);
    expect(view.kyc.status).toBe('PENDING');
    expect(view.credit.reasons).toEqual(['KYC']);
    expect((await ok(`reach/trade/orders/${heldForKyc.id}`)).status).toBe('HELD');

    // A rejection has to say why.
    const queue = await ok('reach/trade/kyc?status=PENDING');
    const waiting = queue.items.find((d: any) => d.id === gstDoc.id);
    expect(waiting.customer).toBe(p + 'C1');
    await rejected(
      `reach/trade/kyc/${gstDoc.id}/decide`,
      'POST',
      { status: 'REJECTED', reason: '', version: waiting.version },
      400,
      /Reason/i,
    );
    await ok(`reach/trade/kyc/${gstDoc.id}/decide`, 'POST', {
      status: 'VERIFIED',
      reason: '',
      version: waiting.version,
    });
    // Deciding twice is refused rather than silently repeated.
    await rejected(
      `reach/trade/kyc/${gstDoc.id}/decide`,
      'POST',
      { status: 'REJECTED', reason: 'changed my mind', version: waiting.version },
      409,
      /already decided/,
    );

    // The acceptance, read from the evidence: the hold is gone and the old order is untouched.
    view = await ok(`reach/trade/customer/${shop}`);
    expect(view.kyc.status).toBe('VERIFIED');
    expect(view.credit.hold).toBe(false);
    expect(view.credit.message).toBe('Clear to place.');
    expect((await ok(`reach/trade/orders/${heldForKyc.id}`)).status).toBe('HELD');

    const placed = await okRep(`reach/trade/customer/${shop}/order`, 'POST', {
      lines: [{ item_id: table.item_id, units: 3 }],
    });
    expect(placed.status).toBe('PLACED');
    expect(placed.total).toBe(7080);

    // ---------- Over the limit is the same story ----------
    const big = await okRep(`reach/trade/customer/${shop}/order`, 'POST', {
      lines: [{ item_id: table.item_id, units: 30 }],
    });
    expect(big.status).toBe('HELD');
    expect(big.credit.reasons).toEqual(['OVER_LIMIT']);
    // Releasing is its own right and its own reason. The rep has neither.
    await rejectedRep(
      `reach/trade/orders/${big.id}/release`,
      'POST',
      { reason: 'let it go', version: 1 },
      403,
      /permission|not allowed|forbidden/i,
    );
    const bigOrder = await ok(`reach/trade/orders/${big.id}`);
    await rejected(
      `reach/trade/orders/${big.id}/release`,
      'POST',
      { reason: '', version: bigOrder.version },
      400,
      /Reason/i,
    );
    await ok(`reach/trade/orders/${big.id}/release`, 'POST', {
      reason: 'Owner agreed on the phone',
      version: bigOrder.version,
    });
    const released = await ok(`reach/trade/orders/${big.id}`);
    expect(released.status).toBe('PLACED');
    expect(released.release_reason).toBe('Owner agreed on the phone');
    // Releasing what is not held is refused: there is nothing to decide.
    await rejected(
      `reach/trade/orders/${big.id}/release`,
      'POST',
      { reason: 'again', version: released.version },
      409,
      /not on hold/,
    );
    await ok(`reach/trade/orders/${big.id}/cancel`, 'PATCH', {
      reason: 'Shop changed its mind',
      version: released.version,
    });
    expect((await ok(`reach/trade/orders/${big.id}`)).status).toBe('CANCELLED');

    // ---------- A bill arrives two ways ----------
    // Raised here, from this module's own series.
    const raised = await ok(`reach/trade/orders/${placed.id}/invoice`, 'POST', {
      prefix: p,
      invoice_date: view.asOf,
    });
    expect(raised.invoice_no).toMatch(new RegExp(`^${p}/\\d{4}/0001$`));
    expect(raised.amount).toBe(7080);
    // One order, one bill.
    await rejected(
      `reach/trade/orders/${placed.id}/invoice`,
      'POST',
      { prefix: p, invoice_date: view.asOf },
      409,
      /already billed/,
    );
    // A held order is not billable, and neither is a cancelled one.
    await rejected(
      `reach/trade/orders/${heldForKyc.id}/invoice`,
      'POST',
      { prefix: p },
      409,
      /placed or routed/,
    );

    // Recorded, from somewhere else. The number is whatever that document says, and no series is
    // touched: the two numbering authorities stay told apart.
    const erpBill = await ok(`reach/trade/customer/${shop}/invoice`, 'POST', {
      invoice_no: `ERP/${p}/77`,
      invoice_date: view.asOf,
      amount: 10000,
      source: 'ERP',
      lines: [{ item_id: chair.item_id, units: 40, total: 10000 }],
    });
    // Lines that do not add up to the bill are refused rather than quietly saved.
    await rejected(
      `reach/trade/customer/${shop}/invoice`,
      'POST',
      {
        invoice_no: `ERP/${p}/78`,
        invoice_date: view.asOf,
        amount: 10000,
        source: 'ERP',
        lines: [{ item_id: chair.item_id, units: 40, total: 9000 }],
      },
      400,
      /lines come to/,
    );
    await rejected(
      `reach/trade/customer/${shop}/invoice`,
      'POST',
      {
        invoice_no: `ERP/${p}/77`,
        invoice_date: view.asOf,
        amount: 10000,
        source: 'ERP',
      },
      409,
      /already recorded/,
    );
    // A recorded bill may not claim this module's own authority.
    await rejected(
      `reach/trade/customer/${shop}/invoice`,
      'POST',
      {
        invoice_no: `ERP/${p}/79`,
        invoice_date: view.asOf,
        amount: 1000,
        source: 'RAISED',
      },
      400,
      /ERP, an import or was entered by hand/,
    );
    expect(sql(`SELECT series_id IS NULL FROM trade_invoices WHERE id='${erpBill.id}'`)).toBe('t');
    expect(sql(`SELECT source FROM trade_invoices WHERE id='${erpBill.id}'`)).toBe('ERP');

    // ---------- The number stays used ----------
    const scrapped = await ok(`reach/trade/invoices/${raised.id}/cancel`, 'PATCH', {
      reason: 'Wrong shop',
      version: 1,
    });
    expect(scrapped.message).toMatch(/number stays used/);
    const second = await ok(`reach/trade/orders/${placed.id}/invoice`, 'POST', {
      prefix: p,
      invoice_date: view.asOf,
    });
    expect(second.invoice_no).toMatch(new RegExp(`^${p}/\\d{4}/0002$`));
    expect(
      sql(`SELECT next_no FROM invoice_series WHERE tenant_id='${tenantId}' AND prefix='${p}'`),
    ).toBe('3');

    // ---------- Collections ----------
    let owing = await ok(`reach/trade/customer/${shop}/outstanding`);
    expect(owing.outstanding).toBe(17080);
    expect(owing.invoices).toBe(2);

    // A cheque without its number cannot be traced to a bank line.
    await rejectedRep(
      `reach/trade/customer/${shop}/receipt`,
      'POST',
      { amount: 1000, mode: 'CHEQUE' },
      400,
      /needs its number/,
    );
    await rejectedRep(
      `reach/trade/customer/${shop}/receipt`,
      'POST',
      { amount: 1000, mode: 'BARTER' },
      400,
      /not a way this system records money/,
    );
    // Money cannot be collected tomorrow.
    const tomorrow = new Date(Date.parse(view.asOf + 'T00:00:00Z') + 86400000)
      .toISOString()
      .slice(0, 10);
    await rejectedRep(
      `reach/trade/customer/${shop}/receipt`,
      'POST',
      { amount: 1000, mode: 'CASH', received_on: tomorrow },
      400,
      /future/,
    );

    const part = await okRep(`reach/trade/customer/${shop}/receipt`, 'POST', {
      amount: 5000,
      mode: 'CASH',
      invoice_id: second.id,
    });
    expect(part.outstanding).toBe(12080);
    owing = await ok(`reach/trade/customer/${shop}/outstanding`);
    expect(owing.rows.find((r: any) => r.id === second.id).status).toBe('PART_PAID');

    // Money with no bill named is still money owed less: it settles the oldest bill first.
    await okRep(`reach/trade/customer/${shop}/receipt`, 'POST', {
      amount: 2000,
      mode: 'UPI',
      reference: 'UPI-' + suffix,
    });
    owing = await ok(`reach/trade/customer/${shop}/outstanding`);
    expect(owing.outstanding).toBe(10080);

    // Reversing a collection makes the bill owed again.
    const receipt = (await ok(`reach/trade/customer/${shop}/outstanding`)).receipts.find(
      (r: any) => r.id === part.id,
    );
    await ok(`reach/trade/receipts/${part.id}/cancel`, 'PATCH', {
      reason: 'Cheque bounced',
      version: receipt.version,
    });
    owing = await ok(`reach/trade/customer/${shop}/outstanding`);
    expect(owing.outstanding).toBe(15080);

    // ---------- The whole screen, read from the evidence ----------
    view = await ok(`reach/trade/customer/${shop}`);
    expect(view.outstanding.outstanding).toBe(15080);
    expect(view.credit.available).toBe(34920);
    expect(view.sales.thisMonth.amount).toBe(17080);
    expect(view.sales.topItems.map((i: any) => i.code)).toContain(p + 'CHAIR');
    expect(view.dso).not.toBeNull();
    // The ageing buckets come from the company's setting, and every open bill falls in exactly
    // one of them.
    expect(view.outstanding.labels.length).toBeGreaterThan(1);
    expect(Object.values(view.outstanding.totals).reduce((a: any, b: any) => a + b, 0)).toBeCloseTo(
      15080,
      2,
    );
    // What the screen may offer is read from the signed-in person's rights, not from a setting.
    expect(view.can).toMatchObject({ invoice: true, credit: true, kyc: true, collect: true });
    expect(view.timeline.length).toBeGreaterThan(3);
    expect(view.timeline.map((e: any) => e.kind)).toContain('INVOICE');

    // A type that lends nothing and asks for nothing holds nothing back.
    const cash = await ok(`reach/trade/customer/${counter}`);
    expect(cash.credit.limit).toBeNull();
    expect(cash.credit.available).toBeNull();
    expect(cash.kyc.status).toBe('VERIFIED');
    expect(cash.credit.hold).toBe(false);

    // ---------- Boundaries ----------
    // The invoice right is the only switch. Without it a login can neither raise nor record.
    await rejectedRep(
      `reach/trade/orders/${placed.id}/invoice`,
      'POST',
      { prefix: p },
      403,
      /permission|not allowed|forbidden/i,
    );
    await rejectedRep(
      `reach/trade/customer/${shop}/invoice`,
      'POST',
      { invoice_no: 'X1', invoice_date: view.asOf, amount: 100 },
      403,
      /permission|not allowed|forbidden/i,
    );
    // A rep reads the orders they took and nobody else's, and asking for another rep's is
    // refused rather than quietly answered with their own.
    await rejectedRep(
      `reach/trade/orders?from=${view.asOf}&to=${view.asOf}&rep=${randomUUID()}`,
      'GET',
      undefined,
      403,
      /only read your own orders/,
    );
    const ownOrders = await okRep(`reach/trade/orders?from=${view.asOf}&to=${view.asOf}`);
    expect(ownOrders.items.every((o: any) => o.rep === p + 'R')).toBe(true);
    expect(ownOrders.canRelease).toBe(false);
    expect(ownOrders.canInvoice).toBe(false);
    // Unknown fields are refused outright rather than dropped.
    await rejected(
      `reach/trade/customer/${shop}/receipt`,
      'POST',
      { amount: 10, mode: 'CASH', sneaky: 'yes' },
      400,
      /Unsupported field/,
    );
    // A window wider than a year is refused rather than served slowly.
    await rejected(
      `reach/trade/orders?from=2020-01-01&to=${view.asOf}`,
      'GET',
      undefined,
      400,
      /at most 366 days/,
    );

    // ---------- The screens ----------
    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(page, 'Customer 360');
    await expect(page.getByRole('heading', { name: 'Customer 360' })).toBeVisible();
    await page.getByLabel('Find a customer').fill(p + 'C1');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await page.getByRole('button', { name: `Open customer ${p}C1` }).click();
    await expect(page.getByRole('heading', { name: new RegExp(p + 'C1') })).toBeVisible();
    await expect(page.getByText('Left to sell')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Record a bill' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Collect', exact: true })).toBeVisible();
    await expect(page.getByText('Clear to place.')).toBeVisible();

    await openScreen(page, 'Orders');
    await expect(page.getByRole('heading', { name: 'Orders', exact: true })).toBeVisible();
    await page.getByLabel('From', { exact: true }).fill(view.asOf);
    await page.getByLabel('To', { exact: true }).fill(view.asOf);
    await expect(page.getByRole('cell', { name: new RegExp(p + 'C1') }).first()).toBeVisible();

    await openScreen(page, 'Paperwork');
    await expect(page.getByRole('heading', { name: 'Paperwork to check' })).toBeVisible();

    await openScreen(page, 'Customer 360 settings');
    await expect(page.getByLabel('Ageing buckets')).toBeVisible();
    await expect(page.getByText(/reach\.invoice/)).toBeVisible();

    await openScreen(page, 'Take order');
    await expect(page.getByRole('heading', { name: 'Take an order' })).toBeVisible();

    // The rep's own screens: they may take an order, and the order book shows only their own.
    await repPage.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(repPage, 'Take order');
    await expect(repPage.getByRole('heading', { name: 'Take an order' })).toBeVisible();
    // Customer 360 is a manager's read, so it is not in this rep's menu at all.
    await expect(repPage.getByRole('button', { name: 'Customer 360' })).toHaveCount(0);

    // ---------- One company sees nothing of another ----------
    sql(
      `INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','RCH5 isolation ${suffix}','RC5${suffix}')`,
    );
    for (const table of [
      'trade_orders',
      'trade_order_lines',
      'trade_invoices',
      'trade_invoice_lines',
      'trade_receipts',
      'kyc_documents',
      'kyc_types',
      'kyc_rules',
      'price_list_items',
      'trade_schemes',
      'invoice_series',
    ]) {
      expect(
        sql(`SELECT relrowsecurity FROM pg_class WHERE relname='${table}'`),
        `${table} is not row-level scoped`,
      ).toBe('t');
      expect(
        sql(
          `SELECT count(*) FROM information_schema.role_table_grants
           WHERE grantee='rare_app' AND table_name='${table}' AND privilege_type='DELETE'`,
        ),
        `${table} grants DELETE to the application role`,
      ).toBe('0');
      expect(sql(`SELECT count(*) FROM ${table} WHERE tenant_id='${otherCompany}'`)).toBe('0');
    }
    // Two people billing at the same moment cannot be handed the same number: the series is
    // unique per company, prefix and year, and the counter moves in the same statement it is read.
    expect(
      sql(`SELECT indisunique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE c.relname='invoice_series_key_idx'`),
    ).toBe('t');
    // A bill this module raised always knows where its number came from.
    expect(
      sql(`SELECT count(*) FROM trade_invoices
           WHERE tenant_id='${tenantId}' AND source='RAISED' AND series_id IS NULL`),
    ).toBe('0');
  } finally {
    const tidy = (what: string, run: () => void) => {
      try {
        run();
      } catch (e: any) {
        console.warn(`cleanup (${what}) did not finish: ${e.message}`);
      }
    };
    await repContext?.close().catch(() => {});
    if (settingsBefore && settingsBefore.version === 0)
      tidy('drop settings row', () =>
        sql(`DELETE FROM reach_settings WHERE tenant_id='${tenantId}'`),
      );
    if (repIdentity)
      await request
        .delete(env.AUTH_URL + '/admin/realms/rare-os/users/' + repIdentity, { headers: kcHeaders })
        .catch(() => {});
    tidy('unlink rep', () =>
      sql(`UPDATE field_reps SET user_id=NULL WHERE user_id='${repUserId}'`),
    );
    tidy('remove login', () =>
      sql(`DELETE FROM user_sites WHERE user_id='${repUserId}';
           DELETE FROM app_users WHERE id='${repUserId}';`),
    );
    if (repRole)
      tidy('remove role', () =>
        sql(
          `DELETE FROM role_permissions WHERE role_id='${repRole}'; DELETE FROM roles WHERE id='${repRole}';`,
        ),
      );
    const customers = `SELECT id FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%'`;
    tidy('remove the trading record', () =>
      sql(`DELETE FROM trade_receipts WHERE customer_id IN (${customers});
           DELETE FROM trade_invoice_lines WHERE invoice_id IN (SELECT id FROM trade_invoices WHERE customer_id IN (${customers}));
           DELETE FROM trade_invoices WHERE customer_id IN (${customers});
           DELETE FROM trade_order_lines WHERE order_id IN (SELECT id FROM trade_orders WHERE customer_id IN (${customers}));
           DELETE FROM trade_orders WHERE customer_id IN (${customers});
           DELETE FROM kyc_documents WHERE customer_id IN (${customers});
           DELETE FROM invoice_series WHERE tenant_id='${tenantId}' AND prefix='${p}';`),
    );
    tidy('remove the price list', () =>
      sql(`DELETE FROM trade_schemes WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM price_list_items WHERE tenant_id='${tenantId}' AND item_id IN (SELECT id FROM items WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM kyc_rules WHERE tenant_id='${tenantId}' AND kyc_type_id IN (SELECT id FROM kyc_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM kyc_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove customers', () =>
      sql(`DELETE FROM customer_geo_log WHERE tenant_id='${tenantId}' AND customer_id IN (${customers});
           DELETE FROM beat_outlets WHERE tenant_id='${tenantId}' AND customer_id IN (${customers});
           DELETE FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove field masters', () =>
      sql(`DELETE FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM customer_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM rep_grades WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM territories WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove items', () =>
      sql(`DELETE FROM items WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM units WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove other company', () => sql(`DELETE FROM tenants WHERE id='${otherCompany}'`));
  }
});
