<script lang="ts">
  import Button from '../lib/Button.svelte';
  import Pill from '../lib/Pill.svelte';
  import {
    deleteJob,
    fetchJob,
    fetchLibraries,
    haltJob,
    type JobSummary,
    type LibrarySummary,
  } from '../lib/api';
  import {
    isActiveJob,
    jobCounters,
    jobLabel,
    jobMessage,
    jobSubtitle,
    jobTypeDefinition,
    statusLabel,
  } from '../lib/jobs';
  import { goBack, navigate } from '../lib/router.svelte';

  let { id, pollMs = 2000 }: { id: string; pollMs?: number } = $props();

  let job = $state<JobSummary | null>(null);
  let loadError = $state<string | null>(null);
  let libraries = $state<LibrarySummary[]>([]);

  async function refresh() {
    try {
      job = await fetchJob(id);
      loadError = null;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void refresh();
  });

  // Poll while the job is still active so the detail page tracks live counters.
  $effect(() => {
    if (job && !isActiveJob(job)) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  });

  $effect(() => {
    fetchLibraries()
      .then((libs) => (libraries = libs))
      .catch(() => {});
  });

  const definition = $derived(job ? jobTypeDefinition(job.type) : undefined);

  async function onHalt() {
    await haltJob(id);
    await refresh();
  }

  async function onDelete() {
    await deleteJob(id);
    navigate('/jobs');
  }
</script>

<div class="detail">
  <nav class="breadcrumb">
    <button type="button" onclick={() => goBack('/jobs')}>← Back</button>
  </nav>

  {#if loadError}
    <p class="error">{loadError}</p>
  {:else if job === null}
    <p class="placeholder">Loading job…</p>
  {:else}
    <div class="job-summary">
      <header>
        <div class="title-block">
          <h1>{jobLabel(job.type)}</h1>
          <p class="subtitle">
            {jobSubtitle({
              type: job.type,
              options: job.options,
              statusData: job.statusData,
              libraries,
            })}
          </p>
        </div>
        <div class="actions">
          <Pill label={statusLabel(job.status)} accent={isActiveJob(job)} />
          {#if job.canManage}
            {#if isActiveJob(job)}
              <Button label="Halt" onclick={() => void onHalt()} />
            {/if}
            <Button label="Delete" onclick={() => void onDelete()} />
          {/if}
        </div>
      </header>
      <p class="message">Message: {jobMessage(job)}</p>
      <div class="counters">
        {#each jobCounters( { type: job.type, options: job.options, statusData: job.statusData, libraries } ) as counter (counter.label)}
          <div class="counter">
            <p class="counter-label">{counter.label}</p>
            <p class="counter-value">
              {typeof counter.value === 'number' ? counter.value.toLocaleString() : counter.value}
            </p>
          </div>
        {/each}
      </div>
    </div>

    {#if definition?.Details}
      {@const Details = definition.Details}
      <Details {job} {libraries} />
    {/if}
  {/if}
</div>

<style lang="scss">
  @use '../styles/variables' as *;

  .detail {
    display: flex;
    flex-direction: column;
    gap: 18px;
    padding: 20px;
    background: $color-shell-bg;
    min-height: 100vh;
  }

  .breadcrumb button {
    padding: 0;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-dim;
    background: none;
    border: 0;
    cursor: pointer;

    &:hover {
      color: $color-text-strong;
    }
  }

  .job-summary {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .subtitle {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .actions {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }

  .message {
    margin: 0;
    font-size: 13px;
    color: $color-text-dim;
  }

  .counters {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
    gap: 12px;
  }

  .counter {
    padding: 12px;
    background: $color-panel-bg;
    border-radius: 2px;
  }

  .counter-label {
    margin: 0 0 4px;
    font-size: 11px;
    color: $color-text-dim;
  }

  .counter-value {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .placeholder,
  .error {
    margin: 0;
    font-size: 13px;
  }

  .placeholder {
    color: $color-text-dim;
  }

  .error {
    color: $color-error;
  }
</style>
