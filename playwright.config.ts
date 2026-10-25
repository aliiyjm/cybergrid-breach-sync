import { defineConfig, devices } from '@playwright/test';

/**
 * Pruebas End-to-End: exactamente tres flujos (autenticación, lobbies, Canvas).
 * Playwright compila y arranca el servidor real contra la base de datos de
 * pruebas (TEST_DATABASE_URL). Cada prueba crea sus propios usuarios.
 */
const PORT = Number(process.env.E2E_PORT ?? 4173);
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: 'reports/playwright-artifacts',
  reporter: [
    ['list'],
    ['html', { outputFolder: 'reports/playwright-html', open: 'never' }],
    ['junit', { outputFile: 'reports/playwright-junit.xml' }],
    ['json', { outputFile: 'reports/playwright-results.json' }],
  ],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    locale: 'es-ES',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: process.env.E2E_SKIP_BUILD ? 'node server/dist/index.js' : 'npm run build && node server/dist/index.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      NODE_ENV: 'test',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DATABASE_URL: databaseUrl,
      MATCH_DURATION_S: '90',
      LOG_LEVEL: 'warn',
      SERVE_CLIENT: 'true',
    },
  },
});
