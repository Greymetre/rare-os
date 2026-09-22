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

// AV-6 on synthetic data. One 480-minute shift every day; CUT (1 machine, 60 min changeover) then
// PACK (2 machines). FG1 = 2 min CUT + 1 min PACK per unit, FG2 = 1 min CUT, FG3 has no routing.
test('AV-6 scheduler: sequence with protected grouping, drum, timing, load, Gantt, publish and permissions', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(420000);
  const suffix = Date.now().toString().slice(-6),
    p = 'S' + suffix,
    userId = randomUUID(),
    email = `schedule.view.${suffix}@example.test`;
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
  const schedule = async (view = 'current') => ok(`plants/${plantId}/schedule?view=${view}`);
  try {
    await ok('units', 'POST', { code: p + 'NOS', name: 'Numbers', decimals: 0 });
    for (const code of ['FG1', 'FG2', 'FG3'])
      await ok('masters/items', 'POST', {
        code: p + code,
        name: 'Item ' + code,
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
    for (const [code, machines, changeover] of [
      ['CUT', '1', '60'],
      ['PACK', '2', '0'],
    ])
      await ok(`plants/${plantId}/resources`, 'POST', {
        code: p + code,
        name: code,
        resource_type: 'MACHINE',
        machine_count: machines,
        efficiency_pct: '100',
        changeover_minutes: changeover,
        calendar: '',
        planned_utilization_pct: code === 'CUT' ? '50' : '',
      });
    const op = (sequence: string, code: string, run: string) => ({
      sequence,
      operation_code: code,
      description: code,
      resource: p + code,
      setup_minutes: '0',
      run_minutes_per_unit: run,
    });
    for (const [item, ops] of [
      ['FG1', [op('10', 'CUT', '2'), op('20', 'PACK', '1')]],
      ['FG2', [op('10', 'CUT', '1')]],
    ] as const)
      await ok(`plants/${plantId}/routings`, 'POST', {
        item: p + item,
        revision: 'V1',
        effective_from: '2020-01-01',
        effective_to: '',
        operations: ops,
      });
    // WO3 is due a day after WO1 and joins it: WO2 still finishes on its due day.
    const header = 'plant,order_no,item,quantity,start_date,due_date,order_type,reference';
    await upload(
      'production_orders',
      [
        header,
        `${plant},${p}-WO1,${p}FG1,100,,${day(1)},PCMT,`,
        `${plant},${p}-WO2,${p}FG2,100,,${day(1)},PCMT,`,
        `${plant},${p}-WO3,${p}FG1,50,,${day(2)},PCMT,`,
        `${plant},${p}-WO4,${p}FG3,10,,${day(2)},PCMT,`,
      ].join('\n'),
    );
    const status = await recalculated();
    let s = await schedule();
    expect(s.header.drum).toBe(p + 'CUT');
    expect([s.header.orders, s.header.late, s.header.unscheduled]).toEqual([3, 0, 1]);
    expect(s.items.map((o: any) => [o.order_no, o.grouped_with])).toEqual([
      [p + '-WO1', null],
      [p + '-WO3', p + '-WO1'],
      [p + '-WO2', null],
      [p + '-WO4', null],
    ]);
    // WO2 waits for 300 minutes of FG1 plus the 60-minute changeover on CUT: 360..460 on day 1.
    const wo2 = s.items[2];
    expect([
      Number(wo2.start_min),
      Number(wo2.finish_min),
      wo2.finish_date,
      wo2.release_date,
    ]).toEqual([360, 460, day(1), day(1)]);
    expect(Number(s.header.changeover_saved_min)).toBe(60);
    expect(s.items[3]).toMatchObject({ status: 'unscheduled' });
    expect(s.items[3].messages[0]).toMatch(/No routing/);
    expect((await ok(`plants/${plantId}/schedule?filter=unscheduled`)).items).toHaveLength(1);
    await refused(
      `plants/${plantId}/schedule?filter=purple`,
      'GET',
      undefined,
      400,
      /Unknown schedule filter/,
    );

    const load = await ok(`plants/${plantId}/schedule/resources`);
    const cut = load.items.find((r: any) => r.code === p + 'CUT');
    expect([Number(cut.run_min), Number(cut.changeover_min), cut.changeovers, cut.drum]).toEqual([
      400,
      60,
      1,
      true,
    ]);
    expect(Number(cut.days[0])).toBeCloseTo(460 / 480, 4);
    const gantt = await ok(`plants/${plantId}/schedule/gantt?days=3&resource=${cut.resource_id}`);
    expect(gantt.blocks.map((b: any) => b.order_no)).toEqual([p + '-WO1', p + '-WO3', p + '-WO2']);
    expect(Number(gantt.blocks[2].changeover_min)).toBe(60);

    // Readiness reports the order without a routing.
    const readiness = await ok(`plants/${plantId}/readiness`);
    expect(readiness.items.find((i: any) => i.key === 'schedule')).toMatchObject({
      status: 'missing',
    });

    // Publish exactly the reviewed calculation, once.
    await refused(
      `plants/${plantId}/schedule/publish`,
      'POST',
      { runNo: 1 },
      409,
      /no longer current/,
    );
    await ok(`plants/${plantId}/schedule/publish`, 'POST', {
      runNo: status.current.run_no,
      note: 'Shift plan',
    });
    await refused(
      `plants/${plantId}/schedule/publish`,
      'POST',
      { runNo: status.current.run_no },
      409,
      /already the published schedule/,
    );
    expect((await schedule('published')).publication).toMatchObject({
      run_no: Number(status.current.run_no),
      note: 'Shift plan',
      current: true,
    });

    // Plant policy: grouping off -> strict due-date order; the published plan keeps its sequence.
    await refused(
      `plants/${plantId}/planning-settings`,
      'PUT',
      {
        club_window_days: '1',
        lead_time_basis: 'FIXED',
        profile_day: '7',
        day_weights: '1,2,3',
        version: 0,
      },
      400,
      /31 shares/,
    );
    await ok(`plants/${plantId}/planning-settings`, 'PUT', {
      club_window_days: '0',
      lead_time_basis: 'PLANNED_LOAD',
      profile_day: '7',
      day_weights: '',
      version: 0,
    });
    await refused(
      `plants/${plantId}/planning-settings`,
      'PUT',
      {
        club_window_days: '1',
        lead_time_basis: 'FIXED',
        profile_day: '7',
        day_weights: '',
        version: 0,
      },
      409,
      /changed after you opened/,
    );
    await recalculated();
    s = await schedule();
    expect(s.items.slice(0, 3).map((o: any) => o.order_no)).toEqual([
      p + '-WO1',
      p + '-WO2',
      p + '-WO3',
    ]);
    const published = await schedule('published');
    expect(published.items.slice(0, 3).map((o: any) => o.order_no)).toEqual([
      p + '-WO1',
      p + '-WO3',
      p + '-WO2',
    ]);
    expect(published.publication.current).toBe(false);

    // Screens.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await page.getByRole('tab', { name: 'Scheduler' }).click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plant} (${plant})` });
    await expect(page.getByRole('row').filter({ hasText: p + '-WO2' })).toContainText('On time');
    await expect(page.getByText('The latest calculation differs')).toBeVisible();
    await expect(page.getByRole('button', { name: /Publish run #/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Gantt' }).click();
    await expect(
      page
        .locator('.gantt-label')
        .filter({ hasText: p + 'CUT' })
        .first(),
    ).toBeVisible();
    await page.getByRole('tab', { name: 'Resource load' }).click();
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: p + 'CUT' })
        .first(),
    ).toContainText('drum');
    await page.getByRole('tab', { name: 'Plant planning' }).click();
    await expect(page.getByLabel('Grouping window (days)')).toHaveValue('0');

    // A viewer of this plant sees the schedule but cannot publish or change the policy.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Schedule viewer ' + suffix,
        permissions: ['dashboard.read', 'sites.read', 'masters.read', 'planning.read'],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Schedule Viewer', email, roleId });
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
    expect((await asViewer(`plants/${plantId}/schedule`)).status()).toBe(200);
    expect(
      (await asViewer(`plants/${plantId}/schedule/publish`, 'POST', { runNo: lastRun })).status(),
    ).toBe(403);
    expect(
      (
        await asViewer(`plants/${plantId}/planning-settings`, 'PUT', {
          club_window_days: '1',
          lead_time_basis: 'FIXED',
          profile_day: '7',
          day_weights: '',
          version: 1,
        })
      ).status(),
    ).toBe(403);
    await vp.getByRole('button', { name: 'Availability', exact: true }).click();
    await vp.getByRole('tab', { name: 'Scheduler' }).click();
    await expect(vp.getByRole('row').filter({ hasText: p + '-WO1' })).toBeVisible();
    await expect(vp.getByRole('button', { name: /Publish run #/ })).toHaveCount(0);
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
    sql(`DELETE FROM schedule_publications WHERE site_id IN (${sites});
      DELETE FROM plant_planning WHERE site_id IN (${sites});
      DELETE FROM planning_results WHERE item_id IN (${items});
      DELETE FROM item_buffers WHERE item_id IN (${items});
      DELETE FROM production_orders WHERE site_id IN (${sites});
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
