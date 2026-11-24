import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Alias, TagDetail, TagInstance, TagSummary } from '../api';
import { setActiveLibraryId } from '../contextmenu/contextmenu.svelte';
import EditTagModal from './EditTagModal.svelte';

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
  {
    tagId: 8,
    name: 'Golden Hour',
    color: '#f59e0b',
    isCategory: false,
    fileCount: 4,
    parentName: null,
  },
];

function createStubState() {
  let nextAliasId = 20;
  let nextValueId = 300;
  let color: string | null = '#10b981';
  let isCategory = 0;

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

  let instances: TagInstance[] = [
    {
      tagId: 5,
      name: 'Art',
      values: [
        { valueId: 201, kind: 'parent', primary: true },
        { valueId: 202, kind: 'text', text: 'Outdoor scenes' },
        { valueId: 203, kind: 'number', number: 3 },
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
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    aliases: [...aliases].sort((a, b) => b.is_primary - a.is_primary || a.alias_id - b.alias_id),
    instances: instances.map((i) => ({ ...i, values: [...i.values] })),
  });

  const calls: { url: string; init?: RequestInit }[] = [];

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    if (url.startsWith('/api/libraries/3/tags?') && !init) {
      return json({ total: TAGS.length, tags: TAGS });
    }
    if (url === '/api/libraries/3/tags/6' && !init) {
      return json({ tag: currentDetail() });
    }
    if (url === '/api/libraries/3/tags/6' && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as { color?: string | null; isCategory?: boolean };
      if (body.color !== undefined) color = body.color;
      if (body.isCategory !== undefined) isCategory = body.isCategory ? 1 : 0;
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
      if (body.primary === false && body.shorthand === true) {
        target.is_primary = 0;
        if (!aliases.some((a) => a.is_primary === 1)) {
          const fallback = aliases.find((a) => a.alias_id !== aliasId);
          if (fallback) fallback.is_primary = 1;
        }
      }
      return json({ tag: currentDetail() });
    }
    if (url.startsWith('/api/libraries/3/tags/6/aliases/') && init?.method === 'DELETE') {
      const aliasId = Number(url.split('/').pop());
      aliases = aliases.filter((a) => a.alias_id !== aliasId);
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/libraries/3/tags/6/parents/') && init?.method === 'PUT') {
      const parentId = Number(url.split('/').pop());
      const body = (init.body ? JSON.parse(String(init.body)) : {}) as { primary?: boolean };
      const tagInfo = TAGS.find((t) => t.tagId === parentId);
      let inst = instances.find((i) => i.tagId === parentId);
      if (!inst) {
        inst = { tagId: parentId, name: tagInfo?.name ?? `#${parentId}`, values: [] };
        instances.push(inst);
      }
      if (body.primary) {
        for (const i of instances) {
          for (const v of i.values) {
            if (v.kind === 'parent') v.primary = false;
          }
        }
      }
      const existing = inst.values.find((v) => v.kind === 'parent');
      if (existing && existing.kind === 'parent') {
        if (body.primary !== undefined) existing.primary = body.primary;
      } else {
        inst.values.push({
          valueId: nextValueId++,
          kind: 'parent',
          primary: body.primary === true,
        });
      }
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/libraries/3/tags/6/parents/') && init?.method === 'DELETE') {
      const parentId = Number(url.split('/').pop());
      const inst = instances.find((i) => i.tagId === parentId);
      if (inst) inst.values = inst.values.filter((v) => v.kind !== 'parent');
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/libraries/3/tags/6/components/') && init?.method === 'PUT') {
      const compId = Number(url.split('/').pop());
      const body = (init.body ? JSON.parse(String(init.body)) : {}) as {
        recursive?: boolean;
        attributed?: boolean;
      };
      const tagInfo = TAGS.find((t) => t.tagId === compId);
      let inst = instances.find((i) => i.tagId === compId);
      if (!inst) {
        inst = { tagId: compId, name: tagInfo?.name ?? `#${compId}`, values: [] };
        instances.push(inst);
      }
      const existing = inst.values.find((v) => v.kind === 'component');
      if (existing && existing.kind === 'component') {
        existing.recursive = body.recursive ?? false;
        existing.attributed = body.attributed ?? true;
      } else {
        inst.values.push({
          valueId: nextValueId++,
          kind: 'component',
          recursive: body.recursive ?? false,
          attributed: body.attributed ?? true,
        });
      }
      return new Response(null, { status: 204 });
    }
    if (url.startsWith('/api/libraries/3/tags/6/components/') && init?.method === 'DELETE') {
      const compId = Number(url.split('/').pop());
      const inst = instances.find((i) => i.tagId === compId);
      if (inst) inst.values = inst.values.filter((v) => v.kind !== 'component');
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
    if (url.match(/\/api\/libraries\/3\/tags\/6\/tags\/\d+$/) && init?.method === 'DELETE') {
      const refTagId = Number(url.split('/').pop());
      instances = instances.filter((i) => i.tagId !== refTagId);
      return new Response(null, { status: 204 });
    }
    return json({ error: 'not stubbed' }, 404);
  });

  return calls;
}

