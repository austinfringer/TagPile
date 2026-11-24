<script lang="ts">
  import Button from './Button.svelte';
  import Pill from './Pill.svelte';
  import type { JobSummary } from './api';
  import { isActiveJob, jobMessage, statusLabel, type JobCounter } from './jobs/present';

  let {
    job,
    title,
    subtitle,
    counters,
    href,
    onOpen,
    onHalt,
    onDelete,
  }: {
    job: JobSummary;
    title: string;
    subtitle: string;
    counters: JobCounter[];
    href: string;
    onOpen: () => void;
    onHalt: () => void;
    onDelete: () => void;
  } = $props();
</script>

<article class="job-card">
  <header>
    <div class="title-block">
      <a
        class="open-link"
        {href}
        onclick={(event) => {
          event.preventDefault();
          onOpen();
        }}>{title}</a
      >
      {#if subtitle}
        <p class="subtitle">{subtitle}</p>
      {/if}
    </div>
    <div class="actions">
      <Pill label={statusLabel(job.status)} accent={isActiveJob(job)} />
      {#if job.canManage}
        {#if isActiveJob(job)}
          <Button label="Halt" onclick={onHalt} />
        {/if}
        <Button label="Delete" onclick={onDelete} />
      {/if}
    </div>
  </header>
  <p class="message">Message: {jobMessage(job)}</p>
  <div class="counters">
    {#each counters as counter (counter.label)}
      <div class="counter">
        <p class="counter-label">{counter.label}</p>
        <p class="counter-value">
          {typeof counter.value === 'number' ? counter.value.toLocaleString() : counter.value}
        </p>
      </div>
    {/each}
  </div>
</article>

<style lang="scss">
  @use '../styles/variables' as *;

  .job-card {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    background: $color-panel-bg;
    border-radius: 2px;
    text-align: left;

    &:hover {
      background: $color-chip-bg;
    }
  }

  // The title link is stretched over the whole card so anywhere on the card opens the
  // detail page, while the action buttons stay clickable above it.
  .open-link {
    color: inherit;
    text-decoration: none;

    &::after {
      position: absolute;
      inset: 0;
      content: '';
    }

    &:focus-visible {
      outline: 2px solid $color-jobs-accent;
      outline-offset: 1px;
    }
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .title-block {
    min-width: 0;
  }

  .open-link {
    display: inline-block;
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
    color: $color-text-strong;
  }

  .subtitle {
    margin: 0;
    font-size: 12px;
    color: $color-text-dim;
  }

  .actions {
    position: relative;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
    z-index: 1;
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
    background: $color-sidebar-bg;
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
</style>
