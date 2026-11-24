<script lang="ts">
  import Button from '../Button.svelte';

  let {
    onCreate,
    onCancel,
  }: {
    /** Create the tag. Throwing keeps the modal open and shows the error; the parent
     *  should close the modal once it resolves. */
    onCreate: (alias: string, color: string) => void | Promise<void>;
    onCancel: () => void;
  } = $props();

  let alias = $state('');
  let color = $state('#2563eb');
  let creating = $state(false);
  let error = $state<string | null>(null);
  let aliasInput = $state<HTMLInputElement>();

  $effect(() => aliasInput?.focus());

  const aliasValid = $derived(alias.trim().length > 0);

  async function create() {
    if (!aliasValid || creating) return;
    creating = true;
    error = null;
    try {
      await onCreate(alias.trim(), color);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      creating = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onCancel();
    if (event.key === 'Enter') void create();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-label="Quick tag">
    <p class="modal-title">Quick tag</p>
    <p class="modal-message">Create a tag with a primary alias and a color.</p>

    <label class="field">
      <span class="label">Primary alias</span>
      <input type="text" bind:value={alias} bind:this={aliasInput} disabled={creating} />
    </label>

    <label class="field">
      <span class="label">Color</span>
      <span class="color-row">
        <input type="color" bind:value={color} disabled={creating} aria-label="Tag color" />
        <span class="color-value">{color}</span>
      </span>
    </label>

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="modal-actions">
      <Button
        label="Create tag"
        accent
        disabled={!aliasValid || creating}
        onclick={() => void create()}
      />
      <Button label="Cancel" onclick={onCancel} />
    </div>
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

  .modal {
    display: flex;
    flex-direction: column;
    gap: 12px;
    width: 360px;
    padding: 16px;
    background: $color-panel-bg;
    border: 0;
    border-radius: 2px;
  }

  .modal-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .modal-message {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .label {
    font-size: 11px;
    color: $color-text-dim;
  }

  .field input[type='text'] {
    width: 100%;
    padding: 10px 12px;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
  }

  .color-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .field input[type='color'] {
    width: 44px;
    height: 28px;
    padding: 0;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
    cursor: pointer;
  }

  .color-value {
    font-family: $font-mono;
    font-size: 12px;
    color: $color-text-dim;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }

  .modal-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }
</style>
