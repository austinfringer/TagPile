import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibrarySummary } from '../../api';
import JsonImportOptions from './JsonImportOptions.svelte';

const libraries: LibrarySummary[] = [
  {
    library_id: 3,
    name: 'Photos',
    root_path: '/data/photos',
    role: 'owner',
    permissions: { canRead: true, canCreateTag: true, canTagFiles: true, canManageLibrary: true },
  },
];

describe('JsonImportOptions', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('adds independent direct paths and reports them with shared creation options', async () => {
    vi.stubGlobal(
      'fetch',
      async () => new Response(JSON.stringify({ libraries }), { status: 200 }),
    );
    const onChange = vi.fn();
    render(JsonImportOptions, { onChange });

    await waitFor(() => expect(screen.getByLabelText('Library')).toBeEnabled());
    await fireEvent.change(screen.getByLabelText('Library'), { target: { value: '3' } });
    await fireEvent.input(screen.getByLabelText('JSON path 1'), {
      target: { value: 'author.name' },
    });
    await fireEvent.click(screen.getByLabelText('Direct mode for JSON path 1'));

    expect(screen.getByLabelText('Tag to apply for JSON path 1')).toBeDisabled();
    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        libraryId: 3,
        paths: [{ path: 'author.name', direct: true }],
      }),
    );

    await fireEvent.click(screen.getByRole('button', { name: '+ Add JSON path' }));
    await fireEvent.input(screen.getByLabelText('JSON path 2'), {
      target: { value: 'people' },
    });
    await fireEvent.click(screen.getByLabelText('Direct mode for JSON path 2'));
    await fireEvent.click(screen.getByLabelText('Create if missing'));

    await waitFor(() =>
      expect(onChange).toHaveBeenLastCalledWith({
        libraryId: 3,
        paths: [
          { path: 'author.name', direct: true },
          { path: 'people', direct: true },
        ],
        createIfMissing: true,
        color: '#e74c3c',
      }),
    );
    const table = screen.getByRole('table', { name: 'JSON paths' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByRole('columnheader', { name: 'JSON path' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Tag to apply' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Direct' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Actions' })).toBeInTheDocument();
  });
});
