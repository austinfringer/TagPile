import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibrarySummary } from '../lib/api';
import { navigate } from '../lib/router.svelte';
import LibrariesPage from './LibrariesPage.svelte';

function library(overrides: Partial<LibrarySummary>): LibrarySummary {
  return {
    library_id: 1,
    name: 'Photos',
    root_path: '/data/photos',
    role: 'owner',
    permissions: { canRead: true, canCreateTag: true, canTagFiles: true, canManageLibrary: true },
    ...overrides,
  };
}

/** Stubs global fetch: `/api/libraries` → list; POSTs recorded and append to the list. */
function stubFetch(libraries: LibrarySummary[], createError?: string) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === '/api/libraries' && init?.method === 'POST') {
      if (createError) {
        return new Response(JSON.stringify({ error: createError }), { status: 400 });
      }
      const body = JSON.parse(String(init.body)) as { name: string; rootPath: string };
      const created = library({ library_id: 2, name: body.name, root_path: body.rootPath });
      libraries.push(created);
      return new Response(JSON.stringify({ library: created }), { status: 201 });
    }
    if (url.startsWith('/api/libraries/') && init?.method === 'DELETE') {
      const id = Number(url.split('/').pop());
      const index = libraries.findIndex((l) => l.library_id === id);
      if (index >= 0) libraries.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    if (url === '/api/libraries')
      return new Response(JSON.stringify({ libraries }), { status: 200 });
    return new Response(JSON.stringify({}), { status: 404 });
  });
  return calls;
}

describe('LibrariesPage', () => {
  beforeEach(() => navigate('/libraries'));
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the header, summary pills, and a card per library', async () => {
    stubFetch([
      library({ library_id: 1, name: 'Photos', root_path: '/data/photos' }),
      library({
        library_id: 2,
        name: 'Docs',
        root_path: '/srv/docs',
        role: 'reader',
        permissions: {
          canRead: true,
          canCreateTag: false,
          canTagFiles: false,
          canManageLibrary: false,
        },
      }),
    ]);
    render(LibrariesPage);

    expect(screen.getByRole('heading', { name: 'Libraries' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('2 total')).toBeInTheDocument());
    expect(screen.getByText('1 managed')).toBeInTheDocument();
    expect(screen.getByText('Photos')).toBeInTheDocument();
    expect(screen.getByText('/data/photos')).toBeInTheDocument();
    expect(screen.getByText('reader')).toBeInTheDocument();
  });

  it('shows an empty-state hint when there are no libraries', async () => {
    stubFetch([]);
    render(LibrariesPage);

    await waitFor(() => expect(screen.getByText(/No libraries yet/)).toBeInTheDocument());
  });

  it('keeps Create disabled until both fields are valid, then POSTs', async () => {
    const calls = stubFetch([]);
    render(LibrariesPage);

    const createButton = screen.getByRole('button', { name: 'Create library' });
    expect(createButton).toBeDisabled();

    await fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Memes' },
    });
    expect(createButton).toBeDisabled();

    await fireEvent.input(screen.getByRole('textbox', { name: 'Root path' }), {
      target: { value: '/data/memes' },
    });
    expect(createButton).not.toBeDisabled();

    await fireEvent.click(createButton);

    await waitFor(() => {
      const post = calls.find((c) => c.init?.method === 'POST');
      expect(post?.init?.body).toBe(JSON.stringify({ name: 'Memes', rootPath: '/data/memes' }));
    });
    // The new library appears in the refreshed list and the form is reset.
    await waitFor(() => expect(screen.getByText('Memes')).toBeInTheDocument());
    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  });

  it('surfaces a server error from a failed create', async () => {
    stubFetch([], 'rootPath must be an existing directory');
    render(LibrariesPage);

    await fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Memes' },
    });
    await fireEvent.input(screen.getByRole('textbox', { name: 'Root path' }), {
      target: { value: '/nope' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Create library' }));

    await waitFor(() =>
      expect(screen.getByText('rootPath must be an existing directory')).toBeInTheDocument(),
    );
  });

  it('offers Delete only for libraries the user can manage', async () => {
    stubFetch([
      library({ library_id: 1, name: 'Photos' }),
      library({
        library_id: 2,
        name: 'Docs',
        role: 'reader',
        permissions: {
          canRead: true,
          canCreateTag: false,
          canTagFiles: false,
          canManageLibrary: false,
        },
      }),
    ]);
    render(LibrariesPage);

    await waitFor(() => expect(screen.getByText('2 total')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
  });

  it('deleting a library goes through the digit-confirmation modal', async () => {
    const calls = stubFetch([library({ library_id: 1, name: 'Photos' })]);
    render(LibrariesPage);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    // No DELETE may fire until the digit challenge is typed.
    const modal = screen.getByRole('dialog');
    const challenge =
      within(modal)
        .getByText(
          (_, el) => el?.tagName === 'P' && /Type \d{5} to confirm/.test(el.textContent ?? ''),
        )
        .textContent?.match(/\d{5}/)?.[0] ?? '';
    const modalDelete = within(modal).getByRole('button', { name: 'Delete library' });
    expect(modalDelete).toBeDisabled();

    await fireEvent.input(within(modal).getByLabelText('Confirmation digits'), {
      target: { value: challenge },
    });
    await fireEvent.click(modalDelete);

    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/libraries/1', init: { method: 'DELETE' } }),
    );
    await waitFor(() => expect(screen.getByText(/No libraries yet/)).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('cancelling the modal keeps the library', async () => {
    const calls = stubFetch([library({ library_id: 1, name: 'Photos' })]);
    render(LibrariesPage);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('Photos')).toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === 'DELETE')).toBe(false);
  });

  it('cancel clears the draft form', async () => {
    stubFetch([]);
    render(LibrariesPage);

    await fireEvent.input(screen.getByRole('textbox', { name: 'Name' }), {
      target: { value: 'Memes' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('');
  });
});
