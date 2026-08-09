import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const WEB_SERVER_TIMEOUT_MS = 180_000;

/**
 * E2E runs the real gateway binary against the real Docusaurus build, with the AWS-backed
 * routes pointed at a stub. That is the only way to exercise static-route precedence — the bug
 * where `/v1/search` gets swallowed by the site handler cannot reproduce in an app-factory test.
 */
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 2 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Escape hatch for environments that already ship a Chromium — sandboxes and locked-down
        // CI images — where `playwright install` cannot or should not download another one.
        // Unset everywhere else, so Playwright uses the build it pins.
        ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] === undefined
          ? {}
          : { launchOptions: { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE'] } }),
      },
    },
  ],
  webServer: {
    command: 'bun run scripts/dev/serve-e2e.ts',
    url: `http://127.0.0.1:${String(PORT)}/healthz`,
    reuseExistingServer: !process.env['CI'],
    timeout: WEB_SERVER_TIMEOUT_MS,
    env: { PORT: String(PORT) },
  },
});
