import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutocompleteResult, Completion } from '../api';
import FileSearchInput from './FileSearchInput.svelte';

const LANDSCAPE: Completion = {
  text: 'Landscape',
  kind: 'tag',
  tagId: 6,
  fileCount: 2,
  parent: 'Art',
};

const KAROTTE: Completion = {
  text: 'Karotte',
  kind: 'tag',
  tagId: 9,
  fileCount: 3,
  parent: null,
  primary: 'carrot',
};

/** Autocompletes the word 'lan' (offset 8 in 'cat and lan'). */
const RESULT: AutocompleteResult = { from: 8, to: 11, completions: [LANDSCAPE, KAROTTE] };

function stubFetch(handler: (q: string) => AutocompleteResult) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const q = new URL(url, 'https://test').searchParams.get('q') ?? '';
    return new Response(JSON.stringify(handler(q)), { status: 200 });
  });
  return calls;
}

const searchInput = () => screen.getByLabelText('Search files');

describe('FileSearchInput', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('fetches suggestions on debounce and shows alias, main alias, and file counts', async () => {
    const calls = stubFetch(() => RESULT);
    render(FileSearchInput, { libraryId: 3, value: '', debounceMs: 1 });

    await fireEvent.input(searchInput(), { target: { value: 'cat and lan' } });

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    expect(
      calls.some(
        (url) =>
          url.includes('/autocomplete') &&
          (url.includes('q=cat+and+lan') || url.includes('q=cat%20and%20lan')),
      ),
    ).toBe(true);
    expect(screen.getByText('Landscape')).toBeInTheDocument();
    expect(screen.getByText('2 files')).toBeInTheDocument();
    // The match came through the secondary alias Karotte: the row names the primary alias.
    expect(screen.getByText('Karotte')).toBeInTheDocument();
    expect(screen.getByText('→ carrot')).toBeInTheDocument();
    expect(screen.getByText('3 files')).toBeInTheDocument();
  });

  it('navigates with the arrow keys and applies with Enter', async () => {
    stubFetch(() => RESULT);
    render(FileSearchInput, { libraryId: 3, value: '', debounceMs: 1 });

    const input = searchInput();
    await fireEvent.input(input, { target: { value: 'cat and lan' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[1]!.id);

    // Wrap around in both directions.
    await fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    // Only the current identifier (from/to) is replaced.
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('cat and Karotte');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('applies a suggestion on click and keeps focus in the input', async () => {
    stubFetch(() => RESULT);
    render(FileSearchInput, { libraryId: 3, value: '', debounceMs: 1 });

    const input = searchInput();
    await fireEvent.input(input, { target: { value: 'cat and lan' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await fireEvent.mouseDown(screen.getByText('Landscape'));

    expect(input).toHaveValue('cat and Landscape');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it('Escape closes the list and it stays closed while the draft is unchanged', async () => {
    stubFetch(() => RESULT);
    render(FileSearchInput, { libraryId: 3, value: '', debounceMs: 1 });

    const input = searchInput();
    await fireEvent.input(input, { target: { value: 'cat and lan' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    // Typing opens it again.
    await fireEvent.input(input, { target: { value: 'cat and land' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
  });

  it('shows no list when there is nothing to complete with', async () => {
    stubFetch(() => ({ from: 0, to: 0, completions: [] }));
    render(FileSearchInput, { libraryId: 3, value: '', debounceMs: 1 });

    await fireEvent.input(searchInput(), { target: { value: 'zzz' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
