<script lang="ts">
  import Button from '../Button.svelte';
  import Icon from '../Icon.svelte';
  import TagChip from '../TagChip.svelte';
  import {
    addAlias,
    removeTagComponent,
    removeTagParent,
    setTagComponent,
    setTagParent,
    updateTag,
  } from '../api';
  import { DEFAULT_TAG_COLOR } from '../tagColors';
  import TagAutocompleteInput, { type SelectedTag } from '../tag/TagAutocompleteInput.svelte';
  import { edgeKey, type TagGraphIndex } from './model';

  type AddKind = 'parent' | 'child' | 'component';

  let {
    index,
    tagId,
    libraryId,
    canEdit,
    busy,
    run,
    onSelect,
    onFocus,
    onEdit,
    onDelete,
    onNewChild,
    onOpen,
  }: {
    index: TagGraphIndex;
    tagId: number;
    libraryId: number;
    canEdit: boolean;
    busy: boolean;
    /** Runs a write, shows its error, and reloads the graph. */
    run: (action: () => Promise<unknown>) => Promise<void>;
    onSelect: (tagId: number) => void;
    onFocus: (tagId: number) => void;
    onEdit: () => void;
    onDelete: () => void;
    onNewChild: () => void;
    onOpen: () => void;
  } = $props();

  const tag = $derived(index.nodes.get(tagId));
  const tagsOf = (ids: readonly number[] | undefined) =>
    (ids ?? []).flatMap((id) => {
      const item = index.nodes.get(id);
      return item ? [item] : [];
    });

  const parents = $derived(
    tagsOf(index.parents.get(tagId)).map((item) => ({
      tag: item,
      primary: index.edges.get(edgeKey(tagId, item.tagId))?.primary ?? false,
    })),
  );
  const children = $derived(tagsOf(index.children.get(tagId)));
  const components = $derived(tagsOf(index.components.get(tagId)));
  const componentOf = $derived(tagsOf(index.componentOf.get(tagId)));
  const others = $derived(
    (index.others.get(tagId) ?? []).flatMap((edge) => {
      const item = index.nodes.get(edge.tagId);
      return item ? [{ tag: item, valueCount: edge.valueCount }] : [];
    }),
  );

  let addKind = $state<AddKind>('parent');
  let picked = $state<SelectedTag | null>(null);
  let aliasDraft = $state('');

  const ADD_LABELS: Record<AddKind, string> = {
    parent: 'Parent',
    child: 'Child',
    component: 'Component',
  };

  function add(other: SelectedTag) {
    const kind = addKind;
    picked = null;
    void run(() => {
      if (kind === 'parent') return setTagParent(libraryId, tagId, other.tagId);
      if (kind === 'child') return setTagParent(libraryId, other.tagId, tagId);
      return setTagComponent(libraryId, tagId, other.tagId);
    });
  }

  function submitAlias() {
    const text = aliasDraft.trim();
    if (!text) return;
    aliasDraft = '';
    void run(() => addAlias(libraryId, tagId, text));
  }
</script>

