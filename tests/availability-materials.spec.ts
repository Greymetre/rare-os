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

// AV-8 on synthetic data. One 480-minute shift every day; CUT (1 machine). FG1 takes 1 min and
// 1 RM1 per unit. RM1: 50 on hand, PO1/10 of 100 due on day 4. WO1 (80, due day 2) is 30 short at
// its release on day 1; WO2 (60, due day 2) is short after WO1 until the purchase arrives.
test('AV-8 materials decisions: expedite with maker-checker and supplier evidence, later date, pending and reschedule', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'M' + suffix,
    userId = randomUUID(),
    email = `expedite.approver.${suffix}@example.test`;
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
  ) => {
    const r = await call(path, method, data);
    const body = await r.json();
    expect(r.status(), JSON.stringify(body)).toBe(status);
    expect(body.error.message).toMatch(text);
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
    expect(staged.error_rows).toBe(0);
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
    return status;
  };
  const plant = p + 'P1';
  let plantId = '';
  const rowOf = async (order: string) =>
    (await ok(`plants/${plantId}/schedule`)).items.find((o: any) => o.order_ref === order);
  try {
    await ok('units', 'POST', { code: p + 'NOS', name: 'Numbers', decimals: 0 });
    for (const [code, type, mb] of [
      ['FG1', 'FG', 'MAKE'],
      ['RM1', 'RM', 'BUY'],
    ])
      await ok('masters/items', 'POST', {
        code: p + code,
        name: 'Item ' + code,
        item_type: type,
        make_buy: mb,
        base_unit: p + 'NOS',
      });
    await ok('masters/suppliers', 'POST', {
      code: p + 'S1',
      name: 'Foam Co',
      lead_time_days: '10',
    });
    plantId = (
      await ok('plants', 'POST', {
        code: plant,
        name: 'Plant ' + plant,
        location: 'Test',
        timezone: 'Asia/Kolkata',
      })
    ).id;
    await ok(`plants/${plantId}/calendars`, 'POST', {
      code: p + 'DAY',
      name: 'Day shift, every day',
      working_days: '1111111',
      is_default: true,
      shifts: [{ name: 'Day', start_time: '08:00', end_time: '16:00', break_minutes: '0' }],
      holidays: [],
    });
    await ok(`plants/${plantId}/resources`, 'POST', {
      code: p + 'CUT',
      name: 'CUT',
      resource_type: 'MACHINE',
      machine_count: '1',
      efficiency_pct: '100',
      changeover_minutes: '0',
      calendar: '',
      planned_utilization_pct: '',
    });
    await ok(`plants/${plantId}/routings`, 'POST', {
      item: p + 'FG1',
      revision: 'V1',
      effective_from: '2020-01-01',
      effective_to: '',
      operations: [
        {
          sequence: '10',
          operation_code: 'CUT',
          description: 'Cut',
          resource: p + 'CUT',
          setup_minutes: '0',
          run_minutes_per_unit: '1',
        },
      ],
    });
    await ok('boms', 'POST', {
      parent_item: p + 'FG1',
      revision: 'V1',
      effective_from: '2020-01-01',
      effective_to: '',
      base_quantity: '1',
      lines: [{ component_item: p + 'RM1', quantity: '1', unit: '', scrap_pct: '0' }],
    });
    await ok(`plants/${plantId}/stock-locations`, 'POST', {
      code: p + 'ST',
      name: 'Raw store',
      location_type: 'STORES',
      nettable: true,
    });
    await ok(`plants/${plantId}/stock/movements`, 'POST', {
      location: p + 'ST',
      item: p + 'RM1',
      movement_type: 'OPENING',
      quantity: '50',
      unit: '',
      movement_date: day(0),
      reference: '',
      reason: '',
    });
    await ok(`plants/${plantId}/purchase-orders`, 'POST', {
      po_no: p + 'PO1',
      supplier: p + 'S1',
      order_date: day(0),
      lines: [
        {
          line_no: '10',
          item: p + 'RM1',
          quantity: '100',
          unit: '',
          due_date: day(4),
          received_quantity: '0',
        },
      ],
    });
    await upload(
      'production_orders',
      [
        'plant,order_no,item,quantity,start_date,due_date,order_type,reference',
        `${plant},${p}-WO1,${p}FG1,80,,${day(2)},PCMT,`,
        `${plant},${p}-WO2,${p}FG1,60,,${day(2)},PCMT,`,
      ].join('\n'),
    );
    await recalculated();
    expect(await rowOf(p + '-WO1')).toMatchObject({
      material_check: 'expedite',
      plan_state: 'decision_required',
    });

    // Expedite: the existing purchase line is asked to come earlier.
    let prev = await ok(`plants/${plantId}/expedite/preview`, 'POST', { order: p + '-WO1' });
    expect(prev.actions).toHaveLength(1);
    expect(prev.actions[0]).toMatchObject({
      type: 'EXPEDITE_PO',
      component: p + 'RM1',
      qty: 30,
      required: day(1),
      po: p + 'PO1',
      line: '10',
      currentDue: day(4),
    });
    await refused(
      `plants/${plantId}/expedite/request`,
      'POST',
      { order: p + '-WO1', runNo: 1, version: prev.version },
      409,
      /no longer current/,
    );
    const req1 = await ok(`plants/${plantId}/expedite/request`, 'POST', {
      order: p + '-WO1',
      runNo: prev.runNo,
      version: prev.version,
    });
    expect(req1.message).toMatch(/A request is not supply/);
    await recalculated();
    expect((await rowOf(p + '-WO1')).plan_state).toBe('expedite_pending');
    let ex = await ok(`plants/${plantId}/expedites`);
    expect(ex.actions[0]).toMatchObject({ state: 'requested', qty: 30, members: [p + '-WO1'] });
    // Maker-checker: the requester cannot approve.
    await refused(
      `expedite-actions/${ex.actions[0].id}/approve`,
      'POST',
      { version: ex.actions[0].version },
      403,
      /another person must approve/,
    );

    // The approver: purchase rights, not planning rights.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Expedite approver ' + suffix,
        permissions: [
          'dashboard.read',
          'sites.read',
          'masters.read',
          'planning.read',
          'purchase.read',
          'purchase.expedite',
        ],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Expedite Approver', email, roleId });
    const grant = await ok('users/' + userId + '/plants');
    await ok('users/' + userId + '/plants', 'PUT', { version: grant.version, plantIds: [plantId] });
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
    const am = await (await ap.request.get('/api/me')).json();
    const asApprover = async (path: string, method = 'GET', data?: unknown) => {
      const r = await ap.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': am.csrfToken },
        data,
      });
      return { status: r.status(), body: await r.json() };
    };
    const action = async () => (await ok(`plants/${plantId}/expedites`)).actions[0];
    expect(
      (
        await asApprover(`plants/${plantId}/expedite/request`, 'POST', {
          order: p + '-WO1',
          runNo: lastRun,
          version: prev.version,
        })
      ).status,
    ).toBe(403);
    let a = await action();
    let r = await asApprover(`expedite-actions/${a.id}/approve`, 'POST', { version: a.version });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await recalculated();
    // Approval is intent only: still waiting for the supplier.
    expect((await rowOf(p + '-WO1')).plan_state).toBe('expedite_pending');
    a = await action();
    r = await asApprover(`expedite-actions/${a.id}/confirm`, 'POST', {
      version: a.version,
      date: day(1),
      qty: 31,
      reference: 'SUP-1',
    });
    expect([r.status, r.body.error?.message]).toEqual([400, expect.stringMatching(/at most 30/)]);
    // The supplier keeps a later date: a new decision is needed.
    r = await asApprover(`expedite-actions/${a.id}/confirm`, 'POST', {
      version: a.version,
      date: day(3),
      qty: 30,
      reference: 'SUP-LATE',
    });
    expect([r.status, r.body.state]).toEqual([201, 'late']);
    await recalculated();
    expect(await rowOf(p + '-WO1')).toMatchObject({
      material_check: 'expedite',
      plan_state: 'decision_required',
    });
    // Timely supplier evidence covers the release.
    a = await action();
    r = await asApprover(`expedite-actions/${a.id}/confirm`, 'POST', {
      version: a.version,
      date: day(1),
      qty: 30,
      reference: 'SUP-ON-TIME',
    });
    expect([r.status, r.body.state]).toEqual([201, 'confirmed']);
    await recalculated();
    expect(await rowOf(p + '-WO1')).toMatchObject({
      material_check: 'clear',
      plan_state: 'conditional_expedite',
    });
    ex = await ok(`plants/${plantId}/expedites`);
    expect(ex.bundles[0].state).toBe('confirmed');
    expect(ex.actions[0]).toMatchObject({
      state: 'confirmed',
      confirmation: { date: day(1), qty: 30, reference: 'SUP-ON-TIME' },
      approvedBy: 'Expedite Approver',
    });

    // WO2 is short after WO1 until the rest of the purchase (70 on day 4): a later date.
    expect((await rowOf(p + '-WO2')).material_check).toBe('expedite');
    let later = await ok(`plants/${plantId}/later/preview`, 'POST', { order: p + '-WO2' });
    expect(later.scenarios[0]).toMatchObject({
      normal: true,
      productionRelease: day(4),
      promise: day(4),
      status: 'clear',
    });
    await refused(
      `plants/${plantId}/later/preview`,
      'POST',
      { order: p + '-WO2', candidateDate: day(0) },
      400,
      /after the planning date/,
    );
    later = await ok(`plants/${plantId}/later/preview`, 'POST', {
      order: p + '-WO2',
      candidateDate: day(6),
    });
    const s = later.scenarios[0];
    expect([s.normal, s.promise]).toEqual([true, day(6)]);
    const apply = (mode: string, x: any, l: any, extra: any = {}) =>
      ok(`plants/${plantId}/later/apply`, 'POST', {
        order: p + '-WO2',
        candidateDate: day(6),
        key: x.key,
        mode,
        release: x.release,
        promise: x.promise,
        runNo: l.runNo,
        version: l.version,
        ...extra,
      });
    await refused(
      `plants/${plantId}/later/apply`,
      'POST',
      {
        order: p + '-WO2',
        candidateDate: day(6),
        key: s.key,
        mode: 'propose',
        release: s.release,
        promise: day(9),
        runNo: later.runNo,
        version: later.version,
      },
      409,
      /changed since the preview/,
    );
    expect((await apply('propose', s, later)).message).toMatch(/waits in Pending/);
    await recalculated();
    expect(await rowOf(p + '-WO2')).toBeUndefined();
    let pending = (await ok(`plants/${plantId}/pending`)).items;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      order_ref: p + '-WO2',
      state: 'awaiting_confirmation',
      original_date: day(2),
      proposed_date: day(6),
      quantity: 60,
    });
    // The promise is unchanged until the customer accepts.
    expect(sql(`SELECT due_date FROM production_orders WHERE order_no='${p}-WO2'`)).toBe(day(2));
    await ok(`plants/${plantId}/pending/ready`, 'POST', {
      order: p + '-WO2',
      version: pending[0].version,
    });
    pending = (await ok(`plants/${plantId}/pending`)).items;
    expect(pending[0].state).toBe('ready_to_reschedule');
    await refused(
      `plants/${plantId}/pending/ready`,
      'POST',
      { order: p + '-WO2', version: pending[0].version },
      409,
      /already ready to reschedule/,
    );
    await recalculated();
    later = await ok(`plants/${plantId}/later/preview`, 'POST', {
      order: p + '-WO2',
      candidateDate: day(6),
    });
    expect(later.scheduled).toBe(false);
    expect((await apply('confirm', later.scenarios[0], later)).message).toMatch(/accepted date/);
    await recalculated();
    expect(sql(`SELECT due_date FROM production_orders WHERE order_no='${p}-WO2'`)).toBe(day(6));
    expect(await rowOf(p + '-WO2')).toMatchObject({
      promise_date: day(6),
      material_check: 'clear',
      plan_state: 'material_clear',
    });
    expect((await ok(`plants/${plantId}/pending`)).items).toHaveLength(0);

    // The supplier cannot deliver after all: rejected, the confirmed supply is gone.
    a = await action();
    r = await asApprover(`expedite-actions/${a.id}/reject`, 'POST', {
      version: a.version,
      reason: 'Supplier withdrew',
    });
    expect(r.status).toBe(201);
    await recalculated();
    expect((await rowOf(p + '-WO1')).plan_state).toBe('decision_required');

    const kinds = (await ok(`plants/${plantId}/decisions`)).items.map((d: any) => d.kind);
    expect(kinds).toEqual([
      'expedite_reject',
      'later_confirm',
      'pending_ready',
      'later_propose',
      'expedite_confirm',
      'expedite_confirm',
      'expedite_approve',
      'expedite_request',
    ]);

    // Screens.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(page, 'Scheduler');
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plant} (${plant})` });
    // The schedule row (the decision history below also names the order).
    const scheduleRow = (pg: any) =>
      pg
        .getByRole('row')
        .filter({ has: pg.getByRole('button', { name: `Materials for ${p}-WO1` }) });
    await expect(scheduleRow(page)).toContainText('Decision required: expedite or quote later');
    await page.getByRole('button', { name: `Request material expedite for ${p}-WO1` }).click();
    await expect(
      page.getByText('No adequate existing PO').or(page.getByText(`${p}PO1 / 10`)),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: `Explore a later date for ${p}-WO1` }).click();
    await expect(page.locator('[data-later="later-0"]')).toBeVisible();
    await openScreen(page, 'Material expedites');
    await expect(page.locator('[data-expedite]').first()).toContainText('Rejected');
    await openScreen(page, 'Pending Orders to Plan');
    await expect(page.getByText('No orders awaiting planning.')).toBeVisible();
    // The approver sees Expedites but has no planning buttons on the Scheduler.
    await ap.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(ap, 'Material expedites');
    await expect(ap.locator('[data-expedite]').first()).toContainText('Rejected');
    await openScreen(ap, 'Scheduler');
    await expect(scheduleRow(ap)).toBeVisible();
    await expect(ap.getByRole('button', { name: /Request material expedite/ })).toHaveCount(0);
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
    sql(`DELETE FROM order_plans WHERE site_id IN (${sites});
      DELETE FROM expedite_actions WHERE site_id IN (${sites});
      DELETE FROM expedite_bundles WHERE site_id IN (${sites});
      DELETE FROM planning_decisions WHERE site_id IN (${sites});
      DELETE FROM plant_sequence WHERE site_id IN (${sites});
      DELETE FROM plant_planning WHERE site_id IN (${sites});
      DELETE FROM planning_results WHERE item_id IN (${items});
      DELETE FROM purchase_proposals WHERE site_id IN (${sites});
      DELETE FROM production_orders WHERE site_id IN (${sites});
      DELETE FROM stock_balances WHERE site_id IN (${sites});
      DELETE FROM stock_movements WHERE site_id IN (${sites});
      DELETE FROM purchase_order_lines WHERE po_id IN (SELECT id FROM purchase_orders WHERE site_id IN (${sites}));
      DELETE FROM purchase_orders WHERE site_id IN (${sites});
      DELETE FROM stock_locations WHERE site_id IN (${sites});
      DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM boms WHERE item_id IN (${items}));
      DELETE FROM boms WHERE item_id IN (${items});
      DELETE FROM routing_operations WHERE routing_id IN (SELECT id FROM routings WHERE site_id IN (${sites}));
      DELETE FROM routings WHERE site_id IN (${sites});
      DELETE FROM resources WHERE site_id IN (${sites});
      DELETE FROM calendar_shifts WHERE calendar_id IN (SELECT id FROM calendars WHERE site_id IN (${sites}));
      DELETE FROM calendars WHERE site_id IN (${sites});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM suppliers WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
