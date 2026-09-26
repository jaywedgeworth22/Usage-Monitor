import { defineConfig } from '@playwright/test';

// Fleet rollout scaffold: chromium-only smoke tests against a local server.
// Point PLAYWRIGHT_BASE_URL at a deployed environment to run against it.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  reporter: 'list',
  use: { baseURL },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    command: 'npm start -- -H 127.0.0.1 -p 3000',
    url: baseURL,
    timeout: 180_000,
    reuseExistingServer: !process.env.CI,
  },
});
