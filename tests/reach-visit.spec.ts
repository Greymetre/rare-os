// RCH-4 Visit and check-out report. Its own acceptance is: send one check-in three times and one
// visit is made, and check in from 800 metres away and the visit is made and flagged. Around
// that: the per-type report form, the field app, the day's calls, the manager's board, the
// export, and the boundaries — a rep records their own calls and nobody else's, and what one
// company may see of another.
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

// A shop in Rohtak, and a spot roughly 800 metres north of it.
const SHOP = { latitude: 28.8955, longitude: 76.6066 };
const DOOR = { latitude: 28.8955, longitude: 76.6067, accuracy_m: 8, source: 'DEVICE' };
const FAR = { latitude: 28.9027, longitude: 76.6066, accuracy_m: 12, source: 'DEVICE' };

test('RCH-4 visits: check-in, the check-out report, de-duplication, the field app and boundaries', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'V' + suffix,
    repUserId = randomUUID(),
    repEmail = `visitrep.${suffix}@example.test`,
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
    // Kept for cleanup: `sql` runs as the owner and ignores row-level security, so anything it
    // deletes has to name the company itself or it would reach into every other one.
    tenantId = me.user.tenant_id;
    expect(tenantId, 'the signed-in company is needed to clean up safely').toMatch(
      /^[0-9a-f-]{36}$/,
    );

    // ---------- The ground a visit stands on ----------
    await ok('masters/territories', 'POST', { code: p + 'T', name: 'Visit territory' });
    await ok('masters/rep_grades', 'POST', { code: p + 'G', name: 'Officer', rank: 1 });
    // A retailer is called on within 75 metres, and a real call takes five minutes.
    await ok('masters/customer_types', 'POST', {
      code: p + 'RET',
      name: 'Retailer',
      checkin_radius_m: 75,
      min_visit_minutes: 5,
      on_beat_plan: true,
    });
    // A distributor's yard is wider, so the same 800 metres is inside its own fence.
    await ok('masters/customer_types', 'POST', {
      code: p + 'DIST',
      name: 'Distributor',
      checkin_radius_m: 5000,
      min_visit_minutes: 10,
      on_beat_plan: false,
    });

    // The report form: one required question of a retailer, one optional.
    for (const field of [
      {
        field_key: p.toLowerCase() + '_share',
        name: 'Shelf share',
        input: 'number',
        section: 'Shelf',
        display_order: 10,
      },
      {
        field_key: p.toLowerCase() + '_comp',
        name: 'Competitor seen',
        input: 'text',
        section: 'Shelf',
        display_order: 20,
      },
    ])
      await ok('masters/visit_form_fields', 'POST', field);
    // The same rule the customer form holds: a choice question with no choices is unanswerable.
    await rejected(
      'masters/visit_form_fields',
      'POST',
      { field_key: p.toLowerCase() + '_bad', name: 'Bad', input: 'select' },
      400,
      /needs its choices/,
    );
    await ok('masters/visit_form_rules', 'POST', {
      type: p + 'RET',
      field: p.toLowerCase() + '_share',
      requirement: 'R',
    });
    await ok('masters/visit_form_rules', 'POST', {
      type: p + 'RET',
      field: p.toLowerCase() + '_comp',
      requirement: 'O',
    });

    const repId = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'R',
        name: 'Kiran Call',
        grade: p + 'G',
        territory: p + 'T',
      })
    ).id;
    const otherRep = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'Z',
        name: 'Other Rep',
        grade: p + 'G',
        territory: p + 'T',
      })
    ).id;
    await ok('masters/beats', 'POST', {
      code: p + 'B',
      name: 'North round',
      territory: p + 'T',
      run_days: 'mon,tue,wed,thu,fri,sat,sun',
    });

    // Four shops on the round, and one distributor off it. A location is a tag of its own in
    // RCH-1, so each one is created and then tagged where it stands.
    const tag = (customerId: string) =>
      ok(`reach/customers/${customerId}/geo`, 'POST', {
        ...SHOP,
        source: 'DEVICE',
        accuracy_m: 8,
      });
    const shops: string[] = [];
    for (let i = 1; i <= 4; i += 1) {
      const shop = (
        await ok('reach/customers', 'POST', {
          code: `${p}C${i}`,
          type: p + 'RET',
          name: `Shop ${i}`,
          territory: p + 'T',
          beat: p + 'B',
          town: 'Rohtak',
        })
      ).id;
      await tag(shop);
      shops.push(shop);
    }
    const house = (
      await ok('reach/customers', 'POST', {
        code: p + 'D1',
        type: p + 'DIST',
        name: 'Rohtak distributor',
        territory: p + 'T',
        town: 'Rohtak',
      })
    ).id;
    await tag(house);

    // ---------- The rep's own session ----------
    repRole = (
      await ok('roles', 'POST', {
        name: 'Visit rep ' + suffix,
        permissions: ['dashboard.read', 'reach.visit'],
      })
    ).id;
    await ok('users', 'POST', {
      requestId: repUserId,
      name: 'Visit Rep',
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
            data: { type: 'password', value: 'Reach-Visit-2026!', temporary: false },
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
    await repPage.locator('#password').fill('Reach-Visit-2026!');
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

    // ---------- The report form travels with the screen ----------
    const formView = await okRep(`reach/visits/form/${shops[0]}`);
    expect(formView.form.map((f: any) => [f.field_key, f.required])).toEqual([
      [p.toLowerCase() + '_share', true],
      [p.toLowerCase() + '_comp', false],
    ]);
    expect(formView.customer.checkin_radius_m).toBe(75);
    // Listing the form masters themselves still needs reach.read, which this rep does not have.
    expect((await asRep('masters/visit_form_fields')).status()).toBe(403);

    // ---------- The milestone acceptance: 800 metres away is a visit, and it is flagged ----------
    const far = await okRep('reach/visits/check-in', 'POST', {
      customer_id: shops[0],
      ...FAR,
      client_ref: `${p}-far`,
    });
    expect(far.repeated).toBe(false);
    expect(far.out_of_fence).toBe(true);
    expect(far.distance_m).toBeGreaterThan(700);
    expect(far.distance_m).toBeLessThan(900);
    // The message says what was recorded, not that anything was refused.
    expect(far.message).toMatch(/recorded and flagged/);
    expect(sql(`SELECT count(*) FROM visits WHERE customer_id='${shops[0]}'`)).toBe('1');

    // The same 800 metres judged by a distributor's own radius carries no flag.
    const atHouse = await okRep('reach/visits/check-in', 'POST', {
      customer_id: house,
      ...FAR,
      client_ref: `${p}-house`,
    });
    expect(atHouse.out_of_fence).toBe(false);

    // ---------- The milestone acceptance: three check-ins, one visit ----------
    for (const attempt of [2, 3]) {
      const again = await okRep('reach/visits/check-in', 'POST', {
        customer_id: shops[0],
        ...FAR,
        client_ref: `${p}-far`,
      });
      expect(again.repeated, `attempt ${attempt} made a second visit`).toBe(true);
      expect(again.id).toBe(far.id);
    }
    expect(
      sql(`SELECT count(*) FROM visits WHERE customer_id='${shops[0]}'`),
      'three check-ins must leave one visit',
    ).toBe('1');
    // Even with no reference at all, the visit still open is the same visit.
    const noRef = await okRep('reach/visits/check-in', 'POST', { customer_id: shops[0], ...DOOR });
    expect([noRef.repeated, noRef.id]).toEqual([true, far.id]);

    // ---------- The check-out report ----------
    const open = (await okRep('reach/visits/my-day')).open;
    expect(open.customer).toBe(p + 'C1');
    // A required question left unanswered stops the check-out and says which one.
    const missing = await rejectedRep(
      `reach/visits/${far.id}/check-out`,
      'POST',
      { report: {}, ...DOOR, version: open.version },
      400,
      /Shelf share/,
    );
    // A key the form never asked for is refused rather than stored.
    await rejectedRep(
      `reach/visits/${far.id}/check-out`,
      'POST',
      {
        report: { nobody_asked: 'x', [p.toLowerCase() + '_share']: 40 },
        ...DOOR,
        version: open.version,
      },
      400,
      /not asked for nobody_asked/,
    );
    // An answer of the wrong shape is refused too.
    await rejectedRep(
      `reach/visits/${far.id}/check-out`,
      'POST',
      {
        report: { [p.toLowerCase() + '_share']: 'not a number' },
        ...DOOR,
        version: open.version,
      },
      400,
      /Shelf share/,
    );
    const left = await okRep(`reach/visits/${far.id}/check-out`, 'POST', {
      report: { [p.toLowerCase() + '_share']: 40 },
      ...DOOR,
      version: open.version,
    });
    // Checked in and out within the same minute: under a retailer's five-minute floor.
    expect(left.status).toBe('SHORT');
    await rejectedRep(
      `reach/visits/${far.id}/check-out`,
      'POST',
      { report: {}, ...DOOR, version: open.version + 1 },
      409,
      /already ended/,
    );

    // The visit keeps the flag it was given at the door.
    let visit = await okRep(`reach/visits/one/${far.id}`);
    expect([visit.out_of_fence, visit.report_complete, visit.status]).toEqual([
      true,
      true,
      'SHORT',
    ]);

    // A report may be corrected afterwards; the visit is never reopened.
    await okRep(`reach/visits/${far.id}/report`, 'PUT', {
      report: { [p.toLowerCase() + '_share']: 55, [p.toLowerCase() + '_comp']: 'Brand X' },
      version: visit.version,
    });
    visit = await okRep(`reach/visits/one/${far.id}`);
    // A number answer is normalised the way every other decimal in the system is, so the report
    // keeps what was typed without a float quietly rounding it.
    expect(String(visit.report[p.toLowerCase() + '_share'])).toBe('55');
    expect(visit.report[p.toLowerCase() + '_comp']).toBe('Brand X');
    expect(visit.checked_out_at).not.toBe(null);

    // ---------- A question made required today reaches yesterday's report ----------
    const second = await okRep('reach/visits/check-in', 'POST', {
      customer_id: shops[1],
      ...DOOR,
      client_ref: `${p}-two`,
    });
    const openTwo = (await okRep('reach/visits/my-day')).open;
    await okRep(`reach/visits/${second.id}/check-out`, 'POST', {
      report: { [p.toLowerCase() + '_share']: 30 },
      ...DOOR,
      version: openTwo.version,
    });
    expect((await okRep(`reach/visits/one/${second.id}`)).report_complete).toBe(true);
    // Make the optional question required. Nothing about the visit is rewritten.
    const rule = (await ok(`masters/visit_form_rules?q=${(p + 'RET').toLowerCase()}`)).items.find(
      (r: any) => r.field === p.toLowerCase() + '_comp',
    );
    await ok(`masters/visit_form_rules/${rule.id}`, 'PATCH', {
      type: p + 'RET',
      field: p.toLowerCase() + '_comp',
      requirement: 'R',
      label_override: '',
      active: true,
      version: rule.version,
    });
    const tightened = await okRep(`reach/visits/one/${second.id}`);
    expect(tightened.report_complete).toBe(false);
    expect(tightened.missing).toEqual([p.toLowerCase() + '_comp']);

    // ---------- The field app ----------
    const day = await okRep('reach/visits/my-day');
    // The rep has no tour plan, so nothing is planned and every call reads as unplanned work —
    // recorded, never discarded.
    expect(day.planned).toBe(0);
    expect(day.unplanned).toBe(3);
    expect(day.summary.visits).toBe(3);
    expect(day.summary.outOfFence).toBe(1);

    // Give the rep an approved plan for today's round, and the same day has stops on it.
    const month = day.date.slice(0, 7);
    const planId = randomUUID();
    sql(
      `INSERT INTO tour_plans(id,tenant_id,rep_id,plan_month,status,submitted_at,decided_at)
       VALUES('${planId}','${tenantId}','${repId}','${month}-01','APPROVED',now(),now());
       INSERT INTO tour_plan_days(tenant_id,plan_id,work_date,beat_id,town,outlet_count,source)
       SELECT '${tenantId}','${planId}','${day.date}',b.id,'Rohtak',4,'AUTO'
       FROM beats b WHERE b.tenant_id='${tenantId}' AND b.code='${p}B';`,
    );
    const planned = await okRep('reach/visits/my-day');
    expect(planned.planned).toBe(4);
    expect(planned.done).toBe(2);
    // The distributor is not a stop on the round, so that call stays unplanned.
    expect(planned.unplanned).toBe(1);
    expect(planned.stops.filter((s: any) => s.planned).map((s: any) => s.sequence)).toEqual([
      1, 2, 3, 4,
    ]);

    // ---------- Boundaries ----------
    // A rep records their own calls and reads their own; a rep id in the body is refused.
    await rejectedRep(
      'reach/visits/check-in',
      'POST',
      { customer_id: shops[2], rep_id: otherRep, ...DOOR },
      400,
      /Unsupported field: rep_id/,
    );
    await rejectedRep(
      'reach/visits/check-in',
      'POST',
      { customer_id: randomUUID(), ...DOOR },
      404,
      /was not found/,
    );
    // A coordinate off the planet is a typo somebody has to see.
    await rejectedRep(
      'reach/visits/check-in',
      'POST',
      { customer_id: shops[2], latitude: 999, longitude: 10, source: 'DEVICE' },
      400,
      /between -90 and 90/,
    );
    await rejectedRep(
      'reach/visits/check-in',
      'POST',
      { customer_id: shops[2], ...DOOR, source: 'SATELLITE' },
      400,
      /location source/,
    );
    await rejectedRep(
      `reach/visits?from=${day.date}&to=${day.date}&rep=${otherRep}`,
      'GET',
      undefined,
      403,
      /only read your own visits/,
    );
    // The board and the export are a manager's screens, and so is the setup.
    expect((await asRep('reach/visits/board')).status()).toBe(403);
    expect((await asRep(`reach/visits/export.csv?from=${day.date}&to=${day.date}`)).status()).toBe(
      403,
    );
    await rejectedRep(
      'reach/visits/settings',
      'PUT',
      { visit_dedupe_minutes: 0, version: 0 },
      403,
      /do not have permission/,
    );
    // One request may ask for a year and no more.
    await rejectedRep(
      'reach/visits?from=2026-01-01&to=2027-06-30',
      'GET',
      undefined,
      400,
      /at most 366 days/,
    );
    // A login that is not a field rep has no round of its own, and is told so plainly.
    await rejected('reach/visits/my-day', 'GET', undefined, 403, /not linked to a field rep/);
    // The setting is bounded, and a stale version is refused.
    await rejected(
      'reach/visits/settings',
      'PUT',
      { visit_dedupe_minutes: 999, version: settingsBefore.version },
      400,
      /from 0 to 240/,
    );
    await rejected(
      'reach/visits/settings',
      'PUT',
      { visit_dedupe_minutes: 10, version: 9999 },
      409,
      /changed elsewhere/,
    );

    // ---------- What a manager reads ----------
    const board = await ok(`reach/visits/board?date=${day.date}`);
    const row = board.reps.find((r: any) => r.rep === p + 'R');
    expect(row.summary.visits).toBe(3);
    expect(row.summary.outOfFence).toBe(1);
    // Only the second shop's report is unfinished: the first was corrected after the question
    // was made required, and the distributor's type asks nothing on the way out.
    expect(row.summary.incomplete).toBe(1);

    const csvResponse = await call(
      `reach/visits/export.csv?from=${day.date}&to=${day.date}&rep=${repId}`,
    );
    expect(csvResponse.headers()['x-content-type-options']).toBe('nosniff');
    expect(csvResponse.headers()['content-disposition']).toMatch(/attachment/);
    const csv = await csvResponse.text();
    expect(csv.split('\r\n')[0].split(',')).toEqual(
      expect.arrayContaining(['visit_date', 'rep', 'customer', 'distance_m', 'out_of_fence']),
    );
    expect(csv).toContain(p + 'C1');
    expect(csv).toMatch(/,yes,/);

    // ---------- The screens ----------
    await repPage.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(repPage, 'Field app');
    await expect(repPage.getByRole('heading', { name: 'Field app' })).toBeVisible();
    // The round is drawn in walking order, with what has happened at each stop.
    await expect(repPage.getByText(p + 'C1').first()).toBeVisible();
    await expect(repPage.getByText('Check in').first()).toBeVisible();
    await openScreen(repPage, 'Visits');
    await expect(repPage.getByRole('heading', { name: 'Visits' })).toBeVisible();

    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(page, 'Calls today');
    await expect(page.getByRole('heading', { name: 'Calls today' })).toBeVisible();
    await page.getByLabel('Date', { exact: true }).fill(day.date);
    await expect(page.getByRole('cell', { name: new RegExp(p + 'R') }).first()).toBeVisible();
    await openScreen(page, 'Visit settings');
    await expect(page.getByLabel('Retry window in minutes')).toBeVisible();

    // ---------- One company sees nothing of another ----------
    sql(
      `INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','RCH4 isolation ${suffix}','RC4${suffix}')`,
    );
    expect(sql(`SELECT count(*) FROM visits WHERE tenant_id='${otherCompany}'`)).toBe('0');
    for (const table of ['visits', 'visit_form_fields', 'visit_form_rules']) {
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
    }
    // The database itself refuses a second open visit and a reused reference, so neither rule
    // rests on the read that comes before it.
    for (const index of ['visits_open_idx', 'visits_client_ref_idx'])
      expect(
        sql(`SELECT indisunique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE c.relname='${index}'`),
      ).toBe('t');
  } finally {
    // Cleanup must never hide the failure that brought us here, so each step stands alone.
    const tidy = (what: string, run: () => void) => {
      try {
        run();
      } catch (e: any) {
        console.warn(`cleanup (${what}) did not finish: ${e.message}`);
      }
    };
    await repContext?.close().catch(() => {});
    // Settings are one row for the whole company. A company that had never saved them reads
    // version 0, and the next spec in the run expects to find it that way.
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
    // Everything this spec set up, in the order the foreign keys allow. Left behind, these
    // masters make the readiness checklist other milestones assert on read as already set up.
    const reps = `SELECT id FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%'`;
    tidy('remove visit records', () =>
      sql(`DELETE FROM visits WHERE rep_id IN (${reps});
           DELETE FROM tour_plan_days WHERE plan_id IN (SELECT id FROM tour_plans WHERE rep_id IN (${reps}));
           DELETE FROM tour_plans WHERE rep_id IN (${reps});`),
    );
    tidy('remove the report form', () =>
      sql(`DELETE FROM visit_form_rules WHERE tenant_id='${tenantId}';
           DELETE FROM visit_form_fields WHERE tenant_id='${tenantId}' AND field_key LIKE '${p.toLowerCase()}%';`),
    );
    tidy('remove customers', () =>
      sql(`DELETE FROM customer_geo_log WHERE tenant_id='${tenantId}' AND customer_id IN (SELECT id FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM beat_outlets WHERE tenant_id='${tenantId}' AND customer_id IN (SELECT id FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove field masters', () =>
      sql(`DELETE FROM beats WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM customer_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM rep_grades WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM territories WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove other company', () => sql(`DELETE FROM tenants WHERE id='${otherCompany}'`));
  }
});
