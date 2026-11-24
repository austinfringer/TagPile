<script lang="ts">
  import { untrack } from 'svelte';
  import { fileContentUrl, type FileSummary } from '../api';
  import Icon from '../Icon.svelte';

  let {
    selection,
    filesById,
    startIndex = undefined,
    onClose,
  }: {
    /** Selected file ids in selection order. */
    selection: number[];
    filesById: ReadonlyMap<number, FileSummary>;
    /** Index in `selection` to open on; defaults to the most recently selected file. */
    startIndex?: number;
    onClose: () => void;
  } = $props();

  // The modal opens on the given (or most recent) entry; later selection changes do not
  // move the viewer, only the clamp below keeps the index in range.
  let index = $state(untrack(() => startIndex ?? selection.length - 1));

  /** The selection can change under the modal (e.g. a library switch clears it); clamp the
   *  index so the viewer never points past the end. */
  const clamped = $derived(Math.min(index, selection.length - 1));
  const fileId = $derived(selection[clamped] as number | undefined);
  const file = $derived(fileId === undefined ? undefined : filesById.get(fileId));

  /** Only image files get a full-content request; everything else keeps its extension
   *  placeholder. */
  const isImage = $derived(file?.type === 'image');

  const extension = $derived.by(() => {
    const name = file?.name ?? (fileId === undefined ? '' : `#${fileId}`);
    const raw = file?.extension ?? /\.([^.]+)$/.exec(name)?.[1] ?? null;
    return raw ? raw.toUpperCase() : 'FILE';
  });

  function step(delta: number) {
    if (selection.length === 0) return;
    index = (clamped + delta + selection.length) % selection.length;
  }

  function onOverlayClick(event: MouseEvent) {
    //Only a click on the backdrop itself closes the viewer, not clicks inside the content.
    if (event.target === event.currentTarget) onClose();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onClose();
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation" onclick={onOverlayClick}>
  <div class="viewer" role="dialog" aria-modal="true" aria-label="Selected files">
    <button type="button" class="arrow" aria-label="Previous file" onclick={() => step(-1)}>
      <Icon name="chevron-left" size={24} />
    </button>

    <div class="stage">
      {#if fileId === undefined}
        <span class="placeholder-ext">No files selected</span>
      {:else if isImage}
        <img class="full" src={fileContentUrl(fileId)} alt={file?.name ?? ''} />
      {:else}
        <span class="placeholder-ext">{extension}</span>
      {/if}
      <p class="caption">
        <span class="name">{file?.name ?? `#${fileId}`}</span>
        <span class="index">{clamped + 1} of {selection.length}</span>
      </p>
    </div>

    <button type="button" class="arrow" aria-label="Next file" onclick={() => step(1)}>
      <Icon name="chevron-right" size={24} />
    </button>
  </div>
</div>

<style lang="scss">
  @use '../../styles/variables' as *;

  .overlay {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgb(0 0 0 / 60%);
  }

  .viewer {
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 90vw;
    max-height: 90vh;
  }

  .stage {
    display: flex;
    flex-direction: column;
    gap: 8px;
    align-items: center;
    min-width: 0;
  }

  .full {
    max-width: 80vw;
    max-height: 76vh;
    object-fit: contain;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
  }

  .placeholder-ext {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40vw;
    height: 40vh;
    font-size: 24px;
    font-weight: 600;
    color: $color-text-dim;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
  }

  .caption {
    display: flex;
    gap: 12px;
    align-items: center;
    margin: 0;
    font-size: 12px;
    color: $color-text-strong;

    .name {
      max-width: 50vw;
      overflow: hidden;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .index {
      color: $color-text-dim;
      white-space: nowrap;
    }
  }

  .arrow {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
    cursor: pointer;

    &:hover {
      background: $color-border;
    }
  }
</style>
