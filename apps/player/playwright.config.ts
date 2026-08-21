import { defineConfig, devices } from '@playwright/test'

const port = Number(process.env.PLAYER_E2E_PORT ?? 4242)

export default defineConfig({
  testDir: './test/e2e',
  timeout: 30_000,
  workers: process.env.CI ? 1 : undefined,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    // The player is served under /player/ (Vite `base`), matching the prefix
    // the gateway mounts it at in production. Relative goto()s resolve here.
    baseURL: `http://127.0.0.1:${port}/player/`,
    launchOptions: { args: ['--disable-gpu'] },
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port}`,
    url: `http://127.0.0.1:${port}/player/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
})
