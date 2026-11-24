import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileValue, QueriedFile, TagSummary } from '../api';
import { setActiveLibraryId } from '../contextmenu/contextmenu.svelte';
import AddValueModal from './AddValueModal.svelte';
import EditRelationshipModal from './EditRelationshipModal.svelte';

const TAGS: TagSummary[] = [
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

const INITIAL_VALUES: FileValue[] = [
  { valueId: 101, kind: 'text', text: 'Taken at dawn' },
  { valueId: 102, kind: 'number', number: 5 },
  { valueId: 103, kind: 'tag', refTagId: 7 },
  {
    valueId: 104,
    kind: 'anchor',
    tStart: 10,
    tEnd: 20,
    rx: null,
    ry: null,
    rw: null,
    rh: null,
  },
];

const FILE_WITH_VALUES: QueriedFile = {
  fileId: 10,
  name: 'alpine-lake.jpg',
  path: 'photos/alpine-lake.jpg',
  type: 'image',
  extension: 'jpg',
  size: 1024,
  missing: false,
  locationCount: 1,
  instances: [
    {
      tagId: 6,
      name: 'Landscape',
      values: INITIAL_VALUES,
    },
  ],
};

function stubApi(values: FileValue[] = INITIAL_VALUES) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let nextValueId = 200;

  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

    if (url.startsWith('/api/libraries/3/tags') && !init) {
      return json({ total: TAGS.length, tags: TAGS });
    }
    if (url === '/api/libraries/3/files/query' && init?.method === 'POST') {
      return json({
        files: [
          {
            ...FILE_WITH_VALUES,
            instances: [{ tagId: 6, name: 'Landscape', values }],
          },
        ],
        notFound: [],
      });
    }
    if (url === '/api/libraries/3/files/10/tags/6/values' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const valueId = nextValueId++;
      return json({ value: { valueId, ...body } }, 201);
    }
    if (url.startsWith('/api/libraries/3/files/10/values/') && init?.method === 'PATCH') {
      const valueId = Number(url.split('/').pop());
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return json({ value: { valueId, ...body } }, 200);
    }
    if (url.startsWith('/api/libraries/3/files/10/values/') && init?.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return json({ error: 'not stubbed' }, 404);
  });

  return calls;
}

describe('AddValueModal', () => {
  afterEach(() => {
    cleanup();
    setActiveLibraryId(null);
    vi.unstubAllGlobals();
  });

  it('adds a text value', async () => {
    const calls = stubApi();
    const onClose = vi.fn();
    const onAdded = vi.fn();

    render(AddValueModal, {
      tagId: 6,
      tagName: 'Landscape',
      fileId: 10,
      libraryId: 3,
      debounceMs: 1,
      onAdded,
      onClose,
    });

    const addBtn = screen.getByRole('button', { name: 'Add value' });
    expect(addBtn).toBeDisabled();

    await fireEvent.input(screen.getByLabelText('Text value'), {
      target: { value: '  Summer trip  ' },
    });
    expect(addBtn).not.toBeDisabled();

    await fireEvent.click(addBtn);

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onAdded).toHaveBeenCalledWith({
      valueId: 200,
      kind: 'text',
      text: 'Summer trip',
    });
    expect(calls).toContainEqual({
      url: '/api/libraries/3/files/10/tags/6/values',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'text', text: 'Summer trip' }),
      }),
    });
  });

  it('validates numeric input and adds a number value', async () => {
    const calls = stubApi();
    const onClose = vi.fn();

    render(AddValueModal, {
      tagId: 6,
      tagName: 'Landscape',
      fileId: 10,
      libraryId: 3,
      debounceMs: 1,
      onClose,
    });

    await fireEvent.change(screen.getByLabelText('Value type'), { target: { value: 'number' } });

    const numInput = screen.getByLabelText('Number value');
    const addBtn = screen.getByRole('button', { name: 'Add value' });

    await fireEvent.input(numInput, { target: { value: 'abc' } });
    expect(screen.getByText('Enter a valid number.')).toBeInTheDocument();
    expect(numInput).toHaveAttribute('aria-invalid', 'true');
    expect(addBtn).toBeDisabled();

    await fireEvent.input(numInput, { target: { value: '-42.5' } });
    expect(screen.queryByText('Enter a valid number.')).not.toBeInTheDocument();
    expect(numInput).toHaveAttribute('aria-invalid', 'false');
    expect(addBtn).not.toBeDisabled();

    await fireEvent.click(addBtn);

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls).toContainEqual({
      url: '/api/libraries/3/files/10/tags/6/values',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'number', number: -42.5 }),
      }),
    });
  });

  it('autocompletes a tag into a visual chip and adds the tag value', async () => {
    const calls = stubApi();
    const onClose = vi.fn();

    render(AddValueModal, {
      tagId: 6,
      tagName: 'Landscape',
      fileId: 10,
      libraryId: 3,
      debounceMs: 1,
      onClose,
    });

    await fireEvent.change(screen.getByLabelText('Value type'), { target: { value: 'tag' } });

    const tagInput = screen.getByLabelText('Tag value');
    await fireEvent.input(tagInput, { target: { value: 'gold' } });

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    await fireEvent.mouseDown(screen.getByText('Golden Hour'));

    // Autocomplete selection creates a visual TagChip and hides the combobox input.
    expect(screen.queryByLabelText('Tag value')).not.toBeInTheDocument();
    expect(screen.getByText('Golden Hour')).toHaveClass('tag-chip');

    await fireEvent.click(screen.getByRole('button', { name: 'Add value' }));

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(calls).toContainEqual({
      url: '/api/libraries/3/files/10/tags/6/values',
      init: expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kind: 'tag', refTagId: 8 }),
      }),
    });
  });

  it('shows anchor values as deferred', async () => {
    stubApi();
    render(AddValueModal, {
      tagId: 6,
      tagName: 'Landscape',
      fileId: 10,
      libraryId: 3,
      onClose: () => {},
    });

    await fireEvent.change(screen.getByLabelText('Value type'), { target: { value: 'anchor' } });
    expect(screen.getByText('Anchor values are deferred.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add value' })).toBeDisabled();
  });
});

