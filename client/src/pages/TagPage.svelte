<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteMap } from 'svelte/reactivity';
  import Button from '../lib/Button.svelte';
  import {
    batchUpdateFiles,
    createTag,
    fetchLibraries,
    listTags,
    queryFiles,
    searchFiles,
    type FileSummary,
    type LibrarySummary,
    type QueriedFile,
    type TagSummary,
  } from '../lib/api';
  import {
    clearSelection,
    isSelected,
    mostRecentSelection,
    select,
    selectionIds,
  } from '../lib/selection.svelte';
  import { ensurePreviews } from '../lib/previews.svelte';
  import { clearTagStore, tagStore } from '../lib/tagStore.svelte';
  import { relationshipStamp, setActiveLibraryId } from '../lib/contextmenu/contextmenu.svelte';
  import FileSearchInput from '../lib/tag/FileSearchInput.svelte';
  import FileTile from '../lib/tag/FileTile.svelte';
  import QuickTagModal from '../lib/tag/QuickTagModal.svelte';
  import SelectionInspector from '../lib/tag/SelectionInspector.svelte';
  import TagPalette from '../lib/tag/TagPalette.svelte';

  let { debounceMs = 300 }: { debounceMs?: number } = $props();

  const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // ---- Library context: the tag workspace operates on the caller's first library ----

  let libraries = $state<LibrarySummary[] | null>(null);
  let librariesError = $state<string | null>(null);
  const library = $derived(libraries?.[0] ?? null);

  $effect(() => {
    fetchLibraries()
      .then((libs) => (libraries = libs))
      .catch((e) => (librariesError = errorMessage(e)));
  });

  $effect(() => {
    setActiveLibraryId(library?.library_id ?? null);
  });

  $effect(() => {
    if (library) clearSelection();
  });

  let previousLibraryId: number | null = null;

  $effect(() => {
    if (!library) return;
    // Tag and file ids are global rowids, so cached state must not leak across libraries.
    if (previousLibraryId !== null && previousLibraryId !== library.library_id) {
      clearTagStore();
    }
    previousLibraryId = library.library_id;
    tags = null;
    results = null;
    knownFiles.clear();
  });

  // ---- Tag vocabulary: alias search in the left panel + a tag info map for display ----

  let tagDraft = $state('');
  let tagQuery = $state('');
  let tags = $state<TagSummary[] | null>(null);
  let tagsError = $state<string | null>(null);
  /** Every tag seen so far, keyed by id; the inspector uses it for names and colors. */
  const tagInfo = tagStore();

  $effect(() => {
    const q = tagDraft.trim();
    const timer = setTimeout(() => (tagQuery = q), debounceMs);
    return () => clearTimeout(timer);
  });

  let tagRequest = 0;

  async function refreshTags() {
    const lib = library;
    relationshipStamp();
    if (!lib) return;
    const request = ++tagRequest;
    try {
      const result = await listTags(lib.library_id, tagQuery, { limit: 500 });
      if (request !== tagRequest) return;
      tags = result.tags;
      tagsError = null;
    } catch (e) {
      if (request === tagRequest) tagsError = errorMessage(e);
    }
  }

  $effect(() => void refreshTags());

  // ---- File search: the omnisearch box drives the center grid ----

  /** Entries per grid page, chosen from the dropdown under the search bar. */
  let pageSize = $state(24);

  /** Grid tile size, chosen from the dropdown under the search bar. */
  let tileSize = $state<'small' | 'medium' | 'large'>('medium');

  let searchDraft = $state('');
  let searchQuery = $state('');
  let currentPage = $state(0);
  let results = $state<{ total: number; files: FileSummary[] } | null>(null);
  /** The total of the last counted search, kept so that a page change does not count again. */
  let knownTotal: { key: string; total: number } | null = null;
  /** Incremented to run the search again with a count. */
  let recount = $state(0);
  let searchError = $state<string | null>(null);
  /** Every file summary seen so far, keyed by id; the deck shows selected files with it. */
  const knownFiles = new SvelteMap<number, FileSummary>();

  $effect(() => {
    const q = searchDraft.trim();
    const timer = setTimeout(() => (searchQuery = q), debounceMs);
    return () => clearTimeout(timer);
  });

  let filesRequest = 0;

  // A new query or a new page size goes back to the first page.
  let previousQuery = untrack(() => searchQuery);
  let previousPageSize = untrack(() => pageSize);

  $effect(() => {
    const q = searchQuery;
    const size = pageSize;
    if (q !== previousQuery || size !== previousPageSize) {
      previousQuery = q;
      previousPageSize = size;
      currentPage = 0;
    }
  });

  $effect(() => {
    const lib = library;
    const q = searchQuery;
    const page = currentPage;
    const size = pageSize;
    if (!lib) {
      results = null;
      return;
    }
    void recount;
    const request = ++filesRequest;
    // The server counts all matches only for a new search; other pages use the kept total.
    const totalKey = `${lib.library_id}:${q}`;
    const keptTotal = knownTotal?.key === totalKey ? knownTotal.total : null;
    searchFiles(lib.library_id, q, {
      limit: size,
      offset: page * size,
      count: keptTotal === null,
    })
      .then((res) => {
        if (request !== filesRequest) return;
        const total = res.total ?? keptTotal ?? 0;
        if (res.files.length === 0 && page > 0) {
          if (res.total === null) {
            // The kept total can be out of date: search again with a count.
            knownTotal = null;
            recount++;
            return;
          }
          if (total > 0) {
            // The results shrank under us: back up to the last page that still has files.
            knownTotal = { key: totalKey, total };
            currentPage = Math.ceil(total / size) - 1;
            return;
          }
        }
        knownTotal = { key: totalKey, total };
        results = { total, files: res.files };
        searchError = null;
        for (const file of res.files) knownFiles.set(file.fileId, file);
        // Fetch the grid's previews in one batch; the tiles read them from the store.
        ensurePreviews(res.files.map((file) => file.fileId));
      })
      .catch((e) => {
        if (request === filesRequest) searchError = errorMessage(e);
      });
  });

  /** Total page count for the loaded result set, at least one so the readout never shows 0. */
  const pageCount = $derived(results ? Math.max(1, Math.ceil(results.total / pageSize)) : 1);

  function goToPage(page: number) {
    currentPage = Math.min(Math.max(page, 0), pageCount - 1);
  }

  // ---- Selection detail: the inspector describes the most recently selected file ----

  let detail = $state<QueriedFile | null>(null);
  let detailError = $state<string | null>(null);
  let detailStamp = $state(0);

  $effect(() => {
    const lib = library;
    const id = mostRecentSelection();
    const stamp = detailStamp + relationshipStamp();
    if (!lib || id === null) {
      detail = null;
      detailError = null;
      return;
    }
    let cancelled = false;
    queryFiles(lib.library_id, [id], ['instances', 'locations'])
      .then((res) => {
        if (cancelled || stamp !== detailStamp + relationshipStamp()) return;
        detail = res.files.find((f) => f.fileId === id) ?? null;
        detailError = null;
      })
      .catch((e) => {
        if (!cancelled && stamp === detailStamp + relationshipStamp())
          detailError = errorMessage(e);
      });
    return () => {
      cancelled = true;
    };
  });

  // ---- Actions ----

  let actionError = $state<string | null>(null);
  let applying = $state(false);
  let quickTagOpen = $state(false);

  async function onTagClick(tag: TagSummary) {
    const lib = library;
    const ids = selectionIds();
    if (!lib || ids.length === 0 || applying) return;
    applying = true;
    actionError = null;
    try {
      await batchUpdateFiles(lib.library_id, ids, [{ op: 'tag', tagId: tag.tagId }]);
      detailStamp++;
    } catch (e) {
      actionError = errorMessage(e);
    } finally {
      applying = false;
    }
  }

  async function onCreateTag(alias: string, color: string): Promise<void> {
    const lib = library;
    if (!lib) throw new Error('No library selected');
    await createTag(lib.library_id, { alias, color });
    quickTagOpen = false;
    await refreshTags();
  }