{#snippet removeButton(label: string, action: () => Promise<unknown>)}
  {#if canEdit}
    <button
      type="button"
      class="icon-button"
      aria-label={label}
      title={label}
      disabled={busy}
      onclick={() => void run(action)}
    >
      <Icon name="x-mark" size={12} />
    </button>
  {/if}
{/snippet}

{#if tag}
  <aside class="inspector" aria-label="Tag details">
    <header>
      <div class="title">
        <TagChip name={tag.name} color={tag.color} tagId={tag.tagId} />
        {#if tag.isCategory}
          <span class="meta">category</span>
        {/if}
      </div>
      <p class="meta">
        {tag.fileCount}
        {tag.fileCount === 1 ? 'file' : 'files'}
        {#if tag.aliases.length > 0}
          · also: {tag.aliases.join(', ')}
        {/if}
      </p>
      <div class="actions">
        <Button label="Focus graph" onclick={() => onFocus(tagId)} />
        <Button label="Open page" onclick={onOpen} />
        {#if canEdit}
          <Button label="Edit…" onclick={onEdit} />
          <Button label="Delete" onclick={onDelete} />
        {/if}
      </div>
    </header>

    {#if canEdit}
      <section aria-label="Settings">
        <h3>Settings</h3>
        <div class="settings">
          <label>
            <span>Color</span>
            <input
              type="color"
              aria-label="Tag color"
              value={tag.color ?? DEFAULT_TAG_COLOR}
              disabled={busy}
              onchange={(event) => {
                const color = event.currentTarget.value;
                void run(() => updateTag(libraryId, tagId, { color }));
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={tag.isCategory}
              disabled={busy}
              onchange={(event) => {
                const isCategory = event.currentTarget.checked;
                void run(() => updateTag(libraryId, tagId, { isCategory }));
              }}
            />
            <span>Category</span>
          </label>
        </div>
        <form
          class="alias-form"
          onsubmit={(event) => {
            event.preventDefault();
            submitAlias();
          }}
        >
          <input
            type="text"
            placeholder="Add alias"
            aria-label="New alias"
            spellcheck="false"
            disabled={busy}
            bind:value={aliasDraft}
          />
          <Button label="Add" disabled={busy || aliasDraft.trim() === ''} onclick={submitAlias} />
        </form>
      </section>

      <section aria-label="Add relationship">
        <h3>Add relationship</h3>
        <div class="add-row">
          <select aria-label="Relationship kind" bind:value={addKind}>
            {#each Object.entries(ADD_LABELS) as [kind, label] (kind)}
              <option value={kind}>{label}</option>
            {/each}
          </select>
          <TagAutocompleteInput
            {libraryId}
            bind:selected={picked}
            excludeTagId={tagId}
            disabled={busy}
            placeholder="Search tags"
            ariaLabel="Tag to add as {addKind}"
            onSelect={add}
          />
        </div>
      </section>
    {/if}

    <section aria-label="Parents">
      <h3>Parents <span class="meta">{parents.length}</span></h3>
      <ul>
        {#each parents as { tag: parent, primary } (parent.tagId)}
          <li>
            <TagChip
              name={parent.name}
              color={parent.color}
              tagId={parent.tagId}
              onclick={() => onSelect(parent.tagId)}
            />
            {#if canEdit}
              <button
                type="button"
                class="text-button"
                class:on={primary}
                aria-pressed={primary}
                aria-label="Primary parent {parent.name}"
                title={primary ? 'Primary parent. Click to clear.' : 'Make this the primary parent'}
                disabled={busy}
                onclick={() =>
                  void run(() =>
                    setTagParent(libraryId, tagId, parent.tagId, { primary: !primary }),
                  )}
              >
                primary
              </button>
            {:else if primary}
              <span class="meta">primary</span>
            {/if}
            {@render removeButton(`Remove parent ${parent.name}`, () =>
              removeTagParent(libraryId, tagId, parent.tagId),
            )}
          </li>
        {:else}
          <li class="meta">No parents. This is a root tag.</li>
        {/each}
      </ul>
    </section>

    <section aria-label="Children">
      <h3>
        Children <span class="meta">{children.length}</span>
        {#if canEdit}
          <button type="button" class="text-button new-child" onclick={onNewChild}>
            New child tag
          </button>
        {/if}
      </h3>
      <ul>
        {#each children as child (child.tagId)}
          <li>
            <TagChip
              name={child.name}
              color={child.color}
              tagId={child.tagId}
              onclick={() => onSelect(child.tagId)}
            />
            {@render removeButton(`Remove child ${child.name}`, () =>
              removeTagParent(libraryId, child.tagId, tagId),
            )}
          </li>
        {:else}
          <li class="meta">No children.</li>
        {/each}
      </ul>
    </section>

    <section aria-label="Components">
      <h3>Components <span class="meta">{components.length}</span></h3>
      <ul>
        {#each components as part (part.tagId)}
          <li>
            <TagChip
              name={part.name}
              color={part.color}
              tagId={part.tagId}
              onclick={() => onSelect(part.tagId)}
            />
            {@render removeButton(`Remove component ${part.name}`, () =>
              removeTagComponent(libraryId, tagId, part.tagId),
            )}
          </li>
        {:else}
          <li class="meta">No components.</li>
        {/each}
      </ul>
    </section>

    {#if componentOf.length > 0}
      <section aria-label="Component of">
        <h3>Component of <span class="meta">{componentOf.length}</span></h3>
        <ul>
          {#each componentOf as owner (owner.tagId)}
            <li>
              <TagChip
                name={owner.name}
                color={owner.color}
                tagId={owner.tagId}
                onclick={() => onSelect(owner.tagId)}
              />
              {@render removeButton(`Remove from ${owner.name}`, () =>
                removeTagComponent(libraryId, owner.tagId, tagId),
              )}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section aria-label="Tags and values">
      <h3>Tags and values <span class="meta">{others.length}</span></h3>
      <ul>
        {#each others as { tag: other, valueCount } (other.tagId)}
          <li>
            <TagChip
              name={other.name}
              color={other.color}
              tagId={other.tagId}
              onclick={() => onSelect(other.tagId)}
            />
            <span class="meta">
              {valueCount}
              {valueCount === 1 ? 'value' : 'values'}
            </span>
          </li>
        {:else}
          <li class="meta">No other tags or values on this tag.</li>
        {/each}
      </ul>
      {#if canEdit}
        <Button label="Add or edit values…" onclick={onEdit} />
      {/if}
    </section>
  </aside>
{/if}

<style lang="scss">
  @use '../../styles/variables' as *;

  .inspector {
    display: flex;
    flex-shrink: 0;
    flex-direction: column;
    gap: 16px;
    width: 320px;
    padding: 16px;
    overflow-y: auto;
    background: $color-sidebar-bg;
  }

  header,
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .title {
    display: flex;
    align-items: center;
    gap: 8px;

    :global(.tag-chip) {
      min-height: 26px;
      padding: 0 8px;
      font-size: 14px;
    }
  }

  .meta {
    margin: 0;
    font-size: 11px;
    font-weight: 400;
    color: $color-text-dim;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: $color-text-inactive;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  ul {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;

    :global(.tag-chip) {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      justify-content: flex-start;
    }

    .icon-button {
      margin-left: auto;
    }
  }

  .icon-button,
  .text-button {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    padding: 2px 4px;
    font-family: inherit;
    font-size: 11px;
    color: $color-text-dim;
    background: transparent;
    border: 0;
    border-radius: 2px;
    cursor: pointer;

    &:hover:not(:disabled) {
      color: $color-text-strong;
      background: $color-chip-bg;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }

  .text-button.on {
    color: $color-jobs-accent;
  }

  .new-child {
    margin-left: auto;
    text-transform: none;
    letter-spacing: 0;
  }

  .settings {
    display: flex;
    align-items: center;
    gap: 16px;

    label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: $color-text-inactive;
    }

    input[type='color'] {
      width: 28px;
      height: 22px;
      padding: 0;
      background: transparent;
      border: 0;
    }
  }

  .alias-form,
  .add-row {
    display: flex;
    gap: 6px;
  }

  .alias-form input,
  .add-row select {
    min-width: 0;
    padding: 6px 10px;
    font-family: inherit;
    font-size: 12px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
  }

  .alias-form input {
    flex: 1;
  }
</style>
