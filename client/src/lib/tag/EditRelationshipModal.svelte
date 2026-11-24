<script lang="ts">
  import Button from '../Button.svelte';
  import {
    deleteFileValue,
    listTags,
    queryFiles,
    updateFileValue,
    type FileValue,
    type TagSummary,
  } from '../api';
  import { notifyRelationshipChanged, resolveLibraryId } from '../contextmenu/contextmenu.svelte';
  import { tagStore } from '../tagStore.svelte';
  import AddValueModal from './AddValueModal.svelte';
  import TagAutocompleteInput, { type SelectedTag } from './TagAutocompleteInput.svelte';

  const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

  function parseNumberInput(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed || !NUMBER_RE.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }

  interface EditableValueRow {
    valueId: number;
    kind: FileValue['kind'];
    original: FileValue;
    textDraft: string;
    numberDraft: string;
    selectedTag: SelectedTag | null;
    busy: boolean;
    rowError: string | null;
  }

  let {
    tagId,
    tagName,
    fileId,
    libraryId = null,
    debounceMs = 150,
    onClose,
  }: {
    tagId: number;
    tagName: string;
    fileId: number;
    libraryId?: number | null;
    debounceMs?: number;
    onClose: () => void;
  } = $props();

  let resolvedLibraryId = $state<number | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let rows = $state<EditableValueRow[]>([]);
  let addOpen = $state(false);
  const tagsById = tagStore();

  function toRow(value: FileValue): EditableValueRow {
    if (value.kind === 'text') {
      return {
        valueId: value.valueId,
        kind: 'text',
        original: value,
        textDraft: value.text,
        numberDraft: '',
        selectedTag: null,
        busy: false,
        rowError: null,
      };
    }
    if (value.kind === 'number') {
      return {
        valueId: value.valueId,
        kind: 'number',
        original: value,
        textDraft: '',
        numberDraft: String(value.number),
        selectedTag: null,
        busy: false,
        rowError: null,
      };
    }
    if (value.kind === 'tag') {
      const info = tagsById.get(value.refTagId);
      return {
        valueId: value.valueId,
        kind: 'tag',
        original: value,
        textDraft: '',
        numberDraft: '',
        selectedTag: {
          tagId: value.refTagId,
          name: info?.name ?? `#${value.refTagId}`,
          color: info?.color ?? null,
        },
        busy: false,
        rowError: null,
      };
    }
    return {
      valueId: value.valueId,
      kind: 'anchor',
      original: value,
      textDraft: '',
      numberDraft: '',
      selectedTag: null,
      busy: false,
      rowError: null,
    };
  }

  $effect(() => {
    const explicit = libraryId;
    const fId = fileId;
    const tId = tagId;
    let cancelled = false;
    loading = true;
    loadError = null;

    (async () => {
      try {
        const libId = await resolveLibraryId(explicit);
        if (cancelled) return;
        resolvedLibraryId = libId;
        const [fileRes] = await Promise.all([
          queryFiles(libId, [fId], ['instances']),
          listTags(libId, '', { limit: 500 }).catch(() => ({ total: 0, tags: [] as TagSummary[] })),
        ]);
        if (cancelled) return;
        const instance = fileRes.files
          .find((f) => f.fileId === fId)
          ?.instances?.find((i) => i.tagId === tId);
        rows = (instance?.values ?? []).map(toRow);
      } catch (e) {
        if (!cancelled) loadError = e instanceof Error ? e.message : String(e);
      } finally {
        if (!cancelled) loading = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  });

  function isNumberInvalid(row: EditableValueRow): boolean {
    return (
      row.kind === 'number' &&
      row.numberDraft.trim() !== '' &&
      parseNumberInput(row.numberDraft) === null
    );
  }

  function canSaveRow(row: EditableValueRow): boolean {
    if (row.busy) return false;
    if (row.kind === 'text') {
      const trimmed = row.textDraft.trim();
      return trimmed.length > 0 && row.original.kind === 'text' && trimmed !== row.original.text;
    }
    if (row.kind === 'number') {
      const parsed = parseNumberInput(row.numberDraft);
      return parsed !== null && row.original.kind === 'number' && parsed !== row.original.number;
    }
    return false;
  }

  async function saveRow(row: EditableValueRow) {
    if (!canSaveRow(row)) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      if (row.kind === 'text') {
        const updated = await updateFileValue(libId, fileId, row.valueId, {
          kind: 'text',
          text: row.textDraft.trim(),
        });
        row.original = updated;
        if (updated.kind === 'text') row.textDraft = updated.text;
      } else if (row.kind === 'number') {
        const parsed = parseNumberInput(row.numberDraft)!;
        const updated = await updateFileValue(libId, fileId, row.valueId, {
          kind: 'number',
          number: parsed,
        });
        row.original = updated;
        if (updated.kind === 'number') row.numberDraft = String(updated.number);
      }
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
    } finally {
      row.busy = false;
    }
  }

  async function saveTagRow(row: EditableValueRow, picked: SelectedTag) {
    if (row.original.kind === 'tag' && picked.tagId === row.original.refTagId) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      const updated = await updateFileValue(libId, fileId, row.valueId, {
        kind: 'tag',
        refTagId: picked.tagId,
      });
      row.original = updated;
      row.selectedTag = picked;
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
    } finally {
      row.busy = false;
    }
  }

  async function removeRow(row: EditableValueRow) {
    if (row.busy) return;
    row.busy = true;
    row.rowError = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      await deleteFileValue(libId, fileId, row.valueId);
      rows = rows.filter((r) => r.valueId !== row.valueId);
      notifyRelationshipChanged();
    } catch (e) {
      row.rowError = e instanceof Error ? e.message : String(e);
      row.busy = false;
    }
  }

  function onValueAdded(created: FileValue) {
    rows = [...rows, toRow(created)];
  }

  function onKeydown(event: KeyboardEvent) {
    if (addOpen) return;
    if (event.key === 'Escape') onClose();
  }

  function onRowKeydown(event: KeyboardEvent, row: EditableValueRow) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void saveRow(row);
    }
  }

  function kindLabel(kind: FileValue['kind']): string {
    if (kind === 'text') return 'Text';
    if (kind === 'number') return 'Number';
    if (kind === 'tag') return 'Tag';
    return 'Anchor';
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Edit Relationship">
    <p class="modal-title">Edit Relationship</p>
    <p class="modal-body">
      Values for <span class="tag-name">{tagName}</span> (#{tagId}) on file #{fileId}.
    </p>

    {#if loading}
      <p class="placeholder">Loading values…</p>
    {:else if loadError}
      <p class="error">{loadError}</p>
    {:else if rows.length === 0}
      <p class="placeholder">No values on this relationship.</p>
    {:else}
      <div class="value-list">
        {#each rows as row (row.valueId)}
          <div class="value-item">
            <div class="value-row">
              <span class="kind-badge">{kindLabel(row.kind)}</span>

              {#if row.kind === 'text'}
                <input
                  type="text"
                  class="value-input"
                  aria-label="Text value"
                  bind:value={row.textDraft}
                  disabled={row.busy}
                  onkeydown={(e) => onRowKeydown(e, row)}
                />
                <Button
                  label="Save"
                  accent
                  disabled={!canSaveRow(row)}
                  onclick={() => void saveRow(row)}
                />
              {:else if row.kind === 'number'}
                <input
                  type="text"
                  inputmode="decimal"
                  class="value-input"
                  aria-label="Number value"
                  aria-invalid={isNumberInvalid(row)}
                  bind:value={row.numberDraft}
                  disabled={row.busy}
                  onkeydown={(e) => onRowKeydown(e, row)}
                />
                <Button
                  label="Save"
                  accent
                  disabled={!canSaveRow(row)}
                  onclick={() => void saveRow(row)}
                />
              {:else if row.kind === 'tag'}
                <div class="tag-input-wrap">
                  <TagAutocompleteInput
                    libraryId={resolvedLibraryId}
                    bind:selected={row.selectedTag}
                    excludeTagId={tagId}
                    disabled={row.busy}
                    {debounceMs}
                    ariaLabel="Tag value"
                    onSelect={(picked) => void saveTagRow(row, picked)}
                  />
                </div>
              {:else}
                <span class="deferred">Anchor editing is deferred.</span>
              {/if}

              <Button label="Delete" disabled={row.busy} onclick={() => void removeRow(row)} />
            </div>

            {#if isNumberInvalid(row)}
              <p class="validation-error">Enter a valid number.</p>
            {/if}
            {#if row.rowError}
              <p class="error">{row.rowError}</p>
            {/if}
          </div>
        {/each}
      </div>
    {/if}

    <div class="modal-actions">
      <Button label="Add Value" accent onclick={() => (addOpen = true)} />
      <Button label="Close" onclick={onClose} />
    </div>
  </div>
</div>

{#if addOpen}
  <AddValueModal
    {tagId}
    {tagName}
    {fileId}
    libraryId={resolvedLibraryId}
    {debounceMs}
    onAdded={onValueAdded}
    onClose={() => (addOpen = false)}
  />
{/if}

<style lang="scss">
  @use '../../styles/variables' as *;

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 150;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgb(0 0 0 / 60%);
  }

  .modal {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 460px;
    max-height: 80vh;
    padding: 16px;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
  }

  .modal-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .modal-body {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .tag-name {
    font-weight: 600;
    color: $color-text-strong;
  }

  .placeholder {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .value-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
  }

  .value-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 2px;
  }

  .value-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .kind-badge {
    flex-shrink: 0;
    width: 52px;
    font-size: 11px;
    font-weight: 600;
    color: $color-text-dim;
  }

  .value-input {
    flex: 1;
    min-width: 0;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 1px solid transparent;
    border-radius: 2px;

    &[aria-invalid='true'] {
      border-color: $color-error;
    }
  }

  .tag-input-wrap {
    display: flex;
    flex: 1;
    min-width: 0;
  }

  .deferred {
    flex: 1;
    font-size: 12px;
    color: $color-text-dim;
  }

  .validation-error,
  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }

  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
