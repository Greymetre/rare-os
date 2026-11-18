// RCH-3 Tour plan. Its own acceptance is: a day where the rep visited 60% of the planned round
// reads as Followed, and leave approved after the plan was built does not read as a day they
// missed. Around that: the auto-fill from the beat calendar, the checks a month must pass,
// submit, approve and send back, moving one day of an approved month by request, and the
// boundaries — a rep builds their own month and nobody else's, a manager decides it and never
// types into it, and what one company may see of another.
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

// March 2026, well in the past, so "this month" can never drift onto it while the suite runs.
// 1 March is a Sunday: Mondays fall on 2/9/16/23/30 and Thursdays on 5/12/19/26.
const MONTH = '2026-03';
const MONDAYS = ['2026-03-02', '2026-03-09', '2026-03-16', '2026-03-23', '2026-03-30'];
const THURSDAYS = ['2026-03-05', '2026-03-12', '2026-03-19', '2026-03-26'];
const SUNDAYS = ['2026-03-01', '2026-03-08', '2026-03-15', '2026-03-22', '2026-03-29'];
const HOLIDAY = '2026-03-25';
// The day the acceptance test is written against, and the day leave is approved on afterwards.
const VISIT_DAY = '2026-03-09';
const LEAVE_DAY = '2026-03-16';

