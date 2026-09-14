import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { randomUUID, randomBytes } from 'node:crypto';
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .trim()
    .split('\n')
    .map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]),
);
test('retained review: platform delegation, plants, isolation and shared login', async ({
  page,
  browser,
  request,
}) => {
  test.skip(process.env.RARE_REVIEW_DEMO !== '1', 'Explicit retained-demo run only');
  test.setTimeout(180000);
  mkdirSync('.local', { recursive: true });
  const manifest = '.local/PLANT_REVIEW.json';
  const d: any = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, 'utf8'))
    : (() => {
        const suffix = Date.now().toString();
        return {
          suffix,
          companyA: randomUUID(),
          companyB: randomUUID(),
          ownerEmail: 'review.owner.' + suffix + '@example.test',
          staffEmail: 'review.staff.' + suffix + '@example.test',
          password: 'Review-' + randomBytes(10).toString('hex') + '!',
        };
      })();
  const persist = () => writeFileSync(manifest, JSON.stringify(d, null, 2), { mode: 0o600 });
  persist();
  async function login(p: any, email: string, password: string) {
    await p.goto('/api/auth/login');
    await p.locator('#username').fill(email);
    await p.locator('#password').fill(password);
    await p.locator('#kc-login').click();
    await expect(
      p.getByRole('heading', {
        name: /Your operations start here.|Company management|Select your company/,
      }),
    ).toBeVisible();
  }
  await login(page, env.SEED_ADMIN_EMAIL, env.SEED_ADMIN_PASSWORD);
  let csrf = (await (await page.request.get('/api/me')).json()).csrfToken;
  const call = (path: string, method = 'GET', data?: unknown) =>
    page.request.fetch('/api/' + path, {
      method,
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': csrf },
      data,
    });
  async function ok(path: string, method = 'GET', data?: unknown) {
    const r = await call(path, method, data);
    const result = await r.json();
    expect(r.ok(), JSON.stringify(result)).toBe(true);
    return result;
  }
  async function open(company: string) {
    await ok('platform/companies/' + company + '/open', 'POST', {});
    csrf = (await (await page.request.get('/api/me')).json()).csrfToken;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
  }
  for (const [id, name, code] of [
    [d.companyA, 'Review Alpha Foods', 'REVA' + d.suffix],
    [d.companyB, 'Review Beta Products', 'REVB' + d.suffix],
  ])
    await ok('platform/companies', 'POST', {
      requestId: id,
      name,
      code,
      contactEmail: d.ownerEmail,
      adminName: 'Review Company Admin',
      adminEmail: d.ownerEmail,
    });
  await page.getByRole('button', { name: 'Companies', exact: true }).click();
  await page.getByRole('button', { name: 'Open company Review Alpha Foods', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
  csrf = (await (await page.request.get('/api/me')).json()).csrfToken;
  expect((await (await page.request.get('/api/me')).json()).user.platform_access).toBe(true);
  await page.getByRole('button', { name: 'Plants', exact: true }).click();
  let plants = (await ok('plants')).items;
  for (const [key, name, code, location] of [
    ['jaipur', 'Jaipur Plant', 'JPR', 'Jaipur, Rajasthan'],
    ['delhi', 'Delhi Plant', 'DEL', 'Delhi'],
  ]) {
    let plant = plants.find((x: any) => x.code === code);
    if (!plant) {
      await page.getByRole('button', { name: 'Create plant', exact: true }).click();
      await page.getByLabel('Plant code', { exact: true }).fill(code);
      await page.getByLabel('Plant name', { exact: true }).fill(name);
      await page.getByLabel('Location', { exact: true }).fill(location);
      await page.getByRole('button', { name: 'Save plant', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'New plant', exact: true })).not.toBeVisible();
      plant = (await ok('plants')).items.find((x: any) => x.code === code);
    }
    d[key] = plant.id;
    persist();
  }
  expect(
    (
      await call('plants', 'POST', {
        code: 'jpr',
        name: 'Duplicate plant',
        location: 'Jaipur',
        timezone: 'Asia/Kolkata',
      })
    ).status(),
  ).toBe(409);
  expect(
    (
      await call('plants', 'POST', {
        code: 'BADTZ',
        name: 'Invalid timezone',
        location: 'Jaipur',
        timezone: 'Mars/Invalid',
      })
    ).status(),
  ).toBe(400);
  async function role(name: string, permissions: string[]) {
    let r = (await ok('roles?q=' + encodeURIComponent(name))).items.find(
      (x: any) => x.name === name,
    );
    if (!r) r = await ok('roles', 'POST', { name, permissions });
    return r.id;
  }
  d.roleA = await role('Jaipur Viewer', ['dashboard.read', 'sites.read']);
  persist();
  async function user(roleId: string) {
    let u = (await ok('users?q=' + encodeURIComponent(d.staffEmail))).items.find(
      (x: any) => x.email === d.staffEmail,
    );
    if (!u) {
      await ok('users', 'POST', {
        requestId: randomUUID(),
        name: 'Review Limited User',
        email: d.staffEmail,
        roleId,
      });
      u = (await ok('users?q=' + encodeURIComponent(d.staffEmail))).items[0];
    }
    return u.id;
  }
  d.staffA = await user(d.roleA);
  persist();
  await page.getByRole('button', { name: 'Users', exact: true }).click();
  await page
    .getByRole('button', { name: 'Plant access for Review Limited User', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Plant access: Review Limited User' });
  await dialog.getByLabel('Jaipur Plant (JPR)', { exact: true }).check();
  await dialog.getByLabel('Delhi Plant (DEL)', { exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Save plant access' }).click();
  await expect(dialog).not.toBeVisible();
  await open(d.companyB);
  let beta = (await ok('plants')).items.find((x: any) => x.code === 'MUM');
  if (!beta)
    beta = await ok('plants', 'POST', {
      code: 'MUM',
      name: 'Mumbai Plant',
      location: 'Mumbai, Maharashtra',
      timezone: 'Asia/Kolkata',
    });
  d.mumbai = beta.id;
  d.roleB = await role('Overview Only', ['dashboard.read']);
  d.staffB = await user(d.roleB);
  persist();
  await open(d.companyA);
  const assigned = await ok('users/' + d.staffA + '/plants');
  expect(
    (
      await call('users/' + d.staffA + '/plants', 'PUT', {
        version: assigned.version,
        plantIds: [d.mumbai],
      })
    ).status(),
  ).toBe(400);
  const grant = await ok('users/' + d.staffA + '/plants');
  await ok('users/' + d.staffA + '/plants', 'PUT', {
    version: grant.version,
    plantIds: [d.jaipur],
  });
  expect(
    (
      await call('users/' + d.staffA + '/plants', 'PUT', { version: grant.version, plantIds: [] })
    ).status(),
  ).toBe(409);
  async function finishInvite(email: string, p: any) {
    const messages = await (
      await request.get('http://localhost:4312/api/v1/messages?limit=200')
    ).json();
    let link = '';
    for (const m of messages.messages
      .filter((m: any) => m.To?.some((t: any) => t.Address === email))
      .reverse()) {
      const content = await (
        await request.get('http://localhost:4312/api/v1/message/' + m.ID)
      ).json();
      const match = content.HTML.match(/href="([^"]*login-actions\/action-token[^"]*)"/);
      if (match) {
        link = match[1].replaceAll('&amp;', '&');
        break;
      }
    }
    expect(link).toBeTruthy();
    await p.goto(link);
    const proceed = p.getByRole('link', { name: /click here to proceed/i });
    if (await proceed.isVisible()) await proceed.click();
    await p.locator('#password-new').fill(d.password);
    await p.locator('#password-confirm').fill(d.password);
    await p.getByRole('button', { name: /submit/i }).click();
    await expect(
      p.getByRole('link', { name: /back to application/i }).or(p.locator('#username')),
    ).toBeVisible();
  }
  const staff = await browser.newContext(),
    sp = await staff.newPage();
  if (!d.staffPasswordSet) {
    await finishInvite(d.staffEmail, sp);
    d.staffPasswordSet = true;
    persist();
  }
  await login(sp, d.staffEmail, d.password);
  await sp
    .getByRole('button', { name: 'Review Alpha Foods (REVA' + d.suffix + ')', exact: true })
    .click();
  await expect(sp.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
  await sp.getByRole('button', { name: 'Plants', exact: true }).click();
  await expect(sp.getByRole('cell', { name: 'Jaipur Plant', exact: true })).toBeVisible();
  await expect(sp.getByRole('cell', { name: 'Delhi Plant', exact: true })).toHaveCount(0);
  await expect(sp.getByRole('button', { name: 'Create plant', exact: true })).toHaveCount(0);
  let sm = await (await sp.request.get('/api/me')).json();
  const sc = (path: string, method = 'GET', data?: unknown) =>
    sp.request.fetch('/api/' + path, {
      method,
      headers: { Origin: env.APP_URL, 'X-CSRF-Token': sm.csrfToken },
      data,
    });
  expect((await sc('plants/' + d.delhi)).status()).toBe(404);
  expect((await sc('plants/' + d.mumbai)).status()).toBe(404);
  expect((await sc('platform/companies/' + d.companyB + '/open', 'POST', {})).status()).toBe(403);
  expect((await sc('roles')).status()).toBe(403);
  expect(
    (
      await sc('plants', 'POST', {
        code: 'DENY',
        name: 'Denied Plant',
        location: 'Test',
        timezone: 'Asia/Kolkata',
      })
    ).status(),
  ).toBe(403);
  const g = await ok('users/' + d.staffA + '/plants');
  await ok('users/' + d.staffA + '/plants', 'PUT', { version: g.version, plantIds: [] });
  expect((await sc('plants/' + d.jaipur)).status()).toBe(404);
  const g2 = await ok('users/' + d.staffA + '/plants');
  await ok('users/' + d.staffA + '/plants', 'PUT', { version: g2.version, plantIds: [d.jaipur] });
  expect((await sc('plants/' + d.jaipur)).status()).toBe(200);
  const plant = await ok('plants/' + d.jaipur);
  const edit = {
    name: plant.name,
    location: plant.location,
    timezone: plant.timezone,
    active: false,
    version: plant.version,
  };
  await ok('plants/' + d.jaipur, 'PATCH', edit);
  expect((await sc('plants/' + d.jaipur)).status()).toBe(404);
  expect((await call('plants/' + d.jaipur, 'PATCH', edit)).status()).toBe(409);
  await ok('plants/' + d.jaipur, 'PATCH', { ...edit, active: true, version: plant.version + 1 });
  await sp.screenshot({ path: '.local/review-limited-plants.png', fullPage: true });
  await sp.getByRole('button', { name: 'Switch company', exact: true }).click();
  await sp
    .getByRole('button', { name: 'Review Beta Products (REVB' + d.suffix + ')', exact: true })
    .click();
  await expect(sp.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
  await expect(sp.getByRole('button', { name: 'Plants', exact: true })).toHaveCount(0);
  expect((await sp.request.get('/api/plants')).status()).toBe(403);
  expect(
    (
      await sp.request.post('/api/roles', {
        headers: { Origin: env.APP_URL, 'X-CSRF-Token': sm.csrfToken },
        data: {},
      })
    ).status(),
  ).toBe(403);
  const owner = await browser.newContext(),
    op = await owner.newPage();
  if (!d.ownerPasswordSet) {
    await finishInvite(d.ownerEmail, op);
    d.ownerPasswordSet = true;
    persist();
  }
  await login(op, d.ownerEmail, d.password);
  await op
    .getByRole('button', { name: 'Review Alpha Foods (REVA' + d.suffix + ')', exact: true })
    .click();
  await expect(op.getByRole('heading', { name: 'Your operations start here.' })).toBeVisible();
  expect((await (await op.request.get('/api/plants')).json()).items).toHaveLength(2);
  const audit = await ok('audit');
  expect(audit.items.some((x: any) => x.action === 'user.plants_assigned' && x.actor_subject)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Plants', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Delhi Plant', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Jaipur Plant', exact: true })).toBeVisible();
  await page.screenshot({ path: '.local/review-admin-plants.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/review-plants-mobile.png', fullPage: true });
  d.verified = true;
  d.verifiedAt = new Date().toISOString();
  persist();
  await staff.close();
  await owner.close();
  // Intentionally no data or identity cleanup: user requested retained review fixtures.
});
