import { expect, test } from '@playwright/test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// This flow only happens once, on a database with zero users, so it can't share the
// long-lived server + database that the other e2e tests use (global-setup.ts already
// seeds a user into that one). Instead we spawn our own server against a fresh, empty
// database, scrape the invitation code it prints on startup, and drive the whole
// redeem-then-log-in flow against it.
const here = dirname(fileURLToPath(import.meta.url));
const serverDir = join(here, '../../server');

const PORT = process.env.E2E_FIRST_TIME_SETUP_PORT ?? '4174';
const BASE_URL = `http://127.0.0.1:${PORT}`;

const NEW_USER = {
  username: 'firstadmin',
  password: 'correct-horse1',
};

let serverProcess: ChildProcessWithoutNullStreams;
let dbDir: string;
let inviteCode: string;

test.beforeAll(async () => {
  dbDir = mkdtempSync(join(tmpdir(), 'tagpile-e2e-first-time-setup-'));
  const databasePath = join(dbDir, 'first-time-setup.sqlite');

  serverProcess = spawn('node', ['dist/index.js'], {
    cwd: serverDir,
    env: {
      ...process.env,
      PORT,
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      DATABASE_PATH: databasePath,
      JWT_SECRET: 'e2e-first-time-setup-secret',
    },
  });

  inviteCode = await new Promise<string>((resolve, reject) => {
    let output = '';
    let ready = false;

    const onData = (chunk: Buffer) => {
      output += chunk.toString();

      if (!inviteCode) {
        const match = /Invitation code: (\S+)/.exec(output);
        if (match) inviteCode = match[1]!;
      }
      if (!ready && /listening on/.test(output)) ready = true;

      if (inviteCode && ready) {
        clearTimeout(timeout);
        serverProcess.stdout.off('data', onData);
        resolve(inviteCode);
      }
    };

    const timeout = setTimeout(() => {
      serverProcess.stdout.off('data', onData);
      reject(new Error(`Timed out waiting for server startup. Output so far:\n${output}`));
    }, 15_000);

    serverProcess.stdout.on('data', onData);
    serverProcess.once('error', reject);
  });
});

test.afterAll(() => {
  serverProcess.kill();
  rmSync(dbDir, { recursive: true, force: true });
});

test('redeems the first invitation code and logs in', async ({ page }) => {
  await page.goto(`${BASE_URL}/login`);

  await page.getByRole('button', { name: 'Have an invitation code? Redeem it' }).click();
  await expect(page.getByRole('heading', { name: 'Redeem your invitation' })).toBeVisible();

  await page.getByLabel('Username').fill(NEW_USER.username);
  await page.getByLabel('Password').fill(NEW_USER.password);
  await page.getByLabel('Invitation Code').fill(inviteCode);
  await page.getByRole('button', { name: 'Create account' }).click();

  // Redeeming logs the new account in immediately.
  await expect(page).toHaveURL(`${BASE_URL}/`);
  await expect(page.getByRole('heading', { name: 'Browse' })).toBeVisible();

  // Confirm the account can also log in on its own, independent of that auto sign-in.
  await page.context().clearCookies();
  await page.goto(`${BASE_URL}/login`);
  await page.getByLabel('Username').fill(NEW_USER.username);
  await page.getByLabel('Password').fill(NEW_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(`${BASE_URL}/`);
  await expect(page.getByRole('heading', { name: 'Browse' })).toBeVisible();
});
