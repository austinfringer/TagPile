import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Alias, TagDetail, TagInstance, TagSummary } from '../lib/api';
import { setActiveLibraryId } from '../lib/contextmenu/contextmenu.svelte';
import { navigate } from '../lib/router.svelte';
import TagDetailPage from './TagDetailPage.svelte';

const TAGS: TagSummary[] = [
  { tagId: 4, name: 'Visual', color: '#6366f1', isCategory: true, fileCount: 5, parentName: null },
  { tagId: 5, name: 'Art', color: '#1416b2', isCategory: true, fileCount: 3, parentName: 'Visual' },
  {
    tagId: 6,
    name: 'Landscape',
    color: '#10b981',
    isCategory: false,
    fileCount: 2,
    parentName: 'Art',
  },
  { tagId: 7, name: 'Moody', color: '#ec4899', isCategory: false, fileCount: 1, parentName: null },
  {
    tagId: 8,
    name: 'Golden Hour',
    color: '#f59e0b',
    isCategory: false,
    fileCount: 4,
    parentName: 'Landscape',
  },
  {
    tagId: 9,
    name: 'Sunset',
    color: '#ef4444',
    isCategory: false,
    fileCount: 1,
    parentName: 'Golden Hour',
  },
];

function createStubState() {
  let nextAliasId = 20;
  let nextValueId = 300;
  let color: string | null = '#10b981';
  let isCategory = 0;
  let wikiText = '# Landscape Notes\n\nIncludes **scenic** views like [[8|Golden Hour]].';

  let aliases: Alias[] = [
    {
      alias_id: 10,
      tag_id: 6,
      library_id: 3,
      text: 'Landscape',
      is_primary: 1,
      is_shorthand: 0,
    },
    {
      alias_id: 11,
      tag_id: 6,
      library_id: 3,
      text: 'land',
      is_primary: 0,
      is_shorthand: 1,
    },
  ];

  const instances: TagInstance[] = [
    {
      tagId: 5,
      name: 'Art',
      values: [
        { valueId: 201, kind: 'parent', primary: true },
        { valueId: 202, kind: 'text', text: 'Outdoor scenes' },
      ],
    },
    {
      tagId: 7,
      name: 'Moody',
      values: [{ valueId: 204, kind: 'component', recursive: false, attributed: true }],
    },
  ];

  const currentDetail = (): TagDetail => ({
    tag: {
      tag_id: 6,
      library_id: 3,
      is_category: isCategory,
      file_count: 2,
      color,
      wiki_text: wikiText,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    aliases: [...aliases].sort((a, b) => b.is_primary - a.is_primary || a.alias_id - b.alias_id),
    instances: instances.map((i) => ({ ...i, values: [...i.values] })),
    parents: [{ tagId: 5, name: 'Art', color: '#1416b2' }],
    ancestors: [
      { tagId: 5, name: 'Art', color: '#1416b2' },
      { tagId: 4, name: 'Visual', color: '#6366f1' },
    ],
    children: [{ tagId: 8, name: 'Golden Hour', color: '#f59e0b' }],
    descendants: [
      { tagId: 8, name: 'Golden Hour', color: '#f59e0b' },
      { tagId: 9, name: 'Sunset', color: '#ef4444' },
    ],
  });

  const calls: { url: string; init?: RequestInit }[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    if (url.startsWith('/api/libraries/3/tags') && !url.includes('/tags/6') && !init) {
      const parsed = new URL(url, 'http://localhost');
      const q = (parsed.searchParams.get('q') ?? '').toLowerCase();
      const filtered = q
        ? TAGS.filter(
            (t) => t.name.toLowerCase().startsWith(q) || (t.tagId === 7 && 'dusk'.startsWith(q)),
          )
        : TAGS;
      return json({ total: filtered.length, tags: filtered });
    }
    if (url.startsWith('/api/libraries/3/autocomplete') && !init) {
      const parsed = new URL(url, 'http://localhost');
      const q = (parsed.searchParams.get('q') ?? '').toLowerCase();
      if ('dusk'.startsWith(q)) {
        return json({
          from: 0,
          to: q.length,
          completions: [
            { text: 'dusk', kind: 'tag', tagId: 7, fileCount: 1, primary: 'Moody', parent: null },
          ],
        });
      }
      return json({ from: 0, to: q.length, completions: [] });
    }
    if (url === '/api/libraries/3/tags/6' && !init) {
      return json({ tag: currentDetail() });
    }
    if (url === '/api/libraries/3/tags/6' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as {
        color?: string | null;
        isCategory?: boolean;
        wikiText?: string;
      };
      if (body.color !== undefined) color = body.color;
      if (body.isCategory !== undefined) isCategory = body.isCategory ? 1 : 0;
      if (body.wikiText !== undefined) wikiText = body.wikiText;
      return json({ tag: currentDetail() });
    }
    if (url === '/api/libraries/3/tags/6/aliases' && init?.method === 'POST') {
      const { text } = JSON.parse(String(init.body)) as { text: string };
      aliases.push({
        alias_id: nextAliasId++,
        tag_id: 6,
        library_id: 3,
        text,
        is_primary: 0,
        is_shorthand: 0,
      });
      return json({ tag: currentDetail() }, 201);
    }
    if (url.startsWith('/api/libraries/3/tags/6/aliases/') && init?.method === 'PATCH') {
      const aliasId = Number(url.split('/').pop());
      const body = JSON.parse(String(init.body)) as {
        text?: string;
        primary?: boolean;
        shorthand?: boolean;
      };
      const target = aliases.find((a) => a.alias_id === aliasId);
      if (!target) return json({ error: 'Alias not found' }, 404);
      if (body.text !== undefined) target.text = body.text;
      if (body.primary === true) {
        for (const a of aliases) a.is_primary = a.alias_id === aliasId ? 1 : 0;
      }
      if (body.shorthand === true) {
        for (const a of aliases) a.is_shorthand = a.alias_id === aliasId ? 1 : 0;
      }
      if (body.shorthand === false) {
        target.is_shorthand = 0;
      }
      return json({ tag: currentDetail() });
    }
    if (url.startsWith('/api/libraries/3/tags/6/aliases/') && init?.method === 'DELETE') {
      const aliasId = Number(url.split('/').pop());
      aliases = aliases.filter((a) => a.alias_id !== aliasId);
      return new Response(null, { status: 204 });
    }
    if (url.match(/\/api\/libraries\/3\/tags\/6\/tags\/\d+\/values$/) && init?.method === 'POST') {
      const parts = url.split('/');
      const refTagId = Number(parts[parts.length - 2]);
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const tagInfo = TAGS.find((t) => t.tagId === refTagId);
      let inst = instances.find((i) => i.tagId === refTagId);
      if (!inst) {
        inst = { tagId: refTagId, name: tagInfo?.name ?? `#${refTagId}`, values: [] };
        instances.push(inst);
      }
      const value = { valueId: nextValueId++, ...body } as TagInstance['values'][number];
      inst.values.push(value);
      return json({ value }, 201);
    }
    if (url.startsWith('/api/libraries/3/tags/6/values/') && init?.method === 'PATCH') {
      const valueId = Number(url.split('/').pop());
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const value = { valueId, ...body } as TagInstance['values'][number];
      for (const inst of instances) {
        inst.values = inst.values.map((v) => (v.valueId === valueId ? value : v));
      }
      return json({ value });
    }
    if (url.startsWith('/api/libraries/3/tags/6/values/') && init?.method === 'DELETE') {
      const valueId = Number(url.split('/').pop());
      for (const inst of instances) {
        inst.values = inst.values.filter((v) => v.valueId !== valueId);
      }
      return new Response(null, { status: 204 });
    }
    return json({ error: 'not stubbed' }, 404);
  });

  return calls;
}

