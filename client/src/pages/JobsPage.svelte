<script lang="ts">
  import Button from '../lib/Button.svelte';
  import JobCard from '../lib/JobCard.svelte';
  import Pill from '../lib/Pill.svelte';
  import {
    deleteJob,
    fetchJobs,
    fetchLibraries,
    haltJob,
    startJob,
    type JobSummary,
    type LibrarySummary,
  } from '../lib/api';
  import { jobCounters, jobLabel, jobSubtitle, jobTypeDefinition, jobTypes } from '../lib/jobs';
  import { navigate } from '../lib/router.svelte';

  let { pollMs = 2000 }: { pollMs?: number } = $props();

  let jobs = $state<JobSummary[] | null>(null);
  let jobsError = $state<string | null>(null);
  let libraries = $state<LibrarySummary[]>([]);
  let draftType = $state(jobTypes()[0]?.type ?? '');
  let draftOptions = $state<unknown | null>(null);
  let queueError = $state<string | null>(null);
  let queueing = $state(false);
  let inspectorOpen = $state(true);

  async function refreshJobs() {
    try {
      jobs = await fetchJobs();
      jobsError = null;
    } catch (e) {
      jobsError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void refreshJobs();
    const timer = setInterval(() => void refreshJobs(), pollMs);
    return () => clearInterval(timer);
  });

  $effect(() => {
    fetchLibraries()
      .then((libs) => (libraries = libs))
      .catch(() => {}); // The options form surfaces its own library-load error.
  });

  const runningCount = $derived((jobs ?? []).filter((j) => j.status === 'running').length);
  const completedCount = $derived((jobs ?? []).filter((j) => j.status === 'complete').length);

  const activeDefinition = $derived(jobTypeDefinition(draftType));

  function subtitleFor(job: JobSummary): string {
    return jobSubtitle({
      type: job.type,
      options: job.options,
      statusData: job.statusData,
      libraries,
    });
  }

  function countersFor(job: JobSummary) {
    return jobCounters({
      type: job.type,
      options: job.options,
      statusData: job.statusData,
      libraries,
    });
  }

  async function onHalt(id: string) {
    try {
      await haltJob(id);
      await refreshJobs();
    } catch (e) {
      jobsError = e instanceof Error ? e.message : String(e);
    }
  }

  async function onDelete(id: string) {
    try {
      await deleteJob(id);
      await refreshJobs();
    } catch (e) {
      jobsError = e instanceof Error ? e.message : String(e);
    }
  }

  async function queueDraft() {
    if (draftOptions === null || queueing) return;
    queueing = true;
    queueError = null;
    try {
      await startJob(draftType, draftOptions);
      draftOptions = null;
      // Switching the type resets the options form below.
      draftType = jobTypes()[0]?.type ?? '';
      await refreshJobs();
    } catch (e) {
      queueError = e instanceof Error ? e.message : String(e);
    } finally {
      queueing = false;
    }
  }

  function cancelDraft() {
    draftOptions = null;
    queueError = null;
    draftType = jobTypes()[0]?.type ?? '';
  }
</script>

<div class="jobs-layout">
  <div class="jobs-content">
    <header class="jobs-header">
      <div class="title-block">
        <h1>Queued jobs</h1>
        <p class="description">
          Monitor server work chunks, halt long-running tasks, and review completed jobs.
        </p>
      </div>
      <div class="summary">
        <Pill label="{runningCount} running" accent={runningCount > 0} />
        <Pill label="{completedCount} completed" />
        <button
          type="button"
          class="panel-toggle"
          aria-expanded={inspectorOpen}
          aria-controls="new-job-panel"
          onclick={() => (inspectorOpen = !inspectorOpen)}
        >
          {inspectorOpen ? 'Hide new job' : 'New job'}
        </button>
      </div>
    </header>

    {#if jobsError}
      <p class="error">{jobsError}</p>
    {:else if jobs === null}
      <p class="placeholder">Loading jobs…</p>
    {:else if jobs.length === 0}
      <p class="placeholder">No jobs yet. Queue a new job from the panel on the right.</p>
    {:else}
      <div class="job-list">
        {#each jobs as job (job.id)}
          <JobCard
            {job}
            title={jobLabel(job.type)}
            subtitle={subtitleFor(job)}
            counters={countersFor(job)}
            href={`/jobs/${encodeURIComponent(job.id)}`}
            onOpen={() => navigate(`/jobs/${encodeURIComponent(job.id)}`)}
            onHalt={() => void onHalt(job.id)}
            onDelete={() => void onDelete(job.id)}
          />
        {/each}
      </div>
    {/if}
  </div>

  <aside
    id="new-job-panel"
    class="inspector"
    class:closed={!inspectorOpen}
    aria-label="New job"
    aria-hidden={!inspectorOpen}
    inert={!inspectorOpen}
  >
    <header class="inspector-header">
      <p class="inspector-title">New job</p>
      <Pill label="draft" accent />
    </header>

    <label class="field">
      <span class="label">Job type</span>
      <select bind:value={draftType}>
        {#each jobTypes() as type (type.type)}
          <option value={type.type}>{type.label}</option>
        {/each}
      </select>
    </label>

    {#if activeDefinition}
      {#key draftType}
        {@const Options = activeDefinition.Options}
        <Options
          onChange={(options) => {
            // Avoid clobbering a draft the user already submitted or switched away from.
            if (!queueing) draftOptions = options;
          }}
        />
      {/key}
    {/if}

    {#if queueError}
      <p class="error">{queueError}</p>
    {/if}

    <div class="inspector-spacer"></div>
    <div class="inspector-actions">
      <Button
        label="Queue job"
        accent
        disabled={draftOptions === null || queueing}
        onclick={() => void queueDraft()}
      />
      <Button label="Cancel" onclick={cancelDraft} />
    </div>
  </aside>
</div>

<style lang="scss">
  @use '../styles/variables' as *;

  .jobs-layout {
    display: flex;
    gap: 0;
    align-items: stretch;
    min-height: 100vh;
    overflow-x: hidden;
  }

  .jobs-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 20px;
    background: $color-shell-bg;
  }

  .jobs-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .title-block h1 {
    margin: 0 0 4px;
    font-size: 20px;
    font-weight: 600;
    color: $color-jobs-accent;
  }

  .description {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .summary {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .panel-toggle {
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

    &:hover {
      color: $color-text-strong;
      background: $color-border;
    }
  }

  .job-list {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .placeholder {
    margin: 0;
    font-size: 13px;
    color: $color-text-dim;
  }

  .error {
    margin: 0;
    font-size: 12px;
    color: $color-error;
  }

  .inspector {
    display: flex;
    flex-direction: column;
    gap: 12px;
    flex-shrink: 0;
    width: 700px;
    margin-right: 0;
    padding: 20px;
    background: $color-sidebar-bg;
    min-height: 100vh;
    transition: margin-right 200ms ease;

    &.closed {
      margin-right: -700px;
      pointer-events: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .inspector {
      transition: none;
    }
  }

  .inspector-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .inspector-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: $color-text-strong;
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

  select {
    width: 100%;
    padding: 10px 12px;
    font-family: inherit;
    font-size: 13px;
    color: $color-text-strong;
    background: $color-chip-bg;
    border: 0;
    border-radius: 2px;
  }

  .inspector-spacer {
    flex: 1;
  }

  .inspector-actions {
    display: flex;
    gap: 8px;
  }
</style>
