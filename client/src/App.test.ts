import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App.svelte';
import { navigate } from './lib/router.svelte';

describe('App', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/jobs/')) {
        return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          jobs: [],
          libraries: [],
          invitations: [],
          users: [],
          user: { id: 'u1', username: 'admin', isAdmin: true },
        }),
        { status: 200 },
      );
    });
    navigate('/');
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the ribbon and the Browse placeholder on /', () => {
    render(App);

    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Browse' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Jobs/ })).not.toHaveAttribute('aria-current');
  });

  it('switches to the Jobs page when the ribbon Jobs button is clicked', async () => {
    render(App);

    await fireEvent.click(screen.getByRole('button', { name: /Jobs/ }));

    expect(screen.getByRole('heading', { name: 'Queued jobs' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Jobs/ })).toHaveAttribute('aria-current', 'page'),
    );
  });

  it('renders the job detail page on /jobs/:id', async () => {
    navigate('/jobs/abc-123');
    render(App);

    await waitFor(() => expect(screen.getByText('Failed to fetch job: 404')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Queue job' })).not.toBeInTheDocument();
  });

  it('navigates from Settings to User management via the User management button', async () => {
    navigate('/settings');
    render(App);

    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    await fireEvent.click(await screen.findByRole('button', { name: /user management/i }));

    expect(screen.getByRole('heading', { name: 'User management' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});
