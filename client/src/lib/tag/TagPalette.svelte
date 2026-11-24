<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity';
  import Icon from '../Icon.svelte';
  import TagChip from '../TagChip.svelte';
  import type { TagSummary } from '../api';

  interface TagGroup {
    name: string;
    tagId?: number;
    tags: TagSummary[];
  }

  let {
    tags,
    query,
    canCreate,
    onSearch,
    onTagClick,
    onQuickTag,
  }: {
    tags: TagSummary[] | null;
    query: string;
    canCreate: boolean;
    onSearch: (query: string) => void;
    onTagClick: (tag: TagSummary) => void;
    onQuickTag: () => void;
  } = $props();

  const UNCATEGORIZED = 'Uncategorized';

  /** Matching tags grouped under the name of their category parent. Category tags show
   *  up as group headings, not as chips, and group their children under them. Uncategorized
   *  tags go in a group at the bottom. */
  const groups = $derived.by((): TagGroup[] => {
    const byCategory = new SvelteMap<string, TagSummary[]>();
    const categoryTagsByName = new SvelteMap<string, TagSummary>();
    const allTagsByName = new SvelteMap<string, TagSummary>();
    for (const tag of tags ?? []) {
      allTagsByName.set(tag.name, tag);
      if (tag.isCategory) {
        categoryTagsByName.set(tag.name, tag);
        if (!byCategory.has(tag.name)) byCategory.set(tag.name, []);
      }
    }
    for (const tag of tags ?? []) {
      if (tag.isCategory) continue;
      const parent = tag.parentName ? allTagsByName.get(tag.parentName) : undefined;
      const key =
        tag.parentName && (parent === undefined || parent.isCategory)
          ? tag.parentName
          : UNCATEGORIZED;
      const list = byCategory.get(key) ?? [];
      list.push(tag);
      byCategory.set(key, list);
    }
    const named: TagGroup[] = [...byCategory.entries()]
      .filter(([name]) => name !== UNCATEGORIZED)
      .map(([name, list]) => ({
        name,
        tagId: categoryTagsByName.get(name)?.tagId,
        tags: list,
      }));
    const uncategorized = byCategory.get(UNCATEGORIZED);
    if (uncategorized) named.push({ name: UNCATEGORIZED, tags: uncategorized });
    return named;
  });
</script>

<aside class="palette">
  <div class="tag-search">
    <Icon name="magnifying-glass" size={14} />
    <input
      type="text"
      placeholder="Search tags"
      aria-label="Search tags"
      value={query}
      oninput={(event) => onSearch(event.currentTarget.value)}
    />
  </div>

  <div class="tag-list">
    {#if tags !== null && groups.length === 0}
      <p class="empty">No tags match.</p>
    {:else}
      {#each groups as group (group.name)}
        <section class="category">
          <h2
            data-context={group.tagId !== undefined ? 'tag' : undefined}
            data-tag-id={group.tagId}
            data-tag-name={group.tagId !== undefined ? group.name : undefined}
          >
            {group.name}
          </h2>
          <div class="category-tags">
            {#each group.tags as tag (tag.tagId)}
              <TagChip
                name={tag.name}
                color={tag.color}
                tagId={tag.tagId}
                onclick={() => onTagClick(tag)}
              />
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>

  <button
    type="button"
    class="quick-tag"
    disabled={!canCreate}
    title={canCreate ? undefined : 'Your role cannot create tags'}
    onclick={onQuickTag}
  >
    Quick tag
  </button>
</aside>

<style lang="scss">
  @use '../../styles/variables' as *;

  .palette {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex-shrink: 0;
    width: 200px;
    height: 100%;
    padding: 12px;
    background: $color-sidebar-bg;
  }

  .tag-search {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 32px;
    padding: 0 10px;
    color: $color-text-dim;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;

    input {
      flex: 1;
      min-width: 0;
      padding: 0;
      font-family: inherit;
      font-size: 12px;
      color: $color-text-strong;
      background: transparent;
      border: 0;
      outline: none;

      &::placeholder {
        color: $color-text-dim;
      }
    }
  }

  .tag-list {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    gap: 12px;
    padding: 4px;
    overflow-y: auto;
  }

  .empty {
    margin: 0;
    padding: 4px;
    font-size: 12px;
    color: $color-text-dim;
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

  .quick-tag {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 32px;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 12px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
    cursor: pointer;

    &:hover:not(:disabled) {
      background: $color-border;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
</style>
