import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LibrarySummary, TagGraph, TagGraphEdge, TagGraphNode } from '../lib/api';
import { clearTagStore } from '../lib/tagStore.svelte';
import ManageTagsPage from './ManageTagsPage.svelte';

const PHOTOS: LibrarySummary = {
  library_id: 3,
  name: 'Photos',
  root_path: '/data/photos',
  role: 'owner',
  permissions: { canRead: true, canCreateTag: true, canTagFiles: true, canManageLibrary: true },
};

const node = (tagId: number, name: string, extra: Partial<TagGraphNode> = {}): TagGraphNode => ({
  tagId,
  name,
  color: null,
  isCategory: false,
  fileCount: 0,
  parentName: null,
  aliases: [],
  ...extra,
});

const edge = (subjectTagId: number, tagId: number, flags: Partial<TagGraphEdge>): TagGraphEdge => ({
  subjectTagId,
  tagId,
  parent: false,
  primary: false,
  component: false,
  valueCount: 0,
  ...flags,
});

const GRAPH: TagGraph = {
  tags: [
    node(1, 'Character', { isCategory: true }),
    node(3, 'Mario', { aliases: ['jumpman'], fileCount: 4 }),
    node(5, 'Overalls'),
    node(2, 'Pet'),
  ],
  edges: [
    edge(3, 1, { parent: true, primary: true }),
    edge(3, 2, { parent: true }),
    edge(3, 5, { component: true }),
  ],
};

function stubFetch(options: { library?: LibrarySummary } = {}) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? 'GET' });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url === '/api/libraries') return json({ libraries: [options.library ?? PHOTOS] });
    if (url === '/api/libraries/3/tag-graph') return json(GRAPH);
    if (url.startsWith('/api/libraries/3/tags/') && init?.method !== undefined) {
      return new Response(null, { status: 204 });
    }
    return json({ error: 'not stubbed' }, 404);
  });
  return calls;
}

const tree = () => screen.getByLabelText('Tag tree');
const graphNode = (name: string) =>
  within(screen.getByLabelText('Tag graph')).getByRole('button', { name });

describe('ManageTagsPage', () => {
  afterEach(() => {
    cleanup();
    clearTagStore();
    vi.unstubAllGlobals();
  });

  it('shows the root tags in the tree and the relationships in the graph', async () => {
    stubFetch();
    render(ManageTagsPage, { debounceMs: 0 });
    await waitFor(() => expect(within(tree()).getByText('Character')).toBeInTheDocument());
    expect(within(tree()).getByText('Pet')).toBeInTheDocument();
    expect(within(tree()).queryByText('Mario')).not.toBeInTheDocument();
    expect(graphNode('Mario')).toBeInTheDocument();
    expect(graphNode('Overalls')).toBeInTheDocument();
  });

  it('expands a tree row to show its children', async () => {
    stubFetch();
    render(ManageTagsPage, { debounceMs: 0 });
    await fireEvent.click(await screen.findByRole('button', { name: 'Expand Character' }));
    expect(within(tree()).getByText('Mario')).toBeInTheDocument();
  });

  it('filters the tree by name or alias and keeps the ancestors', async () => {
    stubFetch();
    render(ManageTagsPage, { debounceMs: 0 });
    await fireEvent.input(await screen.findByLabelText('Search tags'), {
      target: { value: 'jump' },
    });
    await waitFor(() => expect(within(tree()).getAllByText('Mario')).toHaveLength(2));
    expect(within(tree()).queryByText('Overalls')).not.toBeInTheDocument();
    expect(screen.getByText(/1 of 4/)).toBeInTheDocument();
  });

  it('shows the relationships of the selected tag and removes a parent', async () => {
    const calls = stubFetch();
    render(ManageTagsPage, { debounceMs: 0 });
    await waitFor(() => expect(graphNode('Mario')).toBeInTheDocument());
    await fireEvent.click(graphNode('Mario'));

    const parents = screen.getByRole('region', { name: 'Parents' });
    expect(within(parents).getByText('Character')).toBeInTheDocument();
    expect(within(parents).getByText('Pet')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Components' })).getByText('Overalls'),
    ).toBeInTheDocument();
    expect(screen.getByText(/also: jumpman/)).toBeInTheDocument();

    await fireEvent.click(within(parents).getByRole('button', { name: 'Remove parent Pet' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/libraries/3/tags/3/parents/2', method: 'DELETE' }),
    );
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/libraries/3/tag-graph')).toHaveLength(2),
    );
  });

  it('sets the primary parent', async () => {
    const calls = stubFetch();
    render(ManageTagsPage, { debounceMs: 0 });
    await waitFor(() => expect(graphNode('Mario')).toBeInTheDocument());
    await fireEvent.click(graphNode('Mario'));
    await fireEvent.click(screen.getByRole('button', { name: 'Primary parent Pet' }));
    await waitFor(() =>
      expect(calls).toContainEqual({ url: '/api/libraries/3/tags/3/parents/2', method: 'PUT' }),
    );
  });

  it('draws the graph around a tag selected in the tree', async () => {
    stubFetch();
    render(ManageTagsPage, { debounceMs: 0 });
    await waitFor(() => expect(within(tree()).getByText('Pet')).toBeInTheDocument());
    await fireEvent.click(within(tree()).getByText('Pet'));
    expect(screen.getByText('Around')).toBeInTheDocument();
    expect(graphNode('Mario')).toBeInTheDocument();
    expect(
      within(screen.getByLabelText('Tag graph')).queryByRole('button', { name: 'Character' }),
    ).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Show all tags' }));
    expect(graphNode('Character')).toBeInTheDocument();
  });

  it('hides the edit controls from a viewer', async () => {
    stubFetch({
      library: {
        ...PHOTOS,
        role: 'viewer',
        permissions: { ...PHOTOS.permissions, canCreateTag: false },
      },
    });
    render(ManageTagsPage, { debounceMs: 0 });
    await waitFor(() => expect(graphNode('Mario')).toBeInTheDocument());
    await fireEvent.click(graphNode('Mario'));
    expect(screen.getByRole('region', { name: 'Parents' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove parent Pet' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /New tag/ })).not.toBeInTheDocument();
  });
});
