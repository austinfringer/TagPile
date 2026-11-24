import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibrarySummary, QueriedFile, TagSummary } from '../lib/api';
import { clearPreviews } from '../lib/previews.svelte';
import { clearSelection } from '../lib/selection.svelte';
import { clearTagStore } from '../lib/tagStore.svelte';
import TagPage from './TagPage.svelte';

const PHOTOS: LibrarySummary = {
  library_id: 3,
  name: 'Photos',
  root_path: '/data/photos',
  role: 'owner',
  permissions: { canRead: true, canCreateTag: true, canTagFiles: true, canManageLibrary: true },
};

const TAGS: TagSummary[] = [
  { tagId: 5, name: 'Art', color: '#1416b2', isCategory: true, fileCount: 3, parentName: null },
  {
    tagId: 6,
    name: 'Landscape',
    color: '#10b981',
    isCategory: false,
    fileCount: 2,
    parentName: 'Art',
  },
  { tagId: 7, name: 'Moody', color: '#ec4899', isCategory: false, fileCount: 1, parentName: null },
];

const LAKE: QueriedFile = {
  fileId: 10,
  name: 'alpine-lake.jpg',
  path: 'photos/alpine-lake.jpg',
  type: 'image',
  extension: 'jpg',
  size: 4_410_457, // ≈ 4.2 MB
  missing: false,
  locationCount: 1,
};

const NOTES: QueriedFile = {
  fileId: 11,
  name: 'release-notes.txt',
  path: 'docs/release-notes.txt',
  type: 'text',
  extension: 'txt',
  size: 1024,
  missing: false,
  locationCount: 1,
};

const DETAIL: QueriedFile = {
  ...LAKE,
  locations: [
    {
      location_id: 1,
      file_id: 10,
      library_id: 3,
      path: 'photos/alpine-lake.jpg',
      last_seen: 1_774_000_000_000,
      missing: 0,
      previous_file_id: null,
      extension: 'jpg',
      type: 'image',
      created_at: 1_710_806_400_000, // 2024-03-19
      modified_at: 1_710_892_800_000, // 2024-03-20
    },
  ],
  instances: [
    {
      tagId: 6,
      name: 'Landscape',
      values: [{ valueId: 1, kind: 'text', text: 'Taken at dawn' }],
    },
    { tagId: 7, name: 'Moody', values: [] },
  ],
};

/** Stubs global fetch: libraries, tags, files, file queries, batch/tag writes recorded. */
function stubFetch(
  options: {
    tags?: TagSummary[];
    queryTags?: Record<number, TagSummary>;
    filesTotal?: number;
  } = {},
) {
  const tags = options.tags ?? TAGS;
  const queryTags =
    options.queryTags ?? Object.fromEntries(TAGS.map((t): [number, TagSummary] => [t.tagId, t]));
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url === '/api/libraries') return json({ libraries: [PHOTOS] });
    if (url.startsWith('/api/libraries/3/tags') && !init) return json({ total: tags.length, tags });
    if (url.startsWith('/api/libraries/3/tags') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { alias: string; color: string };
      return json(
        {
          tag: {
            tag: { tag_id: 8, library_id: 3, color: body.color },
            aliases: [],
            instances: [],
          },
        },
        201,
      );
    }
    if (url.startsWith('/api/libraries/3/files/query') && init?.method === 'POST') {
      const { ids } = JSON.parse(String(init.body)) as { ids: number[] };
      return json({
        files: ids.includes(10) ? [DETAIL] : [],
        notFound: [],
        tags: queryTags,
      });
    }
    if (url.startsWith('/api/libraries/3/files/batch') && init?.method === 'POST') {
      return json({ files: [] });
    }
    if (url.startsWith('/api/libraries/3/files')) {
      const total = url.includes('count=0') ? null : (options.filesTotal ?? 2);
      return json({ total, files: [LAKE, NOTES] });
    }
    // No file has a preview here, so the tiles and inspector deck use their placeholders.
    if (url === '/api/previews' && init?.method === 'POST') {
      const { ids } = JSON.parse(String(init.body)) as { ids: number[] };
      return json({ previews: [], notFound: ids });
    }
    return json({ error: 'not stubbed' }, 404);
  });
  return calls;
}

