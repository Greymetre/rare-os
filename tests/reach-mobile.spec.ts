// RCH-8 the field app. Its acceptance is one sentence from the milestone plan, and this spec is
// that sentence carried out literally:
//
//   "Airplane mode mein poora beat complete karo — check-in, order, photo. App band karo,
//    kholo, kharab network par jodo — sab kuch exactly ek baar pahunche."
//
// So: the browser is put offline with `setOffline`, a whole beat is worked with no network at
// all, the page is **reloaded** while still offline — which is the app being closed and opened
// again, and the reason none of this may live in memory — and only then is the network allowed
// back. Everything must arrive, and each thing exactly once.
//
// Two more things are proved here because they are what the promise actually rests on. First,
// that an order taken during a visit arrives pointing at that visit, although when it was taken
// the visit had no identity on the server at all. Second, that sending the same work twice is
// free: the retry that makes a dropped line survivable is only safe if the server recognises a
// repeat, so the repeat is sent on purpose and the count is checked.
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

// A one-pixel PNG. The photo path has to carry real bytes, because the server inspects them and
// refuses anything that is not actually an image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('RCH-8 the field app: a whole beat in airplane mode, closed and reopened, arriving exactly once', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'M' + suffix,
    repUserId = randomUUID(),
    repEmail = `fieldrep.${suffix}@example.test`,
    PASSWORD = 'Reach-Mobile-2026!';
  let tenantId = '',
    repRole = '',
    repIdentity = '',
    repId = '',
    mobile: any = null;

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
    expect(tenantId, 'the signed-in company is needed to clean up safely').toMatch(
      /^[0-9a-f-]{36}$/,
    );

    // ---------- The ground a day stands on ----------
    await ok('units', 'POST', { code: p + 'NOS', name: 'Pieces', decimals: 0 });
    await ok('masters/items', 'POST', {
      code: p + 'CHAIR',
      name: 'Moulded chair',
      item_type: 'FG',
      make_buy: 'MAKE',
      base_unit: p + 'NOS',
    });
    await ok('masters/territories', 'POST', { code: p + 'T', name: 'Field territory' });
    await ok('masters/rep_grades', 'POST', { code: p + 'G', name: 'Officer', rank: 1 });
    await ok('masters/work_types', 'POST', {
      code: p + 'F',
      name: 'Field working',
      // No location needed to start, so the test does not depend on a headless browser's GPS.
      needs_location: false,
      counts_present: true,
    });
    // A shop that needs no paperwork and has no credit limit, so nothing about this test is
    // about holds — it is about whether the work arrives at all.
    await ok('masters/customer_types', 'POST', {
      code: p + 'RET',
      name: 'Retailer',
      checkin_radius_m: 500,
      on_beat_plan: true,
      needs_approval: false,
      kyc_before_order: false,
      order_route: 'NONE',
    });
    await ok('masters/price_list_items', 'POST', {
      type: p + 'RET',
      item: p + 'CHAIR',
      rate: '240.0000',
      gst_pct: '18.00',
      from_date: '2020-01-01',
    });
    await ok('masters/beats', 'POST', {
      code: p + 'B1',
      name: 'Field round',
      territory: p + 'T',
      run_days: 'MON,TUE,WED,THU,FRI,SAT,SUN',
    });
    repId = (
      await ok('masters/field_reps', 'POST', {
        code: p + 'R',
        name: 'Kiran Field',
        grade: p + 'G',
        territory: p + 'T',
        hq_town: 'Rohtak',
      })
    ).id;
    await ok('masters/beat_assignments', 'POST', {
      beat: p + 'B1',
      rep: p + 'R',
      from_date: '2026-01-01',
    });
    const shops: string[] = [];
    for (const n of [1, 2])
      shops.push(
        (
          await ok('reach/customers', 'POST', {
            code: `${p}C${n}`,
            type: p + 'RET',
            name: `Field shop ${n}`,
            territory: p + 'T',
            beat: p + 'B1',
            town: 'Rohtak',
          })
        ).id,
      );

    // ---------- A rep who may do the whole day from a phone ----------
    repRole = (
      await ok('roles', 'POST', {
        name: p + ' Field rep',
        permissions: [
          'dashboard.read',
          'reach.attend',
          'reach.visit',
          'reach.order',
          'reach.collect',
          // The catalogue's own rule: uploading a photo requires being able to read one back.
          'files.read',
          'files.upload',
        ],
      })
    ).id;
    await ok('users', 'POST', {
      requestId: repUserId,
      name: 'Kiran Field',
      email: repEmail,
      roleId: repRole,
    });
    repIdentity = sql(`SELECT identity_id FROM app_users WHERE id='${repUserId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + repIdentity + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: PASSWORD, temporary: false },
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
    sql(`UPDATE field_reps SET user_id='${repUserId}' WHERE id='${repId}'`);

    // Today's round, approved. Written directly because this spec is about the phone, not about
    // the planning screens, which RCH-3 already proves.
    const today = sql(`SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date::text`);
    const planId = randomUUID();
    const beatId = sql(`SELECT id FROM beats WHERE tenant_id='${tenantId}' AND code='${p}B1'`);
    sql(`INSERT INTO tour_plans(id,tenant_id,rep_id,plan_month,status,submitted_at,decided_at)
         VALUES('${planId}','${tenantId}','${repId}',date_trunc('month','${today}'::date)::date,'APPROVED',now(),now());
         INSERT INTO tour_plan_days(tenant_id,plan_id,work_date,beat_id,outlet_count)
         VALUES('${tenantId}','${planId}','${today}','${beatId}',2);`);

    // ---------- The phone ----------
    const phone = await browser.newContext();
    mobile = phone;
    const app = await phone.newPage();
    await app.goto('/mobile/');
    await app.getByRole('button', { name: 'Sign in' }).click();
    await app.locator('#username').fill(repEmail);
    await app.locator('#password').fill(PASSWORD);
    await app.locator('#kc-login').click();

    // The day comes down in one request, before the signal is taken away.
    await expect(app.getByRole('heading', { name: 'Kiran Field' })).toBeVisible({ timeout: 30000 });
    await expect(app.getByText('Field shop 1')).toBeVisible();
    await expect(app.getByText(`${today} · 2 stops`)).toBeVisible();

    // ---------- Airplane mode ----------
    await phone.setOffline(true);

    await app.getByRole('button', { name: 'Start day' }).click();
    await expect(app.getByTestId('queue-headline')).toHaveText(/waiting to send/);

    await app.getByText('Field shop 1').click();
    await app.getByLabel('Photo at the shop').setInputFiles({
      name: 'shelf.png',
      mimeType: 'image/png',
      buffer: PNG,
    });
    await app.getByRole('button', { name: 'Check in' }).click();

    // Exactly 'Order', or it also matches 'Take the order' — the same trap RCH-6's spec fell
    // into with 'Open policy'.
    await expect(app.getByRole('button', { name: 'Order', exact: true })).toBeVisible();
    await app.getByLabel('Quantity of Moulded chair').fill('4');
    await app.getByRole('button', { name: 'Take the order' }).click();

    // The tab, then the button on the panel it opens. Both say 'Check out', so the second is
    // addressed by what it is rather than by being the later of two.
    await app.getByRole('button', { name: 'Check out' }).click();
    await app.locator('.card > button.big', { hasText: 'Check out' }).click();
    await expect(app.getByRole('heading', { name: 'Kiran Field' })).toBeVisible();

    // Five things done, nothing sent, and the rep can see exactly that.
    await app.getByRole('button', { name: 'Open the queue' }).click();
    await expect(app.getByTestId('queue-counts')).toHaveText('0 sent · 5 waiting · 0 stopped');
    // Nothing reached the server, which is the point of the last two minutes.
    expect(sql(`SELECT count(*) FROM visits WHERE rep_id='${repId}'`)).toBe('0');
    expect(sql(`SELECT count(*) FROM trade_orders WHERE rep_id='${repId}'`)).toBe('0');

    // ---------- Close the app, open it again — still with no network ----------
    await app.reload();
    await expect(app.getByTestId('queue-headline')).toHaveText(/waiting to send/, {
      timeout: 30000,
    });
    await app.getByRole('button', { name: 'Open the queue' }).click();
    await expect(app.getByTestId('queue-counts')).toHaveText('0 sent · 5 waiting · 0 stopped');

    // ---------- The signal comes back ----------
    await phone.setOffline(false);
    // Two buttons say this: the bar that is always there, and the one at the foot of the queue
    // screen. This is the queue screen's, which is where the rep is standing.
    await app.locator('.screen > button.big', { hasText: 'Send now' }).click();
    // Wait for the queue to come to rest, then say what is wrong in the failure itself. A bare
    // "expected 5 sent, got 1" sends somebody back to the containers, which by then are gone.
    await expect(app.getByTestId('queue-counts')).toHaveText(/· 0 waiting ·/, { timeout: 60000 });
    const stopped = await app.locator('.problem').allInnerTexts();
    expect(stopped, `the queue stopped on: ${stopped.join(' | ')}`).toEqual([]);
    await expect(app.getByTestId('queue-counts')).toHaveText('5 sent · 0 waiting · 0 stopped');
    await expect(app.getByTestId('queue-headline')).toHaveText('Everything is sent');

    // ---------- Everything arrived, and each thing once ----------
    expect(sql(`SELECT count(*) FROM attendance_days WHERE rep_id='${repId}'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM visits WHERE rep_id='${repId}'`)).toBe('1');
    expect(sql(`SELECT count(*) FROM trade_orders WHERE rep_id='${repId}'`)).toBe('1');
    expect(
      sql(`SELECT count(*) FROM stored_files WHERE tenant_id='${tenantId}' AND client_ref <> ''`),
    ).toBe('1');
    // The visit is closed, so the check-out arrived as well as the check-in.
    expect(
      sql(`SELECT count(*) FROM visits WHERE rep_id='${repId}' AND checked_out_at IS NOT NULL`),
    ).toBe('1');

    // The order points at the visit it was taken on — although at the moment the rep tapped
    // "Take the order" that visit existed only on the phone, under a name the server had never
    // heard. This is the local id being swapped for the real one, end to end.
    expect(
      sql(`SELECT count(*) FROM trade_orders o JOIN visits v ON v.id=o.visit_id
           WHERE o.rep_id='${repId}' AND v.rep_id='${repId}'`),
    ).toBe('1');
    // And the selfie is attached to the check-in, not orphaned.
    expect(sql(`SELECT count(*) FROM visits WHERE rep_id='${repId}' AND file_id IS NOT NULL`)).toBe(
      '1',
    );

    // ---------- Sending the same work twice is free ----------
    // This is the rule the whole retry strategy rests on. A phone whose request died in the air
    // learns nothing and must send again; if the server did not recognise the repeat, every bad
    // line would become a duplicate order. So the repeat is sent deliberately.
    const repRequest = await browser.newContext();
    try {
      const repPage = await repRequest.newPage();
      await repPage.goto('/');
      await repPage.getByRole('link', { name: /sign in securely/i }).click();
      await repPage.locator('#username').fill(repEmail);
      await repPage.locator('#password').fill(PASSWORD);
      await repPage.locator('#kc-login').click();
      const who = await (await repPage.request.get('/api/me')).json();
      const asRep = (path: string, method = 'GET', data?: unknown) =>
        withRateLimitRetry(() =>
          repPage.request.fetch('/api/' + path, {
            method,
            headers: { Origin: env.APP_URL, 'X-CSRF-Token': who.csrfToken },
            data,
          }),
        );

      const ref = randomUUID();
      const order = {
        lines: [
          {
            item_id: sql(`SELECT id FROM items WHERE tenant_id='${tenantId}' AND code='${p}CHAIR'`),
            units: 2,
          },
        ],
        client_ref: ref,
      };
      const first = await (
        await asRep(`reach/trade/customer/${shops[1]}/order`, 'POST', order)
      ).json();
      const second = await (
        await asRep(`reach/trade/customer/${shops[1]}/order`, 'POST', order)
      ).json();
      expect(second.id).toBe(first.id);
      expect(second.order_no).toBe(first.order_no);
      // The second call did not take an order; it reported the one that was already there.
      expect(second.repeat).toBe(true);
      expect(sql(`SELECT count(*) FROM trade_orders WHERE client_ref='${ref}'`)).toBe('1');

      // The same for money, where a duplicate is a shop credited twice.
      const payRef = randomUUID();
      const payment = { amount: '500.00', mode: 'CASH', client_ref: payRef };
      const paid = await (
        await asRep(`reach/trade/customer/${shops[1]}/receipt`, 'POST', payment)
      ).json();
      const again = await (
        await asRep(`reach/trade/customer/${shops[1]}/receipt`, 'POST', payment)
      ).json();
      expect(again.receipt_no).toBe(paid.receipt_no);
      expect(again.repeat).toBe(true);
      expect(sql(`SELECT count(*) FROM trade_receipts WHERE client_ref='${payRef}'`)).toBe('1');

      // A write with no reference is untouched by any of this: the web sends none, and two
      // identical orders from a desk are two orders, exactly as they were before RCH-8.
      const plainOne = await (
        await asRep(`reach/trade/customer/${shops[1]}/order`, 'POST', { lines: order.lines })
      ).json();
      const plainTwo = await (
        await asRep(`reach/trade/customer/${shops[1]}/order`, 'POST', { lines: order.lines })
      ).json();
      expect(plainTwo.id).not.toBe(plainOne.id);
    } finally {
      await repRequest.close();
    }

    // ---------- The phone said what it was carrying ----------
    expect(
      Number(sql(`SELECT count(*) FROM device_syncs WHERE rep_id='${repId}'`)),
    ).toBeGreaterThan(0);
    expect(sql(`SELECT queued FROM device_syncs WHERE rep_id='${repId}' LIMIT 1`)).toBe('0');

    // ---------- A device token is not a web session, and the other way round ----------
    const anonymous = await request.get(env.APP_URL + '/api/reach/device/day', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(anonymous.status()).toBe(401);
    // The public config route tells a phone only where to sign in. No secret, and no session.
    const config = await (await request.get(env.APP_URL + '/api/mobile/config')).json();
    expect(config.clientId).toBe('rare-os-mobile');
    expect(JSON.stringify(config)).not.toMatch(/secret/i);
  } finally {
    // Each step on its own, so one failure does not hide the rest: a half-cleaned stack is far
    // harder to diagnose than a clean one with a warning.
    const tidy = (what: string, run: () => void) => {
      try {
        run();
      } catch (e: any) {
        console.warn(`cleanup (${what}) did not finish: ${e.message}`);
      }
    };
    if (mobile) await mobile.close().catch(() => undefined);
    if (repIdentity)
      await request
        .delete(env.AUTH_URL + '/admin/realms/rare-os/users/' + repIdentity, { headers: kcHeaders })
        .catch(() => undefined);

    const shopList = `SELECT id FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%'`;
    const repList = `SELECT id FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%'`;
    tidy("remove the day's work", () =>
      sql(`
        DELETE FROM trade_order_lines WHERE tenant_id='${tenantId}' AND order_id IN (SELECT id FROM trade_orders WHERE customer_id IN (${shopList}));
        DELETE FROM trade_orders WHERE tenant_id='${tenantId}' AND customer_id IN (${shopList});
        DELETE FROM trade_receipts WHERE tenant_id='${tenantId}' AND customer_id IN (${shopList});
        DELETE FROM visits WHERE tenant_id='${tenantId}' AND customer_id IN (${shopList});
        DELETE FROM device_syncs WHERE tenant_id='${tenantId}' AND rep_id IN (${repList});
        DELETE FROM attendance_days WHERE tenant_id='${tenantId}' AND rep_id IN (${repList});
        DELETE FROM tour_plan_days WHERE tenant_id='${tenantId}' AND plan_id IN (SELECT id FROM tour_plans WHERE rep_id IN (${repList}));
        DELETE FROM tour_plans WHERE tenant_id='${tenantId}' AND rep_id IN (${repList});
      `),
    );
    tidy('remove the photos', () =>
      sql(`DELETE FROM stored_files WHERE tenant_id='${tenantId}' AND uploaded_by='${repUserId}'`),
    );
    // The rep record points at the login, and the login points at the role, so they come apart
    // in that order or the database rightly refuses.
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
    tidy('remove the masters', () =>
      sql(`
        DELETE FROM beat_outlets WHERE tenant_id='${tenantId}' AND customer_id IN (${shopList});
        DELETE FROM beat_assignments WHERE tenant_id='${tenantId}' AND beat_id IN (SELECT id FROM beats WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
        DELETE FROM trade_customers WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
        DELETE FROM beats WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
        DELETE FROM price_list_items WHERE tenant_id='${tenantId}' AND type_id IN (SELECT id FROM customer_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%');
        DELETE FROM customer_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
        DELETE FROM field_reps WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
        DELETE FROM work_types WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
        DELETE FROM rep_grades WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
        DELETE FROM territories WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
        DELETE FROM items WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
        DELETE FROM units WHERE tenant_id='${tenantId}' AND code LIKE '${p}%';
      `),
    );
  }
});
