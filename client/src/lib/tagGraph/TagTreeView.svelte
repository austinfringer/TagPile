<script lang="ts">
  import Icon from '../Icon.svelte';
  import TagChip from '../TagChip.svelte';
  import type { TagGraphIndex, TreeRow } from './model';

  let {
    index,
    rows,
    selectedId,
    canEdit,
    onSelect,
    onToggle,
    onLink,
    onMakeRoot,
  }: {
    index: TagGraphIndex;
    rows: TreeRow[];
    selectedId: number | null;
    canEdit: boolean;
    onSelect: (tagId: number) => void;
    onToggle: (key: string) => void;
    /** The user dropped the row of `sourceId` on the row of `targetId`. */
    onLink: (sourceId: number, targetId: number, x: number, y: number) => void;
    /** The user dropped the row of `sourceId` on the root area. */
    onMakeRoot: (sourceId: number) => void;
  } = $props();

  const PAGE = 400;

  let limit = $state(PAGE);
  let dragId = $state<number | null>(null);
  let overKey = $state<string | null>(null);

  const shown = $derived(rows.slice(0, limit));
  const dragHasParents = $derived(dragId !== null && index.parents.has(dragId));

  function onDragStart(event: DragEvent, row: TreeRow) {
    dragId = row.tagId;
    event.dataTransfer?.setData('text/plain', String(row.tagId));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'link';
  }

  function onDragOver(event: DragEvent, key: string, tagId?: number) {
    if (dragId === null || dragId === tagId) return;
    event.preventDefault();
    overKey = key;
  }

  function onDrop(event: DragEvent, row: TreeRow) {
    event.preventDefault();
    const source = dragId;
    dragId = null;
    overKey = null;
    if (source !== null && source !== row.tagId) {
      onLink(source, row.tagId, event.clientX, event.clientY);
    }
  }

  function onRootDrop(event: DragEvent) {
    event.preventDefault();
    const source = dragId;
    dragId = null;
    overKey = null;
    if (source !== null) onMakeRoot(source);
  }

  function onRowKeydown(event: KeyboardEvent, row: TreeRow) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(row.tagId);
    } else if (
      row.childCount > 0 &&
      ((event.key === 'ArrowRight' && !row.expanded) || (event.key === 'ArrowLeft' && row.expanded))
    ) {
      event.preventDefault();
      onToggle(row.key);
    }
  }
</script>

<div class="tree-wrap">
  <div class="tree" aria-label="Tag tree">
    {#each shown as row (row.key)}
      {@const tag = index.nodes.get(row.tagId)}
      {#if tag}
        <div
          class="row"
          class:selected={row.tagId === selectedId}
          class:over={overKey === row.key}
          style:padding-left="{8 + row.depth * 16}px"
          role="button"
          tabindex="0"
          aria-label={tag.name}
          aria-pressed={row.tagId === selectedId}
          data-row-tag={row.tagId}
          draggable={canEdit}
          onclick={() => onSelect(row.tagId)}
          onkeydown={(event) => onRowKeydown(event, row)}
          ondragstart={(event) => onDragStart(event, row)}
          ondragend={() => {
            dragId = null;
            overKey = null;
          }}
          ondragover={(event) => onDragOver(event, row.key, row.tagId)}
          ondragleave={() => (overKey = null)}
          ondrop={(event) => onDrop(event, row)}
        >
          {#if row.childCount > 0}
            <button
              type="button"
              class="toggle"
              aria-label="{row.expanded ? 'Collapse' : 'Expand'} {tag.name}"
              aria-expanded={row.expanded}
              onclick={(event) => {
                event.stopPropagation();
                onToggle(row.key);
              }}
            >
              <Icon name={row.expanded ? 'chevron-down' : 'chevron-right'} size={12} />
            </button>
          {:else}
            <span class="toggle"></span>
          {/if}
          <TagChip name={tag.name} color={tag.color} tagId={tag.tagId} />
          {#if tag.isCategory}
            <span class="badge">category</span>
          {/if}
          <span class="count" title="Files with this tag">{tag.fileCount}</span>
        </div>
      {/if}
    {:else}
      <p class="empty">No tags match.</p>
    {/each}
    {#if rows.length > limit}
      <button type="button" class="more" onclick={() => (limit += PAGE)}>
        Show more ({rows.length - limit} hidden)
      </button>
    {/if}
  </div>
  {#if dragHasParents}
    <div
      class="root-drop"
      class:over={overKey === 'root'}
      role="presentation"
      ondragover={(event) => onDragOver(event, 'root')}
      ondragleave={() => (overKey = null)}
      ondrop={onRootDrop}
    >
      Drop here to remove all parents
    </div>
  {/if}
</div>

<style lang="scss">
  @use '../../styles/variables' as *;

  .tree-wrap {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
  }

  .tree {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    padding: 4px 0 12px;
    overflow-y: auto;
  }

  .row {
    display: flex;
    flex-shrink: 0;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    padding-right: 10px;
    cursor: pointer;
    outline: none;

    &:hover,
    &:focus-visible {
      background: $color-panel-bg;
    }

    &.selected {
      background: $color-chip-bg;
      box-shadow: inset 2px 0 0 $color-jobs-accent;
    }

    &.over {
      background: rgb(242 178 74 / 20%);
    }

    :global(.tag-chip) {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      justify-content: flex-start;
    }
  }

  .toggle {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    color: $color-text-dim;
    background: transparent;
    border: 0;
    border-radius: 2px;
  }

  button.toggle {
    cursor: pointer;

    &:hover {
      color: $color-text-strong;
      background: $color-border;
    }
  }

  .badge {
    flex-shrink: 0;
    font-size: 10px;
    color: $color-text-dim;
  }

  .count {
    flex-shrink: 0;
    margin-left: auto;
    font-size: 11px;
    color: $color-text-dim;
  }

  .root-drop {
    position: absolute;
    right: 8px;
    bottom: 8px;
    left: 8px;
    padding: 12px 8px;
    background: $color-sidebar-bg;
    font-size: 11px;
    color: $color-text-dim;
    text-align: center;
    border: 1px dashed $color-border;
    border-radius: 2px;

    &.over {
      color: $color-text-strong;
      border-color: $color-jobs-accent;
    }
  }

  .empty {
    margin: 0;
    padding: 12px;
    font-size: 12px;
    color: $color-text-dim;
  }

  .more {
    flex-shrink: 0;
    margin: 8px;
    padding: 6px;
    font-family: inherit;
    font-size: 12px;
    color: $color-text-inactive;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
    cursor: pointer;
  }
</style>
