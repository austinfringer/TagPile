<script lang="ts">
  let {
    label,
    accent = false,
    disabled = false,
    onclick,
  }: {
    label: string;
    accent?: boolean;
    disabled?: boolean;
    onclick?: (event: MouseEvent) => void;
  } = $props();
</script>

<button type="button" class:accent {disabled} {onclick}>{label}</button>

<style lang="scss">
  @use '../styles/variables' as *;

  button {
    padding: 8px 12px;
    font-family: inherit;
    font-size: 12px;
    font-weight: 600;
    color: $color-text-inactive;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
    white-space: nowrap;
    cursor: pointer;

    &:hover:not(:disabled) {
      color: $color-text-strong;
      background: $color-border;
    }

    &:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    &.accent {
      color: $color-jobs-accent;
    }
  }
</style>
