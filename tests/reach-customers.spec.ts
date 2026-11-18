// RCH-1 Customers and Beats. Its own acceptance is: put 12 outlets on a beat, see them in order
// with their towns, and watch a new customer join its beat the moment it is made. Around that:
// the per-type form, the location tag and its approval, the round's order, and the boundaries —
// who may read, maintain, approve, set up and remove, and what one company may see of another.
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

// A shop in Kolkata, and a point about 1.1 km north of it: further than the 100 m a rep may move
// a tag on their own.
const SHOP = { latitude: 22.5726, longitude: 88.3639 };
const FAR = { latitude: 22.5826, longitude: 88.3639 };

test('RCH-1 customers and beats: the per-type form, the round, the location tag, approvals and boundaries', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(600000);
  const suffix = Date.now().toString().slice(-6),
    p = 'C' + suffix,
    readerId = randomUUID(),
    readerEmail = `fieldops.${suffix}@example.test`,
    otherCompany = randomUUID(),
    hiddenCustomer = randomUUID();
  let readerRole = '',
    approverRole = '',
    readerIdentity = '',
    readerContext: any,
    approverContext: any,
    // This test changes the company's Reach settings, which are shared state, so what they were
    // before is kept and put back in the finally block.
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
  async function settled(batchId: string, timeout = 120000) {
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
  const importCsv = async (kind: string, csv: string, name: string) => {
    const r = await call('imports/' + kind, 'POST', csv, {
      'Content-Type': 'text/csv',
      'X-File-Name': name,
    });
    const started = await r.json();
    expect(r.ok(), JSON.stringify(started)).toBe(true);
    const batch = await settled(started.id);
    await ok(`imports/${batch.id}/commit`, 'POST', { version: batch.version });
    return settled(batch.id);
  };
  const register = async (query = '') =>
    (await ok('reach/customers' + (query ? '?' + query : ''))).items;
  const find = async (code: string) => (await register('q=' + code.toLowerCase()))[0];

  try {
    // ---------- The six types, straight from the handover's own template ----------
    const typeTemplate = await (await call('imports/templates/customer_types')).text();
    const typeRows = typeTemplate
      .split('\r\n')
      .filter(Boolean)
      .map((line, index) => (index === 0 ? line : line.replace(/^([A-Z]+)/, p + '$1')));
    const types = await importCsv('customer_types', typeRows.join('\r\n') + '\r\n', 'types.csv');
    expect(types.status).toBe('committed');
    expect(types.summary).toMatchObject({ created: 6 });
    const byCode = Object.fromEntries(
      (await ok('reach/customer-types')).items.map((t: any) => [t.code, t]),
    );
    // The handover's own numbers arrived with them.
    expect([byCode[p + 'RET'].checkin_radius_m, byCode[p + 'DIST'].hold_days]).toEqual([75, 30]);
    expect([byCode[p + 'RET'].on_beat_plan, byCode[p + 'KEY'].on_beat_plan]).toEqual([true, false]);
    expect([byCode[p + 'RET'].needs_approval, byCode[p + 'DIST'].needs_approval]).toEqual([
      false,
      true,
    ]);

    // ---------- The questions each type asks ----------
    // The order is the company's own, and the section groups the questions. Trade name is given a
    // later key than shop type on purpose, so the form proves it reads by order and not by key.
    for (const field of [
      {
        field_key: p.toLowerCase() + '_trade_name',
        name: 'Trade name',
        input: 'text',
        section: 'Identity',
        display_order: 10,
      },
      {
        field_key: p.toLowerCase() + '_shop_type',
        name: 'Shop type',
        input: 'select',
        options: 'Exclusive|Multi-brand|General',
        section: 'Identity',
        display_order: 30,
      },
      {
        field_key: p.toLowerCase() + '_gstin',
        name: 'GSTIN',
        input: 'gstin',
        section: 'Statutory',
        display_order: 20,
      },
    ])
      await ok('masters/customer_form_fields', 'POST', field);
    // A choice question with no choices is refused: the form would be unanswerable.
    await rejected(
      'masters/customer_form_fields',
      'POST',
      { field_key: p.toLowerCase() + '_bad', name: 'Bad', input: 'select' },
      400,
      /needs its choices/,
    );
    for (const rule of [
      { type: p + 'RET', field: p.toLowerCase() + '_trade_name', requirement: 'R' },
      { type: p + 'RET', field: p.toLowerCase() + '_shop_type', requirement: 'O' },
      { type: p + 'RET', field: p.toLowerCase() + '_gstin', requirement: 'X' },
      { type: p + 'DIST', field: p.toLowerCase() + '_gstin', requirement: 'R' },
    ])
      await ok('masters/customer_form_rules', 'POST', rule);
    const retForm = await ok(`reach/customer-form/${byCode[p + 'RET'].id}`);
    // Trade name sits at 10 and shop type at 30, so that is the order, whatever their keys are.
    expect(retForm.sections.map((s: any) => s.section)).toEqual(['Identity']);
    expect(retForm.sections.flatMap((s: any) => s.fields.map((f: any) => f.field_key))).toEqual([
      p.toLowerCase() + '_trade_name',
      p.toLowerCase() + '_shop_type',
    ]);
    // A distributor is asked the one question placed on it, in its own section.
    const distForm = await ok(`reach/customer-form/${byCode[p + 'DIST'].id}`);
    expect(distForm.sections.map((s: any) => [s.section, s.fields[0].field_key])).toEqual([
      ['Statutory', p.toLowerCase() + '_gstin'],
    ]);

    // ---------- The ground a beat stands on ----------
    await ok('masters/territories', 'POST', { code: p + 'T1', name: 'Kolkata city' });
    await ok('masters/rep_grades', 'POST', { code: p + 'SO', name: 'Sales Officer' });
    await ok('masters/field_reps', 'POST', {
      code: p + 'FS1',
      name: 'Kiran Patil',
      grade: p + 'SO',
      territory: p + 'T1',
    });
    await ok('masters/beats', 'POST', {
      code: p + 'B1',
      name: 'Kolkata north round',
      territory: p + 'T1',
      run_days: 'mon,thu',
    });
    // A fortnightly beat has to say which half of the fortnight it runs in.
    await rejected(
      'masters/beats',
      'POST',
      {
        code: p + 'B2',
        name: 'Howrah',
        territory: p + 'T1',
        run_days: 'TUE',
        frequency: 'FORTNIGHTLY',
      },
      400,
      /Choose ODD or EVEN/,
    );
    await ok('masters/beat_assignments', 'POST', {
      beat: p + 'B1',
      rep: p + 'FS1',
      from_date: '2026-04-01',
    });
    // One rep holds a beat at a time, and the refusal says who has it.
    await rejected(
      'masters/beat_assignments',
      'POST',
      { beat: p + 'B1', rep: p + 'FS1', from_date: '2026-06-01' },
      400,
      new RegExp(`${p}FS1 already has this beat from 2026-04-01 onwards`),
    );

    // ---------- Twelve outlets on the beat, in order, with their towns ----------
    const towns = ['Shyambazar', 'Baranagar', 'Dum Dum', 'Belgharia'];
    for (let n = 1; n <= 12; n++)
      await ok('reach/customers', 'POST', {
        code: `${p}R${String(n).padStart(2, '0')}`,
        type: p + 'RET',
        name: `Outlet ${n}`,
        territory: p + 'T1',
        beat: p + 'B1',
        town: towns[n % towns.length],
        answers: { [p.toLowerCase() + '_trade_name']: `Trade ${n}` },
      });
    let round = await ok(
      `reach/beats/${(await ok('masters/beats?q=' + (p + 'b1').toLowerCase())).items[0].id}/outlets`,
    );
    const beatId = round.beat.id;
    expect(round.items).toHaveLength(12);
    // In the order they were added, each with the town it was given.
    expect(round.items.map((o: any) => [o.sequence, o.code])).toEqual(
      Array.from({ length: 12 }, (_, i) => [i + 1, `${p}R${String(i + 1).padStart(2, '0')}`]),
    );
    expect(round.items.every((o: any) => o.town)).toBe(true);
    expect(round.beat.rep).toBe(p + 'FS1');

    // The milestone's own acceptance: a new customer joins its beat as it is made.
    const thirteenth = await ok('reach/customers', 'POST', {
      code: p + 'R13',
      type: p + 'RET',
      name: 'Outlet 13',
      territory: p + 'T1',
      beat: p + 'B1',
      town: 'Sinthee',
      answers: { [p.toLowerCase() + '_trade_name']: 'Trade 13' },
    });
    expect(thirteenth.message).toMatch(new RegExp(`added to beat ${p}B1 at stop 13`));
    expect(
      sql(`SELECT sequence FROM beat_outlets o JOIN trade_customers c ON c.id=o.customer_id
      WHERE c.code='${p}R13'`),
    ).toBe('13');

    // ---------- The per-type form is enforced ----------
    const missing = await rejected(
      'reach/customers',
      'POST',
      {
        code: p + 'RBAD',
        type: p + 'RET',
        name: 'No trade name',
        territory: p + 'T1',
        beat: p + 'B1',
        answers: {},
      },
      400,
      /Trade name is required/,
    );
    expect(missing.fields.map((f: any) => f.column)).toEqual([p.toLowerCase() + '_trade_name']);
    // A question this type is never asked cannot be smuggled into the record.
    await rejected(
      'reach/customers',
      'POST',
      {
        code: p + 'RBAD',
        type: p + 'RET',
        name: 'Not asked',
        territory: p + 'T1',
        beat: p + 'B1',
        answers: {
          [p.toLowerCase() + '_trade_name']: 'x',
          [p.toLowerCase() + '_gstin']: '27AAPFU0939F1ZV',
        },
      },
      400,
      /is not asked for/,
    );
    // A choice outside the list, and a GSTIN whose check digit does not hold.
    await rejected(
      'reach/customers',
      'POST',
      {
        code: p + 'RBAD',
        type: p + 'RET',
        name: 'Bad choice',
        territory: p + 'T1',
        beat: p + 'B1',
        answers: {
          [p.toLowerCase() + '_trade_name']: 'x',
          [p.toLowerCase() + '_shop_type']: 'Franchise',
        },
      },
      400,
      /one of: Exclusive, Multi-brand, General/,
    );
    // A type that walks a beat has to be on one.
    await rejected(
      'reach/customers',
      'POST',
      {
        code: p + 'RBAD',
        type: p + 'RET',
        name: 'No beat',
        territory: p + 'T1',
        answers: { [p.toLowerCase() + '_trade_name']: 'x' },
      },
      400,
      /is visited on a beat, so it needs one/,
    );

    // ---------- An account that needs approval ----------
    const dist = await ok('reach/customers', 'POST', {
      code: p + 'D1',
      type: p + 'DIST',
      name: 'Kolkata distributor',
      territory: p + 'T1',
      beat: p + 'B1',
      town: 'Howrah',
      answers: { [p.toLowerCase() + '_gstin']: '27aapfu0939f1zv' },
    });
    expect(dist.status).toBe('AWAITING_APPROVAL');
    expect(dist.message).toMatch(/sent for approval/);
    // Waiting means not yet a stop on the round.
    expect((await ok(`reach/beats/${beatId}/outlets`)).items).toHaveLength(13);
    // The GSTIN was stored the way it is written on the certificate.
    expect(
      sql(`SELECT attrs->>'${p.toLowerCase()}_gstin' FROM trade_customers WHERE code='${p}D1'`),
    ).toBe('27AAPFU0939F1ZV');
    // Active or dormant is not a way around the decision.
    const waiting = await find(p + 'd1');
    await rejected(
      `reach/customers/${waiting.id}/status`,
      'POST',
      { status: 'ACTIVE', version: waiting.version },
      409,
      /waiting for approval/,
    );
    const queue = await ok('reach/approvals');
    expect(queue.accounts.map((a: any) => a.code)).toEqual([p + 'D1']);
    // A rejection has to say why.
    await rejected(
      `reach/approvals/accounts/${waiting.id}`,
      'POST',
      { approve: false, version: waiting.version },
      400,
      /Say why the account is rejected/,
    );
    const approved = await ok(`reach/approvals/accounts/${waiting.id}`, 'POST', {
      approve: true,
      version: waiting.version,
      reason: 'Papers checked',
    });
    expect(approved.message).toMatch(new RegExp(`approved and added to beat ${p}B1`));
    expect((await ok(`reach/beats/${beatId}/outlets`)).items).toHaveLength(14);
    // And it cannot be decided twice.
    await rejected(
      `reach/approvals/accounts/${waiting.id}`,
      'POST',
      { approve: true, version: waiting.version + 1 },
      409,
      /already active/,
    );

    // ---------- The walking order ----------
    const current = (await ok(`reach/beats/${beatId}/outlets`)).items;
    const reversed = [...current].reverse().map((o: any) => o.customer_id);
    const reorder = await ok(`reach/beats/${beatId}/outlets`, 'PUT', { order: reversed });
    expect(reorder.message).toMatch(/14 stops/);
    const after = (await ok(`reach/beats/${beatId}/outlets`)).items;
    expect(after.map((o: any) => o.code)).toEqual([...current].reverse().map((o: any) => o.code));
    expect(after.map((o: any) => o.sequence)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    // An order that is not the whole round, or that repeats a stop, is refused.
    await rejected(
      `reach/beats/${beatId}/outlets`,
      'PUT',
      { order: reversed.slice(0, 5) },
      409,
      /stops on this beat changed/,
    );
    await rejected(
      `reach/beats/${beatId}/outlets`,
      'PUT',
      { order: [...reversed.slice(1), reversed[1]] },
      400,
      /same stop appears twice/,
    );

    // ---------- Dormant leaves the round; active rejoins it ----------
    const first = await find(p + 'r01');
    const slept = await ok(`reach/customers/${first.id}/status`, 'POST', {
      status: 'DORMANT',
      version: first.version,
    });
    expect(slept.message).toMatch(/dormant and off its beat/);
    expect((await ok(`reach/beats/${beatId}/outlets`)).items).toHaveLength(13);
    const woken = await find(p + 'r01');
    await ok(`reach/customers/${woken.id}/status`, 'POST', {
      status: 'ACTIVE',
      version: woken.version,
    });
    const back = (await ok(`reach/beats/${beatId}/outlets`)).items;
    expect(back).toHaveLength(14);
    expect(back[back.length - 1].code).toBe(p + 'R01');

    // ---------- The location tag ----------
    const shop = await find(p + 'r02');
    const typed = await ok(`reach/customers/${shop.id}/geo`, 'POST', {
      ...SHOP,
      source: 'TYPED',
    });
    expect([typed.status, typed.moved, typed.verified]).toEqual(['APPLIED', null, false]);
    const fix = await ok(`reach/customers/${shop.id}/geo`, 'POST', {
      ...SHOP,
      source: 'DEVICE',
      accuracy_m: 20,
    });
    expect([fix.status, fix.verified]).toEqual(['APPLIED', true]);
    expect(fix.message).toMatch(/verified by the device fix/);
    // Only a device fix carries an accuracy, and a coordinate off the planet is a typo.
    await rejected(
      `reach/customers/${shop.id}/geo`,
      'POST',
      { ...SHOP, source: 'TYPED', accuracy_m: 5 },
      400,
      /Only a device fix has an accuracy/,
    );
    await rejected(
      `reach/customers/${shop.id}/geo`,
      'POST',
      { latitude: 200, longitude: 88, source: 'TYPED' },
      400,
      /between -90 and 90/,
    );
    // A move beyond what a rep may do alone waits, and the shop does not move meanwhile.
    const moving = await ok(`reach/customers/${shop.id}/geo`, 'POST', {
      ...FAR,
      source: 'PIN',
      reason: 'Shop moved up the road',
    });
    expect([moving.status, moving.moved, moving.needsApproval]).toEqual(['PENDING', 1112, true]);
    expect(moving.message).toMatch(/more than the 100 m allowed/);
    expect(sql(`SELECT round(latitude,4) FROM trade_customers WHERE code='${p}R02'`)).toBe(
      '22.5726',
    );
    // One request at a time.
    await rejected(
      `reach/customers/${shop.id}/geo`,
      'POST',
      { ...FAR, source: 'PIN' },
      409,
      /already has a move waiting/,
    );
    const retag = (await ok('reach/approvals')).retags[0];
    expect([retag.code, retag.moved_m]).toEqual([p + 'R02', 1112]);
    await rejected(
      `reach/approvals/retags/${retag.id}`,
      'POST',
      { approve: false },
      400,
      /Say why the move is rejected/,
    );
    const moved = await ok(`reach/approvals/retags/${retag.id}`, 'POST', {
      approve: true,
      reason: 'Seen on the ground',
    });
    expect(moved.message).toMatch(/moved 1112 m/);
    expect(sql(`SELECT round(latitude,4) FROM trade_customers WHERE code='${p}R02'`)).toBe(
      '22.5826',
    );
    expect((await ok('reach/approvals')).retags).toHaveLength(0);
    // A second shop tagged yards away is reported as a possible duplicate.
    const neighbour = await find(p + 'r03');
    const near = await ok(`reach/customers/${neighbour.id}/geo`, 'POST', {
      latitude: 22.58261,
      longitude: 88.36391,
      source: 'TYPED',
    });
    expect(near.nearby.map((n: any) => n.code)).toEqual([p + 'R02']);
    // A rejected move leaves the tag where it was.
    const away = await ok(`reach/customers/${neighbour.id}/geo`, 'POST', {
      latitude: 22.6,
      longitude: 88.4,
      source: 'PIN',
      reason: 'Wrong place',
    });
    expect(away.status).toBe('PENDING');
    const second = (await ok('reach/approvals')).retags[0];
    await ok(`reach/approvals/retags/${second.id}`, 'POST', {
      approve: false,
      reason: 'That is a different shop',
    });
    expect(sql(`SELECT round(latitude,4) FROM trade_customers WHERE code='${p}R03'`)).toBe(
      '22.5826',
    );

    // ---------- The register: filters, totals and the file ----------
    const listed = await ok('reach/customers?limit=10');
    expect([listed.total, listed.pageSize, listed.items.length]).toEqual([14, 10, 10]);
    expect(listed.tiles).toMatchObject({ total: 14, active: 14, awaiting: 0 });
    expect((await register(`type=${p}DIST`)).map((c: any) => c.code)).toEqual([p + 'D1']);
    expect((await register('geo=verified')).length).toBe(0);
    expect((await register('geo=tagged')).map((c: any) => c.code)).toEqual([p + 'R02', p + 'R03']);
    expect((await register('q=' + (p + 'r0').toLowerCase())).length).toBe(9);
    // A filter the screen never offers is refused rather than ignored.
    await rejected(
      'reach/customers?status=DELETED',
      'GET',
      undefined,
      400,
      /Status must be one of/,
    );
    await rejected(
      'reach/customers?geo=all',
      'GET',
      undefined,
      400,
      /tagged, untagged or verified/,
    );
    expect((await call('reach/customers?cursor=not-a-cursor')).status()).toBe(400);
    const csv = await call('reach/customers.csv?type=' + p + 'DIST');
    expect(csv.headers()['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers()['content-disposition']).toMatch(/^attachment;/);
    const csvText = await csv.text();
    expect(csvText.split('\r\n')[0]).toBe(
      'code,name,type,status,territory,beat,beat_sequence,town,phone,rep,buys_from,latitude,longitude,location_verified',
    );
    expect(csvText).toContain(p + 'D1');

    // ---------- Removal ----------
    const dealerUnder = await find(p + 'r04');
    await ok(`reach/customers/${dealerUnder.id}`, 'PATCH', {
      name: dealerUnder.name,
      territory: p + 'T1',
      beat: p + 'B1',
      town: dealerUnder.town,
      phone: '',
      rep: '',
      buys_from: p + 'D1',
      sales_customer: '',
      answers: dealerUnder.attrs,
      version: dealerUnder.version,
    });
    const distRow = await find(p + 'd1');
    await rejected(
      `reach/customers/${distRow.id}`,
      'DELETE',
      { version: distRow.version },
      409,
      /1 customer buys from it/,
    );
    const last = await find(p + 'r12');
    const removed = await ok(`reach/customers/${last.id}`, 'DELETE', {
      version: last.version,
      reason: 'Shop closed',
    });
    expect(removed.message).toMatch(/off the register but kept in the records/);
    expect(
      sql(`SELECT count(*) FROM trade_customers WHERE code='${p}R12' AND deleted_at IS NOT NULL
      AND delete_reason='Shop closed'`),
    ).toBe('1');
    expect(await find(p + 'r12')).toBeUndefined();
    expect(
      sql(`SELECT count(*) FROM beat_outlets o JOIN trade_customers c ON c.id=o.customer_id
      WHERE c.code='${p}R12'`),
    ).toBe('0');
    // And the code is free again.
    await ok('reach/customers', 'POST', {
      code: p + 'R12',
      type: p + 'RET',
      name: 'New shop at the old code',
      territory: p + 'T1',
      beat: p + 'B1',
      town: 'Sinthee',
      answers: { [p.toLowerCase() + '_trade_name']: 'Reused' },
    });
    expect(sql(`SELECT count(*) FROM trade_customers WHERE code='${p}R12'`)).toBe('2');

    // ---------- Reach settings ----------
    const settings = await ok('reach/settings');
    settingsBefore = settings.settings;
    expect(settings.settings).toMatchObject({
      gps_verified_m: 50,
      duplicate_within_m: 30,
      retag_approval_m: 100,
      kyc_reminder_days: 7,
      version: 0,
    });
    await ok('reach/settings', 'PUT', {
      gps_verified_m: 25,
      duplicate_within_m: 30,
      retag_approval_m: 250,
      kyc_reminder_days: 7,
      version: 0,
    });
    expect((await ok('reach/settings')).settings).toMatchObject({
      gps_verified_m: 25,
      retag_approval_m: 250,
      version: 1,
    });
    await rejected(
      'reach/settings',
      'PUT',
      {
        gps_verified_m: 25,
        duplicate_within_m: 30,
        retag_approval_m: 250,
        kyc_reminder_days: 7,
        version: 0,
      },
      409,
      /changed elsewhere/,
    );
    await rejected(
      'reach/settings',
      'PUT',
      {
        gps_verified_m: 1,
        duplicate_within_m: 30,
        retag_approval_m: 250,
        kyc_reminder_days: 7,
        version: 1,
      },
      400,
      /whole number from 5 to 1000/,
    );
    // The new limit is the one a move is measured against from now on.
    const afterSetup = await find(p + 'r05');
    const within = await ok(`reach/customers/${afterSetup.id}/geo`, 'POST', {
      ...SHOP,
      source: 'TYPED',
    });
    expect(within.status).toBe('APPLIED');
    const stillInside = await ok(`reach/customers/${afterSetup.id}/geo`, 'POST', {
      latitude: 22.5744,
      longitude: 88.3639,
      source: 'TYPED',
    });
    expect([stillInside.status, stillInside.moved! < 250]).toEqual(['APPLIED', true]);

    // ---------- Readiness ----------
    const readiness = await ok('reach/readiness');
    const row = (key: string) => readiness.items.find((i: any) => i.key === key);
    expect(row('customer_types').status).toBe('ready');
    expect(row('customer_form').status).toBe('ready');
    expect(row('beats').status).toBe('ready');
    expect(row('customers').status).toBe('ready');
    expect(row('customers').detail).toMatch(/on the register/);

    // ---------- The screens ----------
    await page.reload();
    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(page, 'Customer register');
    await expect(page.locator('.tile').first()).toContainText('On the register');
    await page.getByLabel('Customer search').fill(p + 'R02');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('cell', { name: p + 'R02', exact: true })).toBeVisible();
    await page.getByRole('button', { name: `Open customer ${p}R02` }).click();
    await expect(page.getByRole('heading', { name: new RegExp(p + 'R02') })).toBeVisible();
    // The location panel draws the plane and the history of every tag.
    await expect(page.locator('.geo-plane svg')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Location' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'APPROVED' })).toBeVisible();
    await page.getByRole('button', { name: '← Back to the register' }).click();
    // Creating one through the screen asks that type's own questions.
    await page.getByRole('button', { name: 'Create customer' }).click();
    await page.getByLabel('Customer type *').selectOption(p + 'RET');
    await page.getByLabel('Customer code *').fill(p + 'UI1');
    // A type's own questions can include one whose label ends in the same words, such as
    // "Trade name", so the base field is named exactly rather than by what it contains.
    await page.getByLabel('Name *', { exact: true }).fill('Made on the screen');
    await page.getByLabel('Territory code *').fill(p + 'T1');
    await page.getByRole('button', { name: 'Save customer' }).click();
    await expect(page.locator('small.warning').first()).toContainText('is visited on a beat');
    await page.getByLabel('Beat code').fill(p + 'B1');
    await page.getByRole('button', { name: 'Save customer' }).click();
    await expect(page.locator('small.warning').first()).toContainText('Trade name is required');
    await page.getByLabel('Trade name *').fill('Screen trade');
    await page.getByLabel('Shop type').selectOption('Exclusive');
    await page.getByRole('button', { name: 'Save customer' }).click();
    await expect(page.getByText(new RegExp(`${p}UI1 created and added to beat`))).toBeVisible();
    // The round shows the stops in order and can be re-arranged.
    await openScreen(page, 'Beat round');
    await expect(page.getByRole('heading', { name: new RegExp(`${p}B1`) })).toBeVisible();
    const firstRow = page.locator('tbody tr').first();
    const firstCode = (await firstRow.locator('td').nth(1).innerText()).trim();
    await page.getByRole('button', { name: `Move ${firstCode} later` }).click();
    await page.getByRole('button', { name: 'Save this order' }).click();
    await expect(page.getByText(/stops in this order/)).toBeVisible();
    await expect(page.locator('tbody tr').nth(1).locator('td').nth(1)).toHaveText(firstCode);

    // ---------- Another company's register is invisible ----------
    sql(`BEGIN;
      INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','RCH1 isolation ${suffix}','RC1${suffix}');
      INSERT INTO territories(id,tenant_id,code,name) VALUES(gen_random_uuid(),'${otherCompany}','HID-T','Hidden');
      INSERT INTO customer_types(id,tenant_id,code,name) VALUES(gen_random_uuid(),'${otherCompany}','HID-TYPE','Hidden type');
      INSERT INTO trade_customers(id,tenant_id,code,name,type_id,territory_id,status)
        SELECT '${hiddenCustomer}','${otherCompany}','${p}HIDDEN','Hidden shop',
          (SELECT id FROM customer_types WHERE tenant_id='${otherCompany}'),
          (SELECT id FROM territories WHERE tenant_id='${otherCompany}'),'ACTIVE';
      COMMIT;`);
    expect(await register('q=' + (p + 'hidden').toLowerCase())).toHaveLength(0);
    expect((await call(`reach/customers/${hiddenCustomer}`)).status()).toBe(404);
    await rejected(`reach/customers/${hiddenCustomer}`, 'DELETE', { version: 1 }, 404, /not found/);
    await rejected(
      `reach/customers/${hiddenCustomer}/geo`,
      'POST',
      { ...SHOP, source: 'TYPED' },
      404,
      /not found/,
    );
    expect((await ok('reach/approvals')).accounts.some((a: any) => a.code === p + 'HIDDEN')).toBe(
      false,
    );

    // ---------- Who may read, maintain, approve, set up and remove ----------
    readerRole = (
      await ok('roles', 'POST', {
        name: 'Field reader ' + suffix,
        permissions: ['dashboard.read', 'reach.read'],
      })
    ).id;
    approverRole = (
      await ok('roles', 'POST', {
        name: 'Sales head ' + suffix,
        permissions: ['dashboard.read', 'reach.read', 'reach.approve'],
      })
    ).id;
    await ok('users', 'POST', {
      requestId: readerId,
      name: 'Field Ops',
      email: readerEmail,
      roleId: readerRole,
    });
    readerIdentity = sql(`SELECT identity_id FROM app_users WHERE id='${readerId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + readerIdentity + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Reach-Ops-2026!', temporary: false },
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
    const signIn = async (context: any) => {
      const sheet = await context.newPage();
      await sheet.goto(env.APP_URL + '/api/auth/login');
      await sheet.locator('#username').fill(readerEmail);
      await sheet.locator('#password').fill('Reach-Ops-2026!');
      await sheet.locator('#kc-login').click();
      await completeTestMfa(sheet, readerEmail);
      await expect(sheet.locator('.main > header')).toBeVisible();
      const context2 = await (await sheet.request.get('/api/me')).json();
      return {
        sheet,
        send: (path: string, method = 'GET', data?: unknown) =>
          sheet.request.fetch('/api/' + path, {
            method,
            headers: { Origin: env.APP_URL, 'X-CSRF-Token': context2.csrfToken },
            data,
          }),
      };
    };
    readerContext = await browser.newContext();
    const reader = await signIn(readerContext);
    const aShop = await find(p + 'r06');
    // Reading is allowed.
    expect((await reader.send('reach/customers')).status()).toBe(200);
    expect((await reader.send(`reach/customers/${aShop.id}`)).status()).toBe(200);
    expect((await reader.send('reach/settings')).status()).toBe(200);
    expect((await reader.send(`reach/beats/${beatId}/outlets`)).status()).toBe(200);
    // Everything that writes, decides or sets up is not.
    for (const [path, method, data] of [
      [
        'reach/customers',
        'POST',
        { code: p + 'X1', type: p + 'RET', name: 'x', territory: p + 'T1' },
      ],
      [`reach/customers/${aShop.id}`, 'PATCH', { name: 'x', version: aShop.version }],
      [`reach/customers/${aShop.id}`, 'DELETE', { version: aShop.version }],
      [`reach/customers/${aShop.id}/status`, 'POST', { status: 'DORMANT', version: aShop.version }],
      [`reach/customers/${aShop.id}/geo`, 'POST', { ...SHOP, source: 'TYPED' }],
      [`reach/beats/${beatId}/outlets`, 'PUT', { order: [aShop.id] }],
      ['reach/approvals', 'GET', undefined],
      [`reach/approvals/accounts/${aShop.id}`, 'POST', { approve: true, version: aShop.version }],
      [
        'reach/settings',
        'PUT',
        {
          gps_verified_m: 50,
          duplicate_within_m: 30,
          retag_approval_m: 100,
          kyc_reminder_days: 7,
          version: 1,
        },
      ],
      ['masters/customer_types', 'POST', { code: p + 'X', name: 'x' }],
      ['masters/beats', 'POST', { code: p + 'X', name: 'x', territory: p + 'T1', run_days: 'MON' }],
    ] as const)
      expect((await reader.send(path, method, data)).status(), `${method} ${path}`).toBe(403);
    // And the screens offer none of it.
    await reader.sheet.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(reader.sheet, 'Customer register');
    await expect(reader.sheet.getByRole('button', { name: 'Create customer' })).toHaveCount(0);
    await expect(reader.sheet.getByRole('button', { name: /^Remove customer/ })).toHaveCount(0);
    await expect(reader.sheet.getByRole('tab', { name: 'Approvals' })).toHaveCount(0);
    await openScreen(reader.sheet, 'Reach settings');
    await expect(reader.sheet.getByRole('button', { name: 'Save settings' })).toHaveCount(0);
    await expect(
      reader.sheet.getByText('You can see these settings but not change them'),
    ).toBeVisible();

    // A Sales Head decides, but still does not maintain or set up.
    sql(`UPDATE app_users SET role_id='${approverRole}' WHERE id='${readerId}'`);
    approverContext = await browser.newContext();
    const approver = await signIn(approverContext);
    expect((await approver.send('reach/approvals')).status()).toBe(200);
    expect(
      (
        await approver.send('reach/customers', 'POST', {
          code: p + 'X2',
          type: p + 'RET',
          name: 'x',
          territory: p + 'T1',
        })
      ).status(),
    ).toBe(403);
    expect(
      (
        await approver.send('reach/settings', 'PUT', {
          gps_verified_m: 50,
          duplicate_within_m: 30,
          retag_approval_m: 100,
          kyc_reminder_days: 7,
          version: 1,
        })
      ).status(),
    ).toBe(403);
    // Without the CSRF token nothing is decided, whatever the session says.
    expect(
      (
        await approver.sheet.request.fetch(`/api/reach/approvals/accounts/${aShop.id}`, {
          method: 'POST',
          headers: { Origin: env.APP_URL },
          data: { approve: true, version: aShop.version },
        })
      ).status(),
    ).toBe(403);
  } finally {
    await readerContext?.close();
    await approverContext?.close();
    if (readerIdentity)
      await request.delete(env.AUTH_URL + '/admin/realms/rare-os/users/' + readerIdentity, {
        headers: kcHeaders,
      });
    sql(`DELETE FROM user_sites WHERE user_id='${readerId}';
      DELETE FROM app_users WHERE id='${readerId}';`);
    for (const role of [readerRole, approverRole].filter(Boolean))
      sql(
        `DELETE FROM role_permissions WHERE role_id='${role}'; DELETE FROM roles WHERE id='${role}';`,
      );
    sql(`DELETE FROM customer_geo_log WHERE tenant_id='${otherCompany}';
      DELETE FROM beat_outlets WHERE tenant_id='${otherCompany}';
      DELETE FROM trade_customers WHERE tenant_id='${otherCompany}';
      DELETE FROM customer_types WHERE tenant_id='${otherCompany}';
      DELETE FROM territories WHERE tenant_id='${otherCompany}';
      DELETE FROM tenants WHERE id='${otherCompany}';`);
    sql(`DELETE FROM customer_geo_log WHERE customer_id IN (SELECT id FROM trade_customers WHERE code LIKE '${p}%');
      DELETE FROM beat_outlets WHERE customer_id IN (SELECT id FROM trade_customers WHERE code LIKE '${p}%');
      UPDATE trade_customers SET buys_from_id=NULL WHERE code LIKE '${p}%';
      DELETE FROM trade_customers WHERE code LIKE '${p}%';
      DELETE FROM beat_assignments WHERE beat_id IN (SELECT id FROM beats WHERE code LIKE '${p}%');
      DELETE FROM beats WHERE code LIKE '${p}%';
      DELETE FROM customer_form_rules WHERE type_id IN (SELECT id FROM customer_types WHERE code LIKE '${p}%');
      DELETE FROM customer_form_fields WHERE field_key LIKE '${p.toLowerCase()}%';
      DELETE FROM customer_types WHERE code LIKE '${p}%';
      DELETE FROM field_reps WHERE code LIKE '${p}%';
      DELETE FROM rep_grades WHERE code LIKE '${p}%';
      DELETE FROM territories WHERE code LIKE '${p}%';
      DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE kind='customer_types');
      DELETE FROM import_batches WHERE kind='customer_types';`);
    // Put the company's Reach settings back exactly as they were: no row if there was none.
    if (settingsBefore)
      sql(
        settingsBefore.version === 0
          ? `DELETE FROM reach_settings WHERE tenant_id=(SELECT id FROM tenants WHERE active LIMIT 1)`
          : `UPDATE reach_settings SET gps_verified_m=${settingsBefore.gps_verified_m},
               duplicate_within_m=${settingsBefore.duplicate_within_m},
               retag_approval_m=${settingsBefore.retag_approval_m},
               kyc_reminder_days=${settingsBefore.kyc_reminder_days}
             WHERE tenant_id=(SELECT id FROM tenants WHERE active LIMIT 1)`,
      );
  }
});
