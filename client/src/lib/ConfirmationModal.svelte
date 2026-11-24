<script lang="ts">
  import Button from './Button.svelte';

  /** Guards a destructive action behind a small challenge: the user has to type the
   *  5 random digits shown before the action runs. Reusable for any action that
   *  deserves more than a single click. */
  let {
    title,
    message,
    confirmLabel = 'Confirm',
    onConfirm,
    onCancel,
  }: {
    title: string;
    message: string;
    confirmLabel?: string;
    /** Run the guarded action. Throwing keeps the modal open and shows the error;
     *  the parent should close the modal once it resolves. */
    onConfirm: () => void | Promise<void>;
    onCancel: () => void;
  } = $props();

  const digits = String(Math.floor(10000 + Math.random() * 90000));

  let entry = $state('');
  let confirming = $state(false);
  let error = $state<string | null>(null);
  let input = $state<HTMLInputElement>();

  $effect(() => input?.focus());

  const entryValid = $derived(entry === digits);

  async function confirm() {
    if (!entryValid || confirming) return;
    confirming = true;
    error = null;
    try {
      await onConfirm();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      confirming = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') onCancel();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="overlay" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-label={title}>
    <p class="modal-title">{title}</p>
    <p class="modal-message">{message}</p>

    <p class="challenge">Type <span class="digits">{digits}</span> to confirm</p>

    <input
      type="text"
      inputmode="numeric"
      aria-label="Confirmation digits"
      bind:value={entry}
      bind:this={input}
      disabled={confirming}
    />

    {#if error}
      <p class="error">{error}</p>
    {/if}

    <div class="modal-actions">
      <Button
        label={confirmLabel}
        accent
        disabled={!entryValid || confirming}
        onclick={() => void confirm()}
      />
      <Button label="Cancel" onclick={onCancel} />
    </div>
  </div>
</div>

<style lang="scss">
  @use '../styles/variables' as *;

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

  .challenge {
    margin: 0;
    font-size: 13px;
    color: $color-text-inactive;
  }

  .digits {
    font-family: $font-mono;
    font-weight: 600;
    letter-spacing: 2px;
    color: $color-jobs-accent;
  }

  input {
    width: 100%;
    padding: 10px 12px;
    font-family: $font-mono;
    font-size: 16px;
    letter-spacing: 2px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
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
