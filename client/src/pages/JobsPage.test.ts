import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobSummary, LibrarySummary } from '../lib/api';
import { currentPath, navigate } from '../lib/router.svelte';
import JobsPage from './JobsPage.svelte';

const PHOTOS: LibrarySummary = {
  library_id: 3,
  name: 'Photos',
  root_path: '/data/photos',
  role: 'owner',
  permissions: { canRead: true, canCreateTag: true, canTagFiles: true, canManageLibrary: true },
};

function job(overrides: Partial<JobSummary>): JobSummary {
  return {
    id: 'j1',
    type: 'library-scan',
    status: 'running',
    userId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: null,
    error: null,
    options: { libraryId: 3, subpath: '2023/2023-11/Iceland' },
    statusData: { state: 'running', message: 'running...', filesScanned: 1284 },
    canManage: true,
    ...overrides,
  };
}

/** Stubs global fetch: `/api/jobs` → jobs list, `/api/libraries` → [PHOTOS]; POSTs recorded. */
function stubFetch(jobs: JobSummary[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/jobs' && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'new-job' }), { status: 201 });
    }
    if (url === '/api/jobs') return new Response(JSON.stringify({ jobs }), { status: 200 });
    if (url === '/api/libraries')
      return new Response(JSON.stringify({ libraries: [PHOTOS] }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  });
  return calls;
}

describe('JobsPage', () => {
  beforeEach(() => navigate('/jobs'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the header, summary pills, and a job card per job', async () => {
    stubFetch([job({ id: 'a' }), job({ id: 'b', status: 'complete', statusData: null })]);
    render(JobsPage, { pollMs: 60_000 });

    expect(screen.getByRole('heading', { name: 'Queued jobs' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('1 running')).toBeInTheDocument());
    expect(screen.getByText('1 completed')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Library scan' })).toHaveLength(2);
    expect(screen.getAllByText('Library: Photos / Subfolder: 2023/2023-11/Iceland')).toHaveLength(
      2,
    );
    expect(screen.getByText('1,284')).toBeInTheDocument();
  });

  it('shows an empty-state hint when there are no jobs', async () => {
    stubFetch([]);
    render(JobsPage, { pollMs: 60_000 });

    await waitFor(() => expect(screen.getByText(/No jobs yet/)).toBeInTheDocument());
  });

  it('only offers Halt for active jobs', async () => {
    stubFetch([job({ id: 'a' }), job({ id: 'b', status: 'complete', statusData: null })]);
    render(JobsPage, { pollMs: 60_000 });

    await waitFor(() => expect(screen.getByText('1 running')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Halt' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
  });

  it('hides Halt and Delete for a job the user cannot manage', async () => {
    stubFetch([job({ id: 'a', canManage: false })]);
    render(JobsPage, { pollMs: 60_000 });

    await waitFor(() => expect(screen.getByText('1 running')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Halt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('halting a job PUTs to its endpoint', async () => {
    const calls = stubFetch([job({ id: 'a' })]);
    render(JobsPage, { pollMs: 60_000 });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Halt' })).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Halt' }));

    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/jobs/a', init: { method: 'PUT' } }),
    );
  });

  it('clicking a card navigates to its detail page', async () => {
    stubFetch([job({ id: 'abc' })]);
    render(JobsPage, { pollMs: 60_000 });

    await waitFor(() => expect(screen.getByText('1,284')).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('link', { name: 'Library scan' }));

    expect(currentPath()).toBe('/jobs/abc');
  });

  it('closes and reopens the new job panel without resetting the draft', async () => {
    stubFetch([]);
    render(JobsPage, { pollMs: 60_000 });

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Library' })));
    await fireEvent.change(screen.getByRole('combobox', { name: 'Library' }), {
      target: { value: '3' },
    });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Subfolder' }), {
      target: { value: '2023' },
    });

    const panel = screen.getByRole('complementary', { name: 'New job' });
    await fireEvent.click(screen.getByRole('button', { name: 'Hide new job' }));

    expect(panel).toHaveClass('closed');
    expect(screen.queryByRole('complementary', { name: 'New job' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New job' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    await fireEvent.click(screen.getByRole('button', { name: 'New job' }));

    expect(panel).not.toHaveClass('closed');
    expect(screen.getByRole('combobox', { name: 'Library' })).toHaveValue('3');
    expect(screen.getByRole('textbox', { name: 'Subfolder' })).toHaveValue('2023');
  });

  it('queues a new job once the options form reports valid options', async () => {
    const calls = stubFetch([]);
    render(JobsPage, { pollMs: 60_000 });

    const queueButton = screen.getByRole('button', { name: 'Queue job' });
    expect(queueButton).toBeDisabled();

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Library' })));
    await fireEvent.change(screen.getByRole('combobox', { name: 'Library' }), {
      target: { value: '3' },
    });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Subfolder' }), {
      target: { value: '2023' },
    });

    await waitFor(() => expect(queueButton).not.toBeDisabled());
    await fireEvent.click(queueButton);

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST');
      expect(post?.init?.body).toBe(
        JSON.stringify({ jobType: 'library-scan', options: { libraryId: 3, subpath: '2023' } }),
      );
    });
  });
});
