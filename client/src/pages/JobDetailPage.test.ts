import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobSummary, LibrarySummary } from '../lib/api';
import { currentPath, navigate } from '../lib/router.svelte';
import JobDetailPage from './JobDetailPage.svelte';

const PHOTOS: LibrarySummary = {
  library_id: 3,
  name: 'Photos',
  root_path: '/data/photos',
  role: 'owner',
  permissions: { canRead: true, canCreateTag: true, canTagFiles: true, canManageLibrary: true },
};

const COMPLETED_SCAN: JobSummary = {
  id: 'j1',
  type: 'library-scan',
  status: 'complete',
  userId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:02:14Z',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:02:14Z',
  error: null,
  options: { libraryId: 3, subpath: '2023/2023-08/Japan' },
  statusData: {
    state: 'complete',
    filesScanned: 1284,
    filesCreated: 12,
    filesMigrated: 1,
    duplicateFiles: 1,
    idleFiles: 1261,
    missingLocations: 0,
    duplicates: [{ path: 'imports/temple-gate-01.jpg', siblings: ['Kyoto/temple-gate.jpg'] }],
    migrated: [{ path: 'Photos/2023/canal-night.jpg' }],
  },
  canManage: true,
};

function stubFetch(job: JobSummary | null) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.startsWith('/api/jobs/') && job !== null)
      return new Response(JSON.stringify({ job }), { status: 200 });
    if (url === '/api/libraries')
      return new Response(JSON.stringify({ libraries: [PHOTOS] }), { status: 200 });
    return new Response(JSON.stringify({ error: 'Job not found' }), { status: 404 });
  });
  return calls;
}

describe('JobDetailPage', () => {
  beforeEach(() => navigate('/jobs/j1'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the job summary, counters, and scan detail sections', async () => {
    stubFetch(COMPLETED_SCAN);
    render(JobDetailPage, { id: 'j1', pollMs: 60_000 });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Library scan' })).toBeInTheDocument(),
    );
    expect(screen.getByText('Library: Photos / Subfolder: 2023/2023-08/Japan')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('Message: completed in 2m 14s')).toBeInTheDocument();
    expect(screen.getByText('Files scanned')).toBeInTheDocument();
    expect(screen.getByText('1,284')).toBeInTheDocument();
    // Type-specific sections
    expect(screen.getByRole('heading', { name: 'Duplicate files' })).toBeInTheDocument();
    expect(screen.getByText('temple-gate-01.jpg')).toBeInTheDocument();
    expect(screen.getByText('Migrated files')).toBeInTheDocument();
    expect(screen.getByText('Photos/2023/canal-night.jpg')).toBeInTheDocument();
  });

  it('shows an error when the job does not exist', async () => {
    stubFetch(null);
    render(JobDetailPage, { id: 'nope', pollMs: 60_000 });

    await waitFor(() => expect(screen.getByText('Failed to fetch job: 404')).toBeInTheDocument());
  });

  it('delete returns to the jobs list', async () => {
    const calls = stubFetch(COMPLETED_SCAN);
    render(JobDetailPage, { id: 'j1', pollMs: 60_000 });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(currentPath()).toBe('/jobs'));
    expect(calls).toContainEqual({ url: '/api/jobs/j1', init: { method: 'DELETE' } });
  });

  it('hides Halt and Delete for a job the user cannot manage', async () => {
    stubFetch({ ...COMPLETED_SCAN, status: 'running', canManage: false });
    render(JobDetailPage, { id: 'j1', pollMs: 60_000 });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Library scan' })).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Halt' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('the back button returns to the page the user came from', async () => {
    navigate('/tag');
    navigate('/jobs/j1');
    stubFetch(COMPLETED_SCAN);
    render(JobDetailPage, { id: 'j1', pollMs: 60_000 });

    await fireEvent.click(screen.getByRole('button', { name: '← Back' }));

    await waitFor(() => expect(currentPath()).toBe('/tag'));
  });
});
