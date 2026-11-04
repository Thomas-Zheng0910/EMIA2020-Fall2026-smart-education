import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dataDir = process.env.E2E_DATA_DIR || mkdtempSync(join(tmpdir(), 'margin-e2e-'));
// Own ports, so a dev server can stay up while the suite runs.
const webPort = Number(process.env.E2E_WEB_PORT || 5174);
const apiPort = Number(process.env.E2E_API_PORT || 4311);
export default defineConfig({
  testDir: 'e2e',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    headless: true,
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    { command: 'node e2e/mock-llm.mjs', port: 4399, reuseExistingServer: false },
    {
      command: 'npm run dev',
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30000,
      // Real environment variables take precedence over .env, so tests never call the live provider.
      env: {
        DATA_DIR: dataDir,
        PORT: String(apiPort),
        API_PORT: String(apiPort),
        WEB_PORT: String(webPort),
        LLM_BASE_URL: 'http://127.0.0.1:4399/v1',
        LLM_API_KEY: 'test',
        LLM_MODEL: 'mock',
        INDEX_DELAY_MS: '800',
      },
    },
  ],
});
