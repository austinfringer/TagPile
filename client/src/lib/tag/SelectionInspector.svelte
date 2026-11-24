<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import TagChip from '../TagChip.svelte';
  import StackViewerModal from './StackViewerModal.svelte';
  import { ensurePreviews, previewSource } from '../previews.svelte';
  import { tagStore } from '../tagStore.svelte';
  import { tagColorSpec, DEFAULT_TAG_COLOR } from '../tagColors';
  import type { FileSummary, FileValue, QueriedFile, TagSummary } from '../api';

  let {
    detail,
    selection,
    filesById,
    tagInfo = tagStore(),
  }: {
    /** The most recently selected file, with locations and instances. */
    detail: QueriedFile | null;
    /** Selected file ids in selection order. */
    selection: number[];
    filesById: ReadonlyMap<number, FileSummary>;
    tagInfo?: ReadonlyMap<number, TagSummary>;
  } = $props();

  const UNCATEGORIZED = 'Uncategorized';

  interface InspectorGroup {
    name: string;
    valued: InstanceView[];
    plain: InstanceView[];
  }

  interface InstanceView {
    tagId: number;
    name: string;
    color: string | null;
    values: FileValue[];
  }

  /** Instances of the active file grouped by their tag's category, in library-vocabulary
   *  order they arrive in. Tags with values render as full rows first; tags without
   *  values wrap in a grid below them. */
  const groups = $derived.by((): InspectorGroup[] => {
    const byCategory = new SvelteMap<string, { valued: InstanceView[]; plain: InstanceView[] }>();
    const tagsByName = new SvelteMap<string, TagSummary>();
    for (const t of tagInfo.values()) {
      tagsByName.set(t.name, t);
    }
    for (const inst of detail?.instances ?? []) {
      const info = tagInfo.get(inst.tagId);
      const instName = inst.name ?? info?.name ?? `#${inst.tagId}`;
      if (info?.isCategory) {
        if (!byCategory.has(instName)) byCategory.set(instName, { valued: [], plain: [] });
        continue;
      }
      const parentName = info?.parentName ?? null;
      const parent = parentName ? tagsByName.get(parentName) : undefined;
      const key =
        parentName && (parent === undefined || parent.isCategory) ? parentName : UNCATEGORIZED;
      const bucket = byCategory.get(key) ?? { valued: [], plain: [] };
      const view: InstanceView = {
        tagId: inst.tagId,
        name: instName,
        color: info?.color ?? null,
        values: inst.values,
      };
      (inst.values.length > 0 ? bucket.valued : bucket.plain).push(view);
      byCategory.set(key, bucket);
    }
    const named = [...byCategory.entries()]
      .filter(([name]) => name !== UNCATEGORIZED)
      .map(([name, bucket]) => ({ name, ...bucket }));
    const uncategorized = byCategory.get(UNCATEGORIZED);
    if (uncategorized) named.push({ name: UNCATEGORIZED, ...uncategorized });
    return named;
  });

  /** The deck shows the last files selected, most recent on top, fanned to the top-left.
   *  Clicking it opens the full-screen stack viewer. */
  const deckFiles = $derived(selection.slice(-3));

  let viewerOpen = $state(false);

  /** Preview images for the deck cards; a file with no preview keeps its extension
   *  placeholder. */
  $effect(() => ensurePreviews(deckFiles));
  const deckSources = $derived(deckFiles.map((fileId) => previewSource(fileId)));

  function deckOffset(indexFromFront: number): { left: string; top: string } {
    return { left: `${indexFromFront * 6}px`, top: `${12 - indexFromFront * 6}px` };
  }

  function extOf(file: FileSummary | undefined, fileId: number): string {
    const name = file?.name ?? `#${fileId}`;
    const raw = file?.extension ?? /\.([^.]+)$/.exec(name)?.[1] ?? null;
    return raw ? raw.toUpperCase() : 'FILE';
  }

  function formatBytes(size: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    const rounded = unit === 0 ? value : value >= 10 ? Math.round(value) : value.toFixed(1);
    return `${rounded} ${units[unit]}`;
  }

  function formatDate(ms: number | null | undefined): string {
    return ms === null || ms === undefined ? '—' : new Date(ms).toISOString().slice(0, 10);
  }

  function formatTime(seconds: number): string {
    const whole = Math.round(seconds);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
    return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
  }

  function valueText(value: FileValue): string {
    if (value.kind === 'text') return value.text;
    if (value.kind === 'number') return String(value.number);
    if (value.kind !== 'anchor') return '';
    const parts: string[] = [];
    if (value.tStart !== null || value.tEnd !== null) {
      const start = value.tStart === null ? '' : formatTime(value.tStart);
      const end = value.tEnd === null ? '' : formatTime(value.tEnd);
      parts.push(value.tEnd === null ? start || end : `${start}–${end}`);
    }
    if (value.rx !== null || value.ry !== null || value.rw !== null || value.rh !== null) {
      const region = [value.rx, value.ry, value.rw, value.rh]
        .map((v) => (v === null ? '-' : v.toFixed(2)))
        .join(', ');
      parts.push(`region (${region})`);
    }
    return parts.join(' ') || 'anchor';
  }

  function tagChipsOf(values: FileValue[]): { valueId: number; tagId: number }[] {
    return values.flatMap((v) =>
      v.kind === 'tag' ? [{ valueId: v.valueId, tagId: v.refTagId }] : [],
    );
  }

  function textValuesOf(values: FileValue[]): FileValue[] {
    return values.filter((v) => v.kind !== 'tag');
  }

  function specOf(color: string | null): string {
    const spec = tagColorSpec(color ?? DEFAULT_TAG_COLOR);
    return `background-color: ${spec.fill}; border-color: ${spec.border}; color: ${spec.text};`;
  }

  const location = $derived(detail?.locations?.[0] ?? null);