describe('TagDetailPage', () => {
  afterEach(() => {
    cleanup();
    setActiveLibraryId(null);
    navigate('/');
    vi.unstubAllGlobals();
  });

  it('renders wiki markdown, [[tag]] links, and the hierarchy sidebar', async () => {
    createStubState();
    render(TagDetailPage, { id: '6', libraryId: 3, debounceMs: 1 });

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Landscape Notes' })).toBeInTheDocument(),
    );

    const wikiSection = screen.getByRole('region', { name: 'Wiki' });
    expect(within(wikiSection).getByText('scenic').tagName).toBe('STRONG');
    const wikiTagChip = within(wikiSection).getByRole('button', { name: 'Golden Hour' });
    expect(wikiTagChip).toHaveClass('tag-chip');

    const sidebar = screen.getByRole('complementary', { name: 'Tag hierarchy' });
    const parentsGroup = within(sidebar).getByRole('region', { name: 'Parents' });
    const ancestorsGroup = within(sidebar).getByRole('region', { name: 'Ancestors' });
    const childrenGroup = within(sidebar).getByRole('region', { name: 'Children' });
    const descendantsGroup = within(sidebar).getByRole('region', { name: 'Descendants' });
    expect(within(parentsGroup).getByText('Art')).toBeInTheDocument();
    expect(within(ancestorsGroup).getByText('Visual')).toBeInTheDocument();
    expect(within(ancestorsGroup).queryByText('Art')).not.toBeInTheDocument();
    expect(within(childrenGroup).getByText('Golden Hour')).toBeInTheDocument();
    expect(within(descendantsGroup).getByText('Sunset')).toBeInTheDocument();
    expect(within(descendantsGroup).queryByText('Golden Hour')).not.toBeInTheDocument();

    await fireEvent.click(wikiTagChip);
    expect(window.location.pathname).toBe('/tags/8');
  });

  it('edits the wiki writeup with live [[tag]] alias recommendations and saves it', async () => {
    const calls = createStubState();
    render(TagDetailPage, { id: '6', libraryId: 3, debounceMs: 1 });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Edit Wiki' })).toBeInTheDocument(),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Edit Wiki' }));

    const textarea = screen.getByLabelText('Wiki writeup') as HTMLTextAreaElement;
    const draft = 'Linked to [[du';
    textarea.value = draft;
    textarea.setSelectionRange(draft.length, draft.length);
    await fireEvent.input(textarea);

    await waitFor(() =>
      expect(screen.getByRole('listbox', { name: 'Wiki tag suggestions' })).toBeInTheDocument(),
    );
    const listbox = screen.getByRole('listbox', { name: 'Wiki tag suggestions' });
    expect(within(listbox).getByText('dusk')).toBeInTheDocument();
    expect(within(listbox).getByText('→ Moody')).toBeInTheDocument();

    // The list is anchored at the caret's line with inline top/left, not the textarea bottom.
    await waitFor(() => {
      expect(listbox.style.top).toMatch(/^\d+(\.\d+)?px$/);
      expect(parseFloat(listbox.style.top)).toBeGreaterThan(0);
      expect(listbox.style.left).toMatch(/^\d+(\.\d+)?px$/);
    });

    await fireEvent.mouseDown(within(listbox).getByText('dusk'));
    expect(textarea.value).toBe('Linked to [[7|dusk]]');

    await fireEvent.click(screen.getByRole('button', { name: 'Save Wiki' }));
    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ wikiText: 'Linked to [[7|dusk]]' }),
        }),
      });
      const wikiSection = screen.getByRole('region', { name: 'Wiki' });
      expect(within(wikiSection).getByRole('button', { name: 'dusk' })).toBeInTheDocument();
    });
  });

  it('manages aliases, primary alias selection, and relationships/values on the page', async () => {
    const calls = createStubState();
    render(TagDetailPage, { id: '6', libraryId: 3, debounceMs: 1 });

    await waitFor(() => expect(screen.getAllByLabelText('Alias text')).toHaveLength(2));

    const primaryBoxes = screen.getAllByLabelText('Primary alias') as HTMLInputElement[];
    await fireEvent.click(primaryBoxes[1]!);
    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6/aliases/11',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ primary: true, shorthand: false }),
        }),
      });
    });

    await fireEvent.input(screen.getByLabelText('New alias'), { target: { value: 'scenery' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add Alias' }));
    await waitFor(() => expect(screen.getAllByLabelText('Alias text')).toHaveLength(3));

    const textValueInput = screen.getByLabelText('Text value');
    expect(textValueInput).toHaveValue('Outdoor scenes');
    await fireEvent.input(textValueInput, { target: { value: 'Panoramic outdoor scenes' } });
    const relRegion = screen.getByRole('region', { name: 'Relationships & Values' });
    await fireEvent.click(within(relRegion).getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6/values/202',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ kind: 'text', text: 'Panoramic outdoor scenes' }),
        }),
      });
    });
  });
});