describe('TagPage', () => {
  afterEach(() => {
    cleanup();
    clearSelection();
    clearPreviews();
    clearTagStore();
    vi.unstubAllGlobals();
  });

  it('renders tag groups (uncategorized last) and file tiles once loaded', async () => {
    stubFetch();
    render(TagPage, { debounceMs: 1 });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Landscape' })));
    expect(screen.getByRole('heading', { name: 'Art' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Uncategorized' })).toBeInTheDocument();
    // The category tag itself is a heading through its children, not a chip.
    expect(screen.queryByRole('button', { name: 'Art' })).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('alpine-lake.jpg')).toBeInTheDocument());
    expect(screen.getByText('release-notes.txt')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tags')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quick tag' })).toBeInTheDocument();
  });

  it('selecting a file shows its metadata and tags in the inspector', async () => {
    stubFetch();
    render(TagPage, { debounceMs: 1 });
    await waitFor(() => expect(screen.getByText('alpine-lake.jpg')).toBeInTheDocument());

    const tile = screen.getByRole('button', { name: /alpine-lake/ });
    await fireEvent.click(tile);

    await waitFor(() => expect(screen.getByText('1 file')).toBeInTheDocument());
    expect(tile).toHaveClass('selected');
    expect(tile).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(screen.getByText('File Name')).toBeInTheDocument());
    expect(screen.getByText('4.2 MB')).toBeInTheDocument();
    expect(screen.getByText('2024-03-19')).toBeInTheDocument();
    // The valued tag renders as a full row with its value; the plain tag as a grid chip.
    expect(screen.getByText('Taken at dawn')).toBeInTheDocument();
    expect(screen.getAllByText('Moody').length).toBeGreaterThanOrEqual(2); // palette + inspector
  });

  it('clicking again removes the file from the selection', async () => {
    stubFetch();
    render(TagPage, { debounceMs: 1 });
    await waitFor(() => expect(screen.getByText('alpine-lake.jpg')).toBeInTheDocument());

    const tile = screen.getByRole('button', { name: /alpine-lake/ });
    await fireEvent.click(tile);
    await waitFor(() => expect(screen.getByText('1 file')).toBeInTheDocument());
    await fireEvent.click(tile);

    await waitFor(() =>
      expect(
        screen.getByText('Select files in the grid to see their tags and metadata.'),
      ).toBeInTheDocument(),
    );
  });

  it('applying a palette tag sends an idempotent tag op for the selection', async () => {
    const calls = stubFetch();
    render(TagPage, { debounceMs: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Landscape' })));

    const batchCalls = () =>
      calls.filter(
        (c) => c.url.startsWith('/api/libraries/3/files/batch') && c.init?.method === 'POST',
      );

    // Tag buttons are never disabled; clicking with an empty selection sends no request.
    const chip = screen.getByRole('button', { name: 'Landscape' });
    expect(chip).not.toBeDisabled();
    await fireEvent.click(chip);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batchCalls()).toHaveLength(0);

    await fireEvent.click(screen.getByRole('button', { name: /alpine-lake/ }));
    await fireEvent.click(chip);

    await waitFor(() => expect(batchCalls()).toHaveLength(1));
    expect(batchCalls()[0]?.init?.body).toBe(
      JSON.stringify({ fileIds: [10], ops: [{ op: 'tag', tagId: 6 }] }),
    );
  });

  it('paginates file results with Prev/Next buttons and a page readout', async () => {
    // 50 results over the page size of 24 land on 3 pages.
    const calls = stubFetch({ filesTotal: 50 });
    render(TagPage, { debounceMs: 1 });

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
    expect(calls.some((c) => c.url.includes('/files?') && c.url.includes('limit=24'))).toBe(true);

    await fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(screen.getByText('Page 2 of 3')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Prev' })).not.toBeDisabled();
    expect(calls.some((c) => c.url.includes('/files?') && c.url.includes('offset=24'))).toBe(true);

    await fireEvent.click(screen.getByRole('button', { name: 'Prev' }));

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument());

    // Only the first search asks for the count; the page changes keep its total.
    const searches = calls.filter((c) => c.url.includes('/files?'));
    expect(searches.map((c) => c.url.includes('count=0'))).toEqual([false, true, true]);
  });

  it('changes entries per page from the dropdown and resets to the first page', async () => {
    const calls = stubFetch({ filesTotal: 100 });
    render(TagPage, { debounceMs: 1 });

    await waitFor(() => expect(screen.getByText('Page 1 of 5')).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByText('Page 2 of 5')).toBeInTheDocument());

    await fireEvent.change(screen.getByLabelText('Entries per page'), { target: { value: '48' } });

    await waitFor(() => expect(screen.getByText('Page 1 of 3')).toBeInTheDocument());
    expect(calls.some((c) => c.url.includes('/files?') && c.url.includes('limit=48'))).toBe(true);
  });

  it('opens the stack viewer from the selection deck and closes it from the backdrop', async () => {
    stubFetch();
    render(TagPage, { debounceMs: 1 });
    await waitFor(() => expect(screen.getByText('alpine-lake.jpg')).toBeInTheDocument());
    await fireEvent.click(screen.getByRole('button', { name: /alpine-lake/ }));
    await waitFor(() => expect(screen.getByText('1 file')).toBeInTheDocument());

    await fireEvent.click(screen.getByRole('button', { name: 'View selection stack' }));
    const dialog = await screen.findByRole('dialog', { name: 'Selected files' });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('1 of 1')).toBeInTheDocument();

    await fireEvent.click(dialog.parentElement!);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Selected files' })).not.toBeInTheDocument(),
    );
  });

  it('changes file tile size from the preview size dropdown', async () => {
    stubFetch();
    render(TagPage, { debounceMs: 1 });

    await waitFor(() => expect(screen.getByLabelText('Preview size')).toBeInTheDocument());
    const tile = await screen.findByRole('button', { name: /alpine-lake/ });
    expect(tile).not.toHaveClass('small');
    expect(tile).not.toHaveClass('large');

    await fireEvent.change(screen.getByLabelText('Preview size'), { target: { value: 'large' } });
    expect(tile).toHaveClass('large');

    await fireEvent.change(screen.getByLabelText('Preview size'), { target: { value: 'small' } });
    expect(tile).toHaveClass('small');
    expect(tile).not.toHaveClass('large');
  });

  it('searches files on the server after the input debounce', async () => {
    const calls = stubFetch();
    render(TagPage, { debounceMs: 1 });
    await waitFor(() => expect(screen.getByText('alpine-lake.jpg')).toBeInTheDocument());
    await fireEvent.input(screen.getByLabelText('Search files'), { target: { value: 'lake' } });

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/files?q=lake'))).toBe(true);
    });
  });

  it('searches tags by alias prefix on the server after the input debounce', async () => {
    const calls = stubFetch();
    render(TagPage, { debounceMs: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Landscape' })));

    await fireEvent.input(screen.getByLabelText('Search tags'), { target: { value: 'land' } });

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/tags?q=land'))).toBe(true);
    });
  });

  it('creates a tag from the quick tag dialog', async () => {
    const calls = stubFetch();
    render(TagPage, { debounceMs: 1 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Quick tag' })));

    await fireEvent.click(screen.getByRole('button', { name: 'Quick tag' }));
    const nameInput = screen.getByRole('textbox', { name: 'Primary alias' });
    await fireEvent.input(nameInput, { target: { value: 'Night' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Create tag' }));

    await waitFor(() => {
      const post = calls.find(
        (c) => c.url === '/api/libraries/3/tags' && c.init?.method === 'POST',
      );
      expect(post?.init?.body).toBe(JSON.stringify({ alias: 'Night', color: '#2563eb' }));
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Quick tag' })).not.toBeInTheDocument(),
    );
  });

  it('shows category tags as category headings even when empty, and only groups children under categories', async () => {
    stubFetch({
      tags: [
        {
          tagId: 5,
          name: 'EmptyCat',
          color: '#1416b2',
          isCategory: true,
          fileCount: 0,
          parentName: null,
        },
        {
          tagId: 6,
          name: 'PlainParent',
          color: '#10b981',
          isCategory: false,
          fileCount: 1,
          parentName: null,
        },
        {
          tagId: 7,
          name: 'ChildOfPlain',
          color: '#ec4899',
          isCategory: false,
          fileCount: 1,
          parentName: 'PlainParent',
        },
      ],
    });
    render(TagPage, { debounceMs: 1 });

    await waitFor(() => expect(screen.getByRole('heading', { name: 'EmptyCat' })));
    // PlainParent is not a category, so it does not become a category heading; both tags stay in Uncategorized.
    expect(screen.queryByRole('heading', { name: 'PlainParent' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'PlainParent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ChildOfPlain' })).toBeInTheDocument();
  });

  it('renders tag colors and categories in the inspector from queryFiles even when listTags returned empty', async () => {
    stubFetch({ tags: [] });
    render(TagPage, { debounceMs: 1 });
    await waitFor(() => expect(screen.getByText('alpine-lake.jpg')).toBeInTheDocument());

    await fireEvent.click(screen.getByRole('button', { name: /alpine-lake/ }));
    await waitFor(() => expect(screen.getByText('Taken at dawn')).toBeInTheDocument());

    // Category heading 'Art' and tag colors for 'Landscape' (#10b981) and 'Moody' (#ec4899)
    // come from queryFiles.tags via the shared reactive tag store.
    expect(screen.getByRole('heading', { name: 'Art' })).toBeInTheDocument();
    const moodyChip = screen.getByText('Moody');
    expect(moodyChip.style.backgroundColor).toBe('rgb(236, 72, 153)');

    const landscapeRow = screen.getByText('Landscape').closest<HTMLElement>('.tag-value');
    expect(landscapeRow?.style.backgroundColor).toBe('rgb(16, 185, 129)');
  });
});
