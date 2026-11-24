<script lang="ts">
  import { tick } from 'svelte';
  import Icon from '../Icon.svelte';
  import { autocompleteQuery, type AutocompleteResult, type Completion } from '../api';

  let {
    libraryId,
    value = $bindable(''),
    debounceMs = 300,
  }: {
    libraryId: number;
    value?: string;
    debounceMs?: number;
  } = $props();

  /** Suggestions for the current draft; null hides the dropdown. */
  let result = $state<AutocompleteResult | null>(null);
  let active = $state(0);
  /** A draft whose dropdown the user dismissed (applied or escaped) stays closed until it changes. */
  let dismissed = $state('');

  let input = $state<HTMLInputElement | null>(null);
  let list = $state<HTMLUListElement | null>(null);

  const completions = $derived(result?.completions ?? []);
  const open = $derived(completions.length > 0);

  let request = 0;

  $effect(() => {
    const lib = libraryId;
    const draft = value;
    const timer = setTimeout(() => {
      if (!draft.trim() || draft === dismissed) {
        result = null;
        return;
      }
      const id = ++request;
      autocompleteQuery(lib, draft, 10)
        .then((res) => {
          if (id !== request || value !== draft) return;
          result = res;
          active = 0;
        })
        .catch(() => {
          // Autocomplete is best-effort; keep whatever list is showing.
        });
    }, debounceMs);
    return () => clearTimeout(timer);
  });

  // Keep the active row visible while arrowing through the list.
  $effect(() => {
    const i = active;
    if (open) list?.children[i]?.scrollIntoView?.({ block: 'nearest' });
  });

  /** Replaces the current identifier (the from/to span) with the picked completion. */
  function apply(completion: Completion) {
    const res = result;
    if (!res) return;
    const next = value.slice(0, res.from) + completion.text + value.slice(res.to);
    const caret = res.from + completion.text.length;
    value = dismissed = next;
    result = null;
    void tick().then(() => {
      input?.focus();
      input?.setSelectionRange(caret, caret);
    });
  }

  function onKeydown(event: KeyboardEvent) {
    if (!open) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      active = (active + 1) % completions.length;
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      active = (active - 1 + completions.length) % completions.length;
    } else if (event.key === 'Enter') {
      event.preventDefault();
      apply(completions[active]!);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      dismissed = value;
      result = null;
    }
  }
</script>

<div class="search-input">
  <Icon name="magnifying-glass" size={14} />
  <input
    bind:this={input}
    type="text"
    placeholder="Search files, tags, or notes"
    aria-label="Search files"
    role="combobox"
    aria-autocomplete="list"
    aria-expanded={open}
    aria-controls="file-search-suggestions"
    aria-activedescendant={open ? `file-search-suggestion-${active}` : undefined}
    spellcheck="false"
    bind:value
    onkeydown={onKeydown}
    onfocus={() => (dismissed = '')}
    onblur={() => (result = null)}
  />
  {#if open}
    <ul
      bind:this={list}
      class="suggestions"
      role="listbox"
      id="file-search-suggestions"
      aria-label="Search suggestions"
    >
      {#each completions as completion, i (completion.text)}
        <li
          role="option"
          id={`file-search-suggestion-${i}`}
          aria-selected={i === active}
          class:active={i === active}
        >
          <button
            type="button"
            tabindex="-1"
            onmousemove={() => (active = i)}
            onmousedown={(event) => {
              event.preventDefault();
              apply(completion);
            }}
          >
            <span class="text">{completion.text}</span>
            {#if completion.kind === 'tag'}
              {#if completion.primary}<span class="meta">→ {completion.primary}</span>{/if}
              {#if completion.parent}<span class="meta">({completion.parent})</span>{/if}
              <span class="count">
                {completion.fileCount ?? 0}
                {completion.fileCount === 1 ? 'file' : 'files'}
              </span>
            {:else}
              <span class="meta">{completion.kind}</span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style lang="scss">
  @use '../../styles/variables' as *;

  .search-input {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 36px;
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
    z-index: 100;
    top: calc(100% + 4px);
    right: 0;
    left: 0;
    max-height: 260px;
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
      align-items: baseline;
      gap: 8px;
      width: 100%;
      padding: 6px 10px;
      font-family: inherit;
      font-size: 12px;
      color: $color-text-strong;
      text-align: left;
      background: none;
      border: 0;
      cursor: pointer;
    }

    li.active button {
      background: $color-chip-bg;
    }

    .text {
      font-weight: 600;
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
