import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentPath, navigate } from '../lib/router.svelte';
import SettingsPage from './SettingsPage.svelte';

function stubFetch(isAdmin: boolean, passwordResponse = new Response(null, { status: 204 })) {
  const fetchFn = vi.fn((url: string) =>
    Promise.resolve(
      url === '/api/auth/me'
        ? Response.json({ user: { id: 'u1', username: 'alice', isAdmin } })
        : passwordResponse,
    ),
  );
  vi.stubGlobal('fetch', fetchFn);
  return fetchFn;
}

async function fillPasswordForm(current: string, next: string, confirm = next) {
  await fireEvent.input(screen.getByLabelText('Current password'), { target: { value: current } });
  await fireEvent.input(screen.getByLabelText('New password'), { target: { value: next } });
  await fireEvent.input(screen.getByLabelText('Confirm new password'), {
    target: { value: confirm },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('SettingsPage', () => {
  beforeEach(() => navigate('/settings'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows a User management button to an admin that navigates to /settings/users', async () => {
    stubFetch(true);
    render(SettingsPage);

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    const userMgmtBtn = await screen.findByRole('button', { name: /user management/i });
    await fireEvent.click(userMgmtBtn);
    expect(currentPath()).toBe('/settings/users');
  });

  it('hides User management from a non-admin', async () => {
    stubFetch(false);
    render(SettingsPage);
    expect(await screen.findByText('alice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /user management/i })).not.toBeInTheDocument();
  });

  it('changes the password', async () => {
    const fetchFn = stubFetch(false);
    render(SettingsPage);
    await fillPasswordForm('old-password', 'new-password');

    expect(await screen.findByRole('status')).toHaveTextContent('Password changed.');
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'new-password' }),
    });
  });

  it('rejects a confirmation that is not the same', async () => {
    const fetchFn = stubFetch(false);
    render(SettingsPage);
    await fillPasswordForm('old-password', 'new-password', 'other-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('not the same');
    expect(fetchFn).not.toHaveBeenCalledWith('/api/auth/password', expect.anything());
  });

  it('shows the server error for a wrong current password', async () => {
    stubFetch(false, Response.json({ error: 'Current password is not correct' }, { status: 403 }));
    render(SettingsPage);
    await fillPasswordForm('wrong', 'new-password');

    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is not correct');
  });
});
