import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import type { JobSummary } from '../../api';
import JsonImportDetails from './JsonImportDetails.svelte';

const job: JobSummary = {
  id: 'j1',
  type: 'json-import',
  status: 'complete',
  userId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:01Z',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
  error: null,
  options: null,
  statusData: {
    state: 'complete',
    pathStats: [
      {
        path: 'author.name',
        tagId: 7,
        tagName: 'Author',
        direct: false,
        applications: 2,
        tagsCreated: 0,
        misses: 1,
      },
      {
        path: 'people',
        direct: true,
        applications: 4,
        tagsCreated: 3,
        misses: 1,
      },
    ],
    misses: [
      { json: 'a.jpg.json', path: 'author.name', reason: 'Path not found' },
      { json: 'b.jpg.json', path: 'people', reason: 'No usable value at path' },
    ],
  },
  canManage: true,
};

describe('JsonImportDetails', () => {
  afterEach(cleanup);

  it('renders per-path statistics and an expandable missed-application log', async () => {
    render(JsonImportDetails, { job, libraries: [] });

    expect(screen.getByRole('heading', { name: 'JSON path report' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'author.name Author 2 0 1' })).toBeInTheDocument();
    expect(screen.getByRole('row', { name: 'people Direct 4 3 1' })).toBeInTheDocument();

    const summary = screen.getByText('View missed applications (2)');
    const log = summary.closest('details')!;
    expect(log.open).toBe(false);
    await fireEvent.click(summary);
    expect(log.open).toBe(true);
    expect(screen.getByText('a.jpg.json')).toBeInTheDocument();
    expect(screen.getByText('b.jpg.json')).toBeInTheDocument();
    expect(screen.getAllByText('Path not found')).toHaveLength(1);
    expect(screen.getAllByText('No usable value at path')).toHaveLength(1);
  });
});
