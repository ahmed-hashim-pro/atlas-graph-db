import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = 4899;
const dataDir = mkdtempSync(join(tmpdir(), 'atlas-e2e-'));

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, ...devices['Desktop Chrome'] },
  webServer: {
    // Build the SPA, then serve it from @atlas/server static hosting (same origin → real cookies).
    command: `pnpm -F web build && node --import tsx ../../packages/server/src/cli.ts`,
    url: `http://127.0.0.1:${port}/healthz`,
    timeout: 120_000,
    reuseExistingServer: false,
    cwd: __dirname,
    env: {
      ATLAS_DATA_DIR: dataDir,
      ATLAS_SECRET: 'e'.repeat(32),
      ATLAS_PORT: String(port),
      ATLAS_STATIC_DIR: join(__dirname, 'dist/web/browser'),
    },
  },
});