</script>

<div class="tag-layout">
  {#if librariesError}
    <p class="error">{librariesError}</p>
  {:else if libraries === null}
    <p class="placeholder">Loading library…</p>
  {:else if library === null}
    <p class="placeholder">Create a library first to tag its files.</p>
  {:else}
    <TagPalette
      {tags}
      query={tagDraft}
      canCreate={library.permissions.canCreateTag}
      onSearch={(q) => (tagDraft = q)}
      onTagClick={(tag) => void onTagClick(tag)}
      onQuickTag={() => (quickTagOpen = true)}
    />

    <section class="center">
      <div class="omnisearch">
        <FileSearchInput libraryId={library.library_id} bind:value={searchDraft} {debounceMs} />
        <div class="grid-controls">
          <label class="size-field">
            <span class="label">Preview size</span>
            <select bind:value={tileSize}>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
              <option value="large">Large</option>
            </select>
          </label>
          <label class="size-field">
            <span class="label">Entries per page</span>
            <select bind:value={pageSize}>
              <option value={12}>12</option>
              <option value={24}>24</option>
              <option value={48}>48</option>
              <option value={96}>96</option>
            </select>
          </label>
          {#if results !== null}
            <div class="paging">
              <Button
                label="Prev"
                disabled={currentPage === 0}
                onclick={() => goToPage(currentPage - 1)}
              />
              <span class="page-readout">Page {currentPage + 1} of {pageCount}</span>
              <Button
                label="Next"
                disabled={currentPage + 1 >= pageCount}
                onclick={() => goToPage(currentPage + 1)}
              />
            </div>
          {/if}
        </div>
      </div>
      {#if searchError && results === null}
        <p class="error">{searchError}</p>
      {:else if results === null}
        <p class="placeholder">Loading files…</p>
      {:else}
        {#if searchError}
          <p class="error">{searchError}</p>
        {/if}
        <div class="grid">
          {#each results.files as file (file.fileId)}
            <FileTile
              {file}
              size={tileSize}
              selected={isSelected(file.fileId)}
              onclick={(event) => select(file.fileId, event as MouseEvent)}
            />
          {:else}
            <p class="placeholder">No files match.</p>
          {/each}
        </div>
      {/if}
    </section>

    <SelectionInspector {detail} selection={selectionIds()} filesById={knownFiles} {tagInfo} />
  {/if}
</div>

{#if (tagsError || actionError || detailError) && library}
  <p class="sticky-error">{tagsError ?? actionError ?? detailError}</p>
{/if}

{#if quickTagOpen}
  <QuickTagModal onCreate={onCreateTag} onCancel={() => (quickTagOpen = false)} />
{/if}

<style lang="scss">
  @use '../styles/variables' as *;

  .tag-layout {
    display: flex;
    gap: 0;
    align-items: stretch;
    height: 100vh;
  }

  .center {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 0;
    background: $color-shell-bg;

    > .placeholder,
    > .error {
      padding: 16px;
    }
  }

  .omnisearch {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 16px;
    background: $color-sidebar-bg;
  }

  .grid-controls {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .size-field {
    display: flex;
    align-items: center;
    gap: 8px;

    .label {
      font-size: 11px;
      color: $color-text-dim;
    }

    select {
      padding: 6px 10px;
      font-family: inherit;
      font-size: 12px;
      color: $color-text-strong;
      background: $color-chip-bg;
      border: 0;
      border-radius: 2px;
    }
  }

  .paging {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-left: auto;
  }

  .page-readout {
    font-size: 12px;
    color: $color-text-dim;
  }

  .grid {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-content: flex-start;
    flex: 1;
    min-height: 0;
    padding: 16px;
    overflow-y: auto;
  }

  .placeholder {
    margin: 0;
    font-size: 13px;
    color: $color-text-dim;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }

  .sticky-error {
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 50;
    margin: 0;
    max-width: 420px;
    padding: 10px 12px;
    font-size: 12px;
    color: $color-error;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
  }
</style>
