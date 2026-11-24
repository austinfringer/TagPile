import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import LoginForm from './LoginForm.svelte';

describe('LoginForm', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('submits the username and password', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    render(LoginForm);

    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'secret' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Signed in successfully.');
    expect(fetchFn).toHaveBeenCalledWith('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'secret' }),
    });
  });

  it('shows a generic error when login fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    render(LoginForm);

    await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'alice' } });
    await fireEvent.input(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid username or password.');
  });

  it('does not show a switch link when no callback is provided', () => {
    render(LoginForm);

    expect(
      screen.queryByRole('button', { name: 'Have an invitation code? Redeem it' }),
    ).not.toBeInTheDocument();
  });

  it('calls onSwitchToInvite when the switch link is clicked', async () => {
    const onSwitchToInvite = vi.fn();
    render(LoginForm, { onSwitchToInvite });

    await fireEvent.click(
      screen.getByRole('button', { name: 'Have an invitation code? Redeem it' }),
    );

    expect(onSwitchToInvite).toHaveBeenCalledOnce();
  });
});
