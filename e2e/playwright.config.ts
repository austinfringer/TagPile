import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

const PORT = process.env.E2E_PORT ?? '4173';
const BASE_URL = `http://127.0.0.1:${PORT}`;

// A fresh SQLite file per run, shared between the server (started below) and
// globalSetup (which seeds a test user into it once the server has migrated it).
const DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'tagpile-e2e-')), 'e2e.sqlite');
process.env.E2E_DATABASE_PATH = DATABASE_PATH;
process.env.E2E_BASE_URL = BASE_URL;

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  retries: 0,
  globalSetup: './global-setup.ts',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'npm run start -w server',
    cwd: '..',
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT,
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      DATABASE_PATH,
      JWT_SECRET: 'e2e-test-secret',
    },
  },
});
