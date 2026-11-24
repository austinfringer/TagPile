<script lang="ts">
  import { fetchHealth, type HealthResponse } from './api';

  let health = $state<HealthResponse | null>(null);
  let error = $state<string | null>(null);

  $effect(() => {
    fetchHealth()
      .then((h) => (health = h))
      .catch((e: unknown) => (error = e instanceof Error ? e.message : String(e)));
  });
</script>

<p class="status" class:ok={health} class:error>
  {#if health}
    Server online{health.version ? ` (v${health.version})` : ''}
  {:else if error}
    Server unreachable: {error}
  {:else}
    Checking server...
  {/if}
</p>

<style lang="scss">
  @use '../styles/variables' as *;

  .status {
    font-family: $font-mono;
    color: $color-muted;

    &.ok {
      color: $color-ok;
    }

    &.error {
      color: $color-error;
    }
  }
</style>