describe('EditTagModal', () => {
  afterEach(() => {
    cleanup();
    setActiveLibraryId(null);
    vi.unstubAllGlobals();
  });

  it('updates tag color and category checkbox', async () => {
    const calls = createStubState();
    render(EditTagModal, {
      tagId: 6,
      tagName: 'Landscape',
      libraryId: 3,
      debounceMs: 1,
      onClose: () => {},
    });

    await waitFor(() => expect(screen.getByLabelText('Category')).toBeInTheDocument());
    const categoryBox = screen.getByLabelText('Category') as HTMLInputElement;
    expect(categoryBox.checked).toBe(false);

    await fireEvent.click(categoryBox);
    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ isCategory: true }),
        }),
      });
      expect((screen.getByLabelText('Category') as HTMLInputElement).checked).toBe(true);
      expect(screen.getByLabelText('Tag color')).not.toBeDisabled();
    });

    const colorInput = screen.getByLabelText('Tag color');
    await fireEvent.change(colorInput, { target: { value: '#ff0000' } });
    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ color: '#ff0000' }),
        }),
      });
    });
  });

  it('manages aliases and enforces primary/shorthand checkbox exclusivity', async () => {
    const calls = createStubState();
    render(EditTagModal, {
      tagId: 6,
      tagName: 'Landscape',
      libraryId: 3,
      debounceMs: 1,
      onClose: () => {},
    });

    await waitFor(() => expect(screen.getAllByLabelText('Alias text')).toHaveLength(2));
    const aliasInputs = screen.getAllByLabelText('Alias text') as HTMLInputElement[];
    expect(aliasInputs[0]!.value).toBe('Landscape');
    expect(aliasInputs[1]!.value).toBe('land');

    const primaryBoxes = screen.getAllByLabelText('Primary alias') as HTMLInputElement[];
    const shorthandBoxes = screen.getAllByLabelText('Shorthand alias') as HTMLInputElement[];
    expect(primaryBoxes[0]!.checked).toBe(true);
    expect(shorthandBoxes[0]!.checked).toBe(false);
    expect(primaryBoxes[1]!.checked).toBe(false);
    expect(shorthandBoxes[1]!.checked).toBe(true);

    // Selecting Primary on the second alias ('land', which was Shorthand) makes it Primary and removes Shorthand from it.
    await fireEvent.click(primaryBoxes[1]!);
    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6/aliases/11',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ primary: true, shorthand: false }),
        }),
      });
      const updatedPrimary = screen.getAllByLabelText('Primary alias') as HTMLInputElement[];
      const updatedShorthand = screen.getAllByLabelText('Shorthand alias') as HTMLInputElement[];
      // 'land' is now sorted first as primary, with shorthand unchecked.
      expect(updatedPrimary[0]!.checked).toBe(true);
      expect(updatedShorthand[0]!.checked).toBe(false);
      expect(updatedPrimary[1]!.checked).toBe(false);
    });

    // Add a new alias.
    const newAliasInput = screen.getByLabelText('New alias');
    await fireEvent.input(newAliasInput, { target: { value: 'scenery' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add Alias' }));

    await waitFor(() => expect(screen.getAllByLabelText('Alias text')).toHaveLength(3));
    expect(calls).toContainEqual({
      url: '/api/libraries/3/tags/6/aliases',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'scenery' }),
      }),
    });

    // Edit an alias text.
    const allAliasInputs = screen.getAllByLabelText('Alias text');
    await fireEvent.input(allAliasInputs[2]!, { target: { value: 'vista' } });
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    await fireEvent.click(saveButtons[2]!);

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6/aliases/20',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ text: 'vista' }),
        }),
      });
    });
  });

  it('displays, edits, removes, and adds tag-tag relationships and values (including parent and component with tag chip)', async () => {
    const calls = createStubState();
    render(EditTagModal, {
      tagId: 6,
      tagName: 'Landscape',
      libraryId: 3,
      debounceMs: 1,
      onClose: () => {},
    });

    await waitFor(() => expect(screen.getByLabelText('Text value')).toHaveValue('Outdoor scenes'));
    expect(screen.getByLabelText('Number value')).toHaveValue('3');
    expect((screen.getByLabelText('Primary parent') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Recursive component') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('Attributed component') as HTMLInputElement).checked).toBe(true);

    // Toggle Recursive on existing component value.
    await fireEvent.click(screen.getByLabelText('Recursive component'));
    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6/components/7',
        init: expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ recursive: true, attributed: true }),
        }),
      });
    });

    // Edit text value on tag-tag relationship.
    await fireEvent.input(screen.getByLabelText('Text value'), {
      target: { value: 'Mountain & lake views' },
    });
    const textSaveBtns = screen.getAllByRole('button', { name: 'Save' });
    // First 2 Save buttons are for the 2 aliases; 3rd is for Text value.
    await fireEvent.click(textSaveBtns[2]!);

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6/values/202',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ kind: 'text', text: 'Mountain & lake views' }),
        }),
      });
    });

    // Add a new component relationship using the search bar -> displays tag chip -> Add Value.
    const relatedTagInput = screen.getByLabelText('Related tag');
    await fireEvent.input(relatedTagInput, { target: { value: 'gold' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    await fireEvent.mouseDown(screen.getByText('Golden Hour'));

    // Tag chip is now displayed instead of the search input.
    expect(screen.queryByLabelText('Related tag')).not.toBeInTheDocument();
    expect(screen.getByText('Golden Hour')).toHaveClass('tag-chip');

    await fireEvent.change(screen.getByLabelText('Value type'), { target: { value: 'component' } });
    await fireEvent.click(screen.getByLabelText('New recursive component'));
    await fireEvent.click(screen.getByRole('button', { name: 'Add Value' }));

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/tags/6/components/8',
        init: expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ recursive: true, attributed: true }),
        }),
      });
    });
  });
});
