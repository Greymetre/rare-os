import { loadTestEnvironment } from './helpers/test-environment.mjs';
import { completeTestMfa } from './helpers/mfa';
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

test('AV-0 availability foundation: units, staged CSV imports, duplicates, scale, isolation and permissions', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(420000);
  const suffix = Date.now().toString().slice(-6),
    prefix = 'Z' + suffix,
    userId = randomUUID(),
    email = `masters.reader.${suffix}@example.test`,
    otherCompany = randomUUID(),
    otherBatch = randomUUID();
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
  const call = (path: string, method = 'GET', data?: unknown) =>
    page.request.fetch('/api/' + path, {
      method,
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': me.csrfToken },
      data,
    });
  const upload = (csv: string, name = 'units.csv', contentType = 'text/csv') =>
    page.request.fetch('/api/imports/units', {
      method: 'POST',
      headers: {
        Origin: env.APP_URL,
        'X-CSRF-Token': me.csrfToken,
        'Content-Type': contentType,
        'X-File-Name': name,
      },
      data: csv,
    });
  async function settled(batchId: string, timeout = 90000) {
    let batch: any;
    await expect
      .poll(
        async () => {
          batch = await (await call('imports/' + batchId)).json();
          return ['validated', 'committed', 'failed', 'cancelled'].includes(batch.status);
        },
        { timeout, intervals: [500, 1000] },
      )
      .toBe(true);
    return batch;
  }
  const unitCount = () =>
    Number(
      sql(`SELECT count(*) FROM units WHERE code LIKE '${prefix}%' OR code IN ('KG${suffix}')`),
    );
  try {
    const before = await (await call('availability/readiness')).json();
    const unitsReady = before.items.find((i: any) => i.key === 'units');
    expect(['ready', 'missing']).toContain(unitsReady.status);
    expect(before.items.find((i: any) => i.key === 'demand').status).toBe('upcoming');

    // Units master through the UI, with duplicate and stale-edit protection.
    await page.getByRole('button', { name: 'Availability', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Planning data readiness' })).toBeVisible();
    await page.getByRole('tab', { name: 'Units' }).click();
    await page.getByRole('button', { name: 'Create unit', exact: true }).click();
    await page.getByLabel('Unit code', { exact: true }).fill(prefix + 'NOS');
    await page.getByLabel('Unit name', { exact: true }).fill('Numbers');
    await page.getByRole('button', { name: 'Save unit', exact: true }).click();
    await expect(page.getByText(`Unit ${prefix}NOS created.`)).toBeVisible();
    const dup = await call('units', 'POST', {
      code: prefix.toLowerCase() + 'nos',
      name: 'Again',
      decimals: 0,
    });
    expect(dup.status()).toBe(409);
    expect((await dup.json()).error.message).toContain('already exists');
    const nos = (await (await call('units?q=' + prefix.toLowerCase() + 'nos')).json()).items[0];
    expect(
      (
        await call('units/' + nos.id, 'PATCH', {
          name: 'Nos',
          decimals: 0,
          active: true,
          version: 1,
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await call('units/' + nos.id, 'PATCH', {
          name: 'Stale',
          decimals: 0,
          active: true,
          version: 1,
        })
      ).status(),
    ).toBe(409);
    expect(
      (await call('units', 'POST', { code: 'BAD CODE', name: 'x', decimals: 0 })).status(),
    ).toBe(400);
    expect(
      (await call('units', 'POST', { code: prefix + 'X', name: 'x', decimals: 9 })).status(),
    ).toBe(400);

    // Upload-level rejections: nothing is staged.
    expect((await upload('name,code,decimals\nKG,Kilogram,3\n')).status()).toBe(400);
    expect((await upload('{"code":"KG"}', 'x.csv', 'application/json')).status()).toBe(415);
    const huge = await upload('code,name,decimals\n' + 'A'.repeat(6 * 1024 * 1024));
    expect(huge.status()).toBe(413);
    expect((await call('imports/templates/units')).headers()['content-type']).toContain('text/csv');

    // File with errors through the UI: preview, error file, and commit refused.
    await page.getByRole('tab', { name: 'Imports' }).click();
    const bad = [
      'code,name,decimals',
      `${prefix}KG,Kilogram,3`,
      'BAD CODE,Broken,0',
      `${prefix}kg,Duplicate,2`,
      `${prefix}M,Metre,9`,
      '=HACK,Formula,0',
    ].join('\n');
    await page
      .getByLabel('CSV file')
      .setInputFiles({ name: 'bad-units.csv', mimeType: 'text/csv', buffer: Buffer.from(bad) });
    await page.getByRole('button', { name: 'Upload and validate' }).click();
    const detail = page.locator('.import-detail');
    await expect(detail.locator('.status-pill')).toHaveText('Ready to review', { timeout: 60000 });
    await expect(detail.getByText('With errors', { exact: true })).toBeVisible();
    await expect(page.getByLabel('CSV file')).toHaveValue('');
    await expect(detail.getByRole('button', { name: 'Commit import' })).toHaveCount(0);
    await expect(
      detail.getByText('Duplicate code ' + prefix + 'KG; first used on line 2.'),
    ).toBeVisible();
    const badBatch = (await (await call('imports')).json()).items[0];
    expect(badBatch.file_name).toBe('bad-units.csv');
    expect(badBatch.error_rows).toBe(4);
    expect(badBatch.valid_rows).toBe(1);
    const refused = await call(`imports/${badBatch.id}/commit`, 'POST', {
      version: badBatch.version,
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe('IMPORT_HAS_ERRORS');
    const errorFile = await (await call(`imports/${badBatch.id}/errors.csv`)).text();
    expect(errorFile).toContain('line,column,problem,code,name,decimals');
    expect(errorFile).toContain('4,code,Duplicate code');
    expect(errorFile).toContain("'=HACK");
    expect(errorFile).not.toMatch(/(^|,)=HACK/m);
    expect(
      (await call(`imports/${badBatch.id}/cancel`, 'POST', { version: badBatch.version })).ok(),
    ).toBe(true);
    expect(unitCount()).toBe(1);

    // Corrected file through the UI: preview counts then commit.
    const good = [
      'code,name,decimals',
      `${prefix}KG,Kilogram,3`,
      `${prefix}M,Metre,2`,
      `${prefix}NOS,Numbers,0`,
    ].join('\n');
    await page
      .getByLabel('CSV file')
      .setInputFiles({ name: 'units.csv', mimeType: 'text/csv', buffer: Buffer.from(good) });
    await page.getByRole('button', { name: 'Upload and validate' }).click();
    await expect(detail.locator('.status-pill')).toHaveText('Ready to review', { timeout: 60000 });
    await expect(detail.getByText('2 / 1 / 0')).toBeVisible();
    await detail.getByRole('button', { name: 'Commit import' }).click();
    await expect(detail.locator('.status-pill')).toHaveText('Committed', { timeout: 60000 });
    await expect(detail.getByText('2 / 1 / 0')).toBeVisible();
    expect(unitCount()).toBe(3);
    expect(sql(`SELECT name FROM units WHERE code='${prefix}NOS'`)).toBe('Numbers');
    const audit = sql(
      `SELECT count(*) FROM audit_log WHERE action='import.committed' AND details->'after'->>'created'='2'`,
    );
    expect(Number(audit)).toBeGreaterThan(0);

    // Same file bytes cannot be imported twice; same content in a new file changes nothing.
    const again = await upload(good);
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('FILE_ALREADY_IMPORTED');
    const sameRows = await (await upload(good + '\n', 'units-copy.csv')).json();
    let batch = await settled(sameRows.id);
    expect(batch.summary).toEqual({ create: 0, update: 0, unchanged: 3 });
    expect(
      (await call(`imports/${batch.id}/commit`, 'POST', { version: batch.version })).ok(),
    ).toBe(true);
    batch = await settled(batch.id);
    expect(batch.status).toBe('committed');
    expect(batch.summary).toEqual({ created: 0, updated: 0, unchanged: 3 });
    expect(unitCount()).toBe(3);
    // Duplicate delivery: a second commit event for the same batch is processed but changes nothing.
    const firstEvent = sql(
      `SELECT id FROM outbox_events WHERE kind='import.commit' AND payload->>'batchId'='${batch.id}' ORDER BY id LIMIT 1`,
    );
    expect(sql(`SELECT count(*) FROM processed_events WHERE event_id=${firstEvent}`)).toBe('1');
    const duplicateEvent = sql(
      `INSERT INTO outbox_events(tenant_id,kind,payload) SELECT tenant_id,kind,payload FROM outbox_events WHERE id=${firstEvent} RETURNING id`,
    )
      .split('\n')[0]
      .trim();
    await expect
      .poll(() => sql(`SELECT count(*) FROM processed_events WHERE event_id=${duplicateEvent}`), {
        timeout: 30000,
      })
      .toBe('1');
    expect(unitCount()).toBe(3);
    expect((await (await call('imports/' + batch.id)).json()).status).toBe('committed');

    // Scale: 10,000 rows validate and commit in the background.
    const bulk = [
      'code,name,decimals',
      ...Array.from({ length: 10000 }, (_, i) => `${prefix}B${i},Bulk unit ${i},${i % 7}`),
    ].join('\n');
    const started = Date.now();
    const bulkBatch = await (await upload(bulk, 'bulk-units.csv')).json();
    batch = await settled(bulkBatch.id, 120000);
    expect(batch.status).toBe('validated');
    expect(batch.error_rows).toBe(0);
    expect(batch.summary.create).toBe(10000);
    const errorsPage = await (await call(`imports/${batch.id}/rows?errors=true`)).json();
    expect(errorsPage.items).toHaveLength(0);
    const preview = await (await call(`imports/${batch.id}/rows?errors=false`)).json();
    expect(preview.items).toHaveLength(50);
    expect(preview.nextCursor).toBe(51);
    expect(
      (await call(`imports/${batch.id}/commit`, 'POST', { version: batch.version })).ok(),
    ).toBe(true);
    batch = await settled(batch.id, 120000);
    expect(batch.status).toBe('committed');
    expect(batch.summary.created).toBe(10000);
    expect(unitCount()).toBe(10003);
    console.log(
      `PASS 10,000-row import validated and committed in ${Math.round((Date.now() - started) / 1000)}s`,
    );

    // Another company's batch is invisible and cannot be acted on.
    sql(`BEGIN;
      INSERT INTO tenants(id,name,code) VALUES('${otherCompany}','AV0 isolation ${suffix}','ISO${suffix}');
      INSERT INTO import_batches(id,tenant_id,batch_no,kind,file_name,file_sha256,status,total_rows,error_rows) VALUES('${otherBatch}','${otherCompany}',1,'units','other.csv','${'b'.repeat(64)}','validated',1,0);
      COMMIT;`);
    expect((await call('imports/' + otherBatch)).status()).toBe(404);
    expect((await call(`imports/${otherBatch}/rows`)).status()).toBe(404);
    expect((await call(`imports/${otherBatch}/commit`, 'POST', { version: 1 })).status()).toBe(404);

    // Role dependencies and a read-only masters user.
    const badRole = await call('roles', 'POST', {
      name: 'Import without manage ' + suffix,
      permissions: ['dashboard.read', 'imports.create'],
    });
    expect(badRole.status()).toBe(400);
    expect((await badRole.json()).error.code).toBe('DEPENDENCY_REQUIRED');
    roleId = (
      await (
        await call('roles', 'POST', {
          name: 'Masters reader ' + suffix,
          permissions: ['dashboard.read', 'masters.read'],
        })
      ).json()
    ).id;
    expect(roleId).toBeTruthy();
    expect(
      (
        await call('users', 'POST', { requestId: userId, name: 'Masters Reader', email, roleId })
      ).ok(),
    ).toBe(true);
    identityId = sql(`SELECT identity_id FROM app_users WHERE id='${userId}'`);
    expect(
      (
        await request.put(
          env.AUTH_URL + '/admin/realms/rare-os/users/' + identityId + '/reset-password',
          {
            headers: kcHeaders,
            data: { type: 'password', value: 'Masters-Test-2026!', temporary: false },
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
    await up.locator('#password').fill('Masters-Test-2026!');
    await up.locator('#kc-login').click();
    await completeTestMfa(up, email);
    await expect(up.locator('.main > header')).toBeVisible();
    const um = await (await up.request.get('/api/me')).json();
    const asReader = (
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
    expect((await asReader('units')).ok()).toBe(true);
    expect((await asReader('imports')).ok()).toBe(true);
    expect(
      (
        await asReader('units', 'POST', { code: prefix + 'R', name: 'Reader', decimals: 0 })
      ).status(),
    ).toBe(403);
    expect(
      (await asReader('imports/units', 'POST', good, { 'Content-Type': 'text/csv' })).status(),
    ).toBe(403);
    expect((await asReader('imports/templates/units')).status()).toBe(403);
    expect(
      (await asReader(`imports/${bulkBatch.id}/cancel`, 'POST', { version: 1 })).status(),
    ).toBe(403);
    await up.getByRole('button', { name: 'Availability', exact: true }).click();
    await up.getByRole('tab', { name: 'Imports' }).click();
    await expect(up.getByRole('button', { name: 'Open batch ' + batch.batch_no })).toBeVisible();
    await expect(up.getByRole('heading', { name: 'Import master data' })).toHaveCount(0);
    await up.getByRole('tab', { name: 'Units' }).click();
    await expect(up.getByRole('button', { name: 'Create unit' })).toHaveCount(0);
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
    sql(
      `DELETE FROM import_rows WHERE tenant_id='${otherCompany}'; DELETE FROM import_batches WHERE tenant_id='${otherCompany}'; DELETE FROM tenants WHERE id='${otherCompany}';`,
    );
    sql(`DELETE FROM units WHERE code LIKE '${prefix}%';`);
  }
});
