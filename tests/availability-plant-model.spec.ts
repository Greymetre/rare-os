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

test('AV-2 plant model: calendars, resources, BOMs, routings, grouped imports, plant access and scale', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(480000);
  const suffix = Date.now().toString().slice(-6),
    p = 'Z' + suffix,
    userId = randomUUID(),
    email = `planner.${suffix}@example.test`;
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
  const item = (code: string, make_buy: string, base_unit: string) =>
    ok('masters/items', 'POST', {
      code: p + code,
      name: 'Item ' + code,
      item_type: make_buy === 'MAKE' ? 'FG' : 'RM',
      make_buy,
      base_unit: p + base_unit,
    });
  const plantOne = p + 'P1',
    plantTwo = p + 'P2';
  try {
    for (const [code, decimals] of [
      ['KG', 3],
      ['NOS', 0],
      ['BOX', 0],
    ] as const)
      await ok('units', 'POST', { code: p + code, name: code, decimals });
    await item('RM1', 'BUY', 'KG');
    await item('RM2', 'BUY', 'NOS');
    for (const code of ['SFG1', 'FG1', 'FG2', 'FG3']) await item(code, 'MAKE', 'NOS');
    const plants: Record<string, string> = {};
    for (const code of [plantOne, plantTwo])
      plants[code] = (
        await ok('plants', 'POST', {
          code,
          name: 'Plant ' + code,
          location: 'Test',
          timezone: 'Asia/Kolkata',
        })
      ).id;

    // Calendar and resource through the UI; capacity = shift minutes × machines × efficiency.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await page.getByRole('tab', { name: 'Calendars' }).click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await expect(page.getByText('No calendar for this plant yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Create calendar' }).click();
    await page.getByLabel('Calendar code *').fill(p + 'CAL');
    await page.getByLabel('Calendar name *').fill('General shift');
    await page.getByRole('button', { name: 'Add shift' }).click();
    await page.getByLabel('Shift 2 name').fill('Overlap');
    await page.getByLabel('Shift 2 start').fill('17:00');
    await page.getByLabel('Shift 2 end').fill('20:00');
    await page.getByRole('button', { name: 'Save calendar' }).click();
    await expect(page.getByRole('alert')).toContainText('overlaps');
    await page
      .getByRole('row')
      .filter({ has: page.getByLabel('Shift 2 name') })
      .getByRole('button', { name: 'Remove' })
      .click();
    await page.getByRole('button', { name: 'Save calendar' }).click();
    await expect(page.getByText(`Calendar ${p}CAL created as the plant default.`)).toBeVisible();
    const calRow = page.getByRole('row').filter({ hasText: p + 'CAL' });
    await expect(calRow).toContainText('Mon, Tue, Wed, Thu, Fri, Sat');
    await expect(calRow.getByRole('cell').nth(4)).toHaveText('480');

    await page.getByRole('tab', { name: 'Resources' }).click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await page.getByRole('button', { name: 'Create resource' }).click();
    await page.getByLabel('Resource code *').fill(p + 'R1');
    await page.getByLabel('Resource name *').fill('CNC cell');
    await page.getByLabel('Machines *').fill('2');
    await page.getByLabel('Efficiency %').fill('90');
    await page.getByRole('button', { name: 'Save resource' }).click();
    await expect(page.getByText(`Resource ${p}R1 created.`)).toBeVisible();
    const resRow = page.getByRole('row').filter({ hasText: p + 'R1' });
    await expect(resRow).toContainText(`${p}CAL (default)`);
    await expect(resRow.getByRole('cell').nth(7)).toHaveText('864');

    // Calendar rules through the API.
    const calendars = (await ok(`plants/${plants[plantOne]}/calendars`)).items;
    const cal = await ok('calendars/' + calendars[0].id);
    await rejected(
      'calendars/' + cal.id,
      'PUT',
      {
        name: cal.name,
        working_days: cal.working_days,
        is_default: false,
        shifts: cal.shifts,
        holidays: [],
        active: true,
        version: cal.version,
      },
      400,
      /needs a default calendar/,
    );
    await ok(`plants/${plants[plantOne]}/calendars`, 'POST', {
      code: p + 'NIGHT',
      name: 'Night',
      working_days: '1111100',
      shifts: [{ name: 'Night', start_time: '22:00', end_time: '06:00', break_minutes: '30' }],
      holidays: [{ holiday_date: '2026-10-02', name: 'Gandhi Jayanti' }],
    });
    const night = (await ok(`plants/${plants[plantOne]}/calendars`)).items.find(
      (c: any) => c.code === p + 'NIGHT',
    );
    expect([night.is_default, night.day_minutes, night.holidays]).toEqual([false, 450, 1]);
    await rejected(
      `plants/${plants[plantOne]}/resources`,
      'POST',
      { code: p + 'R9', name: 'x', machine_count: '1', calendar: p + 'NONE' },
      400,
      /Calendar .* was not found in plant/,
    );
    await rejected(
      `plants/${plants[plantOne]}/resources`,
      'POST',
      { code: p.toLowerCase() + 'r1', name: 'Duplicate', machine_count: '1' },
      409,
      /already exists/,
    );
    await ok(`plants/${plants[plantTwo]}/resources`, 'POST', {
      code: p + 'X1',
      name: 'Other plant press',
      machine_count: '1',
    });
    expect(
      (await ok(`plants/${plants[plantTwo]}/resources`)).items[0].capacity_minutes_per_day,
    ).toBeNull();

    // BOMs: a UI save, then parent/unit/decimal/overlap/cycle rules.
    await page.getByRole('tab', { name: 'BOMs' }).click();
    await page.getByRole('button', { name: 'Create BOM' }).click();
    await page.getByLabel('Parent item code *').fill(p + 'FG1');
    await page.getByLabel('Effective from *').fill('2020-01-01');
    await page.getByLabel('Line 1 Component item').fill(p + 'SFG1');
    await page.getByLabel('Line 1 Quantity').fill('1');
    await page.getByRole('button', { name: 'Add line' }).click();
    await page.getByLabel('Line 2 Component item').fill(p.toLowerCase() + 'rm2');
    await page.getByLabel('Line 2 Quantity').fill('2.5');
    await page.getByRole('button', { name: 'Save BOM' }).click();
    await expect(page.getByRole('alert')).toContainText('quantity');
    await page.getByLabel('Line 2 Quantity').fill('2');
    await page.getByRole('button', { name: 'Save BOM' }).click();
    await expect(page.getByText(`BOM ${p}FG1 V1 created with 2 line(s).`)).toBeVisible();
    const bomLine = (component: string, quantity: string, unit = '') => ({
      component_item: p + component,
      quantity,
      unit: unit && p + unit,
      scrap_pct: '0',
    });
    const bomBody = (parent: string, revision: string, from: string, lines: any[]) => ({
      parent_item: p + parent,
      revision,
      effective_from: from,
      effective_to: '',
      base_quantity: '1',
      lines,
    });
    await rejected(
      'boms',
      'POST',
      bomBody('RM1', 'V1', '2020-01-01', [bomLine('RM2', '1')]),
      400,
      /is BUY/,
    );
    await rejected(
      'boms',
      'POST',
      bomBody('SFG1', 'V1', '2020-01-01', [bomLine('RM1', '2', 'BOX')]),
      400,
      /no conversion between/,
    );
    await ok('masters/unit_conversions', 'POST', {
      from_unit: p + 'BOX',
      to_unit: p + 'KG',
      factor: '25',
    });
    await ok('boms', 'POST', bomBody('SFG1', 'V1', '2020-01-01', [bomLine('RM1', '2', 'BOX')]));
    await rejected(
      'boms',
      'POST',
      bomBody('FG1', 'V2', '2025-01-01', [bomLine('RM2', '1')]),
      400,
      /overlap with BOM/,
    );
    const loop = await rejected(
      'boms',
      'POST',
      bomBody('SFG1', 'V2', '2020-01-01', [bomLine('FG1', '1')]),
      400,
      /BOM loop/,
    );
    expect(loop.message).toContain(`${p}FG1`);
    const fg1Bom = (await ok('boms?q=' + p.toLowerCase() + 'fg1')).items[0];
    const fg1Detail = await ok('boms/' + fg1Bom.id);
    await ok('boms/' + fg1Bom.id, 'PUT', {
      effective_from: '2020-01-01',
      effective_to: '2029-12-31',
      base_quantity: '1',
      lines: fg1Detail.lines,
      active: true,
      version: fg1Detail.version,
    });
    await rejected(
      'boms/' + fg1Bom.id,
      'PUT',
      {
        effective_from: '2020-01-01',
        effective_to: '',
        base_quantity: '1',
        lines: fg1Detail.lines,
        active: true,
        version: fg1Detail.version,
      },
      409,
      /changed elsewhere/,
    );
    await ok('boms', 'POST', bomBody('FG1', 'V2', '2030-01-01', [bomLine('RM2', '1')]));

    // Routings: resources must belong to the routing's plant; used resources stay active.
    const op = (sequence: string, code: string, resource: string, run: string) => ({
      sequence,
      operation_code: code,
      description: '',
      resource: p + resource,
      setup_minutes: '15',
      run_minutes_per_unit: run,
    });
    await rejected(
      `plants/${plants[plantOne]}/routings`,
      'POST',
      {
        item: p + 'FG1',
        revision: 'V1',
        effective_from: '2020-01-01',
        effective_to: '',
        operations: [op('10', 'CUT', 'X1', '2')],
      },
      400,
      /resource .*X1 was not found in plant/,
    );
    for (const code of ['FG1', 'SFG1'])
      await ok(`plants/${plants[plantOne]}/routings`, 'POST', {
        item: p + code,
        revision: 'V1',
        effective_from: '2020-01-01',
        effective_to: '',
        operations: [op('20', 'PACK', 'R1', '0.5'), op('10', 'CUT', 'R1', '2.25')],
      });
    const routing = (await ok(`plants/${plants[plantOne]}/routings?q=${p.toLowerCase()}fg1`))
      .items[0];
    expect([routing.operation_count, Number(routing.run_minutes_per_unit)]).toEqual([2, 2.75]);
    expect(
      (await ok('routings/' + routing.id)).operations.map((o: any) => o.operation_code),
    ).toEqual(['CUT', 'PACK']);
    const r1 = (await ok(`plants/${plants[plantOne]}/resources`)).items[0];
    await rejected(
      'resources/' + r1.id,
      'PATCH',
      {
        name: r1.name,
        resource_type: r1.resource_type,
        machine_count: String(r1.machine_count),
        efficiency_pct: '90',
        changeover_minutes: '0',
        calendar: '',
        active: false,
        version: r1.version,
      },
      409,
      /used by 4 operation/,
    );

    // Grouped imports: one bad line blocks its whole document; good documents are unaffected.
    const bomHeader =
      'parent_item,revision,effective_from,effective_to,base_quantity,component_item,quantity,unit,scrap_pct';
    const badBoms = await upload(
      'boms',
      [
        bomHeader,
        `${p}FG2,V1,2020-01-01,,1,${p}RM1,1.5,,2`,
        `${p}FG2,V1,2020-01-01,,1,${p}RM2,4,,0`,
        `${p}FG3,V1,2020-01-01,,1,${p}RM2,1,,0`,
        `${p}FG3,V1,2020-01-01,,1,${p}MISSING,1,,0`,
      ].join('\n'),
      `boms-bad-${suffix}.csv`,
    );
    expect([badBoms.valid_rows, badBoms.error_rows, badBoms.summary.create]).toEqual([2, 2, 1]);
    const bomErrors = await (await call(`imports/${badBoms.id}/errors.csv`)).text();
    expect(bomErrors).toContain(`item ${p}MISSING was not found`);
    expect(bomErrors).toContain('Nothing from it will be saved');
    const boms = await commit(
      await upload(
        'boms',
        [
          bomHeader,
          `${p}FG2,V1,2020-01-01,,1,${p}RM1,1.5,,2`,
          `${p}FG2,V1,2020-01-01,,1,${p}RM2,4,,0`,
          `${p}FG3,V1,2020-01-01,,1,${p}RM2,1,,0`,
          `${p.toLowerCase()}fg3,v1,2020-01-01,,1,${p}SFG1,1,,0`,
        ].join('\n'),
        `boms-${suffix}.csv`,
      ),
    );
    expect([boms.status, boms.summary]).toEqual([
      'committed',
      { created: 2, updated: 0, unchanged: 0 },
    ]);
    expect((await ok('boms?q=' + p.toLowerCase() + 'fg3')).items[0].line_count).toBe(2);

    const resources = await commit(
      await upload(
        'resources',
        [
          'plant,code,name,resource_type,machine_count,efficiency_pct,changeover_minutes,calendar',
          `${plantOne},${p}R2,Assembly,LINE,1,95,20,${p}NIGHT`,
          `${plantTwo},${p}X2,Packing,MANUAL,3,100,0,`,
        ].join('\n'),
        `resources-${suffix}.csv`,
      ),
    );
    expect(resources.summary).toEqual({ created: 2, updated: 0, unchanged: 0 });
    const routingHeader =
      'plant,item,revision,effective_from,effective_to,sequence,operation_code,description,resource,setup_minutes,run_minutes_per_unit';
    const routings = await commit(
      await upload(
        'routings',
        [
          routingHeader,
          `${plantOne},${p}FG2,V1,2020-01-01,,10,ASSY,Assemble,${p}R2,10,4`,
          `${plantOne},${p}FG3,V1,2020-01-01,,10,ASSY,Assemble,${p}R2,10,5`,
          `${plantOne},${p}FG3,V1,2020-01-01,,20,PACK,,${p}R1,0,1`,
        ].join('\n'),
        `routings-${suffix}.csv`,
      ),
    );
    expect(routings.summary).toEqual({ created: 2, updated: 0, unchanged: 0 });
    // A resource deactivated between validation and commit: nothing is written.
    const staleRouting = await upload(
      'routings',
      [routingHeader, `${plantTwo},${p}FG1,V1,2020-01-01,,10,PRESS,,${p}X1,0,1`].join('\n'),
      `routings-stale-${suffix}.csv`,
    );
    expect(staleRouting.error_rows).toBe(0);
    const x1 = (await ok(`plants/${plants[plantTwo]}/resources`)).items.find(
      (r: any) => r.code === p + 'X1',
    );
    await ok('resources/' + x1.id, 'PATCH', {
      name: x1.name,
      resource_type: x1.resource_type,
      machine_count: '1',
      efficiency_pct: '100',
      changeover_minutes: '0',
      calendar: '',
      active: false,
      version: x1.version,
    });
    const stale = await commit(staleRouting);
    expect(stale.status).toBe('failed');
    expect(stale.error).toContain('Data changed after validation');
    expect((await ok(`plants/${plants[plantTwo]}/routings`)).items).toHaveLength(0);

    // Plant readiness turns ready once calendar, resources, BOMs and routings exist.
    const readiness = await ok(`plants/${plants[plantOne]}/readiness`);
    const status = Object.fromEntries(readiness.items.map((i: any) => [i.key, i]));
    expect([status.calendar.status, status.resources.status]).toEqual(['ready', 'ready']);
    for (const key of ['boms', 'routings']) expect(status[key].detail).not.toContain(p);
    const plantTwoReadiness = await ok(`plants/${plants[plantTwo]}/readiness`);
    expect(plantTwoReadiness.items.find((i: any) => i.key === 'calendar').status).toBe('missing');
    expect(plantTwoReadiness.items.find((i: any) => i.key === 'routings').detail).toContain(
      p + 'FG1',
    );
    await page.getByRole('tab', { name: 'Readiness' }).click();
    await page.getByLabel('Plant').selectOption({ label: `Plant ${plantOne} (${plantOne})` });
    await expect(
      page.getByText(`Default calendar ${p}CAL: 480 working minutes per day.`),
    ).toBeVisible();

    // Scale: 1,000 BOMs with 10 lines each (10,000 rows) validated and committed in the background.
    const bulkItems = [
      'code,name,item_type,make_buy,base_unit,family,standard_cost,demand_class',
      ...Array.from({ length: 10 }, (_, i) => `${p}C${i},Component ${i},RM,BUY,${p}NOS,,,`),
      ...Array.from(
        { length: 1000 },
        (_, i) => `${p}M${String(i).padStart(4, '0')},Made ${i},FG,MAKE,${p}NOS,,,`,
      ),
    ].join('\n');
    expect((await commit(await upload('items', bulkItems, `items-av2-${suffix}.csv`))).status).toBe(
      'committed',
    );
    const bulkBoms = [
      bomHeader,
      ...Array.from({ length: 10000 }, (_, n) => {
        const parent = `${p}M${String(Math.floor(n / 10)).padStart(4, '0')}`;
        return `${parent},V1,2020-01-01,,1,${p}C${n % 10},${(n % 7) + 1},,0`;
      }),
    ].join('\n');
    const started = Date.now();
    const bulkBatch = await upload('boms', bulkBoms, `boms-bulk-${suffix}.csv`);
    expect([bulkBatch.error_rows, bulkBatch.summary.create]).toEqual([0, 1000]);
    const bulkDone = await commit(bulkBatch);
    expect(bulkDone.summary.created).toBe(1000);
    console.log(
      `PASS 10,000 BOM lines (1,000 BOMs) validated and committed in ${Math.round((Date.now() - started) / 1000)}s`,
    );
    const firstPage = await ok(`boms?q=${p.toLowerCase()}m`);
    expect([
      firstPage.items.length,
      firstPage.items[0].parent_item,
      firstPage.items[0].line_count,
    ]).toEqual([25, p + 'M0000', 10]);
    const secondPage = await ok(`boms?q=${p.toLowerCase()}m&cursor=${firstPage.nextCursor}`);
    expect(secondPage.items[0].parent_item).toBe(p + 'M0025');

    // A planner limited to plant one cannot read or import plant two.
    roleId = (
      await ok('roles', 'POST', {
        name: 'Plant planner ' + suffix,
        permissions: [
          'dashboard.read',
          'sites.read',
          'masters.read',
          'masters.manage',
          'imports.create',
        ],
      })
    ).id;
    await ok('users', 'POST', { requestId: userId, name: 'Plant Planner', email, roleId });
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
            data: { type: 'password', value: 'Planner-Test-2026!', temporary: false },
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
    await up.locator('#password').fill('Planner-Test-2026!');
    await up.locator('#kc-login').click();
    await completeTestMfa(up, email);
    await expect(up.locator('.main > header')).toBeVisible();
    const um = await (await up.request.get('/api/me')).json();
    const asPlanner = (
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
    expect((await asPlanner(`plants/${plants[plantOne]}/resources`)).status()).toBe(200);
    expect((await asPlanner(`plants/${plants[plantTwo]}/resources`)).status()).toBe(404);
    expect((await asPlanner(`plants/${plants[plantTwo]}/readiness`)).status()).toBe(404);
    expect(
      (
        await asPlanner(`plants/${plants[plantTwo]}/calendars`, 'POST', {
          code: 'NOPE',
          name: 'x',
          working_days: '1111100',
          shifts: [{ name: 'Day', start_time: '08:00', end_time: '16:00' }],
        })
      ).status(),
    ).toBe(404);
    const denied = await asPlanner(
      'imports/resources',
      'POST',
      `plant,code,name,resource_type,machine_count,efficiency_pct,changeover_minutes,calendar\n${plantOne},${p}R5,a,MACHINE,1,,,\n${plantTwo},${p}X5,b,MACHINE,1,,,\n`,
      { 'Content-Type': 'text/csv' },
    );
    expect(denied.status()).toBe(403);
    expect((await denied.json()).error.message).toContain(plantTwo);
    expect(
      (
        await asPlanner(
          'imports/resources',
          'POST',
          `plant,code,name,resource_type,machine_count,efficiency_pct,changeover_minutes,calendar\n${plantOne},${p}R5,a,MACHINE,1,,,\n`,
          { 'Content-Type': 'text/csv' },
        )
      ).status(),
    ).toBe(201);
    await up.getByRole('button', { name: 'Availability', exact: true }).click();
    await up.getByRole('tab', { name: 'Resources' }).click();
    await expect(up.getByLabel('Plant').locator('option')).toHaveText([
      `Plant ${plantOne} (${plantOne})`,
    ]);
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
    sql(`DELETE FROM routing_operations WHERE routing_id IN (SELECT id FROM routings WHERE item_id IN (${items}) OR site_id IN (${sites}));
      DELETE FROM routings WHERE item_id IN (${items}) OR site_id IN (${sites});
      DELETE FROM bom_lines WHERE bom_id IN (SELECT id FROM boms WHERE item_id IN (${items}));
      DELETE FROM boms WHERE item_id IN (${items});
      DELETE FROM resources WHERE site_id IN (${sites});
      DELETE FROM calendar_shifts WHERE calendar_id IN (SELECT id FROM calendars WHERE site_id IN (${sites}));
      DELETE FROM calendar_holidays WHERE calendar_id IN (SELECT id FROM calendars WHERE site_id IN (${sites}));
      DELETE FROM calendars WHERE site_id IN (${sites});
      DELETE FROM user_sites WHERE site_id IN (${sites});
      DELETE FROM sites WHERE code LIKE '${p}%';
      DELETE FROM unit_conversions WHERE from_unit_id IN (SELECT id FROM units WHERE code LIKE '${p}%');
      DELETE FROM items WHERE code LIKE '${p}%';
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
