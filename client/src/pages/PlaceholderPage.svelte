<script lang="ts">
  let { label }: { label: string } = $props();
</script>

<div class="placeholder">
  <h1>{label}</h1>
  <p>This tab isn't implemented yet.</p>
</div>

<style lang="scss">
  @use '../styles/variables' as *;

  .placeholder {
    display: grid;
    align-content: center;
    justify-items: center;
    gap: $space-2;
    flex: 1;
    text-align: center;
    color: $color-text-dim;
  }

  h1 {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    color: $color-text-strong;
  }

  p {
    margin: 0;
    font-size: 13px;
  }
</style>
