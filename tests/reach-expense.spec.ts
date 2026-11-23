// RCH-6 Expenses. Its own acceptance is three sentences from the milestone plan: a day on leave
// earns no daily allowance; a line over the limit is capped rather than refused; and one person
// cannot approve a claim as both its manager and finance.
//
// Around that: the rule the whole module rests on — a policy version may only start in the
// future and is frozen once it has — the town coming from the tour plan rather than from what a
// rep typed, the receipt that blocks a claim instead of zeroing a line, the payout file, and the
// boundaries: a rep reads their own claims and nobody else's, and what one company sees of
// another.
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

test('RCH-6 expenses: the policy version, the leave day, the cap, the two desks and the boundaries', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'X' + suffix,
    repUserId = randomUUID(),
    financeUserId = randomUUID(),
    repEmail = `exprep.${suffix}@example.test`,
    financeEmail = `expfin.${suffix}@example.test`,
    otherCompany = randomUUID();
  let repRole = '',
    financeRole = '',
    tenantId = '',
    repIdentity = '',
    financeIdentity = '',
    repContext: any,
    financeContext: any,
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

  const call = (path: string, method = 'GET', data?: unknown) =>
    withRateLimitRetry(() =>
      page.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
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

  // A login the spec creates, signed in, with its own request helper.
  async function signIn(email: string, password: string) {
    const context = await browser.newContext();
    const session = await context.newPage();
    await session.goto('/');
    await session.getByRole('link', { name: /sign in securely/i }).click();
    await session.locator('#username').fill(email);
    await session.locator('#password').fill(password);
    await session.locator('#kc-login').click();
    await completeTestMfa(session, email);
    await expect(session.locator('.main > header')).toBeVisible();
    const who = await (await session.request.get('/api/me')).json();
    const as = (path: string, method = 'GET', data?: unknown) =>
      withRateLimitRetry(() =>
        session.request.fetch('/api/' + path, {
          method,
          headers: { Origin: env.APP_URL, 'X-CSRF-Token': who.csrfToken },
          data,
        }),
      );
    return { context, session, as };
  }

  async function makeLogin(userId: string, name: string, email: string, roleId: string) {
    await ok('users', 'POST', { requestId: userId, name, email, roleId });
    const identity = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + identity + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Reach-Expense-2026!', temporary: false },
          },
        )
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.put(env.AUTH_URL + '/admin/realms/rare-os/users/' + identity, {
          headers: kcHeaders,
          data: { emailVerified: true, requiredActions: [] },
        })
      ).ok(),
    ).toBe(true);
    return identity;
  }

  try {
    settingsBefore = (await ok('reach/settings')).settings;
    tenantId = me.user.tenant_id;
    expect(tenantId, 'the signed-in company is needed to clean up safely').toMatch(
      /^[0-9a-f-]{36}$/,
    );
    const today = (await ok('reach/expense/setup')).today;

    // ---------- The ground a claim stands on ----------
    await ok('masters/territories', 'POST', { code: p + 'T', name: 'Expense territory' });
    await ok('masters/rep_grades', 'POST', { code: p + 'E1', name: 'Senior', rank: 1 });
    await ok('masters/work_types', 'POST', {
      code: p + 'F',
      name: 'Field working',
      needs_location: false,
      counts_present: true,
    });
    await ok('masters/leave_types', 'POST', {
      code: p + 'CL',
      name: 'Casual leave',
      paid: true,
      annual_quota: '12',
      carry_forward: false,
      requires_approval: true,
    });
    // The rep is based at Rohtak. That is what makes a day at Hisar a day out of headquarters.
    const repId = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'R',
        name: 'Kiran Road',
        grade: p + 'E1',
        territory: p + 'T',
        hq_town: 'Rohtak',
      })
    ).id;

    // The client's own categories and numbers, from question 9 of the milestone plan.
    const cats: Record<string, string> = {};
    for (const [code, name, basis, receipt] of [
      [p + 'KM', 'Travel by road', 'KM', ''],
      [p + 'DA', 'Daily allowance', 'DAILY', ''],
      // Lodging asks for no receipt here, so the cap can be read on its own. The receipt rule
      // is shown on the phone bill below, where it is the only thing happening to the line.
      [p + 'STAY', 'Lodging', 'NIGHTLY', ''],
      [p + 'PHONE', 'Phone bill', 'ACTUAL', '200'],
    ] as const)
      cats[basis] = (
        await ok('masters/expense_categories', 'POST', {
          code,
          name,
          basis,
          receipt_above: receipt,
        })
      ).id;

    // ---------- The rule the module rests on ----------
    // A version cannot start today, nor any earlier day: it would already be governing claims.
    await rejected(
      'reach/expense/policies',
      'POST',
      { code: p + 'P0', name: 'Today', effective_from: today },
      400,
      /has to start after today/,
    );

    // A version is created to start tomorrow, its rates typed, and then its start date is moved
    // back into the past directly in the database — the only way to have a version in force
    // during a test that cannot wait a day. Everything after this reads it as frozen.
    const policyId = (
      await ok('reach/expense/policies', 'POST', {
        code: p + 'P1',
        name: 'Road policy',
        effective_from: new Date(Date.parse(today + 'T00:00:00Z') + 86400000)
          .toISOString()
          .slice(0, 10),
      })
    ).id;
    await ok(`reach/expense/policies/${policyId}/rates`, 'PUT', {
      rates: [
        { category_id: cats.KM, key: 'BIKE', rate: '3.5000' },
        { category_id: cats.KM, key: 'CAR', rate: '9.0000' },
        { category_id: cats.DAILY, key: 'HQ', rate: '250.00' },
        { category_id: cats.DAILY, key: 'EX_HQ', rate: '400.00' },
        { category_id: cats.DAILY, key: 'OUTSTATION', rate: '600.00' },
        { category_id: cats.NIGHTLY, key: p + 'E1', rate: '2500.00', cap: '2500.00' },
        { category_id: cats.ACTUAL, key: '', cap: '500.00', period_cap: '500.00' },
      ],
    });
    // A rate row that sets neither a rate nor a limit says nothing at all.
    await rejected(
      `reach/expense/policies/${policyId}/rates`,
      'PUT',
      { rates: [{ category_id: cats.KM, key: 'BUS' }] },
      400,
      /has to set a rate, a limit/,
    );
    sql(`UPDATE expense_policies SET effective_from='2026-01-01' WHERE id='${policyId}'`);

    // Now it is in force, and the module refuses to let anybody touch it.
    const frozen = await ok(`reach/expense/policies/${policyId}`);
    expect(frozen.open).toBe(false);
    await rejected(
      `reach/expense/policies/${policyId}/rates`,
      'PUT',
      { rates: [{ category_id: cats.KM, key: 'BIKE', rate: '99' }] },
      409,
      /cannot be changed/,
    );
    await rejected(
      `reach/expense/policies/${policyId}`,
      'PUT',
      {
        name: 'Renamed',
        effective_from: '2026-01-01',
        active: true,
        version: frozen.version,
      },
      409,
      /cannot be changed/,
    );
    // A new version is how a rate changes, and it starts from the old one's numbers.
    const nextPolicy = await ok('reach/expense/policies', 'POST', {
      code: p + 'P2',
      name: 'From next month',
      effective_from: '2027-06-01',
      copy_from: policyId,
    });
    expect(nextPolicy.copied).toBe(7);
    // Two versions cannot begin on the same day: no date would have one answer.
    await rejected(
      'reach/expense/policies',
      'POST',
      { code: p + 'P3', name: 'Clash', effective_from: '2027-06-01' },
      409,
      /already a policy version/,
    );

    // ---------- Two logins: the rep, and finance ----------
    repRole = (
      await ok('roles', 'POST', {
        name: 'Expense rep ' + suffix,
        permissions: ['dashboard.read', 'reach.expense'],
      })
    ).id;
    financeRole = (
      await ok('roles', 'POST', {
        name: 'Expense finance ' + suffix,
        permissions: ['dashboard.read', 'reach.read', 'reach.expense_finance'],
      })
    ).id;
    repIdentity = await makeLogin(repUserId, 'Expense Rep', repEmail, repRole);
    financeIdentity = await makeLogin(financeUserId, 'Expense Finance', financeEmail, financeRole);
    sql(`UPDATE field_reps SET user_id='${repUserId}' WHERE id='${repId}'`);

    const repLogin = await signIn(repEmail, 'Reach-Expense-2026!');
    repContext = repLogin.context;
    const asRep = repLogin.as;
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

    // ---------- The days behind the claim ----------
    // Three dates in the current claim period: one worked out of headquarters, one on approved
    // leave, one worked at headquarters.
    const period = (await okRep('reach/expense/my-claim')).period;
    const day = (offset: number) =>
      new Date(Date.parse(period.from + 'T00:00:00Z') + offset * 86400000)
        .toISOString()
        .slice(0, 10);
    const away = day(0),
      onLeave = day(1),
      atHome = day(2);

    const workType = sql(
      `SELECT id FROM work_types WHERE tenant_id='${tenantId}' AND code='${p}F'`,
    );
    for (const date of [away, atHome])
      sql(
        `INSERT INTO attendance_days(id,tenant_id,rep_id,work_date,work_type_id,started_at,ended_at)
         VALUES('${randomUUID()}','${tenantId}','${repId}','${date}','${workType}',
                ('${date}'::date + time '09:30') AT TIME ZONE 'Asia/Kolkata',
                ('${date}'::date + time '18:00') AT TIME ZONE 'Asia/Kolkata')`,
      );
    const leaveType = sql(
      `SELECT id FROM leave_types WHERE tenant_id='${tenantId}' AND code='${p}CL'`,
    );
    sql(
      `INSERT INTO leave_requests(id,tenant_id,rep_id,leave_type_id,from_date,to_date,reason,status,decided_at)
       VALUES('${randomUUID()}','${tenantId}','${repId}','${leaveType}','${onLeave}','${onLeave}','Family','APPROVED',now())`,
    );

    // The tour plan sent the rep to Hisar on the first day and kept them at Rohtak on the third.
    await ok('masters/beats', 'POST', {
      code: p + 'B1',
      name: 'Hisar round',
      territory: p + 'T',
      run_days: 'MON,TUE,WED,THU,FRI,SAT,SUN',
    });
    const planId = randomUUID();
    sql(
      `INSERT INTO tour_plans(id,tenant_id,rep_id,plan_month,status,submitted_at,decided_at)
       VALUES('${planId}','${tenantId}','${repId}','${period.from.slice(0, 7)}-01','APPROVED',now(),now())`,
    );
    const beatId = sql(`SELECT id FROM beats WHERE tenant_id='${tenantId}' AND code='${p}B1'`);
    for (const [date, town] of [
      [away, 'Hisar'],
      [onLeave, 'Hisar'],
      [atHome, 'Rohtak'],
    ])
      sql(
        `INSERT INTO tour_plan_days(tenant_id,plan_id,work_date,beat_id,town,outlet_count)
         VALUES('${tenantId}','${planId}','${date}','${beatId}','${town}',6)`,
      );

    // ---------- The milestone acceptance ----------
    const line = (input: Record<string, unknown>) =>
      okRep('reach/expense/my-claim/lines', 'POST', input);

    const dayOut = await line({
      category_id: cats.DAILY,
      spend_date: away,
      claimed_amount: 400,
      town: 'Hisar',
    });
    expect(dayOut.allowed).toBe(400);
    expect(dayOut.reasons).toEqual([]);

    // The first acceptance case: a day the register says the rep was not at work earns nothing.
    const leaveLine = await line({
      category_id: cats.DAILY,
      spend_date: onLeave,
      claimed_amount: 400,
      town: 'Hisar',
    });
    expect(leaveLine.allowed).toBe(0);
    expect(leaveLine.reasons).toEqual(['NOT_AT_WORK']);

    // The town comes from the plan, not from what the rep typed: a day the plan kept at
    // headquarters earns the headquarters rate however far away the claim says it was.
    const gamed = await line({
      category_id: cats.DAILY,
      spend_date: atHome,
      claimed_amount: 400,
      town: 'Hisar',
    });
    expect(gamed.allowed).toBe(250);

    // The second acceptance case: over the limit is capped, with both numbers kept.
    const stay = await line({
      category_id: cats.NIGHTLY,
      spend_date: away,
      nights: 2,
      claimed_amount: 6000,
    });
    expect(stay.allowed).toBe(2500);
    expect(stay.reasons).toEqual(['CAPPED']);

    const road = await line({
      category_id: cats.KM,
      spend_date: away,
      km: 42,
      vehicle: 'BIKE',
      claimed_amount: 147,
    });
    expect(road.allowed).toBe(147);

    // An expense cannot be dated in the future, and a category nobody set a rate for is not nought.
    const tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000)
      .toISOString()
      .slice(0, 10);
    await rejectedRep(
      'reach/expense/my-claim/lines',
      'POST',
      { category_id: cats.DAILY, spend_date: tomorrow, claimed_amount: 100 },
      400,
      /future/,
    );
    const noRate = await line({
      category_id: cats.KM,
      spend_date: away,
      km: 10,
      vehicle: 'OTHER',
      claimed_amount: 90,
    });
    expect(noRate.allowed).toBe(0);
    expect(noRate.reasons).toEqual(['NO_RATE']);

    // ---------- The receipt blocks, it does not zero ----------
    const phone = await line({
      category_id: cats.ACTUAL,
      spend_date: away,
      claimed_amount: 320,
    });
    expect(phone.reasons).toEqual(['RECEIPT_MISSING']);
    // The money is still there. A real expense is not hidden behind a missing piece of paper.
    expect(phone.allowed).toBe(320);

    let mine = await okRep('reach/expense/my-claim');
    expect(mine.priced.blocked).toBe(1);
    await rejectedRep(
      'reach/expense/my-claim/submit',
      'POST',
      { claim_id: mine.claim.id, version: mine.claim.version },
      409,
      /needs a receipt/,
    );

    // The line is corrected rather than argued with: below the limit, no receipt is asked for.
    const phoneLine = mine.priced.lines.find((l: any) => l.id === phone.id);
    await okRep(`reach/expense/lines/${phone.id}`, 'PATCH', {
      category_id: cats.ACTUAL,
      spend_date: away,
      claimed_amount: 180,
      version: phoneLine.version,
    });

    // A line typed by mistake comes off, and its record is kept.
    mine = await okRep('reach/expense/my-claim');
    const strayLine = mine.priced.lines.find((l: any) => l.id === noRate.id);
    await okRep(`reach/expense/lines/${noRate.id}/remove`, 'PATCH', {
      reason: 'Wrong vehicle',
      version: strayLine.version,
    });
    expect(sql(`SELECT deleted_reason FROM expense_lines WHERE id='${noRate.id}'`)).toBe(
      'Wrong vehicle',
    );

    mine = await okRep('reach/expense/my-claim');
    expect(mine.priced.blocked).toBe(0);
    // Asked for: 400 away + 400 on leave + 400 at home + 6000 lodging + 147 road + 180 phone.
    expect(mine.priced.claimed).toBe(7527);
    // Allowed: 400 away + 0 on leave (the register) + 250 at home (the plan) + 2500 lodging
    // (capped) + 147 road + 180 phone.
    expect(mine.priced.allowed).toBe(3477);
    expect(mine.priced.disallowed).toBe(4050);

    // ---------- The two desks ----------
    await okRep('reach/expense/my-claim/submit', 'POST', {
      claim_id: mine.claim.id,
      version: mine.claim.version,
    });
    const claimId = mine.claim.id;
    let claim = await ok(`reach/expense/claims/${claimId}`);
    expect(claim.status).toBe('SUBMITTED');
    // A claim that has gone in cannot be added to.
    await rejectedRep(
      'reach/expense/my-claim/lines',
      'POST',
      { category_id: cats.DAILY, spend_date: away, claimed_amount: 10 },
      409,
      /already been sent in/,
    );

    // Finance cannot reach a claim a manager has not passed.
    const financeLogin = await signIn(financeEmail, 'Reach-Expense-2026!');
    financeContext = financeLogin.context;
    const asFinance = financeLogin.as;
    const early = await asFinance(`reach/expense/claims/${claimId}/decide`, 'POST', {
      stage: 'FINANCE',
      approve: true,
      version: claim.version,
    });
    expect(early.status()).toBe(409);
    expect((await early.json()).error.message).toMatch(/manager has to pass/);

    // The admin passes it as its manager.
    await ok(`reach/expense/claims/${claimId}/decide`, 'POST', {
      stage: 'MANAGER',
      approve: true,
      note: 'Seen',
      version: claim.version,
    });
    claim = await ok(`reach/expense/claims/${claimId}`);
    expect(claim.status).toBe('MANAGER_OK');

    // The third acceptance case: the same person cannot now approve it as finance.
    await rejected(
      `reach/expense/claims/${claimId}/decide`,
      'POST',
      { stage: 'FINANCE', approve: true, version: claim.version },
      409,
      /somebody else has to approve it/,
    );
    // The screen is told the same thing, so it never offers the button.
    expect(claim.stages.find((s: any) => s.stage === 'FINANCE').allowed).toBe(false);

    // Somebody else approves it, and sending it back needs a reason.
    const noReason = await asFinance(`reach/expense/claims/${claimId}/decide`, 'POST', {
      stage: 'FINANCE',
      approve: false,
      reason: '',
      version: claim.version,
    });
    expect(noReason.status()).toBe(400);
    const approved = await asFinance(`reach/expense/claims/${claimId}/decide`, 'POST', {
      stage: 'FINANCE',
      approve: true,
      note: 'Paid with October',
      version: claim.version,
    });
    expect(approved.ok(), JSON.stringify(await approved.json())).toBe(true);
    claim = await ok(`reach/expense/claims/${claimId}`);
    expect(claim.status).toBe('APPROVED');
    // The approved amount is read again from the policy and has not moved.
    expect(claim.priced.allowed).toBe(3477);

    // ---------- The register and the payout ----------
    const register = await ok(
      `reach/expense/register?from=${period.from}&to=${period.to}&rep=${repId}`,
    );
    expect(register.totals.claims).toBe(1);
    expect(register.rows[0].allowed).toBe(3477);

    const csvResponse = await call(`reach/expense/payout.csv?from=${period.from}&to=${period.to}`);
    expect(csvResponse.headers()['x-content-type-options']).toBe('nosniff');
    expect(csvResponse.headers()['content-disposition']).toMatch(/attachment/);
    const csv = await csvResponse.text();
    expect(csv.split('\r\n')[0].split(',')).toEqual(
      expect.arrayContaining(['rep', 'period_from', 'claimed', 'allowed', 'manager', 'finance']),
    );
    expect(csv).toContain(p + 'R');
    expect(csv).toContain('3477');

    // ---------- Boundaries ----------
    // A rep reads their own claims and nobody else's.
    await rejectedRep(
      `reach/expense/claims?from=${period.from}&to=${period.to}&rep=${randomUUID()}`,
      'GET',
      undefined,
      403,
      /only read your own claims/,
    );
    const own = await okRep(`reach/expense/claims?from=${period.from}&to=${period.to}`);
    expect(own.items.every((c: any) => c.rep === p + 'R')).toBe(true);
    expect(own.canPass).toBe(false);
    expect(own.canApprove).toBe(false);
    // Nor may a rep decide anything, nor read the register, nor touch the policy.
    await rejectedRep(
      `reach/expense/claims/${claimId}/decide`,
      'POST',
      { stage: 'MANAGER', approve: true, version: claim.version },
      403,
      /permission|not allowed|forbidden/i,
    );
    expect(
      (await asRep(`reach/expense/register?from=${period.from}&to=${period.to}`)).status(),
    ).toBe(403);
    expect((await asRep('reach/expense/setup')).status()).toBe(403);
    expect((await asRep('masters/expense_categories')).status()).toBe(403);
    // Unknown fields are refused outright rather than dropped.
    await rejectedRep(
      'reach/expense/my-claim/lines',
      'POST',
      { category_id: cats.DAILY, spend_date: away, claimed_amount: 10, rep_id: repId },
      400,
      /Unsupported field/,
    );
    // A window wider than a year is refused rather than served slowly.
    await rejected(
      `reach/expense/claims?from=2020-01-01&to=${today}`,
      'GET',
      undefined,
      400,
      /at most 366 days/,
    );

    // ---------- The screens ----------
    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(page, 'Expense policy');
    await expect(page.getByRole('heading', { name: 'Expense policy' })).toBeVisible();
    // Exact: the row's own cell, not the actions cell whose button is labelled "Open policy …".
    await expect(page.getByRole('cell', { name: p + 'P1', exact: true })).toBeVisible();
    await expect(page.getByText('In force · frozen')).toBeVisible();

    await openScreen(page, 'Expense register');
    await expect(page.getByRole('heading', { name: 'Expense register' })).toBeVisible();
    await page.getByLabel('From', { exact: true }).fill(period.from);
    await page.getByLabel('To', { exact: true }).fill(period.to);
    await expect(page.getByRole('cell', { name: new RegExp(p + 'R') }).first()).toBeVisible();

    await openScreen(page, 'Expense claims');
    await expect(page.getByRole('heading', { name: 'Expense claims' })).toBeVisible();

    // The rep's own screen, in the rep's own session.
    await repLogin.session.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(repLogin.session, 'My expenses');
    await expect(repLogin.session.getByRole('heading', { name: 'My expenses' })).toBeVisible();
    await expect(repLogin.session.getByText('Policy allows')).toBeVisible();
    // The register and the claims queue are not this rep's to see, so they are not in the menu.
    await expect(repLogin.session.getByRole('button', { name: 'Expense register' })).toHaveCount(0);
    await expect(repLogin.session.getByRole('button', { name: 'Expense claims' })).toHaveCount(0);

    // ---------- One company sees nothing of another ----------
    sql(
      `INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','RCH6 isolation ${suffix}','RC6${suffix}')`,
    );
    for (const table of [
      'expense_categories',
      'expense_policies',
      'expense_policy_rates',
      'expense_claims',
      'expense_lines',
    ]) {
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
      expect(sql(`SELECT count(*) FROM ${table} WHERE tenant_id='${otherCompany}'`)).toBe('0');
    }
    // The table itself refuses one person at both desks, whatever the controller does.
    expect(
      sql(`SELECT count(*) FROM pg_constraint WHERE conrelid='expense_claims'::regclass
           AND contype='c' AND pg_get_constraintdef(oid) LIKE '%manager_by <> finance_by%'`),
    ).toBe('1');
    // And two versions cannot begin on the same day.
    expect(
      sql(`SELECT indisunique FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
           WHERE c.relname='expense_policies_from_idx'`),
    ).toBe('t');
  } finally {
    const tidy = (what: string, run: () => void) => {
      try {
        run();
      } catch (e: any) {
        console.warn(`cleanup (${what}) did not finish: ${e.message}`);
      }
    };
    await repContext?.close().catch(() => {});
    await financeContext?.close().catch(() => {});
    if (settingsBefore && settingsBefore.version === 0)
      tidy('drop settings row', () =>
        sql(`DELETE FROM reach_settings WHERE tenant_id='${tenantId}'`),
      );
    for (const identity of [repIdentity, financeIdentity])
      if (identity)
        await request
          .delete(env.AUTH_URL + '/admin/realms/rare-os/users/' + identity, { headers: kcHeaders })
          .catch(() => {});
    tidy('unlink rep', () =>
      sql(`UPDATE field_reps SET user_id=NULL WHERE user_id='${repUserId}'`),
    );
    tidy('remove logins', () =>
      sql(`DELETE FROM user_sites WHERE user_id IN ('${repUserId}','${financeUserId}');
           DELETE FROM app_users WHERE id IN ('${repUserId}','${financeUserId}');`),
    );
    for (const role of [repRole, financeRole])
      if (role)
        tidy('remove role', () =>
          sql(
            `DELETE FROM role_permissions WHERE role_id='${role}'; DELETE FROM roles WHERE id='${role}';`,
          ),
        );
    const reps = `SELECT id FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%'`;
    tidy('remove the claims', () =>
      sql(`DELETE FROM expense_lines WHERE claim_id IN (SELECT id FROM expense_claims WHERE rep_id IN (${reps}));
           DELETE FROM expense_claims WHERE rep_id IN (${reps});`),
    );
    tidy('remove the policy', () =>
      sql(`DELETE FROM expense_policy_rates WHERE tenant_id='${tenantId}' AND policy_id IN (SELECT id FROM expense_policies WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM expense_policies WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM expense_categories WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove the days behind it', () =>
      sql(`DELETE FROM attendance_days WHERE rep_id IN (${reps});
           DELETE FROM leave_requests WHERE rep_id IN (${reps});
           DELETE FROM tour_plan_days WHERE plan_id IN (SELECT id FROM tour_plans WHERE rep_id IN (${reps}));
           DELETE FROM tour_plans WHERE rep_id IN (${reps});`),
    );
    tidy('remove field masters', () =>
      sql(`DELETE FROM beats WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM leave_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM work_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM rep_grades WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM territories WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove other company', () => sql(`DELETE FROM tenants WHERE id='${otherCompany}'`));
  }
});