</script>

<aside class="inspector">
  {#if selection.length === 0}
    <p class="placeholder">Select files in the grid to see their tags and metadata.</p>
  {:else}
    <div class="deck">
      <button
        type="button"
        class="deck-stack"
        aria-label="View selection stack"
        onclick={() => (viewerOpen = true)}
      >
        {#each deckFiles as fileId, i (fileId)}
          {@const fromFront = deckFiles.length - 1 - i}
          {@const offset = deckOffset(fromFront)}
          <div class="deck-preview" style:left={offset.left} style:top={offset.top}>
            {#if deckSources[i]}
              <img src={deckSources[i]} alt="" />
            {:else}
              <span class="deck-extension">{extOf(filesById.get(fileId), fileId)}</span>
            {/if}
          </div>
        {/each}
        <span class="deck-badge {selection.length <= 1 ? 'hidden' : ''}"
          >{selection.length} files selected</span
        >
      </button>
    </div>

    {#if viewerOpen}
      <StackViewerModal {selection} {filesById} onClose={() => (viewerOpen = false)} />
    {/if}

    {#if detail}
      <div class="inspector-list">
        <div class="metadata">
          <div class="metadata-row">
            <span class="meta-label">File Name</span>
            <span class="meta-value">{detail.name}</span>
          </div>
          <div class="metadata-row">
            <span class="meta-label">File Type</span>
            <span class="meta-value">{(detail.extension ?? detail.type ?? '—').toUpperCase()}</span>
          </div>
          <div class="metadata-row">
            <span class="meta-label">File Size</span>
            <span class="meta-value">{formatBytes(detail.size)}</span>
          </div>
          <div class="metadata-row">
            <span class="meta-label">Creation Date</span>
            <span class="meta-value">{formatDate(location?.created_at)}</span>
          </div>
          <div class="metadata-row">
            <span class="meta-label">Modification Date</span>
            <span class="meta-value">{formatDate(location?.modified_at)}</span>
          </div>
          <div class="metadata-row">
            <span class="meta-label">Selections</span>
            <span class="meta-value"
              >{selection.length} {selection.length === 1 ? 'file' : 'files'}</span
            >
          </div>
        </div>

        {#each groups as group (group.name)}
          <section class="category">
            <h2>{group.name}</h2>
            {#each group.valued as inst (inst.tagId)}
              {@const chips = tagChipsOf(inst.values)}
              <div
                class="tag-value"
                style={specOf(inst.color)}
                data-context="tag"
                data-tag-id={inst.tagId}
                data-tag-name={inst.name}
                data-attached-file={detail.fileId}
              >
                <span class="tag-value-name">{inst.name}</span>
                <span class="tag-value-values">
                  {#each textValuesOf(inst.values) as value (value.valueId)}
                    <p>{valueText(value)}</p>
                  {/each}
                  {#if chips.length > 0}
                    <span class="tag-value-chips">
                      {#each chips as chip (chip.valueId)}
                        {@const info = tagInfo.get(chip.tagId)}
                        <TagChip
                          name={info?.name ?? `#${chip.tagId}`}
                          color={info?.color ?? null}
                          tagId={chip.tagId}
                          attachedFileId={detail.fileId}
                        />
                      {/each}
                    </span>
                  {/if}
                </span>
              </div>
            {/each}
            {#if group.plain.length > 0}
              <div class="category-tags">
                {#each group.plain as inst (inst.tagId)}
                  <TagChip
                    name={inst.name}
                    color={inst.color}
                    tagId={inst.tagId}
                    attachedFileId={detail.fileId}
                  />
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {/if}
  {/if}
</aside>

<style lang="scss">
  @use '../../styles/variables' as *;

  .inspector {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex-shrink: 0;
    width: 350px;
    height: 100%;
    padding: 12px;
    background: $color-sidebar-bg;
  }

  .placeholder {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .deck-stack {
    position: relative;
    width: 100%;
    aspect-ratio: 1 / 1;
    padding: 0;
    background: transparent;
    border: 0;
    cursor: pointer;
  }

  .hidden {
    display: none;
  }

  .deck-preview {
    position: absolute;
    display: flex;
    align-items: center;
    justify-content: center;
    width: calc(100% - 12px);
    aspect-ratio: 1 / 1;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
    box-shadow: 0 2px 8px rgb(0 0 0 / 35%);

    img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
  }

  .deck-extension {
    font-size: 20px;
    font-weight: 600;
    color: $color-text-dim;
  }

  .deck-badge {
    position: absolute;
    right: 0;
    bottom: 0;
    padding: 4px 8px;
    font-size: 11px;
    font-weight: 600;
    color: $color-jobs-accent;
    white-space: nowrap;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
  }

  .inspector-list {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 10px;
    overflow-y: auto;
  }

  .metadata {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .metadata-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
  }

  .meta-label {
    font-weight: 500;
    color: $color-text-dim;
  }

  .meta-value {
    font-weight: 600;
    color: $color-text-strong;
    text-align: right;
    overflow-wrap: break-word;
  }

  .category {
    h2 {
      margin: 0 0 5px;
      font-size: 12px;
      font-weight: 600;
      color: white;
    }
  }

  .category-tags {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    align-items: center;
  }

  .tag-value {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 20px;
    padding: 4px;
    margin-bottom: 5px;
    border: 1px solid transparent;
    border-radius: 2px;
  }

  .tag-value-name {
    flex-shrink: 0;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }

  .tag-value-values {
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
    gap: 5px;
    font-size: 10px;
    font-weight: 500;

    p {
      margin: 0;
      overflow-wrap: break-word;
    }
  }

  .tag-value-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    align-items: center;
  }
</style>
