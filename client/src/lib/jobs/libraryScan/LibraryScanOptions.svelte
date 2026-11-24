<script lang="ts">
  import { fetchLibraries, type LibrarySummary } from '../../api';
  import type { JobOptionProps } from '../registry';

  let { onChange }: JobOptionProps = $props();

  let libraries = $state<LibrarySummary[] | null>(null);
  let loadError = $state<string | null>(null);
  let libraryId = $state('');
  let subpath = $state('');
  let ignoreText = $state('');
  const ignorePlaceholder = 'One pattern per line, e.g.\n*.tmp\nThumbs.db\nnode_modules';

  $effect(() => {
    fetchLibraries()
      .then((libs) => (libraries = libs))
      .catch((e: unknown) => (loadError = e instanceof Error ? e.message : String(e)));
  });

  $effect(() => {
    const id = Number(libraryId);
    const ignorePaths = ignoreText
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    onChange(
      libraryId === ''
        ? null
        : {
            libraryId: id,
            ...(subpath.trim() !== '' ? { subpath: subpath.trim() } : {}),
            ...(ignorePaths.length > 0 ? { ignorePaths } : {}),
          },
    );
  });
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
  <label>
    <span class="label">Subfolder</span>
    <input type="text" bind:value={subpath} placeholder="Leave empty to scan the whole library" />
  </label>
  <label>
    <span class="label">Ignore list</span>
    <textarea rows="4" bind:value={ignoreText} placeholder={ignorePlaceholder}></textarea>
    <span class="hint">
      Skips matching files and folders. A pattern matches a name or a library-relative path; use *
      for any characters.
    </span>
  </label>
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
  input,
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

  .hint {
    font-size: 11px;
    color: $color-text-dim;
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
