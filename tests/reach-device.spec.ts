// RCH-8 the field app, from the server's side of the wire.
//
// Its acceptance is one sentence from the milestone plan, and this spec is that sentence carried
// out as far as a test runner can reach:
//
//   "Airplane mode mein poora beat complete karo — check-in, order, photo. App band karo,
//    kholo, kharab network par jodo — sab kuch exactly ek baar pahunche."
//
// The app is now an installed Expo app, so a browser cannot drive it. What a browser could never
// prove anyway is the part that matters, and that is what this spec proves instead:
//
//   * a phone gets in through its own Keycloak client, with Authorization Code and PKCE, exactly
//     as `apps/mobile/src/auth.ts` does — including that the code is useless without the
//     verifier;
//   * a whole beat is built while there is no network at all, using the **real queue engine** and
//     the **real payload builders** the app itself uses, so the field names, the ordering and the
//     dependencies under test are the ones that ship;
//   * the queue survives being written out and read back, which is what "close the app and open
//     it" means for data that lives in SQLite;
//   * then the queue is drained against the real routes, and everything arrives, each thing
//     exactly once — including work sent twice on purpose, because the retry that makes a
//     dropped line survivable is only safe if the server recognises a repeat.
//
// What this spec does not cover is the screens. `apps/mobile/src/sync.ts` is the hands that do
// here what the driver below does, and the rules it obeys are in `tests/sync-queue.test.mjs`
// (23 tests) and `tests/field-payloads.test.mjs` (the payload shapes, against these same
// routes). The user interface needs a device or an emulator; see docs/REACH_TEST_GUIDE_HINGLISH.md
// for the walk through Expo Go.
import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
import { withRateLimitRetry } from './helpers/api';
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  applyResult,
  cascadeBlocks,
  idMapOf,
  kindOf,
  queueItem,
  queueSummary,
  readyToSend,
  resolveLinks,
} from '../packages/engines/sync-queue.mjs';
import {
  checkIn,
  checkOut,
  dayEnd,
  dayStart,
  order,
  photo,
  receipt,
} from '../packages/engines/field-payloads.mjs';

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

const base64url = (input: Buffer) =>
  input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

