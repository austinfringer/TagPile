import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import InvitationForm from './InvitationForm.svelte';

describe('InvitationForm', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('redeems the invitation code and signs the new user in', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    render(InvitationForm);

    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } });
    await fireEvent.input(screen.getByLabelText('Invitation Code'), {
      target: { value: 'CODE123' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Account created successfully.');
    expect(fetchFn).toHaveBeenCalledWith('/api/invitation/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'CODE123', username: 'alice', password: 'secret-pass' }),
    });
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret-pass' }),
    });
  });

  it('shows a generic error when the code is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    render(InvitationForm);

    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } });
    await fireEvent.input(screen.getByLabelText('Invitation Code'), {
      target: { value: 'BAD' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Invalid code, username or password.',
    );
  });

  it('rejects a short password before it sends a request', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    render(InvitationForm);

    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'short' } });
    await fireEvent.input(screen.getByLabelText('Invitation Code'), { target: { value: 'C' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Use at least 8 characters.');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('shows the server message when the username is taken', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(Response.json({ error: 'Username already exists' }, { status: 409 })),
    );
    render(InvitationForm);

    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'secret-pass' } });
    await fireEvent.input(screen.getByLabelText('Invitation Code'), { target: { value: 'C' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Username already exists');
  });

  it('does not show a switch link when no callback is provided', () => {
    render(InvitationForm);

    expect(
      screen.queryByRole('button', { name: 'Already have an account? Sign in' }),
    ).not.toBeInTheDocument();
  });

  it('calls onSwitchToLogin when the switch link is clicked', async () => {
    const onSwitchToLogin = vi.fn();
    render(InvitationForm, { onSwitchToLogin });

    await fireEvent.click(screen.getByRole('button', { name: 'Already have an account? Sign in' }));

    expect(onSwitchToLogin).toHaveBeenCalledOnce();
  });
});
