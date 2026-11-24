<script lang="ts">
  import type { FileSummary } from '../api';
  import { ensurePreviews, previewSource } from '../previews.svelte';

  let {
    file,
    selected = false,
    size = 'medium',
    onclick,
  }: {
    file: FileSummary;
    selected?: boolean;
    /** Tile size: scales the tile width and preview height. */
    size?: 'small' | 'medium' | 'large';
    onclick?: (event: MouseEvent) => void;
  } = $props();

  /** The preview image from the shared store, or null when the file has none; the tile then
   *  falls back to the extension placeholder. */
  const preview = $derived(previewSource(file.fileId));

  $effect(() => ensurePreviews([file.fileId]));

  /** Uppercase extension for the preview placeholder: from the record first, else the
   *  filename suffix. */
  const extension = $derived.by(() => {
    const raw = file.extension ?? /\.([^.]+)$/.exec(file.name)?.[1] ?? null;
    return raw ? raw.toUpperCase() : null;
  });
</script>

<button
  type="button"
  class="tile"
  class:selected
  class:small={size === 'small'}
  class:large={size === 'large'}
  aria-pressed={selected}
  title={file.path}
  data-context="file"
  data-file-id={file.fileId}
  data-file-name={file.name}
  onclick={(e) => onclick?.(e)}
>
  <span class="preview">
    {#if preview}
      <img src={preview} alt="" />
    {:else if extension}
      <span class="extension">{extension}</span>
    {/if}
  </span>
  <span class="name">{file.name}</span>
</button>

<style lang="scss">
  @use '../../styles/variables' as *;

  .tile {
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    width: 150px;
    padding: 0;
    overflow: hidden;
    font-family: inherit;
    background: $color-chip-bg;
    border: 2px solid transparent;
    border-radius: 2px;
    cursor: pointer;

    &.selected {
      border-color: $color-jobs-accent;
    }

    &.small {
      width: 110px;
    }

    &.large {
      width: 220px;
    }
  }

  .preview {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    aspect-ratio: 1 / 1;
    background: $color-panel-bg;
  }

  .preview img {
    width: 100%;
    height: 100%;
    object-fit: contain;
  }

  .extension {
    font-size: 16px;
    font-weight: 600;
    color: $color-text-dim;
  }

  .name {
    display: block;
    width: 100%;
    padding: 3px;
    overflow: hidden;
    font-size: 10px;
    font-weight: 600;
    line-height: 1;
    color: $color-text-strong;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
