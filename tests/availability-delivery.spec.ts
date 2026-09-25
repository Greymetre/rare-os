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

// AV-10 on synthetic data. One 480-minute shift a day; CUT (1 machine). FG1 takes 1 minute a unit
// and is buffered. Three orders: two fit tomorrow, the third cannot be finished by its promise.
test('AV-10 delivery: order OTIF, time buffer, alerts, the planner day and CSV exports', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(420000);
  const suffix = Date.now().toString().slice(-6),
    p = 'Y' + suffix;
  const plant = p + 'P1';
  let plantId = '';
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
    await ok('masters/suppliers', 'POST', { code: p + 'S1', name: 'Foam Co', lead_time_days: '5' });
    await ok('masters/item_suppliers', 'POST', {
      item: p + 'RM1',
      supplier: p + 'S1',
      purchase_unit: '',
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
      item: p + 'RM1',
      policy: 'BUFFER',
      profile: p + 'PR',
    });
    await upload(
      'demand_history',
      ['plant,item,demand_date,quantity']
        .concat(Array.from({ length: 30 }, (_, i) => `${plant},${p}RM1,${day(-1 - i)},20`))
        .join('\n'),
    );
    // WO1 and WO2 fit; WO3 (900 minutes of work) cannot be finished by its promise two days out.
    await upload(
      'production_orders',
      [
        'plant,order_no,item,quantity,start_date,due_date,order_type,reference',
        `${plant},${p}-WO1,${p}FG1,100,,${day(1)},PCMT,`,
        `${plant},${p}-WO2,${p}FG1,100,,${day(3)},PCMT,`,
        `${plant},${p}-WO3,${p}FG1,900,,${day(2)},PCMT,`,
      ].join('\n'),
    );
    await recalculated();

    const view = await ok(`plants/${plantId}/delivery`);
    expect(view.calculation).toMatchObject({ runNo: lastRun, upToDate: true });
    // One of the three orders cannot be finished by its promise.
    expect([view.otif.total, view.otif.onTime, view.otif.orderPct]).toEqual([3, 2, 67]);
    expect(view.otif.late.map((o: any) => o.order)).toEqual([p + '-WO3']);
    const wo3 = view.orders.find((o: any) => o.order === p + '-WO3');
    expect(wo3.buffer).toMatchObject({ zone: 'penetrated', consumed: 100 });
    expect(wo3.lateDays).toBeGreaterThan(0);
    // The first order has most of its runway left; nothing else is past its promise.
    const wo1 = view.orders.find((o: any) => o.order === p + '-WO1');
    expect(wo1.buffer.zone).toBe('green');
    expect(view.orders.filter((o: any) => o.buffer.zone === 'penetrated')).toHaveLength(1);
    // Alerts: the late promise is critical; the component's buffer is short of demand.
    const late = view.alerts.find((a: any) => a.kind === 'promise' && a.subject === p + '-WO3');
    expect(late.severity).toBe('critical');
    expect(view.alerts.some((a: any) => a.kind === 'stock' && a.subject === p + 'RM1')).toBe(true);
    // The planner's day: RM1 to order, the first day's work to release.
    expect(view.day.order.map((r: any) => r.item)).toContain(p + 'RM1');
    expect(view.day.make.map((r: any) => r.order)).toContain(p + '-WO1');
    expect(view.day.watch.some((a: any) => a.subject === p + '-WO3')).toBe(true);

    // CSV of every list, formula-safe and with the plant in its name.
    for (const kind of ['otif', 'time-buffer', 'alerts', 'release-schedule', 'day-list']) {
      const r = await call(`plants/${plantId}/delivery/${kind}.csv`);
      expect(r.status(), kind).toBe(200);
      expect(r.headers()['content-disposition']).toContain(`${plant}-${kind}.csv`);
      const text = await r.text();
      expect(text.split('\r\n')[0].length).toBeGreaterThan(5);
      if (kind === 'otif') expect(text).toContain(p + '-WO3');
    }
    expect((await call(`plants/${plantId}/delivery/nonsense.csv`)).status()).toBe(404);

    // Screens.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await openScreen(page, 'Planning Priorities');
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plant} (${plant})` });
    await expect(page.getByRole('heading', { name: /^Today, / })).toBeVisible();
    await expect(page.locator(`[data-order-today="${p}RM1"]`)).toBeVisible();
    // RM1 has no stock record in this plant, so the release is held on materials.
    await expect(page.locator(`[data-release-today="${p}-WO1"]`)).toContainText('Hold');
    // The exceptions of the same day are their own entry in the menu.
    await openScreen(page, 'Alerts');
    await expect(page.locator(`[data-alert="promise:${p}-WO3"]`)).toContainText('Critical');
    await openScreen(page, 'Order OTIF');
    await expect(page.getByText('OTIF by order')).toBeVisible();
    await expect(page.locator(`[data-promise="${p}-WO3"]`)).toContainText('Penetrated');
    await page.getByRole('checkbox', { name: 'Late only' }).check();
    await expect(page.locator('[data-promise]')).toHaveCount(1);
    await expect(page.getByRole('link', { name: 'Export OTIF (CSV)' })).toHaveAttribute(
      'href',
      `/api/plants/${plantId}/delivery/otif.csv`,
    );

    // A recalculation is announced: the screens say the numbers are behind.
    await ok(`plants/${plantId}/planning-settings`, 'PUT', {
      club_window_days: '0',
      lead_time_basis: 'FIXED',
      profile_day: '7',
      day_weights: '',
      area_operations: '',
      execution_buffer_pct: '25',
      version: 0,
    });
    const stale = await ok(`plants/${plantId}/delivery`);
    expect(stale.calculation.upToDate).toBe(false);
    await recalculated();
    expect((await ok(`plants/${plantId}/delivery`)).calculation.upToDate).toBe(true);
  } finally {
    const items = `SELECT id FROM items WHERE code LIKE '${p}%'`,
      sites = `SELECT id FROM sites WHERE code LIKE '${p}%'`;
    sql(`DELETE FROM planning_decisions WHERE site_id IN (${sites});
      DELETE FROM plant_sequence WHERE site_id IN (${sites});
      DELETE FROM plant_planning WHERE site_id IN (${sites});
      DELETE FROM planning_results WHERE item_id IN (${items});
      DELETE FROM item_buffers WHERE item_id IN (${items});
      DELETE FROM buffer_profiles WHERE code LIKE '${p}%';
      DELETE FROM purchase_proposals WHERE site_id IN (${sites});
      DELETE FROM production_orders WHERE site_id IN (${sites});
      DELETE FROM demand_history WHERE site_id IN (${sites});
      DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM boms WHERE item_id IN (${items}));
      DELETE FROM boms WHERE item_id IN (${items});
      DELETE FROM routing_operations WHERE routing_id IN (SELECT id FROM routings WHERE site_id IN (${sites}));
      DELETE FROM routings WHERE site_id IN (${sites});
      DELETE FROM resources WHERE site_id IN (${sites});
      DELETE FROM calendar_shifts WHERE calendar_id IN (SELECT id FROM calendars WHERE site_id IN (${sites}));
      DELETE FROM calendars WHERE site_id IN (${sites});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM item_suppliers WHERE item_id IN (${items});
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM suppliers WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
