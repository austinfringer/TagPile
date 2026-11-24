<script lang="ts">
  import { tagColorSpec } from './tagColors';

  let {
    name,
    color = null,
    onclick,
    disabled = false,
    tagId,
    attachedFileId,
  }: {
    name: string;
    color?: string | null;
    onclick?: () => void;
    disabled?: boolean;
    /** Marks the chip as a context-menu target for this tag. Omit to opt out. */
    tagId?: number;
    /** Set when the tag is attached to a file (inspector, file page): the context menu
     *  gains Add Value / Edit Relationship for this file. */
    attachedFileId?: number | null;
  } = $props();

  const spec = $derived(tagColorSpec(color));
</script>

{#if onclick}
  <button
    type="button"
    class="tag-chip"
    style:background-color={spec.fill}
    style:border-color={spec.border}
    style:color={spec.text}
    title={name}
    data-context={tagId === undefined ? undefined : 'tag'}
    data-tag-id={tagId}
    data-tag-name={tagId === undefined ? undefined : name}
    data-attached-file={attachedFileId ?? undefined}
    {disabled}
    {onclick}
  >
    {name}
  </button>
{:else}
  <span
    class="tag-chip"
    style:background-color={spec.fill}
    style:border-color={spec.border}
    style:color={spec.text}
    title={name}
    data-context={tagId === undefined ? undefined : 'tag'}
    data-tag-id={tagId}
    data-tag-name={tagId === undefined ? undefined : name}
    data-attached-file={attachedFileId ?? undefined}
  >
    {name}
  </span>
{/if}

<style lang="scss">
  .tag-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 20px;
    padding: 0 4px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;
    border: 1px solid transparent;
    border-radius: 2px;
  }

  button.tag-chip {
    cursor: pointer;

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  }
</style>
