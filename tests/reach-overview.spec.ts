// RCH-7 Reach overview. Its own acceptance is two sentences from the milestone plan: every
// tile's number has to match the real activity underneath it, and no proposal may change
// anything without somebody approving it.
//
// The second one is proved the only way worth proving it: this module has no route that writes.
// The spec asks the server to write through every shape of request it might and is refused each
// time, and the security baseline asserts the same thing about the source.
//
// Around that: the single queue that replaces a queue per module, proposals filtered by what the
// person could actually do about them, going live read from the data, and the Reach audit trail.
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

test('RCH-7 overview: every tile matches its list, no proposal acts, and the queue is one queue', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'W' + suffix,
    readerUserId = randomUUID(),
    readerEmail = `ovreader.${suffix}@example.test`;
  let readerRole = '',
    tenantId = '',
    readerIdentity = '',
    readerContext: any;

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

  try {
    tenantId = me.user.tenant_id;
    expect(tenantId).toMatch(/^[0-9a-f-]{36}$/);
    const before = await ok('reach/overview');
    const countOf = (view: any, code: string) => Number(view.counts[code] ?? 0);

    // ---------- Ground, and two things that will be waiting for somebody ----------
    await ok('masters/territories', 'POST', { code: p + 'T', name: 'Overview territory' });
    await ok('masters/rep_grades', 'POST', { code: p + 'G', name: 'Officer', rank: 1 });
    await ok('masters/leave_types', 'POST', {
      code: p + 'CL',
      name: 'Casual leave',
      paid: true,
      annual_quota: '12',
      carry_forward: false,
      requires_approval: true,
    });
    await ok('masters/customer_types', 'POST', {
      code: p + 'RET',
      name: 'Retailer',
      checkin_radius_m: 75,
      on_beat_plan: false,
      // This type insists on approval, which is the second thing that will be waiting.
      needs_approval: true,
    });
    const repId = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'R',
        name: 'Ovi Rep',
        grade: p + 'G',
        territory: p + 'T',
      })
    ).id;
    const leaveType = sql(
      `SELECT id FROM leave_types WHERE tenant_id='${tenantId}' AND code='${p}CL'`,
    );
    const leaveId = randomUUID();
    sql(
      `INSERT INTO leave_requests(id,tenant_id,rep_id,leave_type_id,from_date,to_date,reason,status)
       VALUES('${leaveId}','${tenantId}','${repId}',
              '${leaveType}',current_date,current_date,'Family','PENDING')`,
    );
    await ok('reach/customers', 'POST', {
      code: p + 'C1',
      type: p + 'RET',
      name: 'Waiting shop',
      territory: p + 'T',
      town: 'Rohtak',
    });

    // ---------- The acceptance: a tile is the size of the list underneath it ----------
    const view = await ok('reach/overview');
    expect(countOf(view, 'LEAVE_WAITING')).toBe(countOf(before, 'LEAVE_WAITING') + 1);
    expect(countOf(view, 'CUSTOMER_WAITING')).toBe(countOf(before, 'CUSTOMER_WAITING') + 1);

    // The number on the overview is the number of rows the screen it points at actually shows.
    const waitingLeave = await ok('reach/attendance/leave?status=PENDING');
    expect(waitingLeave.total).toBe(countOf(view, 'LEAVE_WAITING'));
    const waitingCustomers = await ok('reach/approvals');
    expect(waitingCustomers.accounts.length).toBe(countOf(view, 'CUSTOMER_WAITING'));
    expect(waitingCustomers.retags.length).toBe(countOf(view, 'GEO_WAITING'));

    // And the queue tile is the sum of its own rows, whatever is in it.
    expect(view.queue.total).toBe(
      view.queue.rows.reduce((sum: number, r: any) => sum + r.count, 0),
    );
    // The queue screen and the overview are the same calculation, so they agree exactly.
    const queue = await ok('reach/overview/queue');
    expect(queue.total).toBe(view.queue.total);
    expect(queue.rows.map((r: any) => r.code).sort()).toEqual(
      view.queue.rows.map((r: any) => r.code).sort(),
    );
    // Nothing counted at nought is proposed: the system says nothing rather than reassuring.
    expect(view.proposals.every((r: any) => r.count > 0)).toBe(true);
    // Every proposal says where a person goes and why it matters.
    for (const row of view.proposals) {
      expect(row.module, row.code).toBeTruthy();
      expect(row.screen, row.code).toBeTruthy();
      expect(row.why.length, row.code).toBeGreaterThan(10);
    }
    // It spans the modules, which is the point of there being one of it.
    expect(view.queue.modules.length).toBeGreaterThan(0);

    // ---------- The acceptance: a proposal cannot change anything ----------
    // There is no write route on this module at all. Every shape of request is refused.
    for (const [path, method] of [
      ['reach/overview', 'POST'],
      ['reach/overview', 'PUT'],
      ['reach/overview', 'PATCH'],
      ['reach/overview', 'DELETE'],
      ['reach/overview/queue', 'POST'],
      ['reach/overview/queue/LEAVE_WAITING/approve', 'POST'],
      ['reach/overview/proposals/LEAVE_WAITING/dismiss', 'POST'],
      ['reach/overview/cutover', 'POST'],
      ['reach/overview/audit', 'DELETE'],
    ] as const) {
      const r = await call(path, method, {});
      expect([404, 405], `${method} ${path} was not refused`).toContain(r.status());
    }
    // And nothing moved while we asked.
    const after = await ok('reach/overview');
    expect(after.counts).toEqual(view.counts);
    // The leave request it proposed a decision on is untouched.
    expect(sql(`SELECT status FROM leave_requests WHERE id='${leaveId}'`)).toBe('PENDING');

    // ---------- A proposal nobody can act on is not shown to them ----------
    readerRole = (
      await ok('roles', 'POST', {
        name: 'Overview reader ' + suffix,
        // May read Reach, but may decide nothing at all.
        permissions: ['dashboard.read', 'reach.read'],
      })
    ).id;
    await ok('users', 'POST', {
      requestId: readerUserId,
      name: 'Overview Reader',
      email: readerEmail,
      roleId: readerRole,
    });
    readerIdentity = sql(`SELECT identity_id FROM app_users WHERE id='${readerUserId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + readerIdentity + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Reach-Overview-2026!', temporary: false },
          },
        )
      ).ok(),
    ).toBe(true);
    expect(
      (
        await request.put(env.AUTH_URL + '/admin/realms/rare-os/users/' + readerIdentity, {
          headers: kcHeaders,
          data: { emailVerified: true, requiredActions: [] },
        })
      ).ok(),
    ).toBe(true);

    readerContext = await browser.newContext();
    const readerPage = await readerContext.newPage();
    await readerPage.goto('/');
    await readerPage.getByRole('link', { name: /sign in securely/i }).click();
    await readerPage.locator('#username').fill(readerEmail);
    await readerPage.locator('#password').fill('Reach-Overview-2026!');
    await readerPage.locator('#kc-login').click();
    await completeTestMfa(readerPage, readerEmail);
    await expect(readerPage.locator('.main > header')).toBeVisible();
    const readerMe = await (await readerPage.request.get('/api/me')).json();
    const asReader = (path: string, method = 'GET') =>
      withRateLimitRetry(() =>
        readerPage.request.fetch('/api/' + path, {
          method,
          headers: { Origin: env.APP_URL, 'X-CSRF-Token': readerMe.csrfToken },
        }),
      );

    const readerView = await (await asReader('reach/overview')).json();
    // The counts still travel — the reader can see that there is leave waiting — but it is not
    // offered to them as something to decide, because they cannot.
    expect(Number(readerView.counts.LEAVE_WAITING)).toBe(countOf(view, 'LEAVE_WAITING'));
    expect(readerView.proposals.some((r: any) => r.code === 'LEAVE_WAITING')).toBe(false);
    expect(readerView.proposals.some((r: any) => r.code === 'CUSTOMER_WAITING')).toBe(false);
    // The admin, who may decide both, is offered both.
    expect(view.proposals.some((r: any) => r.code === 'LEAVE_WAITING')).toBe(true);
    expect(view.proposals.some((r: any) => r.code === 'CUSTOMER_WAITING')).toBe(true);
    // The audit trail is a different right again, and reading Reach does not grant it.
    expect((await asReader('reach/overview/audit?from=2026-01-01&to=2026-12-31')).status()).toBe(
      403,
    );

    // ---------- Going live ----------
    const cutover = await ok('reach/overview/cutover');
    expect(cutover.steps.length).toBe(7);
    expect(cutover.done + cutover.steps.filter((s: any) => s.status !== 'ready').length).toBe(7);
    // Every line is read from the data, and says whether it blocks going live.
    for (const step of cutover.steps) {
      expect(['ready', 'missing']).toContain(step.status);
      expect(typeof step.blocking).toBe('boolean');
      expect(step.detail.length).toBeGreaterThan(10);
    }
    // The customer just created is counted, so the number is the data and not a stored flag.
    expect(cutover.facts.customers).toBeGreaterThan(0);

    // ---------- The audit trail ----------
    const trail = await ok('reach/overview/audit?from=2026-01-01&to=2026-12-31&limit=50');
    expect(trail.total).toBeGreaterThan(0);
    // Creating the customer a moment ago is in it.
    expect(trail.items.some((r: any) => /customer/i.test(r.action))).toBe(true);
    // It is a window onto the one shared record, so every row belongs to Reach.
    expect(
      trail.items.every(
        (r: any) =>
          /^(reach|expense|trade|kyc)\./.test(r.action) ||
          [
            'trade_customers',
            'field_reps',
            'customer_geo_log',
            'visits',
            'tour_plans',
            'attendance_days',
            'leave_requests',
            'attendance_edits',
            'tour_plan_days',
            'tour_plan_changes',
            'kyc_documents',
            'trade_orders',
            'trade_invoices',
            'trade_receipts',
            'expense_claims',
            'expense_lines',
            'expense_policies',
            'reach_settings',
            'beat_outlets',
          ].includes(r.entity_type),
      ),
    ).toBe(true);
    // Narrowing by what happened returns exactly what that kind counted.
    const kind = trail.kinds[0];
    const narrowed = await ok(
      `reach/overview/audit?from=2026-01-01&to=2026-12-31&action=${encodeURIComponent(kind.action)}`,
    );
    expect(narrowed.total).toBe(kind.n);
    // A window wider than a year is refused rather than served slowly.
    const wide = await call('reach/overview/audit?from=2020-01-01&to=2026-12-31');
    expect(wide.status()).toBe(400);
    expect((await wide.json()).error.message).toMatch(/at most 366 days/);

    // ---------- The screens ----------
    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(page, 'Overview');
    await expect(page.getByRole('heading', { name: 'Reach overview' })).toBeVisible();
    await expect(page.getByText('Waiting for a decision').first()).toBeVisible();
    await expect(page.getByText('Days started, of')).toBeVisible();

    await openScreen(page, 'Waiting for a decision');
    await expect(page.getByRole('heading', { name: 'Waiting for a decision' })).toBeVisible();

    await openScreen(page, 'Going live');
    await expect(page.getByRole('heading', { name: 'Going live' })).toBeVisible();
    await expect(page.getByText('Customers are loaded')).toBeVisible();

    await openScreen(page, 'Reach audit trail');
    await expect(page.getByRole('heading', { name: 'Reach audit trail' })).toBeVisible();

    // The reader sees the overview but not the trail, so it is not in their menu at all.
    await readerPage.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(readerPage, 'Overview');
    await expect(readerPage.getByRole('heading', { name: 'Reach overview' })).toBeVisible();
    await expect(readerPage.getByRole('button', { name: 'Reach audit trail' })).toHaveCount(0);
  } finally {
    const tidy = (what: string, run: () => void) => {
      try {
        run();
      } catch (e: any) {
        console.warn(`cleanup (${what}) did not finish: ${e.message}`);
      }
    };
    await readerContext?.close().catch(() => {});
    if (readerIdentity)
      await request
        .delete(env.AUTH_URL + '/admin/realms/rare-os/users/' + readerIdentity, {
          headers: kcHeaders,
        })
        .catch(() => {});
    tidy('remove login', () =>
      sql(`DELETE FROM user_sites WHERE user_id='${readerUserId}';
           DELETE FROM app_users WHERE id='${readerUserId}';`),
    );
    if (readerRole)
      tidy('remove role', () =>
        sql(
          `DELETE FROM role_permissions WHERE role_id='${readerRole}'; DELETE FROM roles WHERE id='${readerRole}';`,
        ),
      );
    const reps = `SELECT id FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%'`;
    tidy('remove what was waiting', () =>
      sql(`DELETE FROM leave_requests WHERE rep_id IN (${reps});`),
    );
    tidy('remove customers', () =>
      sql(`DELETE FROM customer_geo_log WHERE tenant_id='${tenantId}' AND customer_id IN (SELECT id FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM beat_outlets WHERE tenant_id='${tenantId}' AND customer_id IN (SELECT id FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
           DELETE FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
    tidy('remove field masters', () =>
      sql(`DELETE FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM customer_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM leave_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM rep_grades WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
           DELETE FROM territories WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';`),
    );
  }
});
