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

// AV-7 on synthetic data. One 480-minute shift every day; CUT (1 machine, 60 min changeover).
// FG1 and FG2 take 1 min per unit, the family standard <p>ODX72304 2 min; all use RM1 (no stock).
test('AV-7 decisions: declub, move, release, insert (catalogue, decline, odd size, rush) and permissions', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'D' + suffix,
    userId = randomUUID(),
    email = `decision.view.${suffix}@example.test`;
  let roleId = '',
    identityId = '',
    context: any,
    madeNos = false,
    tenantId = '';
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
  const sequence = async () =>
    (await ok(`plants/${plantId}/schedule`)).items
      .filter((o: any) => o.status !== 'unscheduled')
      .map((o: any) => o.order_no);
  try {
    // Odd-size BOM inheritance needs a piece unit (NOS); keep an existing one.
    const nos = await call('units', 'POST', { code: 'NOS', name: 'Numbers', decimals: 0 });
    madeNos = nos.ok();
    if (!madeNos) expect(nos.status(), await nos.text()).toBe(409);
    for (const [code, type, mb] of [
      ['FG1', 'FG', 'MAKE'],
      ['FG2', 'FG', 'MAKE'],
      ['ODX72304', 'FG', 'MAKE'],
      ['RM1', 'RM', 'BUY'],
    ])
      await ok('masters/items', 'POST', {
        code: p + code,
        name: 'Item ' + code,
        item_type: type,
        make_buy: mb,
        base_unit: 'NOS',
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
      changeover_minutes: '60',
      calendar: '',
      planned_utilization_pct: '',
    });
    for (const [item, run] of [
      ['FG1', '1'],
      ['FG2', '1'],
      ['ODX72304', '2'],
    ]) {
      await ok(`plants/${plantId}/routings`, 'POST', {
        item: p + item,
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
            run_minutes_per_unit: run,
          },
        ],
      });
      await ok('boms', 'POST', {
        parent_item: p + item,
        revision: 'V1',
        effective_from: '2020-01-01',
        effective_to: '',
        base_quantity: '1',
        lines: [{ component_item: p + 'RM1', quantity: '2', unit: '', scrap_pct: '0' }],
      });
    }
    // Area operations of odd sizes; the family whose standards share the code stem <p>OD.
    await ok(`plants/${plantId}/planning-settings`, 'PUT', {
      club_window_days: '1',
      lead_time_basis: 'FIXED',
      profile_day: '7',
      day_weights: '',
      area_operations: 'cut',
      version: 0,
    });
    const tenant = sql(`SELECT tenant_id FROM sites WHERE id='${plantId}'`);
    tenantId = tenant;
    sql(
      `INSERT INTO odd_size_families(tenant_id,code,name) VALUES('${tenant}','${p}OD','Test family')`,
    );
    const header = 'plant,order_no,item,quantity,start_date,due_date,order_type,reference';
    await upload(
      'production_orders',
      [
        header,
        `${plant},${p}-WO1,${p}FG1,100,,${day(2)},PCMT,`,
        `${plant},${p}-WO2,${p}FG2,100,,${day(2)},PCMT,`,
        `${plant},${p}-WO3,${p}FG1,50,,${day(3)},PCMT,`,
      ].join('\n'),
    );
    let status = await recalculated();
    expect(await sequence()).toEqual([p + '-WO1', p + '-WO3', p + '-WO2']);

    // Club compare of FG1: declub puts WO3 back on its promise date.
    const prev = await ok(`plants/${plantId}/decisions/club-preview`, 'POST', { item: p + 'FG1' });
    expect(prev.orders).toEqual([p + '-WO1', p + '-WO3']);
    const declub = prev.scenarios.find((s: any) => s.key === 'declub');
    expect(declub.normal).toBe(true);
    await refused(
      `plants/${plantId}/decisions/club`,
      'POST',
      { item: p + 'FG1', key: 'declub', orders: declub.orders, runNo: 1, version: prev.version },
      409,
      /no longer current/,
    );
    const d1 = await ok(`plants/${plantId}/decisions/club`, 'POST', {
      item: p + 'FG1',
      key: 'declub',
      orders: declub.orders,
      runNo: prev.runNo,
      version: prev.version,
    });
    expect(d1.message).toMatch(/back on their promise dates/);
    status = await recalculated();
    expect(await sequence()).toEqual([p + '-WO1', p + '-WO2', p + '-WO3']);

    // Move by hand, then release to the computed order.
    let plan = await ok(`plants/${plantId}/decisions`);
    await ok(`plants/${plantId}/decisions/move`, 'POST', {
      order: p + '-WO3',
      target: p + '-WO1',
      position: 'before',
      runNo: status.current.run_no,
      version: plan.version,
    });
    await refused(
      `plants/${plantId}/decisions/move`,
      'POST',
      {
        order: p + '-WO2',
        target: p + '-WO1',
        position: 'before',
        runNo: status.current.run_no,
        version: plan.version,
      },
      409,
      /Another planning decision was saved|being recalculated|no longer current/,
    );
    status = await recalculated();
    expect(await sequence()).toEqual([p + '-WO3', p + '-WO1', p + '-WO2']);
    plan = await ok(`plants/${plantId}/decisions`);
    expect(plan.manual).toBe(true);
    await ok(`plants/${plantId}/decisions/release-manual`, 'POST', {
      runNo: status.current.run_no,
      version: plan.version,
    });
    status = await recalculated();
    expect(await sequence()).toEqual([p + '-WO1', p + '-WO3', p + '-WO2']);

    // Insert a catalogue order: four options, each checked forward; RM1 has no stock record.
    const opts = await ok(`plants/${plantId}/insert/options`);
    expect(opts.drum).toBe(p + 'CUT');
    expect(opts.areaOperations).toEqual(['CUT']);
    expect(opts.families.find((f: any) => f.code === p + 'OD')).toMatchObject({ standards: 1 });
    const ask = { mode: 'catalogue', item: p + 'FG2', qty: 50, needDate: day(4), intent: 'dated' };
    await refused(
      `plants/${plantId}/insert/preview`,
      'POST',
      { ...ask, needDate: day(-3) },
      400,
      /after the planning date/,
    );
    let ins = await ok(`plants/${plantId}/insert/preview`, 'POST', ask);
    expect(ins.target).toMatchObject({ class: 'standard', drumMinPerUnit: 1, operations: 1 });
    expect(ins.scenarios.map((s: any) => s.key)).toEqual([
      'whole_now',
      'split',
      'whole_late',
      'decline',
    ]);
    expect(ins.scenarios.every((s: any) => s.materials.status === 'unknown')).toBe(true);
    const pick = ins.scenarios.find((s: any) => s.key === ins.recommended);
    await refused(
      `plants/${plantId}/insert/commit`,
      'POST',
      {
        ...ask,
        key: pick.key,
        lots: [{ qty: 1, date: day(1) }],
        runNo: ins.runNo,
        version: ins.version,
      },
      409,
      /changed since the preview/,
    );
    const c1 = await ok(`plants/${plantId}/insert/commit`, 'POST', {
      ...ask,
      customer: 'Walk-in',
      key: pick.key,
      lots: pick.lots,
      runNo: ins.runNo,
      version: ins.version,
    });
    expect(c1.order).toMatch(/^INS-\d+$/);
    status = await recalculated();
    let seq = await sequence();
    expect(seq.filter((x: string) => x.startsWith(c1.order))).toHaveLength(pick.lots.length);
    expect(
      sql(
        `SELECT source||','||customer||','||due_date FROM production_orders WHERE order_ref='${c1.order}' AND site_id='${plantId}' LIMIT 1`,
      ),
    ).toBe(`INSERTED,Walk-in,${day(4)}`);

    // Decline: a quote is logged, nothing is scheduled.
    ins = await ok(`plants/${plantId}/insert/preview`, 'POST', {
      ...ask,
      item: p + 'FG1',
      qty: 10,
    });
    const dec = ins.scenarios.find((s: any) => s.key === 'decline');
    const q = await ok(`plants/${plantId}/insert/commit`, 'POST', {
      ...ask,
      item: p + 'FG1',
      qty: 10,
      key: 'decline',
      lots: dec.lots,
      runNo: ins.runNo,
      version: ins.version,
    });
    expect(q.message).toMatch(/declined .* quoted/);
    expect((await sequence()).length).toBe(seq.length);

    // Odd size: nearest standard of the family, area-scaled, written as an estimated item.
    const odd = {
      mode: 'oddsize',
      family: p + 'OD',
      length: 75,
      width: 30,
      thickness: 4,
      qty: 20,
      needDate: day(6),
      intent: 'dated',
    };
    ins = await ok(`plants/${plantId}/insert/preview`, 'POST', odd);
    expect(ins.target).toMatchObject({
      class: 'oddsize',
      code: p + 'OD-75X30X4',
      exists: false,
      source: p + 'ODX72304',
      exactThickness: true,
      drumMinPerUnit: 2.083,
      bomLines: 1,
    });
    const op = ins.scenarios.find((s: any) => s.key === ins.recommended);
    await ok(`plants/${plantId}/insert/commit`, 'POST', {
      ...odd,
      key: op.key,
      lots: op.lots,
      runNo: ins.runNo,
      version: ins.version,
    });
    expect(
      sql(
        `SELECT e.area_ratio::numeric(8,4)||','||o.run_minutes_per_unit::numeric(8,3)||','||l.quantity::numeric(8,3)
         FROM items i JOIN estimated_items e ON e.item_id=i.id JOIN routings r ON r.item_id=i.id
         JOIN routing_operations o ON o.routing_id=r.id JOIN boms b ON b.item_id=i.id JOIN bom_lines l ON l.bom_id=b.id
         WHERE i.code='${p}OD-75X30X4'`,
      ),
    ).toBe('1.0417,2.083,2.000');
    status = await recalculated();

    // Rush: every insertion position priced.
    const rush = await ok(`plants/${plantId}/insert/preview`, 'POST', {
      mode: 'catalogue',
      item: p + 'FG2',
      qty: 10,
      intent: 'rush',
    });
    expect(rush.intent).toBe('rush');
    expect(rush.evaluated).toBeGreaterThan(3);
    expect(rush.scenarios[0].quoteDate).toBeTruthy();

    const kinds = (await ok(`plants/${plantId}/decisions`)).items.map((d: any) => d.kind);
    expect(kinds).toEqual(['insert', 'quote', 'insert', 'release_manual', 'move', 'declub']);

    // Screens.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await page.getByRole('tab', { name: 'Insert order' }).click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plant} (${plant})` });
    await page.getByLabel('Item code').fill(p + 'FG1');
    await page.getByLabel('Quantity').fill('30');
    await page.getByLabel('Need-by date').fill(day(5));
    await page.getByRole('button', { name: 'Show options' }).click();
    await expect(page.locator('[data-scenario=whole_now]')).toContainText('Take it whole, now');
    await expect(page.locator('[data-scenario=decline]')).toContainText(
      'Decline and log the quote',
    );
    await page.getByRole('tab', { name: 'Scheduler' }).click();
    await expect(page.getByRole('row').filter({ hasText: c1.order }).first()).toBeVisible();

    // A viewer previews but cannot insert or change the plan.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Decision viewer ' + suffix,
        permissions: ['dashboard.read', 'sites.read', 'masters.read', 'planning.read'],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Decision Viewer', email, roleId });
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
    const vprev = await asViewer(`plants/${plantId}/insert/preview`, 'POST', ask);
    expect(vprev.ok()).toBe(true);
    const vj = await vprev.json();
    const vs = vj.scenarios[0];
    expect(
      (
        await asViewer(`plants/${plantId}/insert/commit`, 'POST', {
          ...ask,
          key: vs.key,
          lots: vs.lots,
          runNo: vj.runNo,
          version: vj.version,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await asViewer(`plants/${plantId}/decisions/release-manual`, 'POST', {
          runNo: vj.runNo,
          version: vj.version,
        })
      ).status(),
    ).toBe(403);
    await vp.getByRole('button', { name: 'Availability', exact: true }).click();
    await vp.getByRole('tab', { name: 'Insert order' }).click();
    await vp.getByLabel('Item code').fill(p + 'FG1');
    await vp.getByLabel('Quantity').fill('30');
    await vp.getByLabel('Need-by date').fill(day(5));
    await vp.getByRole('button', { name: 'Show options' }).click();
    await expect(vp.locator('[data-scenario=whole_now]')).toBeVisible();
    await expect(vp.getByRole('button', { name: /^Commit|Decline and log/ })).toHaveCount(0);
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
    sql(`DELETE FROM estimated_items WHERE item_id IN (${items});
      DELETE FROM odd_size_families WHERE code LIKE '${p}%';
      DELETE FROM planning_decisions WHERE site_id IN (${sites});
      DELETE FROM plant_sequence WHERE site_id IN (${sites});
      DELETE FROM schedule_publications WHERE site_id IN (${sites});
      DELETE FROM plant_planning WHERE site_id IN (${sites});
      DELETE FROM planning_results WHERE item_id IN (${items});
      DELETE FROM item_buffers WHERE item_id IN (${items});
      DELETE FROM production_orders WHERE site_id IN (${sites});
      DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM boms WHERE item_id IN (${items}));
      DELETE FROM boms WHERE item_id IN (${items});
      DELETE FROM routing_operations WHERE routing_id IN (SELECT id FROM routings WHERE site_id IN (${sites}));
      DELETE FROM routings WHERE site_id IN (${sites});
      DELETE FROM resources WHERE site_id IN (${sites});
      DELETE FROM calendar_shifts WHERE calendar_id IN (SELECT id FROM calendars WHERE site_id IN (${sites}));
      DELETE FROM calendars WHERE site_id IN (${sites});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM items WHERE code LIKE '${p}%';`);
    if (madeNos && tenantId) sql(`DELETE FROM units WHERE code='NOS' AND tenant_id='${tenantId}'`);
  }
});
