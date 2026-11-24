<script lang="ts">
  import { ICON_PATHS, type IconName } from './icons';

  let { name, size = 18 }: { name: IconName; size?: number } = $props();
</script>

<svg
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="1.5"
  aria-hidden="true"
>
  {#each ICON_PATHS[name] as d (d)}
    <path {d} stroke-linecap="round" stroke-linejoin="round" />
  {/each}
</svg>
