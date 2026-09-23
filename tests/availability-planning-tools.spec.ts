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

// AV-11 on synthetic data. FG1 is buffered and sells steadily; an event lifts its zones, an
// accepted scheme adds demand, and the tools price a target and a space limit.
test('AV-11 planning tools: month shape, recommended buffers, buffer vs MTO, events, schemes, target, space, network and assumptions', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'T' + suffix,
    userId = randomUUID(),
    email = `tools.viewer.${suffix}@example.test`;
  const plant = p + 'P1';
  let plantId = '',
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
  const rowOf = async (code: string) =>
    (await ok(`plants/${plantId}/buffers?limit=50`)).items.find((r: any) => r.item === code);
  try {
    await ok('units', 'POST', { code: p + 'NOS', name: 'Numbers', decimals: 0 });
    await ok('masters/items', 'POST', {
      code: p + 'FG1',
      name: 'Item FG1',
      item_type: 'FG',
      make_buy: 'MAKE',
      base_unit: p + 'NOS',
      family: p + 'FAM',
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
    await ok(`plants/${plantId}/calendars`, 'POST', {
      code: p + 'DAY',
      name: 'Day shift, every day',
      working_days: '1111111',
      is_default: true,
      shifts: [{ name: 'Day', start_time: '08:00', end_time: '16:00', break_minutes: '0' }],
      holidays: [],
    });
    for (const [code, machines] of [
      ['CUT', '1'],
      ['PACK', '2'],
    ])
      await ok(`plants/${plantId}/resources`, 'POST', {
        code: p + code,
        name: code,
        resource_type: 'MACHINE',
        machine_count: machines,
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
          run_minutes_per_unit: '2',
        },
        {
          sequence: '20',
          operation_code: 'PACK',
          description: 'Pack',
          resource: p + 'PACK',
          setup_minutes: '0',
          run_minutes_per_unit: '1',
        },
      ],
    });
    await ok('buffer-profiles', 'POST', {
      code: p + 'PR',
      name: 'Test profile',
      red_base_pct: '50',
      red_safety_pct: '50',
      green_pct: '100',
      order_cycle_days: '7',
      adu_window_days: '90',
      spike_threshold_pct: '50',
      method: 'STANDARD',
    });
    await ok(`plants/${plantId}/buffer-settings`, 'POST', {
      item: p + 'FG1',
      policy: 'BUFFER',
      profile: p + 'PR',
      lead_time_days: '7',
    });
    await ok(`plants/${plantId}/planning-settings`, 'PUT', {
      club_window_days: '1',
      lead_time_basis: 'FIXED',
      profile_day: '7',
      // A month that despatches twice as much in its last ten days.
      day_weights: [...Array(20).fill('2.5'), ...Array(11).fill('4.5454')].join(','),
      area_operations: '',
      execution_buffer_pct: '25',
      version: 0,
    });
    await upload(
      'demand_history',
      ['plant,item,demand_date,quantity']
        // A full year, so the trailing weeks the tools read are steady and complete.
        .concat(Array.from({ length: 371 }, (_, i) => `${plant},${p}FG1,${day(-1 - i)},10`))
        .join('\n'),
    );
    await upload(
      'production_orders',
      [
        'plant,order_no,item,quantity,start_date,due_date,order_type,reference',
        `${plant},${p}-WO1,${p}FG1,100,,${day(3)},PCMT,`,
      ].join('\n'),
    );
    await recalculated();

    // Month shape: the surge asks for more than the constraint's day, the quiet days can take some.
    const month = await ok(`plants/${plantId}/tools/month-shape`);
    expect(month.drum.code).toBe(p + 'CUT');
    expect(month.shape.days).toHaveLength(31);
    expect(month.shape.over).toBeGreaterThan(0);
    expect(month.shape.lastThird).toBeGreaterThan(40);
    expect(month.level.peakUnits).toBeGreaterThan(0);
    expect(month.level.peakDay).toBeGreaterThan(10);

    // Recommended buffers: steady demand needs little safety, and more service costs more stock.
    const rec = await ok(`plants/${plantId}/tools/recommended-buffers?service=0.95`);
    const fg = rec.rows.find((r: any) => r.code === p + 'FG1');
    expect(fg.leadTimeDays).toBe(7);
    expect(fg.adu).toBeGreaterThan(9);
    expect(fg.adu).toBeLessThanOrEqual(10);
    expect(fg.fillPct).toBeGreaterThanOrEqual(95);
    expect(fg.topOfGreen).toBeGreaterThan(fg.topOfYellow);
    expect(rec.curve.map((c: any) => c.service)).toEqual([0.85, 0.9, 0.95]);
    await refused(
      `plants/${plantId}/tools/recommended-buffers?service=0.5`,
      'GET',
      undefined,
      400,
      /Service level must be/,
    );

    // Buffer or made to order: this one is ordered every week and steady.
    const mto = await ok(`plants/${plantId}/tools/buffer-vs-mto`);
    const row = mto.rows.find((r: any) => r.code === p + 'FG1');
    expect(row).toMatchObject({
      recommend: 'BUFFER',
      policy: 'BUFFER',
      change: false,
      ordersPerYear: 52,
    });

    // An event lifts the zones for its window, early enough for the lead time.
    const before = await rowOf(p + 'FG1');
    await ok(`plants/${plantId}/tools/events`, 'POST', {
      code: p + 'EV',
      name: 'Festival',
      kind: 'EVENT',
      from: day(3),
      to: day(20),
      uplift: 50,
      items: [p + 'FG1'],
      family: '',
      note: '',
    });
    await recalculated();
    const after = await rowOf(p + 'FG1');
    expect(Number(after.top_of_green)).toBeGreaterThan(Number(before.top_of_green));
    expect(Number(after.top_of_green) / Number(before.top_of_green)).toBeCloseTo(1.5, 2);
    const events = await ok(`plants/${plantId}/tools/events?item=${p}FG1`);
    expect(events.items[0]).toMatchObject({ code: p + 'EV', uplift_pct: 50, active: true });
    expect(events.curve.weeks.some((w: any) => w.inWindow)).toBe(true);
    await refused(
      `plants/${plantId}/tools/events`,
      'POST',
      { code: p + 'B', name: 'Backwards', from: day(10), to: day(2), uplift: 10 },
      400,
      /ends before it starts/,
    );

    // A scheme is demand only once it is accepted.
    await ok(`plants/${plantId}/tools/schemes`, 'POST', {
      code: p + 'SC',
      name: 'Dealer scheme',
      item: p + 'FG1',
      from: day(1),
      to: day(10),
      units: 200,
      note: '',
    });
    await recalculated();
    const proposed = await rowOf(p + 'FG1');
    expect(Number(proposed.qualified_demand)).toBe(Number(after.qualified_demand));
    const scheme = (await ok(`plants/${plantId}/tools/schemes`)).items[0];
    expect(scheme).toMatchObject({ code: p + 'SC', state: 'proposed', expected_units: 200 });
    await ok(`plants/${plantId}/tools/schemes/${scheme.id}/accept`, 'POST', {
      version: scheme.version,
    });
    await recalculated();
    const accepted = await rowOf(p + 'FG1');
    expect(Number(accepted.qualified_demand)).toBeGreaterThan(Number(proposed.qualified_demand));

    // A target priced against history.
    const target = await ok(`plants/${plantId}/tools/target`, 'POST', {
      family: '',
      from: day(1),
      to: day(30),
      units: 600,
    });
    expect(target.historyUnits).toBeGreaterThan(270);
    expect(target.historyUnits).toBeLessThanOrEqual(300);
    expect(target.ratio).toBeGreaterThan(1.8);
    expect(target.ratio).toBeLessThan(2.3);
    expect(target.deltaStock).toBeGreaterThan(0);
    expect(target.utilisationPct).toBeGreaterThan(100);

    // A space limit trims green first.
    await ok(`plants/${plantId}/tools/space`, 'PUT', {
      capacity: 60,
      measure: 'UNITS',
      note: 'One rack',
    });
    const space = await ok(`plants/${plantId}/tools/space?service=0.9`);
    expect(space.limit).toMatchObject({ capacity: 60, measure: 'UNITS' });
    expect(space.fit.fits).toBe(false);
    expect(space.fit.rows[0].fitted).toBeLessThan(space.fit.rows[0].topOfGreen);
    expect(space.fit.rows[0].fitted).toBeGreaterThanOrEqual(space.fit.rows[0].topOfYellow);

    // The network: the constraint of this plant and what another machine would do.
    const net = await ok('network');
    const mine = net.plants.find((x: any) => x.code === plant);
    expect(mine.drum.code).toBe(p + 'CUT');
    expect(mine.stability.next.code).toBe(p + 'PACK');
    // PACK runs the same units in half the minutes on twice the machines, so it sits at a quarter
    // of CUT: two more machines on CUT are not enough to move the constraint, five are.
    const twoUp = await ok(`plants/${plantId}/tools/what-if`, 'POST', {
      resource: p + 'CUT',
      machines: 2,
    });
    expect(twoUp.moved).toBe(false);
    expect(twoUp.after.code).toBe(p + 'CUT');
    const whatIf = await ok(`plants/${plantId}/tools/what-if`, 'POST', {
      resource: p + 'CUT',
      machines: 5,
    });
    expect(whatIf.moved).toBe(true);
    expect(whatIf.after.code).toBe(p + 'PACK');
    await refused(
      `plants/${plantId}/tools/what-if`,
      'POST',
      { resource: p + 'NOPE', machines: 2 },
      404,
      /is not on this plant/,
    );

    // The assumptions the plan rests on, and confirming one.
    const assumptions = await ok(`plants/${plantId}/tools/assumptions`);
    const club = assumptions.rows.find((r: any) => r.code === 'club_window_days');
    expect(club).toMatchObject({ value: '1 day(s)', confirmed: false });
    await ok(`plants/${plantId}/tools/assumptions`, 'PUT', {
      code: 'club_window_days',
      note: 'Confirmed with the plant on the call',
      confirmed: true,
    });
    const confirmed = (await ok(`plants/${plantId}/tools/assumptions`)).rows.find(
      (r: any) => r.code === 'club_window_days',
    );
    expect(confirmed).toMatchObject({
      confirmed: true,
      note: 'Confirmed with the plant on the call',
    });

    // A viewer reads the tools but cannot change what the plan rests on.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Tools viewer ' + suffix,
        permissions: ['dashboard.read', 'sites.read', 'masters.read', 'planning.read'],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Tools Viewer', email, roleId });
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
    expect((await asViewer(`plants/${plantId}/tools/month-shape`)).status()).toBe(200);
    expect((await asViewer('network')).status()).toBe(200);
    for (const [path, method, data] of [
      [
        `plants/${plantId}/tools/events`,
        'POST',
        { code: p + 'V', name: 'No', from: day(1), to: day(2), uplift: 10 },
      ],
      [
        `plants/${plantId}/tools/schemes`,
        'POST',
        { code: p + 'V', name: 'No', item: p + 'FG1', from: day(1), to: day(2), units: 1 },
      ],
      [`plants/${plantId}/tools/space`, 'PUT', { capacity: 10, measure: 'UNITS', note: '' }],
      [`plants/${plantId}/tools/assumptions`, 'PUT', { code: 'club_window_days', note: 'no' }],
    ] as const)
      expect((await asViewer(path, method, data)).status(), path).toBe(403);
    await vp.getByRole('button', { name: 'Availability', exact: true }).click();
    await vp.getByRole('tab', { name: 'Planning tools' }).click();
    await vp.getByLabel('Tool').selectOption('events');
    await expect(vp.locator(`[data-event="${p}EV"]`)).toBeVisible();
    await expect(vp.getByRole('button', { name: 'Save event' })).toHaveCount(0);

    // Screens.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await page.getByRole('tab', { name: 'Planning tools' }).click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plant} (${plant})` });
    await expect(page.getByRole('heading', { name: /The month's shape against/ })).toBeVisible();
    await page.getByLabel('Tool').selectOption('recommended');
    await expect(page.locator(`[data-recommended="${p}FG1"]`)).toBeVisible();
    await page.getByLabel('Tool').selectOption('mto');
    await expect(page.locator(`[data-mto="${p}FG1"]`)).toContainText('BUFFER');
    await page.getByLabel('Tool').selectOption('events');
    await expect(page.locator(`[data-event="${p}EV"]`)).toContainText('+50%');
    await page.getByLabel('Tool').selectOption('schemes');
    await expect(page.locator(`[data-scheme="${p}SC"]`)).toContainText('accepted');
    await page.getByLabel('Tool').selectOption('space');
    await expect(page.getByText('The set against the space')).toBeVisible();
    await page.getByLabel('Tool').selectOption('assumptions');
    await expect(page.locator('[data-assumption="club_window_days"]')).toContainText('Confirmed');
    await page.getByRole('tab', { name: 'Network' }).click();
    await expect(page.locator(`[data-plant="${plant}"]`)).toContainText(p + 'CUT');
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
    sql(`DELETE FROM demand_events WHERE site_id IN (${sites});
      DELETE FROM demand_schemes WHERE site_id IN (${sites});
      DELETE FROM sales_targets WHERE site_id IN (${sites});
      DELETE FROM space_limits WHERE site_id IN (${sites});
      DELETE FROM planning_assumptions WHERE site_id IN (${sites});
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
