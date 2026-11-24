<script lang="ts">
  import Button from '../Button.svelte';
  import { addFileValue, type FileValue, type NewFileValue } from '../api';
  import { notifyRelationshipChanged, resolveLibraryId } from '../contextmenu/contextmenu.svelte';
  import TagAutocompleteInput, { type SelectedTag } from './TagAutocompleteInput.svelte';

  type ValueKind = 'text' | 'number' | 'tag' | 'anchor';

  const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

  function parseNumberInput(raw: string): number | null {
    const trimmed = raw.trim();
    if (!trimmed || !NUMBER_RE.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
  }

  let {
    tagId,
    tagName,
    fileId,
    libraryId = null,
    debounceMs = 150,
    onAdded,
    onClose,
  }: {
    tagId: number;
    tagName: string;
    fileId: number;
    libraryId?: number | null;
    debounceMs?: number;
    onAdded?: (value: FileValue) => void;
    onClose: () => void;
  } = $props();

  let resolvedLibraryId = $state<number | null>(null);
  let kind = $state<ValueKind>('text');
  let textValue = $state('');
  let numberText = $state('');
  let selectedTag = $state<SelectedTag | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    const explicit = libraryId;
    let cancelled = false;
    resolveLibraryId(explicit)
      .then((id) => {
        if (!cancelled) resolvedLibraryId = id;
      })
      .catch(() => {
        if (!cancelled) resolvedLibraryId = null;
      });
    return () => {
      cancelled = true;
    };
  });

  const parsedNumber = $derived(parseNumberInput(numberText));
  const numberInvalid = $derived(
    kind === 'number' && numberText.trim() !== '' && parsedNumber === null,
  );

  const canSubmit = $derived.by(() => {
    if (saving) return false;
    if (kind === 'text') return textValue.trim().length > 0;
    if (kind === 'number') return parsedNumber !== null;
    if (kind === 'tag') return selectedTag !== null;
    return false;
  });

  async function add() {
    if (!canSubmit || saving) return;
    saving = true;
    error = null;
    try {
      const libId = resolvedLibraryId ?? (await resolveLibraryId(libraryId));
      let payload: NewFileValue;
      if (kind === 'text') {
        payload = { kind: 'text', text: textValue.trim() };
      } else if (kind === 'number') {
        payload = { kind: 'number', number: parsedNumber! };
      } else if (kind === 'tag') {
        payload = { kind: 'tag', refTagId: selectedTag!.tagId };
      } else {
        return;
      }
      const created = await addFileValue(libId, fileId, tagId, payload);
      notifyRelationshipChanged();
      onAdded?.(created);
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  }

  function onInputKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void add();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Add Value">
    <p class="modal-title">Add Value</p>
    <p class="modal-body">
      Add a value to <span class="tag-name">{tagName}</span> (#{tagId}) on file #{fileId}.
    </p>

    <label class="field">
      <span class="label">Value type</span>
      <select
        aria-label="Value type"
        bind:value={kind}
        disabled={saving}
        onchange={() => (error = null)}
      >
        <option value="text">Text</option>
        <option value="number">Number</option>
        <option value="tag">Tag</option>
        <option value="anchor">Anchor</option>
      </select>
    </label>

    {#if kind === 'text'}
      <label class="field">
        <span class="label">Text</span>
        <input
          type="text"
          aria-label="Text value"
          placeholder="Enter text value"
          bind:value={textValue}
          disabled={saving}
          onkeydown={onInputKeydown}
        />
      </label>
    {:else if kind === 'number'}
      <label class="field">
        <span class="label">Number</span>
        <input
          type="text"
          inputmode="decimal"
          aria-label="Number value"
          aria-invalid={numberInvalid}
          placeholder="Enter numeric value"
          bind:value={numberText}
          disabled={saving}
          onkeydown={onInputKeydown}
        />
        {#if numberInvalid}
          <span class="validation-error">Enter a valid number.</span>
        {/if}
      </label>
    {:else if kind === 'tag'}
      <div class="field">
        <span class="label">Tag</span>
        <TagAutocompleteInput
          libraryId={resolvedLibraryId}
          bind:selected={selectedTag}
          excludeTagId={tagId}
          disabled={saving}
          {debounceMs}
          ariaLabel="Tag value"
        />
      </div>
    {:else}
      <p class="deferred">Anchor values are deferred.</p>
    {/if}

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="modal-actions">
      <Button label="Add value" accent disabled={!canSubmit} onclick={() => void add()} />
      <Button label="Close" onclick={onClose} />
    </div>
  </div>
</div>

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
    width: 380px;
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

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label {
    font-size: 11px;
    color: $color-text-dim;
  }

  .field input[type='text'],
  .field select {
    width: 100%;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 1px solid transparent;
    border-radius: 2px;
  }

  .field input[aria-invalid='true'] {
    border-color: $color-error;
  }

  .validation-error,
  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }

  .deferred {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