describe('EditRelationshipModal', () => {
  afterEach(() => {
    cleanup();
    setActiveLibraryId(null);
    vi.unstubAllGlobals();
  });

  it('renders existing values with their matching inputs and edits or deletes them immediately', async () => {
    const calls = stubApi();
    render(EditRelationshipModal, {
      tagId: 6,
      tagName: 'Landscape',
      fileId: 10,
      libraryId: 3,
      debounceMs: 1,
      onClose: () => {},
    });

    await waitFor(() => expect(screen.getByLabelText('Text value')).toHaveValue('Taken at dawn'));
    expect(screen.getByLabelText('Number value')).toHaveValue('5');
    expect(screen.getByText('Moody')).toHaveClass('tag-chip');
    expect(screen.getByText('Anchor editing is deferred.')).toBeInTheDocument();

    // Edit text value and save immediately.
    const textInput = screen.getByLabelText('Text value');
    await fireEvent.input(textInput, { target: { value: 'Taken at dusk' } });
    const saveButtons = screen.getAllByRole('button', { name: 'Save' });
    await fireEvent.click(saveButtons[0]!);

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/files/10/values/101',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ kind: 'text', text: 'Taken at dusk' }),
        }),
      });
    });

    // Validate and edit number value.
    const numInput = screen.getByLabelText('Number value');
    await fireEvent.input(numInput, { target: { value: 'not-a-num' } });
    expect(screen.getByText('Enter a valid number.')).toBeInTheDocument();
    expect(saveButtons[1]).toBeDisabled();

    await fireEvent.input(numInput, { target: { value: '12' } });
    expect(screen.queryByText('Enter a valid number.')).not.toBeInTheDocument();
    await fireEvent.click(saveButtons[1]!);

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/files/10/values/102',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ kind: 'number', number: 12 }),
        }),
      });
    });

    // Edit tag value by clearing the visual tag chip and picking from autocomplete.
    await fireEvent.click(screen.getByRole('button', { name: 'Clear tag' }));
    const tagSearch = screen.getByLabelText('Tag value');
    await fireEvent.input(tagSearch, { target: { value: 'gold' } });
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    await fireEvent.mouseDown(screen.getByText('Golden Hour'));

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/files/10/values/103',
        init: expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ kind: 'tag', refTagId: 8 }),
        }),
      });
    });
    expect(screen.getByText('Golden Hour')).toHaveClass('tag-chip');

    // Delete the text value row immediately.
    const deleteButtons = screen.getAllByRole('button', { name: 'Delete' });
    await fireEvent.click(deleteButtons[0]!);

    await waitFor(() => {
      expect(calls).toContainEqual({
        url: '/api/libraries/3/files/10/values/101',
        init: { method: 'DELETE' },
      });
    });
    expect(screen.queryByLabelText('Text value')).not.toBeInTheDocument();
  });

  it('opens Add Value modal from Edit Relationship and appends the new value', async () => {
    stubApi([]);
    render(EditRelationshipModal, {
      tagId: 6,
      tagName: 'Landscape',
      fileId: 10,
      libraryId: 3,
      debounceMs: 1,
      onClose: () => {},
    });

    await waitFor(() =>
      expect(screen.getByText('No values on this relationship.')).toBeInTheDocument(),
    );

    await fireEvent.click(screen.getByRole('button', { name: 'Add Value' }));
    expect(screen.getByRole('dialog', { name: 'Add Value' })).toBeInTheDocument();

    await fireEvent.input(screen.getByLabelText('Text value'), {
      target: { value: 'Brand new note' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Add value' }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add Value' })).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Text value')).toHaveValue('Brand new note');
  });
});
