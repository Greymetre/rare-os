import { loadTestEnvironment } from './test-environment.mjs';
import { expect, type Page } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
const path = '.local/e2e-mfa.json';
const appOrigin = new URL(loadTestEnvironment().APP_URL).origin;
function otp(secret: string) {
  let bits = '';
  for (const c of secret.replace(/\s/g, '').toUpperCase())
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map((b) => parseInt(b, 2))),
    counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = createHmac('sha1', key).update(counter).digest(),
    o = h[h.length - 1] & 15;
  return ((h.readUInt32BE(o) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
}
// Enroll only explicitly disposable test stacks; never discover/read real users' OTP secrets.
export async function completeTestMfa(page: Page, email: string) {
  let stage = '';
  await expect
    .poll(
      async () => {
        if (await page.locator('#kc-totp-secret-qr-code').isVisible()) stage = 'enroll';
        else if (await page.locator('#otp').isVisible()) stage = 'verify';
        else if (
          new URL(page.url()).origin === appOrigin ||
          (await page.getByRole('link', { name: /back to application/i }).isVisible()) ||
          (await page.locator('#username').isVisible())
        )
          stage = 'done';
        return stage;
      },
      { timeout: 15000 },
    )
    .not.toBe('');
  if (stage === 'done') return;
  if (process.env.RARE_E2E_DISPOSABLE_STACK !== 'true')
    throw Error(
      'Use a disposable test stack and RARE_E2E_DISPOSABLE_STACK=true for automatic test MFA enrollment. Real account credentials are preserved.',
    );
  const data = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  if (stage === 'enroll') {
    await page.getByRole('link', { name: /unable to scan/i }).click();
    data[email] = {
      secret: (await page.locator('#kc-totp-secret-key').innerText()).replace(/\s/g, ''),
    };
  }
  if (!data[email]?.secret)
    throw Error('Missing disposable MFA fixture; use a fresh test database.');
  const entry = data[email];
  await expect
    .poll(() => otp(entry.secret), { timeout: 35000, intervals: [500] })
    .not.toBe(entry.used);
  entry.used = otp(entry.secret);
  mkdirSync('.local', { recursive: true });
  writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  if (stage === 'enroll') {
    await page.locator('#totp').fill(entry.used);
    await page.locator('#userLabel').fill('Disposable test authenticator');
    await page.getByRole('button', { name: /submit/i }).click();
  } else {
    await page.locator('#otp').fill(entry.used);
    await page.locator('#kc-login').click();
  }
}