test('RCH-8 the field app: a whole beat built with no network, reopened, arriving exactly once', async ({
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

    // ---------- The phone gets in on its own client ----------
    //
    // Authorization Code with PKCE, driven over HTTP because the app's redirect is `rareos://`
    // and no browser can follow a custom scheme. Keycloak still answers with a 302 to it, and
    // the code is in the Location header — which is exactly what the app reads.
    const phone = await browser.newContext();
    mobile = phone;
    const net = phone.request;
    const realm = env.AUTH_URL + '/realms/rare-os/protocol/openid-connect';

    // One sign-in, start to finish, the way the app does it. An authorization code is single use
    // — Keycloak refuses it the second time it is presented, whatever the reason the first
    // attempt failed — so each check below starts its own sign-in rather than sharing a code.
    async function signInForCode(challenge: string) {
      const authorize =
        realm +
        '/auth?' +
        new URLSearchParams({
          response_type: 'code',
          client_id: 'rare-os-mobile',
          redirect_uri: 'rareos://auth',
          scope: 'openid offline_access',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: randomUUID(),
        }).toString();
      const loginPage = await net.get(authorize);
      expect(loginPage.ok(), 'the field app client cannot start a sign-in').toBe(true);
      const form = /<form[^>]+action="([^"]+)"/.exec(await loginPage.text());
      expect(form, 'Keycloak did not offer a login form to the field app client').toBeTruthy();
      const posted = await net.post(form![1].replace(/&amp;/g, '&'), {
        form: { username: repEmail, password: PASSWORD },
        maxRedirects: 0,
      });
      const back = posted.headers()['location'] ?? '';
      expect(back, `sign-in did not come back to the app: ${posted.status()}`).toContain(
        'rareos://',
      );
      const code = new URL(back).searchParams.get('code') ?? '';
      expect(code, 'no authorization code came back').not.toBe('');
      return code;
    }

    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    const code = await signInForCode(challenge);

    const exchanged = await net.post(realm + '/token', {
      form: {
        grant_type: 'authorization_code',
        client_id: 'rare-os-mobile',
        redirect_uri: 'rareos://auth',
        code,
        code_verifier: verifier,
      },
    });
    expect(exchanged.ok(), `the token exchange failed: ${await exchanged.text()}`).toBe(true);
    const tokens = await exchanged.json();
    const deviceToken: string = tokens.access_token;
    // `offline_access` was asked for, so the phone can still send at six in the evening.
    expect(
      tokens.refresh_token,
      'no refresh token: the phone would sign out mid-beat',
    ).toBeTruthy();

    const asPhone = (path: string, method = 'GET', data?: unknown) =>
      withRateLimitRetry(() =>
        net.fetch(env.APP_URL + '/api/' + path, {
          method,
          headers: {
            Authorization: 'Bearer ' + deviceToken,
            ...(data === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(data === undefined ? {} : { data }),
        }),
      );

    // ---------- The day comes down in one request ----------
    const dayResponse = await asPhone('reach/device/day');
    expect(dayResponse.ok(), `the day did not load: ${await dayResponse.text()}`).toBe(true);
    const dayPayload = await dayResponse.json();
    expect(dayPayload.rep.code).toBe(p + 'R');
    expect(dayPayload.server_date).toBe(today);
    expect(dayPayload.stops.map((s: any) => s.code)).toEqual([p + 'C1', p + 'C2']);
    // The prices for the one type of shop on this round, and no others.
    expect(dayPayload.prices.length).toBe(1);
    expect(dayPayload.prices[0].item).toBe(p + 'CHAIR');
    // What this login may send, so the app can hide what it cannot.
    expect(dayPayload.permissions).toContain('visit.checkin');
    expect(dayPayload.permissions).toContain('order.place');
    const itemId = dayPayload.prices[0].item_id;
    const shopOne = dayPayload.stops[0].customer_id;

    // ---------- A whole beat, with no network at all ----------
    //
    // Nothing below touches the wire. This is the queue the app would hold at the end of a day
    // out of coverage, built by the same engine and the same payload builders that ship.
    let seq = 0;
    const queue: any[] = [];
    const add = (
      kind: string,
      payload: Record<string, unknown>,
      label: string,
      extra: any = {},
    ) => {
      const item = {
        ...queueItem({
          kind,
          payload,
          localId: extra.localId ?? 'local:' + randomUUID(),
          clientRef: randomUUID(),
          seq: (seq += 1),
        }),
        label,
        ...extra,
      };
      queue.push(item);
      return item;
    };

    const fix = { latitude: 28.8955, longitude: 76.6066, accuracy_m: 12 };
    add(
      'attendance.start',
      dayStart({ workTypeId: dayPayload.work_types[0].id, fix }),
      'Day started',
    );
    const shelf = add('file.upload', photo({ purpose: 'shelf', name: 'shelf.png' }), 'Photo');
    const arrival = add(
      'visit.checkin',
      checkIn({ customerId: shopOne, fix, fileId: shelf.localId }),
      'Check-in',
    );
    add(
      'order.place',
      order({
        customerId: shopOne,
        visitId: arrival.localId,
        lines: [{ item_id: itemId, units: 4 }],
      }),
      'Order',
    );
    add(
      'receipt.collect',
      receipt({ customerId: shopOne, amount: 500, mode: 'CASH', fix }),
      'Collection',
    );
    add(
      'visit.checkout',
      checkOut({ visitId: arrival.localId, version: 1, answers: {}, fix }),
      'Check-out',
    );
    add('attendance.end', dayEnd({ fix, version: 1 }), 'Day ended');

    // Seven pieces of work, none of them sent, and the queue says so in the words a rep reads.
    expect(queueSummary(queue).queued).toBe(7);
    expect(queueSummary(queue).sent).toBe(0);
    expect(queueSummary(queue).blocked).toBe(0);

    // ---------- Closing the app and opening it again ----------
    //
    // On a phone the queue is in SQLite, so this is the part that must survive. Written out and
    // read back proves no item depends on anything held in memory — the fault that made an
    // earlier build advance one step per pass and then sit, with nothing blocked and no error.
    const reopened = JSON.parse(JSON.stringify(queue));
    expect(reopened).toEqual(queue);
    expect(reopened.filter((i: any) => i.state === 'QUEUED').length).toBe(7);

    // ---------- The network comes back ----------
    //
    // The engine decides what goes and in what order; this loop only does what it is told, the
    // way `apps/mobile/src/sync.ts` does. One at a time, in the order the rep worked.
    const sent: string[] = [];
    async function drain(items: any[]) {
      let live = cascadeBlocks(items);
      for (let pass = 0; pass < 60; pass += 1) {
        const [next] = readyToSend(live, { now: Date.now(), limit: 1 });
        if (!next) break;
        const spec = kindOf(next.kind)!;
        const resolved = resolveLinks({
          path: spec.path,
          payload: next.payload,
          idMap: idMapOf(live),
        });
        expect(resolved.ready, `${next.kind} was offered with ${resolved.missing} unresolved`).toBe(
          true,
        );

        let response;
        if (spec.binary) {
          const query = new URLSearchParams({
            purpose: String(next.payload.purpose),
            ref: next.clientRef,
            name: String(next.payload.name),
          });
          response = await withRateLimitRetry(() =>
            net.fetch(env.APP_URL + '/api/' + resolved.path + '?' + query.toString(), {
              method: 'POST',
              headers: { Authorization: 'Bearer ' + deviceToken, 'content-type': 'image/png' },
              data: PNG,
            }),
          );
        } else {
          response = await asPhone(resolved.path, spec.method, resolved.payload);
        }

        const body = await response.json().catch(() => null);
        const result = response.ok()
          ? { ok: true, status: response.status(), body: body ?? {} }
          : {
              ok: false,
              status: response.status(),
              code: body?.code ?? body?.error?.code ?? '',
              message: body?.message ?? body?.error?.message ?? '',
            };
        const after = applyResult(next, result, { now: Date.now() });
        sent.push(`${next.kind} → ${response.status()}`);
        live = cascadeBlocks(live.map((i: any) => (i.localId === after.localId ? after : i)));
      }
      return live;
    }

    const drained = await drain(reopened);
    const stopped = drained
      .filter((i: any) => i.state === 'BLOCKED')
      .map((i: any) => `${i.kind}: ${i.lastCode} ${i.lastError}`);
    // Say why, in the message. "5 waiting" sends you back to containers that are already gone.
    expect(stopped, `the queue stopped on: ${stopped.join(' | ')}`).toEqual([]);
    expect(queueSummary(drained).sent, `what went up: ${sent.join(', ')}`).toBe(7);
    expect(queueSummary(drained).queued).toBe(0);

    // ---------- It all arrived, and the links held ----------
    const visitId = sql(
      `SELECT id FROM visits WHERE tenant_id='${tenantId}' AND customer_id='${shopOne}'`,
    );
    expect(visitId, 'the visit did not arrive').toMatch(/^[0-9a-f-]{36}$/);
    // The order was taken while the visit had no identity on the server at all, and it still
    // arrived pointing at the right one.
    expect(
      sql(
        `SELECT visit_id FROM trade_orders WHERE tenant_id='${tenantId}' AND customer_id='${shopOne}'`,
      ),
    ).toBe(visitId);
    expect(
      sql(`SELECT units::int FROM trade_order_lines WHERE tenant_id='${tenantId}' AND order_id IN
           (SELECT id FROM trade_orders WHERE customer_id='${shopOne}')`),
    ).toBe('4');
    // The photo taken at the counter is on the visit, which is what `visits.file_id` is for.
    expect(
      sql(
        `SELECT file_id IS NOT NULL FROM visits WHERE tenant_id='${tenantId}' AND id='${visitId}'`,
      ),
    ).toBe('t');
    expect(
      sql(
        `SELECT amount::int FROM trade_receipts WHERE tenant_id='${tenantId}' AND customer_id='${shopOne}'`,
      ),
    ).toBe('500');
    expect(
      sql(
        `SELECT checked_out_at IS NOT NULL FROM visits WHERE tenant_id='${tenantId}' AND id='${visitId}'`,
      ),
    ).toBe('t');
    expect(
      sql(`SELECT started_at IS NOT NULL AND ended_at IS NOT NULL FROM attendance_days
           WHERE tenant_id='${tenantId}' AND rep_id='${repId}'`),
    ).toBe('t');

    // ---------- Sending the same work twice is free ----------
    //
    // This is the keystone. A retry is only safe if the server recognises a repeat, so the
    // repeats are sent on purpose and the rows are counted.
    const repeated = await drain(
      reopened.map((i: any) => ({
        ...i,
        state: 'QUEUED',
        attempts: 0,
        retryAfter: 0,
        sentAt: null,
      })),
    );
    const blockedOnRepeat = repeated
      .filter((i: any) => i.state === 'BLOCKED')
      .map((i: any) => `${i.kind}: ${i.lastCode} ${i.lastError}`);
    expect(blockedOnRepeat, `a repeat was refused: ${blockedOnRepeat.join(' | ')}`).toEqual([]);

    expect(
      sql(
        `SELECT count(*) FROM trade_orders WHERE tenant_id='${tenantId}' AND customer_id='${shopOne}'`,
      ),
      'the same order arrived twice',
    ).toBe('1');
    expect(
      sql(
        `SELECT count(*) FROM trade_receipts WHERE tenant_id='${tenantId}' AND customer_id='${shopOne}'`,
      ),
      'the same collection arrived twice',
    ).toBe('1');
    expect(
      sql(`SELECT count(*) FROM visits WHERE tenant_id='${tenantId}' AND customer_id='${shopOne}'`),
      'the same check-in became two visits',
    ).toBe('1');
    expect(
      sql(
        `SELECT count(*) FROM attendance_days WHERE tenant_id='${tenantId}' AND rep_id='${repId}'`,
      ),
      'the day was started twice',
    ).toBe('1');
    expect(
      sql(
        `SELECT count(*) FROM stored_files WHERE tenant_id='${tenantId}' AND uploaded_by='${repUserId}'`,
      ),
      'the same photo was stored twice',
    ).toBe('1');

    // ---------- The phone says what it is still carrying ----------
    const beat = await asPhone('reach/device/heartbeat', 'POST', {
      device_ref: 'test-handset',
      platform: 'android',
      app_version: '0.1.0',
      queued: 0,
      blocked: 0,
    });
    expect(beat.ok(), `the heartbeat failed: ${await beat.text()}`).toBe(true);
    expect(sql(`SELECT queued FROM device_syncs WHERE rep_id='${repId}' LIMIT 1`)).toBe('0');

    // ---------- A code is worthless without the verifier that started it ----------
    //
    // The whole point of PKCE for an app anybody can download, so it is proved rather than
    // assumed — on a sign-in of its own, because a code is single use.
    const spareVerifier = base64url(randomBytes(32));
    const spareCode = await signInForCode(
      base64url(createHash('sha256').update(spareVerifier).digest()),
    );
    const withoutVerifier = await net.post(realm + '/token', {
      form: {
        grant_type: 'authorization_code',
        client_id: 'rare-os-mobile',
        redirect_uri: 'rareos://auth',
        code: spareCode,
      },
    });
    expect(withoutVerifier.ok(), 'a code was spent without its verifier').toBe(false);
    const wrongVerifier = await net.post(realm + '/token', {
      form: {
        grant_type: 'authorization_code',
        client_id: 'rare-os-mobile',
        redirect_uri: 'rareos://auth',
        code: spareCode,
        code_verifier: base64url(randomBytes(32)),
      },
    });
    expect(wrongVerifier.ok(), 'a code was spent with the wrong verifier').toBe(false);

    // ---------- A device token is not a web session, and the other way round ----------
    const anonymous = await request.get(env.APP_URL + '/api/reach/device/day', {
      headers: { Authorization: 'Bearer not-a-real-token' },
    });
    expect(anonymous.status()).toBe(401);
    // A device token may not open a desk screen that needs a real session.
    const asDesk = await asPhone('users');
    expect([401, 403]).toContain(asDesk.status());
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
