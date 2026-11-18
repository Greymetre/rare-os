// RCH-2 Attendance and Leave. Its own acceptance is: a rep who punches at 09:45 reads as Late,
// one who ends at 13:00 reads as Half day, and on an approved leave day the punch is not asked
// about at all. Around that: the day board, leave and its balance, corrections, the payroll
// export, and the boundaries — a rep marks their own day and nobody else's, and what one company
// may see of another.
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

// A Wednesday, well in the past, so "today" can never drift onto it while the suite runs.
const WED = '2026-03-18';
const MON = '2026-03-16';
const SUN = '2026-03-15';

test('RCH-2 attendance and leave: the register, the day board, corrections and boundaries', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'A' + suffix,
    repUserId = randomUUID(),
    repEmail = `fieldrep.${suffix}@example.test`,
    otherCompany = randomUUID();
  let repRole = '',
    headRole = '',
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

    // ---------- The ground a register stands on ----------
    const territory = (
      await ok('masters/territories', 'POST', { code: p + 'T', name: 'Dry territory' })
    ).id;
    const grade = (
      await ok('masters/rep_grades', 'POST', { code: p + 'G', name: 'Officer', rank: 1 })
    ).id;
    // 09:30 start, ten minutes of grace, half a day under four hours, nothing under an hour.
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
    await ok('masters/work_types', 'POST', {
      code: p + 'W',
      name: 'Field working',
      needs_location: true,
      counts_present: true,
    });
    // An office day needs no location, which is what lets this test punch without a device fix.
    await ok('masters/work_types', 'POST', {
      code: p + 'O',
      name: 'Office day',
      needs_location: false,
      counts_present: true,
    });
    await ok('masters/leave_types', 'POST', {
      code: p + 'CL',
      name: 'Casual leave',
      paid: true,
      annual_quota: '12',
    });

    // The rep, and the login that is them. A login is always created holding a role, so the
    // rep's own role — the right to mark a day and nothing more — is made first.
    repRole = (
      await ok('roles', 'POST', {
        name: 'Field rep ' + suffix,
        permissions: ['dashboard.read', 'reach.attend'],
      })
    ).id;
    await ok('users', 'POST', {
      requestId: repUserId,
      name: 'Field Rep',
      email: repEmail,
      roleId: repRole,
    });
    const rep = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'R',
        name: 'Kiran Field',
        grade: p + 'G',
        territory: p + 'T',
        user: repEmail,
        shift: p + 'S',
      })
    ).id;

    // Applying for leave and asking for a correction are a rep's own acts, so the rep's session
    // is opened before the register work that depends on them.
    headRole = (
      await ok('roles', 'POST', {
        name: 'Field head ' + suffix,
        permissions: ['dashboard.read', 'reach.read', 'reach.attend', 'reach.leave'],
      })
    ).id;
    repIdentity = sql(`SELECT identity_id FROM app_users WHERE id='${repUserId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + repIdentity + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Reach-Rep-2026!', temporary: false },
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
    await repPage.locator('#password').fill('Reach-Rep-2026!');
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

    // ---------- The milestone's own acceptance ----------
    // Punches are written straight to the table so the clock can be exact; everything that reads
    // them goes through the API.
    const punch = (date: string, start: string, end: string | null) =>
      sql(
        `INSERT INTO attendance_days(id,tenant_id,rep_id,work_date,work_type_id,started_at,ended_at)
         SELECT gen_random_uuid(), r.tenant_id, r.id, '${date}',
                (SELECT id FROM work_types WHERE code='${p}O'),
                '${date} ${start}+05:30'::timestamptz,
                ${end ? `'${date} ${end}+05:30'::timestamptz` : 'NULL'}
         FROM field_reps r WHERE r.id='${rep}'`,
      );

    punch(WED, '09:45', '13:00');
    let register = await ok(`reach/attendance/register?from=${WED}&to=${WED}&rep=${rep}`);
    expect(register.rows[0].status).toBe('HALF_DAY');
    expect(register.rows[0].workedMinutes).toBe(195);
    // The shortfall decides the day, but the arrival is still reported.
    expect(register.rows[0].late).toBe(true);
    expect(register.paidDays).toBe(0.5);

    sql(`UPDATE attendance_days SET ended_at='${WED} 18:00+05:30'::timestamptz
         WHERE rep_id='${rep}' AND work_date='${WED}'`);
    register = await ok(`reach/attendance/register?from=${WED}&to=${WED}&rep=${rep}`);
    expect(register.rows[0].status).toBe('LATE');
    expect(register.paidDays).toBe(1);

    // ---------- Leave settles the day ----------
    const leaveTypeId = sql(`SELECT id FROM leave_types WHERE code='${p}CL'`);
    const leave = await okRep('reach/attendance/leave', 'POST', {
      leave_type_id: leaveTypeId,
      from_date: WED,
      to_date: WED,
      half_day: false,
      reason: 'Family',
    });
    // Asking twice for the same days is refused, whoever asks.
    await rejectedRep(
      'reach/attendance/leave',
      'POST',
      { leave_type_id: leaveTypeId, from_date: WED, to_date: WED, reason: 'again' },
      409,
      /already have leave/i,
    );

    register = await ok(`reach/attendance/register?from=${WED}&to=${WED}&rep=${rep}`);
    expect(register.rows[0].status, 'a request that is only pending changes nothing').toBe('LATE');

    await ok(`reach/attendance/leave/${leave.id}/decide`, 'POST', {
      status: 'APPROVED',
      reason: '',
      version: 1,
    });
    register = await ok(`reach/attendance/register?from=${WED}&to=${WED}&rep=${rep}`);
    expect(register.rows[0].status, 'approved leave settles the day, punch or no punch').toBe(
      'LEAVE',
    );
    expect(register.paidDays).toBe(1);

    // Refusing needs a reason; approving does not.
    await rejected(
      `reach/attendance/leave/${leave.id}/decide`,
      'POST',
      { status: 'REJECTED', reason: '', version: 2 },
      400,
      /reason/i,
    );
    // And a decision cannot be taken twice.
    await rejected(
      `reach/attendance/leave/${leave.id}/decide`,
      'POST',
      { status: 'APPROVED', reason: '', version: 2 },
      409,
      /already decided|changed elsewhere/i,
    );

    // ---------- Holidays and week-offs ----------
    await ok('masters/holidays', 'POST', {
      holiday_date: WED,
      name: 'Dry Run Day',
      holiday_type: 'NATIONAL',
    });
    register = await ok(`reach/attendance/register?from=${WED}&to=${WED}&rep=${rep}`);
    expect(register.rows[0].status, 'a holiday outranks approved leave').toBe('HOLIDAY');

    register = await ok(`reach/attendance/register?from=${SUN}&to=${SUN}&rep=${rep}`);
    expect(register.rows[0].status, 'Sunday is a week off, not an absence').toBe('WEEK_OFF');

    // ---------- A day that was started and never ended ----------
    punch(MON, '09:00', null);
    register = await ok(`reach/attendance/register?from=${MON}&to=${MON}&rep=${rep}`);
    expect(register.rows[0].status).toBe('OPEN');
    expect(register.open).toEqual([MON]);

    // ---------- Corrections ----------
    const fix = await okRep('reach/attendance/corrections', 'POST', {
      work_date: MON,
      start_time: '09:00',
      end_time: '18:00',
      reason: 'Phone battery died',
    });
    await rejectedRep(
      'reach/attendance/corrections',
      'POST',
      { work_date: MON, start_time: '10:00', reason: 'again' },
      409,
      /already waiting/i,
    );
    // A day that has not happened cannot be corrected.
    await rejectedRep(
      'reach/attendance/corrections',
      'POST',
      { work_date: '2099-01-01', start_time: '09:00', reason: 'time travel' },
      400,
      /future/i,
    );
    const queued = await ok('reach/attendance/corrections?status=PENDING');
    const mine = queued.items.find((c: any) => c.id === fix.id);
    expect([mine.previous_start, mine.requested_start, mine.requested_end]).toEqual([
      '09:00',
      '09:00',
      '18:00',
    ]);

    await ok(`reach/attendance/corrections/${fix.id}/decide`, 'POST', {
      status: 'APPROVED',
      reason: '',
    });
    register = await ok(`reach/attendance/register?from=${MON}&to=${MON}&rep=${rep}`);
    expect(register.rows[0].status, 'the corrected day now settles').toBe('PRESENT');
    expect(register.rows[0].workedMinutes).toBe(540);

    // ---------- The day board ----------
    const board = await ok(`reach/attendance/board?date=${WED}`);
    const onBoard = board.rows.find((r: any) => r.code === p + 'R');
    expect(onBoard.status).toBe('HOLIDAY');
    expect(onBoard.remind, 'nobody is chased on a holiday').toBe(false);

    // ---------- Payroll ----------
    const csv = await call(`reach/attendance/payroll.csv?from=${MON}&to=${WED}`);
    expect(csv.headers()['content-type']).toMatch(/text\/csv/);
    expect(csv.headers()['x-content-type-options']).toBe('nosniff');
    expect(csv.headers()['content-disposition']).toMatch(/attachment/);
    const lines = (await csv.text()).trim().split('\r\n');
    expect(lines[0]).toBe(
      'code,name,days,present,late,half_day,leave,absent,week_off,holiday,open,paid_days',
    );
    const row = lines.find((l) => l.startsWith(p + 'R'));
    // Mon present, Tue absent, Wed holiday: the same three days the register showed.
    expect(row).toMatch(new RegExp(`^${p}R,Kiran Field,3,1,0,0,0,1,0,1,0,1$`));

    // A span wider than a year is refused rather than silently truncated.
    await rejected(
      'reach/attendance/register?from=2020-01-01&to=2026-01-01',
      'GET',
      undefined,
      400,
      /at most/i,
    );
    await rejected(
      'reach/attendance/register?from=2026-03-20&to=2026-03-10',
      'GET',
      undefined,
      400,
      /cannot be before/i,
    );
    await rejected(
      'reach/attendance/register?from=not-a-date&to=2026-03-10',
      'GET',
      undefined,
      400,
      /YYYY-MM-DD/,
    );

    // ---------- Validation at the edge ----------
    await rejected(
      'reach/attendance/start',
      'POST',
      { work_type_id: randomUUID(), latitude: 999, longitude: 0 },
      400,
      /Latitude/,
    );
    await rejected(
      'reach/attendance/start',
      'POST',
      { work_type_id: randomUUID(), source: 'GUESS' },
      400,
      /source/i,
    );
    await rejected(
      'reach/attendance/corrections',
      'POST',
      { work_date: MON, start_time: '9am', reason: 'x' },
      400,
      /HH:MM/,
    );
    await rejected(
      'reach/attendance/corrections',
      'POST',
      { work_date: MON, reason: 'nothing asked for' },
      400,
      /start time, an end time, or both/,
    );

    // ---------- Settings ----------
    await rejected(
      'reach/attendance/settings',
      'PUT',
      {
        attendance_fence_m: 5,
        absent_after_minutes: 120,
        selfie_required: true,
        timezone: 'Asia/Kolkata',
        version: settingsBefore.version,
      },
      400,
      /whole number from 10/,
    );
    await rejected(
      'reach/attendance/settings',
      'PUT',
      {
        attendance_fence_m: 200,
        absent_after_minutes: 120,
        selfie_required: true,
        timezone: 'Mars/Olympus',
        version: settingsBefore.version,
      },
      400,
      /valid timezone/,
    );
    // Saving the attendance settings must not blank the customer ones beside them in the row.
    const beforeSave = (await ok('reach/settings')).settings;
    await ok('reach/attendance/settings', 'PUT', {
      attendance_fence_m: 350,
      absent_after_minutes: 90,
      selfie_required: false,
      timezone: 'Asia/Kolkata',
      version: beforeSave.version,
    });
    const afterSave = (await ok('reach/settings')).settings;
    expect(afterSave.attendance_fence_m).toBe(350);
    expect(
      [afterSave.gps_verified_m, afterSave.retag_approval_m, afterSave.duplicate_within_m],
      'the customer settings survived an attendance save',
    ).toEqual([
      beforeSave.gps_verified_m,
      beforeSave.retag_approval_m,
      beforeSave.duplicate_within_m,
    ]);

    // ---------- A rep marks their own day, and nobody else's ----------
    // The rep starts their own day through the real route. The office work type needs no fix.
    const officeType = sql(`SELECT id FROM work_types WHERE code='${p}O'`);
    const started = await asRep('reach/attendance/start', 'POST', {
      work_type_id: officeType,
      source: 'TYPED',
    });
    expect(started.status(), await started.text()).toBe(201);
    // Starting twice is refused.
    const again = await asRep('reach/attendance/start', 'POST', {
      work_type_id: officeType,
      source: 'TYPED',
    });
    expect(again.status()).toBe(409);

    const myDay = await (await asRep('reach/attendance/my-day')).json();
    expect(myDay.rep.code).toBe(p + 'R');
    expect(myDay.day.end_time).toBe(null);
    const ended = await asRep('reach/attendance/end', 'POST', {
      source: 'TYPED',
      version: myDay.day.version,
    });
    expect(ended.status(), await ended.text()).toBe(201);
    expect(
      (
        await asRep('reach/attendance/end', 'POST', { source: 'TYPED', version: myDay.day.version })
      ).status(),
    ).toBe(409);

    // Without reach.read a rep may read their own register, and nothing of anyone else's.
    expect((await asRep(`reach/attendance/register?from=${MON}&to=${WED}`)).status()).toBe(200);
    expect(
      (await asRep(`reach/attendance/register?from=${MON}&to=${WED}&rep=${rep}`)).status(),
      'the rep asking for their own id by hand is still themselves',
    ).toBe(200);
    // The day board is everyone's, so it needs reach.read.
    expect((await asRep('reach/attendance/board')).status()).toBe(403);
    // Deciding is not something a rep does.
    expect(
      (
        await asRep(`reach/attendance/leave/${leave.id}/decide`, 'POST', {
          status: 'APPROVED',
          reason: '',
          version: 3,
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await asRep(`reach/attendance/corrections/${fix.id}/decide`, 'POST', {
          status: 'APPROVED',
          reason: '',
        })
      ).status(),
    ).toBe(403);
    expect(
      (await asRep('reach/attendance/payroll.csv?from=2026-03-01&to=2026-03-31')).status(),
    ).toBe(403);
    expect(
      (
        await asRep('reach/attendance/settings', 'PUT', {
          attendance_fence_m: 400,
          absent_after_minutes: 90,
          selfie_required: false,
          timezone: 'Asia/Kolkata',
          version: 99,
        })
      ).status(),
    ).toBe(403);

    // A request sent without the CSRF token is refused however good the session is.
    const forged = await repPage.request.fetch('/api/reach/attendance/start', {
      method: 'POST',
      headers: { Origin: env.APP_URL },
      data: { work_type_id: officeType, source: 'TYPED' },
    });
    expect(forged.status()).toBe(403);

    // ---------- The screens ----------
    await repPage.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(repPage, 'My day');
    await expect(repPage.getByRole('heading', { name: 'My day' })).toBeVisible();
    await expect(repPage.getByText('Your day is finished. Thank you.')).toBeVisible();
    // A rep without reach.read is not offered the day board at all.
    await expect(repPage.getByRole('button', { name: 'Today', exact: true })).toHaveCount(0);

    await openScreen(repPage, 'Register');
    await expect(repPage.getByRole('heading', { name: 'Register' })).toBeVisible();
    // Payroll is a manager's export, so a rep is not offered it.
    await expect(repPage.getByRole('link', { name: 'Payroll CSV' })).toHaveCount(0);

    // The admin, who may read everything, sees the board and the whole register.
    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(page, 'Today');
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect(page.getByRole('cell', { name: new RegExp(p + 'R') })).toBeVisible();

    // ---------- One company sees nothing of another ----------
    sql(
      `INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','RCH2 isolation ${suffix}','RC2${suffix}')`,
    );
    const hiddenRows = sql(
      `SELECT count(*) FROM attendance_days WHERE tenant_id='${otherCompany}'`,
    );
    expect(hiddenRows).toBe('0');
    // Every attendance table is row-level scoped, so a company id that is not the caller's can
    // never be read through the application role.
    for (const table of [
      'attendance_days',
      'leave_requests',
      'attendance_edits',
      'shifts',
      'work_types',
    ]) {
      expect(
        sql(`SELECT relrowsecurity FROM pg_class WHERE relname='${table}'`),
        `${table} is not row-level scoped`,
      ).toBe('t');
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
    else if (settingsBefore)
      await call('reach/attendance/settings', 'PUT', {
        attendance_fence_m: settingsBefore.attendance_fence_m,
        absent_after_minutes: settingsBefore.absent_after_minutes,
        selfie_required: settingsBefore.selfie_required,
        timezone: settingsBefore.timezone,
        version: (await (await call('reach/settings')).json()).settings.version,
      }).catch(() => {});
    if (repIdentity)
      await request
        .delete(env.AUTH_URL + '/admin/realms/rare-os/users/' + repIdentity, { headers: kcHeaders })
        .catch(() => {});
    // The rep points at the login, and the login's role cannot be blanked, so the link goes
    // first, then the login, then the roles nothing holds any more.
    tidy('unlink rep', () =>
      sql(`UPDATE field_reps SET user_id=NULL WHERE user_id='${repUserId}'`),
    );
    tidy('remove login', () =>
      sql(`DELETE FROM user_sites WHERE user_id='${repUserId}';
           DELETE FROM app_users WHERE id='${repUserId}';`),
    );
    for (const role of [repRole, headRole].filter(Boolean))
      tidy('remove role', () =>
        sql(
          `DELETE FROM role_permissions WHERE role_id='${role}'; DELETE FROM roles WHERE id='${role}';`,
        ),
      );
    // Everything this spec set up, in the order the foreign keys allow. Left behind, these
    // masters make the readiness checklist other milestones assert on read as already set up.
    tidy('remove attendance records', () =>
      sql(`DELETE FROM attendance_edits WHERE rep_id IN (SELECT id FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM leave_requests WHERE rep_id IN (SELECT id FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM attendance_days WHERE rep_id IN (SELECT id FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');`),
    );
    tidy('remove field masters', () =>
      sql(`DELETE FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM shifts WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM work_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM leave_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM holidays WHERE tenant_id='${tenantId}' AND name='Dry Run Day';
           DELETE FROM rep_grades WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM territories WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove other company', () => sql(`DELETE FROM tenants WHERE id='${otherCompany}'`));
  }
});
