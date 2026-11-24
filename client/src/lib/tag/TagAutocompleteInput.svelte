<script lang="ts">
  import { tick } from 'svelte';
  import Icon from '../Icon.svelte';
  import TagChip from '../TagChip.svelte';
  import { listTags, type TagSummary } from '../api';

  export interface SelectedTag {
    tagId: number;
    name: string;
    color: string | null;
  }

  let {
    libraryId,
    selected = $bindable<SelectedTag | null>(null),
    excludeTagId,
    disabled = false,
    debounceMs = 150,
    placeholder = 'Search tags',
    ariaLabel = 'Tag value',
    onSelect,
    onClear,
  }: {
    libraryId: number | null;
    selected?: SelectedTag | null;
    excludeTagId?: number;
    disabled?: boolean;
    debounceMs?: number;
    placeholder?: string;
    ariaLabel?: string;
    onSelect?: (tag: SelectedTag) => void | Promise<void>;
    onClear?: () => void;
  } = $props();

  let query = $state('');
  let suggestions = $state<TagSummary[]>([]);
  let active = $state(0);
  let dismissed = $state('');
  let input = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);

  const open = $derived(selected === null && suggestions.length > 0);

  let request = 0;

  $effect(() => {
    const lib = libraryId;
    const draft = query;
    const currentSelected = selected;
    const excluded = excludeTagId;
    const timer = setTimeout(() => {
      const trimmed = draft.trim();
      if (lib === null || currentSelected !== null || !trimmed || draft === dismissed) {
        suggestions = [];
        return;
      }
      const id = ++request;
      listTags(lib, trimmed, { limit: 10 })
        .then((res) => {
          if (id !== request || query !== draft || selected !== null) return;
          const allowed = res.tags.filter((tag) => tag.tagId !== excluded);
          const lower = trimmed.toLowerCase();
          const byName = allowed.filter((tag) => tag.name.toLowerCase().includes(lower));
          suggestions = byName.length > 0 ? byName : allowed;
          active = 0;
        })
        .catch(() => {
          // Autocomplete is best-effort; keep whatever list is showing.
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const i = active;
    if (open) list?.children[i]?.scrollIntoView?.({ block: 'nearest' });
  });

  function pick(tag: TagSummary) {
    const chosen: SelectedTag = { tagId: tag.tagId, name: tag.name, color: tag.color };
    selected = chosen;
    query = '';
    dismissed = '';
    suggestions = [];
    void onSelect?.(chosen);
  }

  function clear() {
    if (disabled) return;
    selected = null;
    query = '';
    dismissed = '';
    suggestions = [];
    onClear?.();
    void tick().then(() => input?.focus());
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = (active + 1) % suggestions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active - 1 + suggestions.length) % suggestions.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      pick(suggestions[active]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      dismissed = query;
      suggestions = [];
    }
  }
</script>

{#if selected !== null}
  <div class="selected-tag-box">
    <TagChip name={selected.name} color={selected.color} />
    <button type="button" class="clear-tag" aria-label="Clear tag" {disabled} onclick={clear}>
      <Icon name="x-mark" size={12} />
    </button>
  </div>
{:else}
  <div class="tag-autocomplete">
    <Icon name="magnifying-glass" size={14} />
    <input
      bind:this={input}
      type="text"
      {placeholder}
      aria-label={ariaLabel}
      role="combobox"
      aria-autocomplete="list"
      aria-expanded={open}
      aria-controls="tag-autocomplete-suggestions"
      aria-activedescendant={open ? `tag-autocomplete-suggestion-${active}` : undefined}
      spellcheck="false"
      {disabled}
      bind:value={query}
      onkeydown={onKeydown}
      onfocus={() => (dismissed = '')}
      onblur={() => (suggestions = [])}
    />
    {#if open}
      <ul
        bind:this={list}
        class="suggestions"
        role="listbox"
        id="tag-autocomplete-suggestions"
        aria-label="Tag suggestions"
      >
        {#each suggestions as tag, i (tag.tagId)}
          <li
            role="option"
            id={`tag-autocomplete-suggestion-${i}`}
            aria-selected={i === active}
            class:active={i === active}
          >
            <button
              type="button"
              tabindex="-1"
              onmousemove={() => (active = i)}
              onmousedown={(event) => {
                event.preventDefault();
                pick(tag);
              }}
            >
              <TagChip name={tag.name} color={tag.color} />
              {#if tag.parentName}
                <span class="meta">({tag.parentName})</span>
              {/if}
              <span class="count">
                {tag.fileCount}
                {tag.fileCount === 1 ? 'file' : 'files'}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style lang="scss">
  @use '../../styles/variables' as *;

  .selected-tag-box {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 4px 8px;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
  }

  .clear-tag {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin-left: auto;
    padding: 2px;
    color: $color-text-dim;
    background: transparent;
    border: 0;
    border-radius: 2px;
    cursor: pointer;

    &:hover:not(:disabled) {
      color: $color-text-strong;
      background: rgb(255 255 255 / 8%);
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .tag-autocomplete {
    position: relative;
    display: flex;
    flex: 1;
    align-items: center;
    gap: 8px;
    min-height: 34px;
    padding: 0 10px;
    color: $color-text-dim;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;

    input {
      flex: 1;
      min-width: 0;
      padding: 6px 0;
      font-family: inherit;
      font-size: 13px;
      color: $color-text-strong;
      background: transparent;
      border: 0;
      outline: none;

      &::placeholder {
        color: $color-text-dim;
      }
    }

    &:focus-within {
      background: $color-border;
    }
  }

  .suggestions {
    position: absolute;
    z-index: 160;
    top: calc(100% + 4px);
    right: 0;
    left: 0;
    max-height: 200px;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    list-style: none;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 50%);

    li button {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      color: $color-text-strong;
      text-align: left;
      background: none;
      border: 0;
      border-radius: 2px;
      cursor: pointer;
    }

    li.active button {
      background: $color-chip-bg;
    }

    .meta {
      color: $color-text-dim;
    }

    .count {
      margin-left: auto;
      color: $color-text-dim;
      white-space: nowrap;
    }
  }
</style>
