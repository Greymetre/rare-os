import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: 'http://localhost:4310',
    headless: true,
    actionTimeout: 15000,
    channel: 'chrome',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  reporter: 'list',
});