const marchDates = Array.from(
  { length: 31 },
  (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`,
);

test('RCH-3 tour plan: the auto-fill, the checks, approval, day changes, plan versus actual and boundaries', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'P' + suffix,
    repUserId = randomUUID(),
    repEmail = `tourrep.${suffix}@example.test`,
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

    // ---------- The ground a plan stands on ----------
    await ok('masters/territories', 'POST', { code: p + 'T', name: 'Tour territory' });
    await ok('masters/rep_grades', 'POST', { code: p + 'G', name: 'Officer', rank: 1 });
    await ok('masters/shifts', 'POST', {
      code: p + 'S',
      name: 'General shift',
      starts_at: '09:30',
      ends_at: '18:00',
      grace_minutes: 10,
      half_day_minutes: 240,
      min_minutes: 60,
      week_off: 'SUN',
    });
    await ok('masters/leave_types', 'POST', {
      code: p + 'CL',
      name: 'Casual leave',
      paid: true,
      annual_quota: '12',
    });
    await ok('masters/holidays', 'POST', {
      name: 'Tour plan day',
      holiday_date: HOLIDAY,
    });

    // The rep, and the login that is them. A login is always created holding a role, so the
    // rep's own role — the right to build a plan and nothing more — is made first.
    repRole = (
      await ok('roles', 'POST', {
        name: 'Tour rep ' + suffix,
        permissions: ['dashboard.read', 'reach.plan'],
      })
    ).id;
    await ok('users', 'POST', {
      requestId: repUserId,
      name: 'Tour Rep',
      email: repEmail,
      roleId: repRole,
    });
    const repId = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'R',
        name: 'Kiran Tour',
        grade: p + 'G',
        territory: p + 'T',
        user: repEmail,
        shift: p + 'S',
      })
    ).id;
    // A second rep, so "read your own and nobody else's" has somebody else to be refused.
    const otherRep = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'Z',
        name: 'Other Rep',
        grade: p + 'G',
        territory: p + 'T',
      })
    ).id;

    // ---------- The rounds, and the shops on them ----------
    await ok('masters/beats', 'POST', {
      code: p + 'B1',
      name: 'North round',
      territory: p + 'T',
      run_days: 'mon,thu',
    });
    await ok('masters/beats', 'POST', {
      code: p + 'B2',
      name: 'South round',
      territory: p + 'T',
      frequency: 'FORTNIGHTLY',
      run_days: 'wed',
      week_parity: 'ODD',
    });
    await ok('masters/beat_assignments', 'POST', {
      beat: p + 'B1',
      rep: p + 'R',
      from_date: '2026-02-01',
    });
    // Taken over mid-month on purpose: the auto-fill must not plan it for the days before.
    await ok('masters/beat_assignments', 'POST', {
      beat: p + 'B2',
      rep: p + 'R',
      from_date: '2026-03-16',
    });

    const typeTemplate = await (await call('imports/templates/customer_types')).text();
    const typeRows = typeTemplate
      .split('\r\n')
      .filter(Boolean)
      .map((line, index) => (index === 0 ? line : line.replace(/^([A-Z]+)/, p + '$1')));
    const typeBatch = await call('imports/customer_types', 'POST', typeRows.join('\r\n') + '\r\n', {
      'Content-Type': 'text/csv',
      'X-File-Name': 'types.csv',
    });
    const started = await typeBatch.json();
    expect(typeBatch.ok(), JSON.stringify(started)).toBe(true);
    // Validating and committing are both done by the worker, so each is waited for in turn.
    let batch: any;
    const settled = async () => {
      await expect
        .poll(
          async () => {
            batch = await (await call('imports/' + started.id)).json();
            return ['validated', 'committed', 'failed', 'cancelled'].includes(batch.status);
          },
          { timeout: 120000, intervals: [1000, 2000] },
        )
        .toBe(true);
      return batch;
    };
    const validated = await settled();
    expect(validated.status, JSON.stringify(validated)).toBe('validated');
    await ok(`imports/${validated.id}/commit`, 'POST', { version: validated.version });
    expect((await settled()).status, JSON.stringify(batch)).toBe('committed');

    // Ten shops on the north round, all in one town, so a day on it asks for ten calls.
    const shops: string[] = [];
    for (let n = 1; n <= 10; n += 1)
      shops.push(
        (
          await ok('reach/customers', 'POST', {
            code: `${p}C${String(n).padStart(2, '0')}`,
            type: p + 'RET',
            name: `Shop ${n}`,
            territory: p + 'T',
            beat: p + 'B1',
            town: 'Rohtak',
          })
        ).id,
      );
    expect(
      sql(
        `SELECT count(*) FROM beat_outlets o JOIN beats b ON b.id=o.beat_id WHERE b.code='${p}B1'`,
      ),
    ).toBe('10');

    // ---------- The rep's own session ----------
    repIdentity = sql(`SELECT identity_id FROM app_users WHERE id='${repUserId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + repIdentity + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Reach-Tour-2026!', temporary: false },
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
    await repPage.locator('#password').fill('Reach-Tour-2026!');
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

    // ---------- Starting the month ----------
    let view = await okRep(`reach/tour/plan?month=${MONTH}`);
    expect(view.plan).toBe(null);
    expect(view.mine).toBe(true);
    // The rounds travel with the screen: a rep building a month never asks for the beat master.
    expect(view.beats.map((b: any) => b.code).sort()).toEqual([p + 'B1', p + 'B2']);
    expect(view.limits).toMatchObject({ max_outlets: 12, field_days_pct: 75, followed_pct: 60 });
    // Listing the masters themselves still needs reach.read, which this rep does not have.
    expect((await asRep('masters/beats')).status()).toBe(403);

    // A rep id is not a field any route here reads, so a month cannot be started for somebody
    // else. The body allowlist refuses the field outright rather than quietly dropping it.
    await rejectedRep(
      'reach/tour/plan',
      'POST',
      { month: MONTH, rep_id: otherRep },
      400,
      /Unsupported field: rep_id/,
    );
    const planId = (await okRep('reach/tour/plan', 'POST', { month: MONTH })).id;
    // The month belongs to the signed-in rep, taken from the login and not from the request.
    expect(sql(`SELECT rep_id FROM tour_plans WHERE id='${planId}'`)).toBe(repId);
    await rejectedRep('reach/tour/plan', 'POST', { month: MONTH }, 409, /already have a plan/);
    await rejectedRep('reach/tour/plan', 'POST', { month: '2026-13' }, 400, /written as YYYY-MM/);

    // ---------- The auto-fill ----------
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    const filled = await okRep(`reach/tour/plan/${planId}/autofill`, 'POST', {
      version: view.plan.version,
    });
    expect(filled.written).toBeGreaterThan(0);
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    const dates = view.days.map((d: any) => d.work_date);
    // Checked by the days this round actually runs on, not by pinning the whole month: a later
    // milestone may add another reason for a day to appear.
    for (const monday of MONDAYS) expect(dates, `${monday} is a Monday`).toContain(monday);
    for (const thursday of THURSDAYS) expect(dates).toContain(thursday);
    // Attendance owns the holiday and the week-off, and the auto-fill leaves both alone.
    for (const sunday of SUNDAYS) expect(dates).not.toContain(sunday);
    expect(dates).not.toContain(HOLIDAY);
    expect(filled.skipped.filter((s: any) => s.reason === 'HOLIDAY')).toHaveLength(1);
    expect(filled.skipped.filter((s: any) => s.reason === 'WEEK_OFF')).toHaveLength(5);
    // The round taken over on the 16th is never planned for the Wednesdays before it.
    for (const day of view.days.filter((d: any) => d.beat === p + 'B2'))
      expect(day.work_date >= '2026-03-16').toBe(true);
    // A laid-out day carries the round's own town and size; the rep corrects, never types it in.
    const ninth = view.days.find((d: any) => d.work_date === VISIT_DAY);
    expect([ninth.beat, ninth.town, ninth.outlet_count, ninth.source]).toEqual([
      p + 'B1',
      'Rohtak',
      10,
      'AUTO',
    ]);

    // ---------- What the month has to pass ----------
    // March has 31 days, five Sundays and one holiday: 25 working days. Nine of them are field
    // days so far, which is well under the 75% this company asks for.
    expect(view.workingDays).toBe(25);
    expect(view.ready).toBe(false);
    expect(view.checks.find((c: any) => c.code === 'FIELD_DAYS').message).toMatch(/75%/);
    await rejectedRep(
      `reach/tour/plan/${planId}/submit`,
      'POST',
      { version: view.plan.version },
      400,
      /75%/,
    );

    // A day asking for more outlets than the company plans in one day is refused as it is typed.
    await rejectedRep(
      `reach/tour/plan/${planId}/day`,
      'PUT',
      {
        work_date: MONDAYS[0],
        beat_id: view.beats.find((b: any) => b.code === p + 'B1').id,
        outlet_count: 30,
        version: view.plan.version,
      },
      400,
      /at most 12 outlets/,
    );
    // A date outside the month belongs to another month's plan.
    await rejectedRep(
      `reach/tour/plan/${planId}/day`,
      'PUT',
      { work_date: '2026-04-06', beat_id: null, version: view.plan.version },
      400,
      /not in 2026-03/,
    );
    // A round the rep does not hold cannot be planned, whatever the body says.
    await rejectedRep(
      `reach/tour/plan/${planId}/day`,
      'PUT',
      { work_date: MONDAYS[0], beat_id: randomUUID(), version: view.plan.version },
      404,
      /not one this rep holds/,
    );

    // Fill the rest of the working days by hand, which is also what proves a typed day survives
    // a second run of the auto-fill.
    const b1 = view.beats.find((b: any) => b.code === p + 'B1').id;
    let version = view.plan.version;
    for (const date of marchDates) {
      if (SUNDAYS.includes(date) || date === HOLIDAY || dates.includes(date)) continue;
      await okRep(`reach/tour/plan/${planId}/day`, 'PUT', {
        work_date: date,
        beat_id: b1,
        objective: 'Order and shelf check',
        version,
      });
      version += 1;
    }
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    expect(view.fieldDays).toBe(25);
    expect(view.fieldPct).toBe(100);
    expect(view.ready).toBe(true);
    const typedDay = view.days.find((d: any) => d.work_date === '2026-03-03');
    expect([typedDay.source, typedDay.objective]).toEqual(['MANUAL', 'Order and shelf check']);
    // A second auto-fill refreshes its own rows and leaves the rep's alone.
    const again = await okRep(`reach/tour/plan/${planId}/autofill`, 'POST', {
      version: view.plan.version,
    });
    expect(again.kept).toBeGreaterThan(0);
    expect(
      (await okRep(`reach/tour/plan?month=${MONTH}`)).days.find(
        (d: any) => d.work_date === '2026-03-03',
      ).source,
    ).toBe('MANUAL');

    // ---------- Submitting, and being sent back ----------
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    await okRep(`reach/tour/plan/${planId}/submit`, 'POST', { version: view.plan.version });
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    expect(view.plan.status).toBe('SUBMITTED');
    // A month waiting for a decision is not edited, by anyone.
    await rejectedRep(
      `reach/tour/plan/${planId}/day`,
      'PUT',
      { work_date: MONDAYS[0], beat_id: null, version: view.plan.version },
      409,
      /waiting for a decision/,
    );
    // And a rep does not decide their own month.
    await rejectedRep(
      `reach/tour/plan/${planId}/decide`,
      'POST',
      { status: 'APPROVED', reason: '', version: view.plan.version },
      403,
      /do not have permission/,
    );
    // Sending a month back without saying why teaches the rep nothing.
    await rejected(
      `reach/tour/plan/${planId}/decide`,
      'POST',
      { status: 'SENT_BACK', reason: '', version: view.plan.version },
      400,
      /Reason/,
    );
    await rejected(
      `reach/tour/plan/${planId}/decide`,
      'POST',
      { status: 'CANCELLED', reason: 'no', version: view.plan.version },
      400,
      /approved or sent back/,
    );
    await ok(`reach/tour/plan/${planId}/decide`, 'POST', {
      status: 'SENT_BACK',
      reason: 'Add the south round',
      version: view.plan.version,
    });
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    expect([view.plan.status, view.plan.decision_reason]).toEqual([
      'SENT_BACK',
      'Add the south round',
    ]);

    // Sent back, so it is the rep's again; submitting clears the old decision.
    await okRep(`reach/tour/plan/${planId}/submit`, 'POST', { version: view.plan.version });
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    expect([view.plan.status, view.plan.decision_reason]).toEqual(['SUBMITTED', '']);
    await ok(`reach/tour/plan/${planId}/decide`, 'POST', {
      status: 'APPROVED',
      reason: '',
      version: view.plan.version,
    });
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    expect(view.plan.status).toBe('APPROVED');
    // A month cannot be decided twice.
    await rejected(
      `reach/tour/plan/${planId}/decide`,
      'POST',
      { status: 'APPROVED', reason: '', version: view.plan.version },
      409,
      /not waiting for a decision/,
    );

    // ---------- Moving one day of an approved month ----------
    await rejectedRep(
      `reach/tour/plan/${planId}/day`,
      'PUT',
      { work_date: MONDAYS[0], beat_id: null, version: view.plan.version },
      409,
      /Ask for a day change/,
    );
    const b2 = view.beats.find((b: any) => b.code === p + 'B2').id;
    const before = view.days.find((d: any) => d.work_date === MONDAYS[3]);
    await rejectedRep(
      `reach/tour/plan/${planId}/change`,
      'POST',
      { work_date: MONDAYS[3], beat_id: b2, reason: '' },
      400,
      /Reason/,
    );
    const changeId = (
      await okRep(`reach/tour/plan/${planId}/change`, 'POST', {
        work_date: MONDAYS[3],
        beat_id: b2,
        objective: 'Distributor stock arrives',
        reason: 'Stock lands that morning',
      })
    ).id;
    // Only one change for a day may be in flight, so two cannot be approved into each other.
    await rejectedRep(
      `reach/tour/plan/${planId}/change`,
      'POST',
      { work_date: MONDAYS[3], beat_id: b1, reason: 'Second thoughts' },
      409,
      /already waiting for a decision/,
    );
    const queue = await okRep('reach/tour/changes?status=PENDING');
    expect(queue.total).toBe(1);
    expect(queue.canApprove).toBe(false);
    // A rep asks; they do not decide.
    await rejectedRep(
      `reach/tour/changes/${changeId}/decide`,
      'POST',
      { status: 'APPROVED', reason: '' },
      403,
      /do not have permission/,
    );
    await rejected(
      `reach/tour/changes/${changeId}/decide`,
      'POST',
      { status: 'REJECTED', reason: '' },
      400,
      /Reason/,
    );
    await ok(`reach/tour/changes/${changeId}/decide`, 'POST', {
      status: 'APPROVED',
      reason: '',
    });
    view = await okRep(`reach/tour/plan?month=${MONTH}`);
    const moved = view.days.find((d: any) => d.work_date === MONDAYS[3]);
    // The south round carries no stops, so the day it moves to names no town: the town always
    // comes from the round and is never typed into the request.
    expect([before.beat, moved.beat, moved.town]).toEqual([p + 'B1', p + 'B2', '']);
    // The day beside it did not move, and the old day survives on the request that replaced it.
    expect(view.days.find((d: any) => d.work_date === MONDAYS[2]).beat).toBe(p + 'B1');
    const decided = (await okRep('reach/tour/changes?status=APPROVED')).items[0];
    expect([decided.previous_beat, decided.beat]).toEqual([p + 'B1', p + 'B2']);
    await rejected(
      `reach/tour/changes/${changeId}/decide`,
      'POST',
      { status: 'REJECTED', reason: 'Changed my mind' },
      409,
      /already decided/,
    );

    // ---------- The milestone's own acceptance ----------
    // Six of the ten shops on the planned round, visited on a planned Monday. Visits are written
    // straight to the table — RCH-4 records them — and everything that reads them is this module.
    // Each one is written as a completed call: RCH-4 allows a rep only one *open* visit per shop,
    // so a fixture that never checks out could not call on the same shop twice.
    const visit = (date: string, customerId: string) =>
      sql(
        `INSERT INTO visits(id,tenant_id,rep_id,customer_id,visit_date,checked_in_at,checked_out_at)
         VALUES(gen_random_uuid(),'${tenantId}','${repId}','${customerId}','${date}',
                '${date} 11:00+05:30','${date} 11:20+05:30')`,
      );
    for (const shop of shops.slice(0, 6)) visit(VISIT_DAY, shop);

    let adherence = await okRep(`reach/tour/adherence?from=${VISIT_DAY}&to=${VISIT_DAY}`);
    expect([
      adherence.rows[0].status,
      adherence.rows[0].percent,
      adherence.rows[0].visited,
      adherence.rows[0].planned,
    ]).toEqual(['FOLLOWED', 60, 6, 10]);

    // A planned day nobody worked is missed — until leave is approved for it.
    adherence = await okRep(`reach/tour/adherence?from=${LEAVE_DAY}&to=${LEAVE_DAY}`);
    expect(adherence.rows[0].status).toBe('MISSED');

    // Leave approved AFTER the month was approved. Nothing about the plan is rewritten; the
    // register simply answers again, which is the whole reason adherence is calculated.
    sql(
      `INSERT INTO leave_requests(id,tenant_id,rep_id,leave_type_id,from_date,to_date,reason,status,decided_at)
       SELECT gen_random_uuid(),'${tenantId}','${repId}',t.id,'${LEAVE_DAY}','${LEAVE_DAY}','Family','APPROVED',now()
       FROM leave_types t WHERE t.tenant_id='${tenantId}' AND t.code='${p}CL'`,
    );
    adherence = await okRep(`reach/tour/adherence?from=${LEAVE_DAY}&to=${LEAVE_DAY}`);
    expect(adherence.rows[0].status).toBe('LEAVE');
    expect(adherence.countedDays).toBe(0);

    // The holiday and the Sundays are not held against anybody either.
    adherence = await okRep(`reach/tour/adherence?from=${HOLIDAY}&to=${HOLIDAY}`);
    expect(adherence.rows[0].status).toBe('HOLIDAY');

    // Work on a shop nobody planned for that day is recorded, never discarded.
    visit('2026-03-10', shops[0]);
    adherence = await okRep('reach/tour/adherence?from=2026-03-10&to=2026-03-10');
    expect(adherence.rows[0].status).toBe('PARTIAL');
    expect(adherence.rows[0].visited).toBe(1);

    // The whole month, as a manager reads it.
    const month = await ok(`reach/tour/adherence?from=2026-03-01&to=2026-03-31&rep=${repId}`);
    expect(month.rows).toHaveLength(31);
    expect(month.totals.FOLLOWED).toBe(1);
    expect(month.totals.LEAVE).toBe(1);
    expect(month.totals.HOLIDAY).toBe(1);
    expect(month.totals.WEEK_OFF).toBe(5);
    expect(month.score).toBeGreaterThan(0);

    // ---------- Boundaries ----------
    // A rep reads their own month and nobody else's.
    await rejectedRep(
      `reach/tour/plan?month=${MONTH}&rep=${otherRep}`,
      'GET',
      undefined,
      403,
      /only read your own tour plan/,
    );
    await rejectedRep(
      `reach/tour/adherence?from=2026-03-01&to=2026-03-31&rep=${otherRep}`,
      'GET',
      undefined,
      403,
      /only read your own tour plan/,
    );
    // The board is a manager's screen, and so is changing the numbers a month is judged by.
    expect((await asRep(`reach/tour/plans?month=${MONTH}`)).status()).toBe(403);
    await rejectedRep(
      'reach/tour/settings',
      'PUT',
      {
        plan_due_day: 1,
        plan_max_outlets: 1,
        plan_field_days_pct: 0,
        plan_followed_pct: 1,
        version: 0,
      },
      403,
      /do not have permission/,
    );
    // One request may ask for a year and no more.
    await rejectedRep(
      'reach/tour/adherence?from=2026-01-01&to=2027-06-30',
      'GET',
      undefined,
      400,
      /at most 366 days/,
    );
    // A login that is not a field rep has no month of its own, and is told so plainly.
    await rejected(
      `reach/tour/plan?month=${MONTH}`,
      'GET',
      undefined,
      403,
      /not linked to a field rep/,
    );
    // The settings are bounded, and a stale version is refused.
    await rejected(
      'reach/tour/settings',
      'PUT',
      {
        plan_due_day: 40,
        plan_max_outlets: 12,
        plan_field_days_pct: 75,
        plan_followed_pct: 60,
        version: settingsBefore.version,
      },
      400,
      /from 1 to 28/,
    );
    await rejected(
      'reach/tour/settings',
      'PUT',
      {
        plan_due_day: 25,
        plan_max_outlets: 12,
        plan_field_days_pct: 75,
        plan_followed_pct: 60,
        version: 9999,
      },
      409,
      /changed elsewhere/,
    );

    // ---------- The board, and the screens ----------
    const board = await ok(`reach/tour/plans?month=${MONTH}`);
    expect(board.rows.find((r: any) => r.rep === p + 'R')).toMatchObject({
      status: 'APPROVED',
      field_days: 25,
    });
    // The reps who owe a month and have not started one are the point of the screen.
    expect(board.missing.map((m: any) => m.rep)).toContain(p + 'Z');

    // Every screen opens on the month a rep would be filling in, so the test has to ask for the
    // month it built before it can read anything off them.
    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(page, 'Plans');
    await page.getByLabel('Month', { exact: true }).fill(MONTH);
    await expect(page.getByRole('cell', { name: new RegExp(p + 'R') }).first()).toBeVisible();
    await expect(page.getByRole('row', { name: new RegExp(p + 'R') })).toContainText('Approved');
    // The rep who owes a month and has not started one is on the same board.
    await expect(page.getByRole('row', { name: new RegExp(p + 'Z') })).toContainText('Not started');

    await openScreen(page, 'Tour plan settings');
    await expect(page.getByLabel('Followed at percent of the round')).toBeVisible();

    // The rep's own screens, in the rep's own session.
    await repPage.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(repPage, 'My plan');
    await expect(repPage.getByRole('heading', { name: 'Tour plan' })).toBeVisible();
    await repPage.getByLabel('Month', { exact: true }).fill(MONTH);
    await expect(repPage.getByText('Approved', { exact: true }).first()).toBeVisible();
    // The round the change request moved that Monday onto is what the month now shows.
    await expect(repPage.getByRole('row', { name: MONDAYS[3] })).toContainText(p + 'B2');

    await openScreen(repPage, 'Plan vs actual');
    await expect(repPage.getByRole('heading', { name: 'Plan vs actual' })).toBeVisible();
    await repPage.getByLabel('From', { exact: true }).fill(VISIT_DAY);
    await repPage.getByLabel('To', { exact: true }).fill(VISIT_DAY);
    // The milestone's own acceptance, read off the screen a manager would read it off.
    await expect(repPage.getByText('Followed', { exact: true }).first()).toBeVisible();
    await repPage.getByLabel('From', { exact: true }).fill(LEAVE_DAY);
    await repPage.getByLabel('To', { exact: true }).fill(LEAVE_DAY);
    await expect(repPage.getByText('Leave', { exact: true }).first()).toBeVisible();

    // ---------- One company sees nothing of another ----------
    sql(
      `INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','RCH3 isolation ${suffix}','RC3${suffix}')`,
    );
    expect(sql(`SELECT count(*) FROM tour_plans WHERE tenant_id='${otherCompany}'`)).toBe('0');
    for (const table of ['tour_plans', 'tour_plan_days', 'tour_plan_changes', 'visits']) {
      expect(
        sql(`SELECT relrowsecurity FROM pg_class WHERE relname='${table}'`),
        `${table} is not row-level scoped`,
      ).toBe('t');
    }
    // Nothing here may be deleted by the application role: a plan, a decision and a visit are
    // records of what was intended or what happened.
    for (const table of ['tour_plans', 'tour_plan_days', 'tour_plan_changes', 'visits']) {
      expect(
        sql(
          `SELECT count(*) FROM information_schema.role_table_grants
           WHERE grantee='rare_app' AND table_name='${table}' AND privilege_type='DELETE'`,
        ),
        `${table} grants DELETE to the application role`,
      ).toBe('0');
    }
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
    // version 0, and the next spec in the run expects to find it that way, so the row this test
    // created is taken away again rather than restored.
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
    tidy('remove plan records', () =>
      sql(`DELETE FROM tour_plan_changes WHERE rep_id IN (${reps});
           DELETE FROM tour_plan_days WHERE plan_id IN (SELECT id FROM tour_plans WHERE rep_id IN (${reps}));
           DELETE FROM tour_plans WHERE rep_id IN (${reps});
           DELETE FROM visits WHERE rep_id IN (${reps});
           DELETE FROM leave_requests WHERE rep_id IN (${reps});`),
    );
    tidy('remove customers', () =>
      sql(`DELETE FROM customer_geo_log WHERE tenant_id='${tenantId}' AND customer_id IN (SELECT id FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM beat_outlets WHERE tenant_id='${tenantId}' AND customer_id IN (SELECT id FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove field masters', () =>
      sql(`DELETE FROM beat_assignments WHERE tenant_id='${tenantId}' AND beat_id IN (SELECT id FROM beats WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM beats WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM shifts WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM leave_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM holidays WHERE tenant_id='${tenantId}' AND name='Tour plan day';
           DELETE FROM customer_form_rules WHERE tenant_id='${tenantId}' AND type_id IN (SELECT id FROM customer_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM customer_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM rep_grades WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM territories WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove import batches', () =>
      sql(`DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE tenant_id='${tenantId}' AND file_name='types.csv');
           DELETE FROM import_batches WHERE tenant_id='${tenantId}' AND file_name='types.csv';`),
    );
    tidy('remove other company', () => sql(`DELETE FROM tenants WHERE id='${otherCompany}'`));
  }
});
