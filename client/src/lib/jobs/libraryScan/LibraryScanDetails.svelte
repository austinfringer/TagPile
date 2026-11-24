<script lang="ts">
  import Pill from '../../Pill.svelte';
  import type { JobDetailsProps } from '../registry';

  interface DuplicateGroup {
    path: string;
    siblings: string[];
  }

  let { job }: JobDetailsProps = $props();

  const basename = (path: string) => path.split('/').pop() ?? path;

  const duplicates = $derived(
    Array.isArray(job.statusData?.duplicates)
      ? (job.statusData.duplicates as DuplicateGroup[])
      : [],
  );
  const migrated = $derived(
    Array.isArray(job.statusData?.migrated) ? (job.statusData.migrated as { path: string }[]) : [],
  );
</script>

{#if duplicates.length > 0}
  <section class="detail-section">
    <h2>Duplicate files</h2>
    <p class="section-description">
      {duplicates.length} duplicate {duplicates.length === 1 ? 'file was' : 'files were'} detected during
      the scan.
    </p>
    {#each duplicates as dup (dup.path)}
      <article class="file-card">
        <header>
          <div>
            <p class="file-name">{basename(dup.path)}</p>
            <p class="file-sub">{dup.siblings.length + 1} locations</p>
          </div>
          <Pill label="duplicate" accent />
        </header>
        <div class="locations">
          <span class="locations-label">Locations</span>
          <code>{dup.path}</code>
          {#each dup.siblings as sibling (sibling)}
            <code>{sibling}</code>
          {/each}
        </div>
      </article>
    {/each}
  </section>
{/if}

{#if migrated.length > 0}
  <section class="detail-section">
    <h2>Migrated files</h2>
    <p class="section-description">
      {migrated.length}
      {migrated.length === 1 ? 'file' : 'files'} had their content change during the scan; this library's
      tags were carried over to the new content.
    </p>
    {#each migrated as mig (mig.path)}
      <article class="file-card">
        <header>
          <div>
            <p class="file-name">{basename(mig.path)}</p>
            <p class="file-sub">Content changed; tags carried over</p>
          </div>
          <Pill label="migrated" />
        </header>
        <div class="locations">
          <span class="locations-label">Path</span>
          <code>{mig.path}</code>
        </div>
      </article>
    {/each}
  </section>
{/if}

<style lang="scss">
  @use '../../../styles/variables' as *;

  .detail-section {
    display: flex;
    flex-direction: column;
    gap: $space-2;
  }

  h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .section-description {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .file-card {
    display: flex;
    flex-direction: column;
    gap: $space-2;
    border-radius: 2px;
    padding: 12px;
    background: $color-panel-bg;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: $space-2;
  }

  .file-name {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .file-sub {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .locations {
    display: flex;
    flex-direction: column;
    gap: $space-1;
  }

  .locations-label {
    font-size: 11px;
    color: $color-text-dim;
  }

  code {
    font-size: 12px;
    color: $color-text-dim;
    word-break: break-all;
  }
</style>
