<script lang="ts">
  import Button from '../lib/Button.svelte';
  import ConfirmationModal from '../lib/ConfirmationModal.svelte';
  import Pill from '../lib/Pill.svelte';
  import { createLibrary, deleteLibrary, fetchLibraries, type LibrarySummary } from '../lib/api';

  let libraries = $state<LibrarySummary[] | null>(null);
  let librariesError = $state<string | null>(null);
  let draftName = $state('');
  let draftRootPath = $state('');
  let createError = $state<string | null>(null);
  let creating = $state(false);
  let pendingDelete = $state<LibrarySummary | null>(null);

  async function refreshLibraries() {
    try {
      libraries = await fetchLibraries();
      librariesError = null;
    } catch (e) {
      librariesError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void refreshLibraries();
  });

  const managedCount = $derived(
    (libraries ?? []).filter((l) => l.permissions.canManageLibrary).length,
  );

  const draftValid = $derived(draftName.trim().length > 0 && draftRootPath.startsWith('/'));

  async function createDraft() {
    if (!draftValid || creating) return;
    creating = true;
    createError = null;
    try {
      await createLibrary(draftName.trim(), draftRootPath.trim());
      draftName = '';
      draftRootPath = '';
      await refreshLibraries();
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }

  function cancelDraft() {
    draftName = '';
    draftRootPath = '';
    createError = null;
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    await deleteLibrary(pendingDelete.library_id);
    pendingDelete = null;
    await refreshLibraries();
  }
</script>

<div class="libraries-layout">
  <div class="libraries-content">
    <header class="libraries-header">
      <div class="title-block">
        <h1>Libraries</h1>
        <p class="description">
          Workspaces that index a directory of files, with their own tags and members.
        </p>
      </div>
      <div class="summary">
        <Pill label="{(libraries ?? []).length} total" />
        <Pill label="{managedCount} managed" accent={managedCount > 0} />
      </div>
    </header>

    {#if librariesError}
      <p class="error">{librariesError}</p>
    {:else if libraries === null}
      <p class="placeholder">Loading libraries…</p>
    {:else if libraries.length === 0}
      <p class="placeholder">No libraries yet. Create one from the panel on the right.</p>
    {:else}
      <div class="library-list">
        {#each libraries as library (library.library_id)}
          <div class="library-card">
            <div class="library-info">
              <span class="library-name">{library.name}</span>
              {#if library.root_path !== null}
                <span class="library-path">{library.root_path}</span>
              {/if}
            </div>
            <div class="library-side">
              <Pill label={library.role} accent={library.permissions.canManageLibrary} />
              {#if library.permissions.canManageLibrary}
                <Button label="Delete" onclick={() => (pendingDelete = library)} />
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <aside class="inspector">
    <header class="inspector-header">
      <p class="inspector-title">New library</p>
      <Pill label="draft" accent />
    </header>

    <label class="field">
      <span class="label">Name</span>
      <input type="text" bind:value={draftName} placeholder="Photos" disabled={creating} />
    </label>

    <label class="field">
      <span class="label">Root path</span>
      <input
        type="text"
        bind:value={draftRootPath}
        placeholder="/data/photos"
        disabled={creating}
      />
    </label>

    <p class="hint">The root path must be an existing directory on the server.</p>

    {#if createError}
      <p class="error">{createError}</p>
    {/if}

    <div class="inspector-spacer"></div>
    <div class="inspector-actions">
      <Button
        label="Create library"
        accent
        disabled={!draftValid || creating}
        onclick={() => void createDraft()}
      />
      <Button label="Cancel" onclick={cancelDraft} />
    </div>
  </aside>
</div>

{#if pendingDelete}
  <ConfirmationModal
    title="Delete library"
    message={`This deletes “${pendingDelete.name}” (${pendingDelete.root_path}) — its locations, tags, and members. The files on disk are not touched.`}
    confirmLabel="Delete library"
    onConfirm={confirmDelete}
    onCancel={() => (pendingDelete = null)}
  />
{/if}

<style lang="scss">
  @use '../styles/variables' as *;

  .libraries-layout {
    display: flex;
    gap: 0;
    align-items: stretch;
    min-height: 100vh;
  }

  .libraries-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px;
    background: $color-shell-bg;
  }

  .libraries-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .title-block h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: $color-jobs-accent;
  }

  .description {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .summary {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .library-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .library-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 12px;
    background: $color-panel-bg;
    border-radius: 2px;
  }

  .library-side {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }

  .library-info {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }

  .library-name {
    font-size: 14px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .library-path {
    font-size: 12px;
    color: $color-text-dim;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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

  .inspector {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex-shrink: 0;
    width: 350px;
    padding: 20px;
    background: $color-sidebar-bg;
    min-height: 100vh;
  }

  .inspector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .inspector-title {
    margin: 0;
    font-size: 16px;
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

  input {
    width: 100%;
    padding: 10px 12px;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
  }

  .hint {
    margin: 0;
    font-size: 11px;
    color: $color-text-dim;
  }

  .inspector-spacer {
    flex: 1;
  }

  .inspector-actions {
    display: flex;
    gap: 8px;
  }
</style>
