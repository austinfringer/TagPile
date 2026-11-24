<script lang="ts">
  let { label, accent = false }: { label: string; accent?: boolean } = $props();
</script>

<span class="pill" class:accent>{label}</span>

<style lang="scss">
  @use '../styles/variables' as *;

  .pill {
    padding: 6px 10px;
    font-size: 12px;
    font-weight: 600;
    line-height: 1.1;
    color: $color-text-inactive;
    background: $color-chip-bg;
    border: 0;
    border-radius: 999px;
    white-space: nowrap;

    &.accent {
      color: $color-jobs-accent;
    }
  }
</style>
