import { describe, expect, it, vi } from 'vitest';
import { currentPath, goBack, navigate } from './router.svelte';

describe('router', () => {
  it('navigate updates the current path and history', () => {
    navigate('/jobs');

    expect(currentPath()).toBe('/jobs');
    expect(window.location.pathname).toBe('/jobs');
  });

  it('navigating to the current path is a no-op', () => {
    navigate('/jobs');
    const entriesBefore = window.history.length;

    navigate('/jobs');

    expect(window.history.length).toBe(entriesBefore);
  });

  it('popstate re-syncs the current path', () => {
    navigate('/jobs');
    window.history.replaceState(null, '', '/tag');

    window.dispatchEvent(new PopStateEvent('popstate'));

    expect(currentPath()).toBe('/tag');
    navigate('/');
  });

  it('goBack returns to the page the user came from', async () => {
    navigate('/tag');
    navigate('/tags/5');

    goBack('/tags');

    await vi.waitFor(() => expect(currentPath()).toBe('/tag'));
  });

  it('goBack goes to the fallback on the first page of the session', () => {
    window.history.replaceState(null, '', '/tags/5');
    window.dispatchEvent(new PopStateEvent('popstate'));

    goBack('/tags');

    expect(currentPath()).toBe('/tags');
    navigate('/');
  });
});
