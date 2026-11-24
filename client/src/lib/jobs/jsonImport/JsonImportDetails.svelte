<script lang="ts">
  import Pill from '../../Pill.svelte';
  import type { JobDetailsProps } from '../registry';

  interface ImportEvent {
    json: string;
    targets: string[];
  }

  interface ErrorEvent {
    path: string;
    reason: string;
  }

  interface PathStats {
    path: string;
    tagId?: number;
    tagName?: string;
    direct: boolean;
    applications: number;
    tagsCreated: number;
    misses: number;
  }

  interface MissEvent {
    json: string;
    path: string;
    reason: string;
  }

  let { job }: JobDetailsProps = $props();

  const basename = (path: string) => path.split('/').pop() ?? path;

  const imports = $derived(
    Array.isArray(job.statusData?.imports) ? (job.statusData.imports as ImportEvent[]) : [],
  );
  const errors = $derived(
    Array.isArray(job.statusData?.errors) ? (job.statusData.errors as ErrorEvent[]) : [],
  );
  const pathStats = $derived(
    Array.isArray(job.statusData?.pathStats) ? (job.statusData.pathStats as PathStats[]) : [],
  );
  const misses = $derived(
    Array.isArray(job.statusData?.misses) ? (job.statusData.misses as MissEvent[]) : [],
  );
  const missCount = $derived(pathStats.reduce((total, stats) => total + stats.misses, 0));

  function tagLabel(stats: PathStats): string {
    if (stats.direct) return 'Direct';
    return stats.tagName ?? (stats.tagId !== undefined ? `Tag #${stats.tagId}` : 'Unknown tag');
  }
</script>

{#if pathStats.length > 0}
  <section class="detail-section">
    <h2>JSON path report</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>JSON path</th>
            <th>Tag</th>
            <th>Applications</th>
            <th>Created tags</th>
            <th>Misses</th>
          </tr>
        </thead>
        <tbody>
          {#each pathStats as stats, i (i)}
            <tr>
              <td><code>{stats.path}</code></td>
              <td>{tagLabel(stats)}</td>
              <td>{stats.applications}</td>
              <td>{stats.tagsCreated}</td>
              <td>{stats.misses}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
    {#if missCount > 0}
      <details class="miss-log">
        <summary>View missed applications ({missCount})</summary>
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>JSON file</th>
                <th>JSON path</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {#each misses as miss, i (`${miss.json}:${miss.path}:${i}`)}
                <tr>
                  <td><code>{miss.json}</code></td>
                  <td><code>{miss.path}</code></td>
                  <td>{miss.reason}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        {#if missCount > misses.length}
          <p class="section-description">
            Showing the first {misses.length} of {missCount} misses.
          </p>
        {/if}
      </details>
    {/if}
  </section>
{/if}

{#if errors.length > 0}
  <section class="detail-section">
    <h2>Import errors</h2>
    <p class="section-description">
      {errors.length} sidecar {errors.length === 1 ? 'file could' : 'files could'} not be imported.
    </p>
    {#each errors as err (err.path)}
      <article class="file-card">
        <header>
          <div>
            <p class="file-name">{basename(err.path)}</p>
            <p class="file-sub">{err.reason}</p>
          </div>
          <Pill label="error" />
        </header>
        <div class="locations">
          <span class="locations-label">Path</span>
          <code>{err.path}</code>
        </div>
      </article>
    {/each}
  </section>
{/if}

{#if imports.length > 0}
  <section class="detail-section">
    <h2>Imported values</h2>
    <p class="section-description">
      Values from {imports.length}
      {imports.length === 1 ? 'sidecar were' : 'sidecars were'} applied to their data files.
    </p>
    {#each imports as imp (imp.json)}
      <article class="file-card">
        <header>
          <div>
            <p class="file-name">{basename(imp.json)}</p>
            <p class="file-sub">
              applied to {imp.targets.length}
              {imp.targets.length === 1 ? 'file' : 'files'}
            </p>
          </div>
          <Pill label="imported" accent />
        </header>
        <div class="locations">
          <span class="locations-label">Targets</span>
          {#each imp.targets as target (target)}
            <code>{target}</code>
          {/each}
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

  .table-wrap {
    overflow-x: auto;
    background: $color-panel-bg;
    border-radius: 2px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    color: $color-text-strong;
    text-align: left;
  }

  th,
  td {
    padding: 10px 12px;
    border-bottom: 1px solid $color-chip-bg;
  }

  th {
    font-size: 11px;
    font-weight: 500;
    color: $color-text-dim;
    white-space: nowrap;
  }

  tbody tr:last-child td {
    border-bottom: 0;
  }

  .miss-log {
    display: flex;
    flex-direction: column;
    gap: $space-2;
  }

  .miss-log summary {
    width: fit-content;
    font-size: 12px;
    color: $color-text-dim;
    cursor: pointer;

    &:hover {
      color: $color-text-strong;
    }
  }

  .miss-log[open] summary {
    margin-bottom: $space-2;
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
