// RCH-0 Reach foundation (developer handover 27-Oct-2026). Its own acceptance test is: a rep's
// master loads from a file, a selfie uploads and comes back, and a record that is 'removed' leaves
// the list but is still in the database. Everything around that is here too: the field masters and
// their rules, the readiness checklist, and the boundaries — who may read, maintain and remove,
// what a company may see of another company, and what an upload may be.
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

// A real 1x1 PNG, so the browser can draw it and the server can measure it.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n%%EOF\n')]);
// The same image with one byte of padding: still a valid PNG, but a different checksum, so it
// would land at a path of its own if it were ever written.
const PNG_PADDED = Buffer.concat([PNG, Buffer.from([0])]);
// How many files the volume holds. The bytes live on a disk volume, so 'nothing was written' is a
// question about the disk, not about the database.
const filesOnDisk = () =>
  Number(
    execFileSync(
      'docker',
      ['compose', 'exec', '-T', 'api', 'sh', '-c', 'find "$FILE_STORE_DIR" -type f | wc -l'],
      { encoding: 'utf8' },
    ).trim(),
  );

test('RCH-0 Reach foundation: field masters, photos, soft delete, imports, isolation and permissions', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(420000);
  const suffix = Date.now().toString().slice(-6),
    p = 'R' + suffix,
    userId = randomUUID(),
    email = `fieldadmin.${suffix}@example.test`,
    readerId = randomUUID(),
    readerEmail = `fieldreader.${suffix}@example.test`,
    otherCompany = randomUUID(),
    hiddenTerritory = randomUUID(),
    hiddenFile = randomUUID();
  let readerRole = '',
    plainRole = '',
    readerIdentity = '',
    readerContext: any,
    plainContext: any;
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
  const find = async (kind: string, q: string) =>
    (await ok(`masters/${kind}?q=${encodeURIComponent(q.toLowerCase())}`)).items;
  const uploadFile = (bytes: Buffer, type: string, purpose = 'selfie', name = 'selfie.png') =>
    withRateLimitRetry(() =>
      page.request.fetch(`/api/files?purpose=${purpose}&name=${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: {
          Origin: env.APP_URL,
          'X-CSRF-Token': me.csrfToken,
          'Content-Type': type,
        },
        data: bytes,
      }),
    );
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
    const body = await r.json();
    expect(r.ok(), JSON.stringify(body)).toBe(true);
    const batch = await settled(body.id);
    await ok(`imports/${batch.id}/commit`, 'POST', { version: batch.version });
    return settled(batch.id);
  };

  try {
    // ---------- The module is there, and starts almost empty ----------
    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Field data readiness' })).toBeVisible();
    // Storage is ready before anything else: the volume is there whether or not a photo is.
    await expect(page.locator('.readiness-row[data-status="ready"]')).toHaveCount(1);
    // The six rows this milestone owns. Later milestones add rows of their own, so the checklist
    // is read by name rather than by length.
    const ownRows = [
      'Territories',
      'Rep grades',
      'Field reps',
      'Leave types',
      'Holiday list',
      'Photo and document storage',
    ];
    for (const row of ownRows)
      await expect(page.locator('.readiness-row', { hasText: row })).toHaveCount(1);
    await expect(
      page.locator('.readiness-row', { hasText: 'Photo and document storage' }),
    ).toContainText('Ready');

    // ---------- Territories: a zone, a territory under it, and no third level ----------
    await openScreen(page, 'Territories');
    await page.getByRole('button', { name: 'Create territory' }).click();
    await page.getByLabel('Territory code *').fill(p + 'EAST');
    await page.getByLabel('Name *').fill('East zone');
    await page.getByRole('button', { name: 'Save territory' }).click();
    await expect(page.getByText(`Territory ${p}EAST created.`)).toBeVisible();

    await page.getByRole('button', { name: 'Create territory' }).click();
    await page.getByLabel('Territory code *').fill(p + 'T1');
    await page.getByLabel('Name *').fill('Kolkata city');
    await page.getByLabel('Parent territory').fill(p + 'NOPE');
    await page.getByRole('button', { name: 'Save territory' }).click();
    await expect(page.locator('small.warning')).toHaveText(
      `Territory ${p}NOPE was not found. Create it first.`,
    );
    await page.getByLabel('Parent territory').fill(p.toLowerCase() + 'east');
    await page.getByRole('button', { name: 'Save territory' }).click();
    await expect(page.getByText(`Territory ${p}T1 created.`)).toBeVisible();
    await expect(page.getByRole('cell', { name: p + 'EAST', exact: true })).toHaveCount(2);

    // Two levels only: a territory that already has a parent cannot become one.
    await rejected(
      'masters/territories',
      'POST',
      { code: p + 'T2', name: 'Deeper', parent: p + 'T1' },
      400,
      /already sits under another territory/,
    );
    const zone = (await find('territories', p + 'east'))[0];
    const town = (await find('territories', p + 't1'))[0];
    // A territory that already has a parent cannot be a parent either, so that is what is said.
    await rejected(
      `masters/territories/${zone.id}`,
      'PATCH',
      { name: 'East zone', parent: p + 'T1', active: true, version: zone.version },
      400,
      /already sits under another territory/,
    );
    // And a territory that has territories of its own cannot move under a top-level one, because
    // that would make a third level out of its children.
    await ok('masters/territories', 'POST', { code: p + 'WEST', name: 'West zone' });
    await rejected(
      `masters/territories/${zone.id}`,
      'PATCH',
      { name: 'East zone', parent: p + 'WEST', active: true, version: zone.version },
      400,
      new RegExp(`already has ${p}T1 under it`),
    );
    // And nothing may be its own parent.
    await rejected(
      `masters/territories/${zone.id}`,
      'PATCH',
      { name: 'East zone', parent: p + 'EAST', active: true, version: zone.version },
      400,
      /cannot be its own parent/,
    );

    // ---------- The rest of the field masters ----------
    await ok('masters/rep_grades', 'POST', { code: p + 'SO', name: 'Sales Officer', rank: '1' });
    // Seniority defaults to 1 when the column is left blank, as a spreadsheet often does.
    const asm = await ok('masters/rep_grades', 'POST', { code: p + 'ASM', name: 'ASM' });
    expect(asm.message).toMatch(/created/);
    expect((await find('rep_grades', p + 'asm'))[0].rank).toBe(1);
    await ok('masters/leave_types', 'POST', {
      code: p + 'CL',
      name: 'Casual leave',
      paid: true,
      annual_quota: '12.5',
      carry_forward: false,
      requires_approval: true,
    });
    await ok('masters/holidays', 'POST', { holiday_date: '2026-01-26', name: 'Republic Day' });
    // The same day twice is the same holiday.
    await rejected(
      'masters/holidays',
      'POST',
      { holiday_date: '2026-01-26', name: 'Again' },
      409,
      /already exists/,
    );
    // A regional holiday on the same day is a different record.
    await ok('masters/holidays', 'POST', {
      holiday_date: '2026-01-26',
      name: 'Regional too',
      holiday_type: 'REGIONAL',
      territory: p + 'T1',
    });

    // ---------- A field rep, through the screen ----------
    await openScreen(page, 'Field reps');
    await page.getByRole('button', { name: 'Create field rep' }).click();
    await page.getByLabel('Rep code *').fill(p + 'FS1');
    await page.getByLabel('Name *').fill('Kiran Patil');
    await page.getByLabel('Grade code *').fill(p + 'SO');
    await page.getByLabel('Territory code *').fill(p + 'T1');
    await page.getByLabel('Login email').fill('nobody.' + suffix + '@example.test');
    await page.getByRole('button', { name: 'Save field rep' }).click();
    await expect(page.locator('small.warning')).toContainText('Invite the user first');
    await page.getByLabel('Login email').fill('');
    await page.getByLabel('Joined on').fill('2024-04-01');
    await page.getByRole('button', { name: 'Save field rep' }).click();
    await expect(page.getByText(`Field rep ${p}FS1 created.`)).toBeVisible();
    const rep = (await find('field_reps', p + 'fs1'))[0];
    expect([rep.grade, rep.territory, rep.user, rep.joined_on]).toEqual([
      p + 'SO',
      p + 'T1',
      '',
      '2024-04-01',
    ]);

    // ---------- The rep list from a file, through the same import engine ----------
    const template = await (await call('imports/templates/field_reps')).text();
    const header = template.split('\r\n')[0];
    // The columns this milestone owns. Later milestones add their own to the same import, so the
    // header is checked for these rather than pinned to exactly these, and the rows below are
    // laid out from whatever the template actually says.
    expect(header.split(',')).toEqual(
      expect.arrayContaining([
        'code',
        'name',
        'grade',
        'territory',
        'user',
        'email',
        'phone',
        'joined_on',
      ]),
    );
    const rows = [2, 3, 4]
      .map((n) => {
        const values: Record<string, string> = {
          code: `${p}FS${n}`,
          name: `Imported rep ${n}`,
          grade: `${p}SO`,
          territory: `${p}T1`,
          email: `rep${n}.${suffix}@example.test`,
          joined_on: `2025-07-0${n}`,
        };
        return header
          .split(',')
          .map((column) => values[column] ?? '')
          .join(',');
      })
      .join('\r\n');
    await openScreen(page, 'Imports');
    // The import kinds this milestone owns. Later milestones add their own to the same picker,
    // so each is looked for rather than the whole list being pinned.
    for (const kind of ['Territories', 'Rep grades', 'Field reps', 'Leave types', 'Holidays'])
      await expect(page.getByLabel('Import type').locator('option', { hasText: kind })).toHaveCount(
        1,
      );
    const imported = await importCsv('field_reps', `${header}\r\n${rows}\r\n`, 'reps.csv');
    expect(imported.status).toBe('committed');
    expect(imported.summary).toMatchObject({ created: 3 });
    // The very same bytes are refused outright: a file is committed once per kind.
    const duplicate = await call('imports/field_reps', 'POST', `${header}\r\n${rows}\r\n`, {
      'Content-Type': 'text/csv',
      'X-File-Name': 'reps.csv',
    });
    expect(duplicate.status()).toBe(409);
    expect((await duplicate.json()).error.code).toBe('FILE_ALREADY_IMPORTED');
    // The same three records in a different order are a different file, and still change nothing:
    // the import decides per record, so re-running it is safe.
    const reordered = rows.split('\r\n').reverse().join('\r\n');
    const replay = await importCsv('field_reps', `${header}\r\n${reordered}\r\n`, 'reps-again.csv');
    expect(replay.summary).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await find('field_reps', p + 'fs')).toHaveLength(4);

    // ---------- A selfie: uploaded, stored off the database, and served back ----------
    const uploaded = await uploadFile(PNG, 'image/png');
    const file = await uploaded.json();
    expect(uploaded.status(), JSON.stringify(file)).toBe(201);
    expect([file.contentType, file.byteSize, file.pixelWidth, file.pixelHeight]).toEqual([
      'image/png',
      PNG.length,
      1,
      1,
    ]);
    // The bytes are not in the database: only the handle is.
    expect(sql(`SELECT storage_key FROM stored_files WHERE id='${file.id}'`)).toMatch(
      /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/,
    );
    await ok(`reach/field-reps/${rep.id}/photo`, 'PUT', { fileId: file.id });
    const served = await call(`files/${file.id}`);
    expect(served.status()).toBe(200);
    expect(served.headers()['content-type']).toBe('image/png');
    expect(served.headers()['x-content-type-options']).toBe('nosniff');
    expect(served.headers()['content-disposition']).toMatch(/^inline;/);
    expect((await served.body()).equals(PNG)).toBe(true);
    // A PDF is handed over as a download, so nothing inside it ever runs in our origin.
    const doc = await (await uploadFile(PDF, 'application/pdf', 'kyc', 'kyc.pdf')).json();
    expect((await call(`files/${doc.id}`)).headers()['content-disposition']).toMatch(
      /^attachment;/,
    );
    // A rep's photo has to have been uploaded as a selfie.
    await rejected(
      `reach/field-reps/${rep.id}/photo`,
      'PUT',
      { fileId: doc.id },
      400,
      /has to be uploaded as a selfie/,
    );

    // The screen shows it, and can take it off again.
    await page.reload();
    await page.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(page, 'Field reps');
    await page.getByRole('button', { name: `Photo of field rep ${p}FS1` }).click();
    const photo = page.locator('img.rep-photo');
    await expect(photo).toBeVisible();
    await expect(photo).toHaveAttribute('src', `/api/files/${file.id}`);
    await page.getByRole('button', { name: 'Remove photo' }).click();
    await expect(page.getByText(`Photo removed from field rep ${p}FS1.`)).toBeVisible();
    expect(sql(`SELECT photo_file_id IS NULL FROM field_reps WHERE id='${rep.id}'`)).toBe('t');
    // The file itself is still there; taking it off a rep is not deleting it.
    expect((await call(`files/${file.id}`)).status()).toBe(200);
    // 'Close', not the dialog's own 'Close form' cross.
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.locator('img.rep-photo')).toHaveCount(0);

    // ---------- Removal: off the list, still in the database, code free again ----------
    await openScreen(page, 'Holidays');
    await expect(page.getByRole('cell', { name: 'Republic Day', exact: true })).toBeVisible();
    // Two holidays share this date, so the label has to say which one: date and name together.
    await page.getByRole('button', { name: 'Remove holiday 2026-01-26 Republic Day' }).click();
    await page.getByLabel('Reason (optional)').fill('Entered twice');
    await page.getByRole('button', { name: 'Confirm remove' }).click();
    await expect(
      page.getByText(/removed\. It is off the list but kept in the records\./),
    ).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Republic Day', exact: true })).toHaveCount(0);
    expect(
      sql(
        `SELECT count(*) FROM holidays WHERE holiday_date='2026-01-26' AND name='Republic Day' AND deleted_at IS NOT NULL AND delete_reason='Entered twice'`,
      ),
    ).toBe('1');
    // The day is free to enter again, and the removed row stays beside the new one.
    await ok('masters/holidays', 'POST', { holiday_date: '2026-01-26', name: 'Republic Day' });
    expect(sql(`SELECT count(*) FROM holidays WHERE holiday_date='2026-01-26'`)).toBe('3');

    // A master that something still points at is not removable.
    await rejected(
      `masters/territories/${town.id}`,
      'DELETE',
      { version: town.version },
      409,
      /4 field reps still use it/,
    );
    await rejected(
      `masters/territories/${zone.id}`,
      'DELETE',
      { version: zone.version },
      409,
      /1 territory still uses it/,
    );
    // A planning master has no removal at all: it is deactivated, so everything still reads.
    const anyUnit = await ok('units', 'POST', { code: p + 'UOM', name: 'Unit', decimals: 0 });
    expect(anyUnit.id).toBeTruthy();
    const items = await ok('masters/items');
    expect(items.pageSize).toBe(25);
    const catalogue = await ok('masters');
    // The masters this milestone registers. Later milestones add their own to the same module,
    // so the catalogue is checked for these rather than pinned to exactly these.
    expect(
      catalogue.kinds.filter((k: any) => k.module === 'Reach').map((k: any) => k.kind),
    ).toEqual(
      expect.arrayContaining([
        'territories',
        'rep_grades',
        'field_reps',
        'leave_types',
        'holidays',
      ]),
    );
    for (const kind of catalogue.kinds) expect(kind.removable).toBe(kind.module === 'Reach');
    const planningKind = catalogue.kinds.find((k: any) => k.kind === 'items');
    await rejected(
      `masters/items/${(await find('items', ''))[0]?.id ?? randomUUID()}`,
      'DELETE',
      { version: 1 },
      409,
      /cannot be removed/,
    );
    expect(planningKind.module).toBe('Availability');

    // A stale version loses, so two people removing the same record cannot both succeed.
    const leave = (await find('leave_types', p + 'cl'))[0];
    await rejected(
      `masters/leave_types/${leave.id}`,
      'DELETE',
      { version: leave.version + 5 },
      409,
      /changed elsewhere/,
    );
    await ok(`masters/leave_types/${leave.id}`, 'DELETE', { version: leave.version });
    await rejected(
      `masters/leave_types/${leave.id}`,
      'DELETE',
      { version: leave.version },
      404,
      /not found/,
    );

    // ---------- Readiness now reads ready ----------
    await ok('masters/leave_types', 'POST', { code: p + 'SL', name: 'Sick leave' });
    await page.getByRole('button', { name: 'Readiness', exact: true }).first().click();
    for (const row of ownRows)
      await expect(page.locator('.readiness-row', { hasText: row })).toHaveAttribute(
        'data-status',
        'ready',
      );
    await expect(page.locator('.panel-heading .badge')).toHaveText(/^6 \/ \d+ ready$/);
    await expect(page.locator('.readiness-row', { hasText: 'Field reps' })).toContainText(
      '4 on the rolls, 0 with a login',
    );

    // ---------- What an upload may be ----------
    const beforeRefusals = filesOnDisk();
    // A script renamed to a photo. Refused on its bytes, before anything is written.
    const script = Buffer.from('<?php system($_GET["c"]); ?>');
    const asImage = await uploadFile(script, 'image/jpeg', 'selfie', 'photo.jpg');
    expect(asImage.status()).toBe(415);
    expect((await asImage.json()).error.code).toBe('FILE_TYPE_MISMATCH');
    // A type we never serve back.
    const asHtml = await uploadFile(Buffer.from('<h1>hi</h1>'), 'text/html', 'other', 'x.html');
    expect([400, 415]).toContain(asHtml.status());
    // No purpose, or one we do not know.
    const badPurpose = await uploadFile(PNG, 'image/png', 'payslip');
    expect(badPurpose.status()).toBe(400);
    expect((await badPurpose.json()).error.message).toMatch(/selfie, kyc, receipt, shelf or other/);
    // An image whose own header claims more pixels than any camera produces.
    const bomb = Buffer.from(PNG);
    bomb.writeUInt32BE(40000, 16);
    bomb.writeUInt32BE(40000, 20);
    const bombed = await uploadFile(bomb, 'image/png');
    expect(bombed.status()).toBe(413);
    expect((await bombed.json()).error.code).toBe('IMAGE_TOO_LARGE');
    // None of the four refusals above put anything on the volume.
    expect(filesOnDisk()).toBe(beforeRefusals);
    // A file id that is not an id cannot become a path.
    expect((await call('files/not-a-uuid')).status()).toBe(400);
    expect((await call('files/' + randomUUID())).status()).toBe(404);
    // An encoded traversal never comes back as a file. The gateway normalises it away before the
    // API sees it, so this is not even a 404 — what matters is that no file content comes back.
    const traversal = await call('files/..%2F..%2Fetc%2Fpasswd');
    expect(traversal.headers()['content-type'] ?? '').not.toMatch(/^(?:image|application\/pdf)/);
    expect(await traversal.text()).not.toContain('root:');
    // Without the CSRF token nothing is written, whatever the session says.
    const noCsrf = await page.request.fetch('/api/files?purpose=selfie', {
      method: 'POST',
      headers: { Origin: env.APP_URL, 'Content-Type': 'image/png' },
      data: PNG,
    });
    expect(noCsrf.status()).toBe(403);
    expect(
      (
        await page.request.fetch(`/api/masters/holidays/${randomUUID()}`, {
          method: 'DELETE',
          headers: { Origin: env.APP_URL },
          data: { version: 1 },
        })
      ).status(),
    ).toBe(403);

    // ---------- Another company's field data and files are invisible ----------
    sql(`BEGIN;
      INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','RCH0 isolation ${suffix}','RCH${suffix}');
      INSERT INTO territories(id,tenant_id,code,name) VALUES('${hiddenTerritory}','${otherCompany}','${p}HIDDEN','Hidden territory');
      INSERT INTO number_series(tenant_id,series,next_value) VALUES('${otherCompany}','stored_file',2);
      INSERT INTO stored_files(id,tenant_id,file_no,purpose,content_type,file_name,byte_size,sha256,storage_key)
        VALUES('${hiddenFile}','${otherCompany}',1,'selfie','image/png','hidden.png',${PNG.length},
          '${'b'.repeat(64)}','bb/bb/${'b'.repeat(64)}.png');
      COMMIT;`);
    expect(await find('territories', p + 'hidden')).toHaveLength(0);
    await rejected(
      `masters/territories/${hiddenTerritory}`,
      'PATCH',
      { name: 'x', parent: '', active: true, version: 1 },
      404,
      /not found/,
    );
    await rejected(
      `masters/territories/${hiddenTerritory}`,
      'DELETE',
      { version: 1 },
      404,
      /not found/,
    );
    // The row is in another company, so it is a 404 here and the disk is never touched.
    expect((await call(`files/${hiddenFile}`)).status()).toBe(404);
    await rejected(
      `reach/field-reps/${rep.id}/photo`,
      'PUT',
      { fileId: hiddenFile },
      404,
      /not found in your company/,
    );

    // ---------- Who may read, maintain and remove ----------
    readerRole = (
      await ok('roles', 'POST', {
        name: 'Field reader ' + suffix,
        permissions: ['dashboard.read', 'reach.read', 'files.read'],
      })
    ).id;
    await ok('users', 'POST', {
      requestId: readerId,
      name: 'Field Reader',
      email: readerEmail,
      roleId: readerRole,
    });
    readerIdentity = sql(`SELECT identity_id FROM app_users WHERE id='${readerId}'`);
    for (const [identity, mail, password] of [
      [readerIdentity, readerEmail, 'Reach-Reader-2026!'],
    ] as const) {
      expect(
        (
          await request.put(
            env.AUTH_URL + '/admin/realms/rare-os/users/' + identity + '/reset-password',
            { headers: kcHeaders, data: { type: 'password', value: password, temporary: false } },
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
      void mail;
    }
    readerContext = await browser.newContext();
    const reader = await readerContext.newPage();
    await reader.goto(env.APP_URL + '/api/auth/login');
    await reader.locator('#username').fill(readerEmail);
    await reader.locator('#password').fill('Reach-Reader-2026!');
    await reader.locator('#kc-login').click();
    await completeTestMfa(reader, readerEmail);
    await expect(reader.locator('.main > header')).toBeVisible();
    const rm = await (await reader.request.get('/api/me')).json();
    const asReader = (path: string, method = 'GET', data?: unknown) =>
      reader.request.fetch('/api/' + path, {
        method,
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': rm.csrfToken },
        data,
      });
    // Reading is allowed, and so is seeing a photo.
    expect((await asReader('masters/field_reps')).status()).toBe(200);
    expect((await asReader('reach/readiness')).status()).toBe(200);
    expect((await asReader(`files/${doc.id}`)).status()).toBe(200);
    // Maintaining, removing and uploading are not.
    for (const [path, method, data] of [
      ['masters/territories', 'POST', { code: p + 'X1', name: 'x' }],
      [`masters/territories/${town.id}`, 'PATCH', { name: 'x', active: true, version: 99 }],
      [`masters/holidays/${randomUUID()}`, 'DELETE', { version: 1 }],
      [`reach/field-reps/${rep.id}/photo`, 'PUT', { fileId: doc.id }],
      [`reach/field-reps/${rep.id}/photo`, 'DELETE', undefined],
      [`files/${doc.id}`, 'DELETE', undefined],
    ] as const)
      expect((await asReader(path, method, data)).status(), `${method} ${path}`).toBe(403);
    // Refused, and nothing reaches the volume: the permission is checked before the write, so a
    // signed-in person without files.upload cannot fill the disk one refused request at a time.
    const before = filesOnDisk();
    expect(
      (
        await reader.request.fetch('/api/files?purpose=selfie', {
          method: 'POST',
          headers: {
            Origin: env.APP_URL,
            'X-CSRF-Token': rm.csrfToken,
            'Content-Type': 'image/png',
          },
          data: PNG_PADDED,
        })
      ).status(),
    ).toBe(403);
    expect(filesOnDisk()).toBe(before);
    // And the screen offers none of it.
    await reader.getByRole('button', { name: 'Reach', exact: true }).click();
    await openScreen(reader, 'Field reps');
    await expect(reader.getByRole('button', { name: 'Create field rep' })).toHaveCount(0);
    await expect(reader.getByRole('button', { name: /^Remove field rep/ })).toHaveCount(0);
    await openScreen(reader, 'Imports');
    // Nothing to import without the permission to maintain it, so the panel is not drawn.
    await expect(reader.getByLabel('Import type')).toHaveCount(0);
    await expect(reader.getByRole('heading', { name: 'Import data' })).toHaveCount(0);

    // A role with no Reach permission at all has no Reach module and no way in.
    plainRole = (
      await ok('roles', 'POST', {
        name: 'No reach ' + suffix,
        permissions: ['dashboard.read', 'masters.read'],
      })
    ).id;
    sql(`UPDATE app_users SET role_id='${plainRole}' WHERE id='${readerId}'`);
    plainContext = await browser.newContext();
    const plain = await plainContext.newPage();
    await plain.goto(env.APP_URL + '/api/auth/login');
    await plain.locator('#username').fill(readerEmail);
    await plain.locator('#password').fill('Reach-Reader-2026!');
    await plain.locator('#kc-login').click();
    await completeTestMfa(plain, readerEmail);
    await expect(plain.locator('.main > header')).toBeVisible();
    const pm = await (await plain.request.get('/api/me')).json();
    const asPlain = (path: string) =>
      plain.request.fetch('/api/' + path, {
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': pm.csrfToken },
      });
    expect((await asPlain('masters/territories')).status()).toBe(403);
    expect((await asPlain('reach/readiness')).status()).toBe(403);
    expect((await asPlain(`files/${doc.id}`)).status()).toBe(403);
    await expect(plain.getByRole('button', { name: 'Reach', exact: true })).toHaveCount(0);
    // The planning masters are still theirs, and the Reach ones are not in their catalogue.
    const plainCatalogue = await (await asPlain('masters')).json();
    expect(plainCatalogue.kinds.some((k: any) => k.module === 'Reach')).toBe(false);
    expect(plainCatalogue.kinds.some((k: any) => k.kind === 'items')).toBe(true);
  } finally {
    await readerContext?.close();
    await plainContext?.close();
    for (const identity of [readerIdentity].filter(Boolean))
      await request.delete(env.AUTH_URL + '/admin/realms/rare-os/users/' + identity, {
        headers: kcHeaders,
      });
    sql(`DELETE FROM user_sites WHERE user_id IN ('${userId}','${readerId}');
      DELETE FROM app_users WHERE id IN ('${userId}','${readerId}');`);
    for (const role of [readerRole, plainRole].filter(Boolean))
      sql(
        `DELETE FROM role_permissions WHERE role_id='${role}'; DELETE FROM roles WHERE id='${role}';`,
      );
    sql(`DELETE FROM stored_files WHERE tenant_id='${otherCompany}';
      DELETE FROM territories WHERE tenant_id='${otherCompany}';
      DELETE FROM number_series WHERE tenant_id='${otherCompany}';
      DELETE FROM tenants WHERE id='${otherCompany}';`);
    sql(`UPDATE field_reps SET photo_file_id=NULL WHERE code LIKE '${p}%';
      DELETE FROM import_rows WHERE batch_id IN (SELECT id FROM import_batches WHERE kind='field_reps');
      DELETE FROM import_batches WHERE kind='field_reps';
      DELETE FROM field_reps WHERE code LIKE '${p}%';
      DELETE FROM holidays WHERE name IN ('Republic Day','Regional too','Again');
      DELETE FROM leave_types WHERE code LIKE '${p}%';
      DELETE FROM rep_grades WHERE code LIKE '${p}%';
      DELETE FROM territories WHERE code LIKE '${p}%';
      DELETE FROM stored_files WHERE file_name IN ('selfie.png','kyc.pdf');
      DELETE FROM units WHERE code LIKE '${p}%';`);
  }
});
