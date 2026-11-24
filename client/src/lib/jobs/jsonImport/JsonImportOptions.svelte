<script lang="ts">
  import { fetchLibraries, type LibrarySummary } from '../../api';
  import TagAutocompleteInput, { type SelectedTag } from '../../tag/TagAutocompleteInput.svelte';
  import type { JobOptionProps } from '../registry';

  let { onChange }: JobOptionProps = $props();

  interface PathDraft {
    path: string;
    direct: boolean;
    tag: SelectedTag | null;
  }

  let libraries = $state<LibrarySummary[] | null>(null);
  let loadError = $state<string | null>(null);
  let libraryId = $state('');
  let subpath = $state('');
  let ignoreText = $state('');
  const ignorePlaceholder = 'One pattern per line, e.g.\n*.tmp\nThumbs.db\nnode_modules';
  let paths = $state<PathDraft[]>([{ path: '', direct: false, tag: null }]);
  let createIfMissing = $state(false);
  let parent = $state<SelectedTag | null>(null);
  let color = $state('#e74c3c');
  const hasDirect = $derived(paths.some((draft) => draft.direct));

  $effect(() => {
    fetchLibraries()
      .then((libs) => (libraries = libs))
      .catch((e: unknown) => (loadError = e instanceof Error ? e.message : String(e)));
  });

  $effect(() => {
    const ignorePaths = ignoreText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    const valid =
      libraryId !== '' &&
      paths.every((draft) => draft.path.trim() !== '' && (draft.direct || draft.tag !== null));
    if (!valid) {
      onChange(null);
      return;
    }
    onChange({
      libraryId: Number(libraryId),
      paths: paths.map((draft) => ({
        path: draft.path.trim(),
        ...(draft.direct
          ? { direct: true }
          : { tagId: draft.tag!.tagId, tagName: draft.tag!.name }),
      })),
      ...(subpath.trim() !== '' ? { subpath: subpath.trim() } : {}),
      ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
      ...(hasDirect && createIfMissing
        ? {
            createIfMissing: true,
            ...(parent !== null ? { parentTagId: parent.tagId, parentName: parent.name } : {}),
            color,
          }
        : {}),
    });
  });

  function addPath() {
    paths.push({ path: '', direct: false, tag: null });
  }

  function removePath(index: number) {
    paths.splice(index, 1);
  }
</script>

<div class="fields">
  <label>
    <span class="label">Library</span>
    {#if loadError}
      <p class="error">Libraries unavailable: {loadError}</p>
    {:else if libraries === null}
      <p class="loading">Loading libraries…</p>
    {:else if libraries.length === 0}
      <p class="error">No libraries yet — create one under Settings.</p>
    {:else}
      <select bind:value={libraryId} disabled={libraries.length === 0}>
        <option value="" disabled>Select a library</option>
        {#each libraries as lib (lib.library_id)}
          <option value={String(lib.library_id)}>{lib.name}</option>
        {/each}
      </select>
    {/if}
  </label>
  <table class="path-table" aria-label="JSON paths">
    <thead>
      <tr>
        <th class="path-column" scope="col">JSON path</th>
        <th class="tag-column" scope="col">Tag to apply</th>
        <th class="direct-column" scope="col">Direct</th>
        {#if paths.length > 1}
          <th class="actions-column" scope="col"><span class="visually-hidden">Actions</span></th>
        {/if}
      </tr>
    </thead>
    <tbody>
      {#each paths as draft, i (draft)}
        <tr>
          <td>
            <input
              type="text"
              bind:value={draft.path}
              placeholder="Dot notation, e.g. author.name"
              aria-label={`JSON path ${i + 1}`}
            />
          </td>
          <td>
            <div class:greyed={draft.direct}>
              <TagAutocompleteInput
                libraryId={libraryId === '' ? null : Number(libraryId)}
                bind:selected={draft.tag}
                disabled={draft.direct}
                placeholder="Search tags"
                ariaLabel={`Tag to apply for JSON path ${i + 1}`}
              />
            </div>
          </td>
          <td class="direct-cell">
            <input
              type="checkbox"
              bind:checked={draft.direct}
              aria-label={`Direct mode for JSON path ${i + 1}`}
            />
          </td>
          {#if paths.length > 1}
            <td class="actions-cell">
              <button
                type="button"
                class="text-button"
                aria-label={`Remove JSON path ${i + 1}`}
                onclick={() => removePath(i)}
              >
                Remove
              </button>
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
  <p class="hint">Direct: extracted values are tag names, applied as tags.</p>
  <button type="button" class="text-button add-path" onclick={addPath}>+ Add JSON path</button>
  <label>
    <span class="label">Subfolder</span>
    <input type="text" bind:value={subpath} placeholder="Leave empty to scan the whole library" />
  </label>
  <label>
    <span class="label">Ignore list</span>
    <textarea rows="3" bind:value={ignoreText} placeholder={ignorePlaceholder}></textarea>
  </label>
  {#if hasDirect}
    <label class="checkbox-row">
      <input type="checkbox" bind:checked={createIfMissing} />
      <span>Create if missing</span>
    </label>
    {#if createIfMissing}
      <p class="hint">These settings apply to every direct JSON path.</p>
      <label>
        <span class="label">Parent for created tags</span>
        <TagAutocompleteInput
          libraryId={libraryId === '' ? null : Number(libraryId)}
          bind:selected={parent}
          placeholder="No parent"
          ariaLabel="Parent for created tags"
        />
      </label>
      <label>
        <span class="label">Color for created tags</span>
        <input type="color" bind:value={color} aria-label="Color for created tags" />
      </label>
    {/if}
  {/if}
</div>

<style lang="scss">
  @use '../../../styles/variables' as *;

  .fields {
    display: flex;
    flex-direction: column;
    gap: $space-3;
    width: 100%;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: $space-1;
  }

  .label {
    font-size: 11px;
    color: $color-text-dim;
  }

  select,
  input[type='text'],
  textarea {
    width: 100%;
    padding: 10px 12px;
    font-size: 13px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
    font-family: inherit;
  }

  textarea {
    resize: vertical;
  }

  input::placeholder,
  textarea::placeholder {
    color: $color-text-dim;
  }

  .checkbox-row {
    flex-direction: row;
    align-items: center;
    gap: $space-2;
    font-size: 13px;
    color: $color-text-strong;
  }

  .path-table {
    width: 100%;
    background: $color-panel-bg;
    border-collapse: collapse;
    border-radius: 2px;
    table-layout: fixed;
    text-align: left;

    th,
    td {
      padding: 10px;
      border-bottom: 1px solid $color-chip-bg;
      vertical-align: middle;
    }

    th {
      font-size: 11px;
      font-weight: 500;
      color: $color-text-dim;
    }

    tbody tr:last-child td {
      border-bottom: 0;
    }

    input[type='text'] {
      min-width: 0;
      padding: 8px 10px;
    }
  }

  .path-column {
    width: 34%;
  }

  .tag-column {
    width: 38%;
  }

  .direct-column {
    width: 64px;
    text-align: center;
  }

  .actions-column {
    width: 72px;
  }

  .direct-cell,
  .actions-cell {
    text-align: center;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .text-button {
    align-self: flex-start;
    padding: 0;
    font-family: inherit;
    font-size: 12px;
    color: $color-text-dim;
    background: none;
    border: 0;
    cursor: pointer;

    &:hover {
      color: $color-text-strong;
    }
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: $color-text-dim;
  }

  .greyed {
    opacity: 0.45;
    pointer-events: none;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }

  .loading {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }
</style>
