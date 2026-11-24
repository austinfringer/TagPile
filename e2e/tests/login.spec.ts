import { expect, test } from '@playwright/test';
import { TEST_USER } from '../global-setup.ts';

test('logs in and lands on the home page', async ({ page }) => {
  // The server sends a Content-Security-Policy; the client must work without violating it.
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violations.push(msg.text());
  });
  await page.goto('/login');

  await page.getByLabel('Username').fill(TEST_USER.username);
  await page.getByLabel('Password').fill(TEST_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Browse' })).toBeVisible();
  await page.getByRole('button', { name: 'Manage tags' }).click();
  await page.getByRole('button', { name: 'Jobs' }).click();
  expect(violations).toEqual([]);
});

test('logs out and cannot return to the app without a new login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Username').fill(TEST_USER.username);
  await page.getByLabel('Password').fill(TEST_USER.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('/');

  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL('/login');
  await page.goto('/');
  await expect(page).toHaveURL('/login');
});

test('redirects an unauthenticated visitor to the login page', async ({ page }) => {
  await page.goto('/');

  await expect(page).toHaveURL('/login');
  await expect(page.getByRole('heading', { name: 'Welcome back' })).toBeVisible();
});
