import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Login from './Login.svelte';

describe('Login', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders the invitation-only login page', () => {
    render(Login);

    expect(screen.getByText('TagPile')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText('Accounts are available by invitation only.')).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: /create|sign up|register/i }),
    ).not.toBeInTheDocument();
  });

  it('switches to the invitation redemption form and back', async () => {
    render(Login);

    await fireEvent.click(
      screen.getByRole('button', { name: 'Have an invitation code? Redeem it' }),
    );

    expect(screen.getByRole('heading', { name: 'Redeem your invitation' })).toBeInTheDocument();
    expect(screen.getByLabelText('Invitation Code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Already have an account? Sign in' }));

    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Invitation Code')).not.toBeInTheDocument();
  });
});
