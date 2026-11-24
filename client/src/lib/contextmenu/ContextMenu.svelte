<script lang="ts">
  import EditRelationshipModal from '../tag/EditRelationshipModal.svelte';
  import AddValueModal from '../tag/AddValueModal.svelte';
  import EditTagModal from '../tag/EditTagModal.svelte';
  import {
    closeContextMenu,
    closeStubModal,
    contextMenuState,
    openContextMenu,
    stubModal,
    type ContextMenuItem,
  } from './contextmenu.svelte';

  // Named `menu` not `state`: `$state` would collide with the rune in the checker.
  const menu = $derived(contextMenuState());
  const stub = $derived(stubModal());

  let menuEl = $state<HTMLElement>();
  /** Render offset from the click point: zero unless the menu measured past the
   *  viewport edge, in which case it shifts back into view. */
  let shift = $state<{ x: number; y: number }>({ x: 0, y: 0 });

  // Clamp after render: effects flush before paint, so the shifted position never shows.
  $effect(() => {
    const current = menu;
    const el = menuEl;
    if (!current || !el) return;
    const rect = el.getBoundingClientRect();
    shift = {
      x: Math.min(0, window.innerWidth - 4 - rect.right),
      y: Math.min(0, window.innerHeight - 4 - rect.bottom),
    };
  });

  $effect(() => {
    if (!menu) return;
    const close = () => closeContextMenu();
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  });

  function onRightClick(event: MouseEvent) {
    // Ctrl+right-click is the escape hatch: don't intercept, show the native menu.
    if (!openContextMenu(event)) closeContextMenu();
  }

  function onWindowClick(event: MouseEvent) {
    if (menu && menuEl && !menuEl.contains(event.target as Node)) closeContextMenu();
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') closeContextMenu();
  }

  function activate(item: ContextMenuItem) {
    closeContextMenu();
    item.onSelect();
  }
</script>

<svelte:window oncontextmenu={onRightClick} onclick={onWindowClick} onkeydown={onWindowKeydown} />

{#if menu}
  <div
    bind:this={menuEl}
    class="context-menu"
    role="menu"
    aria-label="Context menu"
    style:left="{menu.x + shift.x}px"
    style:top="{menu.y + shift.y}px"
  >
    {#each menu.entries as entry, i (i)}
      {#if entry === 'separator'}
        <div class="separator" role="separator"></div>
      {:else}
        <button
          type="button"
          role="menuitem"
          disabled={entry.disabled ?? false}
          onclick={() => activate(entry)}
        >
          {entry.label}
        </button>
      {/if}
    {/each}
  </div>
{/if}

{#if stub?.kind === 'edit-tag'}
  <EditTagModal tagId={stub.tagId} tagName={stub.tagName} onClose={closeStubModal} />
{:else if stub?.kind === 'add-value'}
  <AddValueModal
    tagId={stub.tagId}
    tagName={stub.tagName}
    fileId={stub.fileId}
    onClose={closeStubModal}
  />
{:else if stub?.kind === 'edit-relationship'}
  <EditRelationshipModal
    tagId={stub.tagId}
    tagName={stub.tagName}
    fileId={stub.fileId}
    onClose={closeStubModal}
  />
{/if}

<style lang="scss">
  @use '../../styles/variables' as *;

  .context-menu {
    position: fixed;
    z-index: 200;
    display: flex;
    flex-direction: column;
    min-width: 160px;
    padding: 4px;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 50%);

    button {
      padding: 6px 10px;
      font-family: inherit;
      font-size: 12px;
      color: $color-text-strong;
      text-align: left;
      background: transparent;
      border: 0;
      border-radius: 2px;
      cursor: pointer;

      &:hover:not(:disabled),
      &:focus-visible {
        background: $color-chip-bg;
        outline: none;
      }

      &:disabled {
        color: $color-muted;
        cursor: default;
      }
    }
  }

  .separator {
    height: 1px;
    margin: 4px 6px;
    background: $color-border;
  }
</style>
