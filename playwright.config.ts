import { defineConfig } from '@playwright/test';
import { loadTestEnvironment } from './tests/helpers/test-environment.mjs';
const env = loadTestEnvironment();
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  workers: 1,
  timeout: 60000,
  forbidOnly: true,
  use: {
    baseURL: env.APP_URL,
    headless: true,
    actionTimeout: 15000,
    channel: 'chrome',
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/results.xml' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
});
