import { test, expect } from '@playwright/test';

test('branded login keeps its layout for validation, password reset and mobile', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('link', { name: /sign in securely/i }).click();
  await expect(page.locator('.rare-story')).toBeVisible();
  await expect(page.locator('#username')).toBeVisible();
  await expect(page.locator('#password')).toHaveCSS('border-top-left-radius', '12px');
  await expect(page.locator('#kc-login')).toHaveCSS('border-top-left-radius', '12px');
  await page.screenshot({
    path: '.local/login-theme-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: '.local/login-theme-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.locator('#username').fill('missing-theme-user@example.test');
  await page.locator('#password').fill('Not-A-Real-Password-2026!');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await expect(page.locator('#password')).toHaveAttribute('type', 'password');
  await page.locator('#kc-login').click();
  await expect(page.locator('#input-error')).toBeVisible();
  await expect(page.locator('.rare-story')).toBeVisible();
  await page.getByRole('link', { name: /forgot password/i }).click();
  await expect(page.locator('#kc-reset-password-form')).toBeVisible();
  await expect(page.locator('.rare-story')).toBeVisible();
  await page.screenshot({
    path: '.local/login-theme-reset.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('.card-pf')).toHaveCSS('animation-name', 'none');
});
