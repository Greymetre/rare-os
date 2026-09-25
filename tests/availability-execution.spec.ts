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

// AV-9 on synthetic data. One 480-minute shift every day; CUT (1 machine). FG1 takes 1 minute per
// unit and is buffered, so the board recommends making it. Six orders of 60 run the execution loop.
test('AV-9 execution: make order release, the two events, downtime and at-risk promises, cycle-time audit', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'X' + suffix,
    userId = randomUUID(),
    email = `execution.viewer.${suffix}@example.test`;
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
  const schedule = async () => ok(`plants/${plantId}/schedule`);
  const rowOf = async (order: string) =>
    (await schedule()).items.find((o: any) => o.order_no === order);
  try {
    await ok('units', 'POST', { code: p + 'NOS', name: 'Numbers', decimals: 0 });
    await ok('masters/items', 'POST', {
      code: p + 'FG1',
      name: 'Item FG1',
      item_type: 'FG',
      make_buy: 'MAKE',
      base_unit: p + 'NOS',
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
    // A buffer with demand, so the board recommends making it.
    await ok('buffer-profiles', 'POST', {
      code: p + 'PR',
      name: 'Test profile',
      red_base_pct: '50',
      red_safety_pct: '50',
      green_pct: '100',
      order_cycle_days: '7',
      adu_window_days: '30',
      spike_threshold_pct: '50',
      method: 'STANDARD',
    });
    await ok(`plants/${plantId}/buffer-settings`, 'POST', {
      item: p + 'FG1',
      policy: 'BUFFER',
      profile: p + 'PR',
      lead_time_days: '5',
      reference_lot: '',
    });
    await upload(
      'demand_history',
      ['plant,item,demand_date,quantity']
        .concat(Array.from({ length: 30 }, (_, i) => `${plant},${p}FG1,${day(-1 - i)},20`))
        .join('\n'),
    );
    const header = 'plant,order_no,item,quantity,start_date,due_date,order_type,reference';
    await upload(
      'production_orders',
      [header]
        .concat(
          Array.from(
            { length: 6 },
            // All promised for tomorrow: the day holds 480 minutes, the six orders 360.
            (_, i) => `${plant},${p}-WO${i + 1},${p}FG1,60,,${day(1)},PCMT,`,
          ),
        )
        .join('\n'),
    );
    let status = await recalculated();
    let s = await schedule();
    expect(s.items.slice(0, 3).map((o: any) => o.order_no)).toEqual([
      p + '-WO1',
      p + '-WO2',
      p + '-WO3',
    ]);

    // Release: the order jumps to the front of the book and stays there.
    await refused(
      `plants/${plantId}/work-orders/release`,
      'POST',
      { order: p + '-WO3', runNo: 1 },
      409,
      /no longer current/,
    );
    const rel = await ok(`plants/${plantId}/work-orders/release`, 'POST', {
      order: p + '-WO3',
      runNo: Number(status.current.run_no),
    });
    expect(rel.plannedMinutes).toBe(60);
    await recalculated();
    s = await schedule();
    expect(s.items[0]).toMatchObject({ order_no: p + '-WO3', execution_state: 'released' });
    await refused(
      `plants/${plantId}/work-orders/release`,
      'POST',
      { order: p + '-WO3', runNo: lastRun },
      409,
      /already released/,
    );
    // A planner's move cannot take released work out of its place.
    const plan = await ok(`plants/${plantId}/decisions`);
    await ok(`plants/${plantId}/decisions/move`, 'POST', {
      order: p + '-WO1',
      target: p + '-WO3',
      position: 'before',
      runNo: lastRun,
      version: plan.version,
    });
    await recalculated();
    expect((await schedule()).items[0].order_no).toBe(p + '-WO3');

    // Completion: the second event. 72 minutes against 60 planned uses 80% of a 25% buffer.
    await refused(
      `plants/${plantId}/work-orders/complete`,
      'POST',
      { order: p + '-WO4', date: day(0), quantity: 60, elapsed: 72 },
      409,
      /Release .* before completing/,
    );
    await refused(
      `plants/${plantId}/work-orders/complete`,
      'POST',
      { order: p + '-WO3', date: day(1), quantity: 60, elapsed: 72 },
      400,
      /cannot be after/,
    );
    await ok(`plants/${plantId}/work-orders/complete`, 'POST', {
      order: p + '-WO3',
      date: day(0),
      quantity: 60,
      elapsed: 72,
    });
    await recalculated();
    let ex = await ok(`plants/${plantId}/execution`);
    expect(ex.items[0]).toMatchObject({
      order_no: p + '-WO3',
      planned_minutes: 60,
      elapsed_work_minutes: 72,
      penetration: 80,
      inside_buffer: true,
    });
    expect([ex.pct, ex.completions, ex.released]).toEqual([100, 1, 0]);
    expect(await rowOf(p + '-WO3')).toBeUndefined();

    // Four more completions, every one over the standard: the audit has its evidence.
    for (const n of [1, 2, 4, 5]) {
      await ok(`plants/${plantId}/work-orders/release`, 'POST', {
        order: `${p}-WO${n}`,
        runNo: lastRun,
      });
      await recalculated();
      await ok(`plants/${plantId}/work-orders/complete`, 'POST', {
        order: `${p}-WO${n}`,
        date: day(0),
        quantity: 60,
        elapsed: 72,
      });
      await recalculated();
    }
    ex = await ok(`plants/${plantId}/execution`);
    expect([ex.completions, ex.pct]).toEqual([5, 100]);
    let audit = await ok(`plants/${plantId}/cycle-time-audit`);
    expect(audit.rows[0]).toMatchObject({
      item: p + 'FG1',
      standard: 1,
      actual: 1.2,
      completions: 5,
      drift: 20,
      consistent: true,
      flagged: true,
    });
    const adopted = await ok(`plants/${plantId}/cycle-time-audit/adopt`, 'POST', {
      item: p + 'FG1',
    });
    expect(adopted.revision).toBe('ACT1');
    expect(
      sql(
        `SELECT o.run_minutes_per_unit::numeric(6,3) FROM routings r JOIN routing_operations o ON o.routing_id=r.id
         WHERE r.site_id='${plantId}' AND r.revision='ACT1'`,
      ),
    ).toBe('1.200');
    await recalculated();
    // The corrected standard is what the schedule now plans with: 60 units take 72 minutes.
    expect(
      Number((await rowOf(p + '-WO6')).finish_min) - Number((await rowOf(p + '-WO6')).start_min),
    ).toBe(72);
    await refused(
      `plants/${plantId}/cycle-time-audit/adopt`,
      'POST',
      { item: p + 'FG1' },
      409,
      /nothing to correct/,
    );

    // Downtime: the minutes are lost and the promises that break are derived, not scripted.
    const before = await rowOf(p + '-WO6');
    const stop = await ok(`plants/${plantId}/downtime`, 'POST', {
      resource: p + 'CUT',
      machine: null,
      date: day(1),
      minutes: 440,
      reason: 'Breakdown',
    });
    expect(stop.message).toMatch(/440 minutes lost/);
    await recalculated();
    const after = await rowOf(p + '-WO6');
    expect(Number(after.start_min)).toBeGreaterThan(Number(before.start_min));
    const down = await ok(`plants/${plantId}/downtime`);
    expect(down.items[0]).toMatchObject({ minutes: 440, state: 'open', resource: p + 'CUT' });
    expect(down.atRisk.items.length).toBeGreaterThan(0);
    expect(down.atRisk.items[0]).toMatchObject({ days: expect.any(Number) });
    await ok(`plants/${plantId}/downtime/${down.items[0].id}/close`, 'POST', {});
    await recalculated();
    expect((await ok(`plants/${plantId}/downtime`)).items[0].state).toBe('closed');
    expect(Number((await rowOf(p + '-WO6')).start_min)).toBe(Number(before.start_min));

    // Make order release: the buffer recommendation becomes an order in the book.
    const board = await ok(`plants/${plantId}/buffers?limit=50`);
    const rec = board.items.find((r: any) => r.item === p + 'FG1');
    expect(rec.recommended_kind).toBe('MAKE');
    const mo = await ok(`plants/${plantId}/make-orders/release`, 'POST', {
      item: p + 'FG1',
      runNo: lastRun,
    });
    expect(mo.order).toMatch(/^MO-\d+$/);
    await recalculated();
    expect(
      sql(
        `SELECT source||','||quantity::numeric(12,2)||','||due_date FROM production_orders WHERE order_no='${mo.order}'`,
      ),
    ).toBe(`MAKE,${Number(rec.recommended_qty).toFixed(2)},${rec.due_date}`);
    expect((await rowOf(mo.order)).status).toBe('scheduled');

    const kinds = (await ok(`plants/${plantId}/decisions`)).items.map((d: any) => d.kind);
    expect(kinds.slice(0, 3)).toEqual(['make_release', 'downtime', 'cycle_time_adopt']);

    // Screens.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(page, 'Execution Loop');
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plant} (${plant})` });
    await expect(page.locator(`[data-work="${p}-WO3"]`)).toContainText('Inside buffer');
    await expect(page.getByText('Schedule adherence')).toBeVisible();
    await openScreen(page, 'Work Orders & Downtime');
    await expect(page.locator('[data-downtime]').first()).toContainText('Breakdown');
    await openScreen(page, 'Master-Data Audit');
    await expect(page.locator(`[data-audit="${p}FG1"]`)).toContainText('1.2');

    // A viewer sees the loop but cannot run it.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Execution viewer ' + suffix,
        permissions: ['dashboard.read', 'sites.read', 'masters.read', 'planning.read'],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Execution Viewer', email, roleId });
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
    const asViewer = (path: string, method = 'GET', data?: unknown) =>
      vp.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': vm.csrfToken },
        data,
      });
    expect((await asViewer(`plants/${plantId}/execution`)).status()).toBe(200);
    for (const [path, data] of [
      [`plants/${plantId}/work-orders/release`, { order: p + '-WO6', runNo: lastRun }],
      [
        `plants/${plantId}/downtime`,
        { resource: p + 'CUT', machine: null, date: day(1), minutes: 60, reason: 'x' },
      ],
      [`plants/${plantId}/make-orders/release`, { item: p + 'FG1', runNo: lastRun }],
      [`plants/${plantId}/cycle-time-audit/adopt`, { item: p + 'FG1' }],
    ] as const)
      expect((await asViewer(path, 'POST', data)).status(), path).toBe(403);
    await vp.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(vp, 'Execution Loop');
    await expect(vp.locator(`[data-work="${p}-WO3"]`)).toBeVisible();
    await expect(vp.getByRole('button', { name: 'Release', exact: true })).toHaveCount(0);
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
    sql(`DELETE FROM cycle_time_adoptions WHERE site_id IN (${sites});
      DELETE FROM downtime_events WHERE site_id IN (${sites});
      DELETE FROM order_plans WHERE site_id IN (${sites});
      DELETE FROM planning_decisions WHERE site_id IN (${sites});
      DELETE FROM plant_sequence WHERE site_id IN (${sites});
      DELETE FROM plant_planning WHERE site_id IN (${sites});
      DELETE FROM planning_results WHERE item_id IN (${items});
      DELETE FROM item_buffers WHERE item_id IN (${items});
      DELETE FROM buffer_profiles WHERE code LIKE '${p}%';
      DELETE FROM purchase_proposals WHERE site_id IN (${sites});
      DELETE FROM production_orders WHERE site_id IN (${sites});
      DELETE FROM demand_history WHERE site_id IN (${sites});
      DELETE FROM routing_operations WHERE routing_id IN (SELECT id FROM routings WHERE site_id IN (${sites}));
      DELETE FROM routings WHERE site_id IN (${sites});
      DELETE FROM resources WHERE site_id IN (${sites});
      DELETE FROM calendar_shifts WHERE calendar_id IN (SELECT id FROM calendars WHERE site_id IN (${sites}));
      DELETE FROM calendars WHERE site_id IN (${sites});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
