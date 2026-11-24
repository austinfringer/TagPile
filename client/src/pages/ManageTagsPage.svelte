<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import Button from '../lib/Button.svelte';
  import ConfirmationModal from '../lib/ConfirmationModal.svelte';
  import Icon from '../lib/Icon.svelte';
  import {
    createTag,
    deleteTag,
    fetchLibraries,
    fetchTagGraph,
    removeTagParent,
    setTagComponent,
    setTagParent,
    type LibrarySummary,
    type TagGraph,
  } from '../lib/api';
  import {
    notifyRelationshipChanged,
    relationshipStamp,
    setActiveLibraryId,
  } from '../lib/contextmenu/contextmenu.svelte';
  import { navigate } from '../lib/router.svelte';
  import EditTagModal from '../lib/tag/EditTagModal.svelte';
  import QuickTagModal from '../lib/tag/QuickTagModal.svelte';
  import TagGraphView from '../lib/tagGraph/TagGraphView.svelte';
  import TagManageInspector from '../lib/tagGraph/TagManageInspector.svelte';
  import TagTreeView from '../lib/tagGraph/TagTreeView.svelte';
  import {
    buildIndex,
    edgeKey,
    neighborhood,
    overview,
    pathKeys,
    searchTags,
    treeRows,
    wouldCycle,
  } from '../lib/tagGraph/model';

  let { debounceMs = 200 }: { debounceMs?: number } = $props();

  const OVERVIEW_CAP = 150;
  const ALL_LEVELS = 99;

  const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // ---- Library context: the page operates on the caller's first library ----

  let libraries = $state<LibrarySummary[] | null>(null);
  let librariesError = $state<string | null>(null);
  const library = $derived(libraries?.[0] ?? null);
  const canEdit = $derived(library?.permissions.canCreateTag ?? false);

  $effect(() => {
    fetchLibraries()
      .then((libs) => (libraries = libs))
      .catch((e) => (librariesError = errorMessage(e)));
  });

  $effect(() => {
    setActiveLibraryId(library?.library_id ?? null);
  });

  // ---- Tag graph: loaded in full, and loaded again after each change ----

  let graph = $state<TagGraph | null>(null);
  let graphError = $state<string | null>(null);
  let graphRequest = 0;

  $effect(() => {
    const lib = library;
    void relationshipStamp();
    if (!lib) return;
    const request = ++graphRequest;
    fetchTagGraph(lib.library_id)
      .then((result) => {
        if (request !== graphRequest) return;
        graph = result;
        graphError = null;
      })
      .catch((e) => {
        if (request === graphRequest) graphError = errorMessage(e);
      });
  });

  const index = $derived(buildIndex(graph));

  // ---- Browse state ----

  let selectedId = $state<number | null>(null);
  let focusId = $state<number | null>(null);
  let depth = $state(2);
  let showComponents = $state(true);
  let draft = $state('');
  let query = $state('');
  const expanded = new SvelteSet<string>();

  $effect(() => {
    const q = draft;
    const timer = setTimeout(() => (query = q), debounceMs);
    return () => clearTimeout(timer);
  });

  const selected = $derived(selectedId !== null && index.nodes.has(selectedId) ? selectedId : null);
  const focus = $derived(focusId !== null && index.nodes.has(focusId) ? focusId : null);
  const search = $derived(searchTags(index, query));
  const rows = $derived(treeRows(index, expanded, search?.visible ?? null));
  const shownGraph = $derived(
    focus !== null
      ? { ids: neighborhood(index, focus, depth, showComponents), hidden: 0 }
      : overview(index, OVERVIEW_CAP, showComponents),
  );
  const nameOf = (id: number) => index.nodes.get(id)?.name ?? `#${id}`;

  let treePanel = $state<HTMLElement>();

  function selectTag(id: number, options: { focus?: boolean; reveal?: boolean } = {}) {
    selectedId = id;
    if (options.focus) focusId = id;
    if (options.reveal) {
      for (const key of pathKeys(index, id)) expanded.add(key);
      void tick().then(() =>
        treePanel?.querySelector(`[data-row-tag="${id}"]`)?.scrollIntoView?.({ block: 'nearest' }),
      );
    }
  }

  function toggleRow(key: string) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
  }

  // ---- Writes ----

  let busy = $state(false);
  let actionError = $state<string | null>(null);

  async function run(action: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    busy = true;
    actionError = null;
    try {
      await action();
    } catch (e) {
      actionError = errorMessage(e);
    } finally {
      busy = false;
      notifyRelationshipChanged();
    }
  }

  /** The choice shown after the user drops one tag on another. */
  let linkMenu = $state<{ sourceId: number; targetId: number; x: number; y: number } | null>(null);

  const linkState = $derived.by(() => {
    if (!linkMenu) return null;
    const { sourceId, targetId } = linkMenu;
    const parents = index.parents.get(sourceId) ?? [];
    return {
      cycle: wouldCycle(index, sourceId, targetId),
      isParent: parents.includes(targetId),
      onlyParent: parents.length === 1 && parents[0] === targetId,
      isComponent: (index.components.get(targetId) ?? []).includes(sourceId),
    };
  });

  function openLinkMenu(sourceId: number, targetId: number, x: number, y: number) {
    if (canEdit && sourceId !== targetId) linkMenu = { sourceId, targetId, x, y };
  }

  function removeAllParents(libraryId: number, tagId: number, keep?: number) {
    return (async () => {
      for (const parent of index.parents.get(tagId) ?? []) {
        if (parent !== keep) await removeTagParent(libraryId, tagId, parent);
      }
    })();
  }

  function applyLink(kind: 'move' | 'parent' | 'component') {
    const lib = library;
    const link = linkMenu;
    linkMenu = null;
    if (!lib || !link) return;
    const { sourceId, targetId } = link;
    const libraryId = lib.library_id;
    void run(async () => {
      if (kind === 'parent') return setTagParent(libraryId, sourceId, targetId);
      if (kind === 'component') return setTagComponent(libraryId, targetId, sourceId);
      // Move: add the new parent first, so that a rejected parent leaves the tag as it was.
      const hadPrimary = (index.parents.get(sourceId) ?? []).some(
        (parent) => parent !== targetId && index.edges.get(edgeKey(sourceId, parent))?.primary,
      );
      await setTagParent(libraryId, sourceId, targetId, hadPrimary ? { primary: true } : {});
      await removeAllParents(libraryId, sourceId, targetId);
    }).then(() => selectTag(sourceId, { reveal: true }));
  }

  function makeRoot(sourceId: number) {
    const lib = library;
    if (!lib || !canEdit) return;
    void run(() => removeAllParents(lib.library_id, sourceId));
  }

  // ---- Modals ----

  let editOpen = $state(false);
  let deleteOpen = $state(false);
  /** Parent of the tag to create; `null` creates a root tag; `undefined` means closed. */
  let newTagParent = $state<number | null | undefined>(undefined);

  async function onCreateTag(alias: string, color: string): Promise<void> {
    const lib = library;
    if (!lib) throw new Error('No library selected');
    const parentId = newTagParent ?? undefined;
    const detail = await createTag(lib.library_id, { alias, color, parentId });
    newTagParent = undefined;
    graph = await fetchTagGraph(lib.library_id);
    selectTag(detail.tag.tag_id, { reveal: true });
  }

  async function onDeleteTag(): Promise<void> {
    const lib = library;
    const id = selected;
    if (!lib || id === null) return;
    await deleteTag(lib.library_id, id);
    deleteOpen = false;
    if (focusId === id) focusId = null;
    selectedId = null;
    notifyRelationshipChanged();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') linkMenu = null;
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="manage-layout">
  {#if librariesError}
    <p class="placeholder">{librariesError}</p>
  {:else if libraries === null}
    <p class="placeholder">Loading library…</p>
  {:else if library === null}
    <p class="placeholder">Create a library first to manage its tags.</p>
  {:else if graph === null}
    <p class="placeholder" class:error={graphError !== null}>{graphError ?? 'Loading tags…'}</p>
  {:else}
    <aside class="tree-panel" bind:this={treePanel} aria-label="Tags">
      <div class="tag-search">
        <Icon name="magnifying-glass" size={14} />
        <input
          type="text"
          placeholder="Search tags"
          aria-label="Search tags"
          spellcheck="false"
          bind:value={draft}
        />
      </div>
      <div class="tree-head">
        <span>
          {search ? `${search.matches.size} of ${index.nodes.size}` : index.nodes.size}
          {index.nodes.size === 1 ? 'tag' : 'tags'}
        </span>
        {#if canEdit}
          <button type="button" class="new-tag" onclick={() => (newTagParent = null)}>
            <Icon name="plus" size={12} /> New tag
          </button>
        {/if}
      </div>
      <TagTreeView
        {index}
        {rows}
        selectedId={selected}
        {canEdit}
        onSelect={(id) => selectTag(id, { focus: true })}
        onToggle={toggleRow}
        onLink={openLinkMenu}
        onMakeRoot={makeRoot}
      />
    </aside>

    <section class="center" aria-label="Tag relationships">
      <div class="toolbar">
        {#if focus !== null}
          <span class="scope">Around <strong>{nameOf(focus)}</strong></span>
          <label>
            <span>Child levels</span>
            <select bind:value={depth}>
              <option value={1}>1</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
              <option value={ALL_LEVELS}>All</option>
            </select>
          </label>
          <Button label="Show all tags" onclick={() => (focusId = null)} />
        {:else}
          <span class="scope">
            All relationships
            {#if shownGraph.hidden > 0}
              <span class="dim">
                · {shownGraph.hidden} tags not drawn. Select a tag to see its relationships.
              </span>
            {/if}
          </span>
        {/if}
        <label class="push">
          <input type="checkbox" bind:checked={showComponents} />
          <span>Components</span>
        </label>
      </div>
      <TagGraphView
        {index}
        ids={shownGraph.ids}
        selectedId={selected}
        focusId={focus}
        matches={search?.matches ?? null}
        {showComponents}
        {canEdit}
        onSelect={(id) => selectTag(id, { reveal: true })}
        onFocus={(id) => selectTag(id, { focus: true, reveal: true })}
        onLink={openLinkMenu}
      />
      <p class="hint">
        Click a tag to select it. Double-click a tag to draw the graph around it.
        {#if canEdit}
          Drag a tag onto a different tag to change their relationship.
        {/if}
      </p>
    </section>

    {#if selected !== null}
      <TagManageInspector
        {index}
        tagId={selected}
        libraryId={library.library_id}
        {canEdit}
        {busy}
        {run}
        onSelect={(id) => selectTag(id, { reveal: true })}
        onFocus={(id) => selectTag(id, { focus: true, reveal: true })}
        onEdit={() => (editOpen = true)}
        onDelete={() => (deleteOpen = true)}
        onNewChild={() => (newTagParent = selected)}
        onOpen={() => navigate(`/tags/${selected}`)}
      />
    {:else}
      <aside class="no-selection">
        <p>Select a tag to see and change its parents, children, components, and values.</p>
      </aside>
    {/if}
  {/if}
</div>

{#if linkMenu && linkState}
  {@const source = nameOf(linkMenu.sourceId)}
  {@const target = nameOf(linkMenu.targetId)}
  <div class="link-backdrop" role="presentation" onclick={() => (linkMenu = null)}></div>
  <div
    class="link-menu"
    role="menu"
    aria-label="Change relationship"
    style:left="{Math.min(linkMenu.x, window.innerWidth - 300)}px"
    style:top="{Math.min(linkMenu.y, window.innerHeight - 190)}px"
  >
    <p><strong>{source}</strong> → <strong>{target}</strong></p>
    <button
      type="button"
      role="menuitem"
      disabled={linkState.cycle || linkState.onlyParent}
      onclick={() => applyLink('move')}
    >
      Move under {target}
      <span>Replace all parents of {source}</span>
    </button>
    <button
      type="button"
      role="menuitem"
      disabled={linkState.cycle || linkState.isParent}
      onclick={() => applyLink('parent')}
    >
      Add {target} as a parent
      <span>Keep the other parents of {source}</span>
    </button>
    <button
      type="button"
      role="menuitem"
      disabled={linkState.isComponent}
      onclick={() => applyLink('component')}
    >
      Add as a component of {target}
      <span>{source} comes along when {target} is applied</span>
    </button>
    {#if linkState.cycle}
      <p class="dim">{target} is a descendant of {source}, so it cannot be a parent.</p>
    {/if}
    <button type="button" role="menuitem" onclick={() => (linkMenu = null)}>Cancel</button>
  </div>
{/if}

{#if (actionError || graphError) && graph !== null}
  <p class="sticky-error" role="alert">{actionError ?? graphError}</p>
{/if}

{#if newTagParent !== undefined}
  <QuickTagModal onCreate={onCreateTag} onCancel={() => (newTagParent = undefined)} />
{/if}

{#if editOpen && selected !== null && library}
  {#key selected}
    <EditTagModal
      tagId={selected}
      tagName={nameOf(selected)}
      libraryId={library.library_id}
      onClose={() => (editOpen = false)}
    />
  {/key}
{/if}

{#if deleteOpen && selected !== null}
  <ConfirmationModal
    title="Delete tag"
    message={`Delete the tag "${nameOf(selected)}"? This removes it from all files and from all other tags.`}
    confirmLabel="Delete"
    onConfirm={onDeleteTag}
    onCancel={() => (deleteOpen = false)}
  />
{/if}

<style lang="scss">
  @use '../styles/variables' as *;

  .manage-layout {
    display: flex;
    align-items: stretch;
    height: 100vh;
  }

  .placeholder {
    margin: 0;
    padding: 16px;
    font-size: 13px;
    color: $color-text-dim;

    &.error {
      color: $color-error;
    }
  }

  .tree-panel {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    width: 280px;
    min-height: 0;
    background: $color-sidebar-bg;
  }

  .tag-search {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 8px;
    margin: 12px 12px 8px;
    padding: 0 10px;
    color: $color-text-dim;
    background: $color-chip-bg;
    border-radius: 2px;

    input {
      flex: 1;
      min-width: 0;
      padding: 8px 0;
      font-family: inherit;
      font-size: 13px;
      color: $color-text-strong;
      background: transparent;
      border: 0;
      outline: none;
    }
  }

  .tree-head {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: space-between;
    padding: 0 12px 6px;
    font-size: 11px;
    color: $color-text-dim;
  }

  .new-tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    font-family: inherit;
    font-size: 11px;
    font-weight: 600;
    color: $color-text-inactive;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
    cursor: pointer;

    &:hover {
      color: $color-text-strong;
    }
  }

  .center {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    background: $color-shell-bg;
  }

  .toolbar {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 16px;
    min-height: 52px;
    padding: 8px 16px;
    font-size: 12px;
    color: $color-text-inactive;
    background: $color-sidebar-bg;

    label {
      display: inline-flex;
      align-items: center;
      gap: 8px;
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

    strong {
      color: $color-text-strong;
    }

    .push {
      margin-left: auto;
    }
  }

  .dim {
    color: $color-text-dim;
  }

  .hint {
    flex-shrink: 0;
    margin: 0;
    padding: 6px 16px;
    font-size: 11px;
    color: $color-text-dim;
    background: $color-sidebar-bg;
  }

  .no-selection {
    flex-shrink: 0;
    width: 320px;
    padding: 16px;
    font-size: 12px;
    color: $color-text-dim;
    background: $color-sidebar-bg;

    p {
      margin: 0;
    }
  }

  .link-backdrop {
    position: fixed;
    inset: 0;
    z-index: 90;
  }

  .link-menu {
    position: fixed;
    z-index: 91;
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 280px;
    padding: 8px;
    background: $color-panel-bg;
    border: 1px solid $color-border;
    border-radius: 2px;
    box-shadow: 0 8px 24px rgb(0 0 0 / 50%);

    p {
      margin: 0;
      padding: 4px 8px;
      font-size: 12px;
      color: $color-text-inactive;
    }

    button {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      color: $color-text-strong;
      text-align: left;
      background: transparent;
      border: 0;
      border-radius: 2px;
      cursor: pointer;

      span {
        font-size: 11px;
        color: $color-text-dim;
      }

      &:hover:not(:disabled) {
        background: $color-chip-bg;
      }

      &:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    }
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
    border-radius: 2px;
  }
</style>
