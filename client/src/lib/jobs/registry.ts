import type { Component } from 'svelte';
import type { JobStatusData, JobSummary, LibrarySummary } from '../api';

/** A single stat tile on a job card / detail page. */
export interface JobCounter {
  label: string;
  value: string | number;
}

/** What a job type knows about a given job record when presenting it. */
export interface JobTypeContext {
  /** Parsed options the job was started with. */
  options: unknown;
  /** Live counters (active jobs) or the final status snapshot (finished jobs). */
  statusData: JobStatusData | null;
  /** Libraries the user can see, for resolving ids to names. */
  libraries: LibrarySummary[];
}

/** Props for a job type's New-job options form. The form reports the current options to
 *  the inspector: `null` while the draft is incomplete/invalid. */
export interface JobOptionProps {
  onChange: (options: unknown | null) => void;
}

/** Props for a job type's optional full-page detail sections. */
export interface JobDetailsProps {
  job: JobSummary;
  libraries: LibrarySummary[];
}

/**
 * Registers one job type for the Jobs UI. New job modules (server) that want UI support
 * register a definition here: an `Options` form for the New-job inspector, plus how to
 * present the type (`describe` for the subtitle, `counters` for the stat tiles) and, when
 * the job's status carries extra data, a `Details` component for the detail page.
 */
export interface JobTypeDefinition {
  /** Human-readable name, e.g. "Library scan" (also the card/detail title). */
  label: string;
  /** Subtitle under the title, e.g. "Library: Photos / Subfolder: 2023". */
  describe(ctx: JobTypeContext): string;
  /** Stat tiles from the job's status data. */
  counters(ctx: JobTypeContext): JobCounter[];
  /** The inspector's options form for this type. */
  Options: Component<JobOptionProps>;
  /** Optional extra sections on the job detail page (below the counters). */
  Details?: Component<JobDetailsProps>;
}

const registry = new Map<string, JobTypeDefinition>();

export function registerJobType(type: string, definition: JobTypeDefinition): void {
  registry.set(type, definition);
}

export function jobTypeDefinition(type: string): JobTypeDefinition | undefined {
  return registry.get(type);
}

/** Registered types for the inspector's job-type dropdown, in registration order. */
export function jobTypes(): { type: string; label: string }[] {
  return [...registry.entries()].map(([type, def]) => ({ type, label: def.label }));
}

/** Presentation for any job, falling back gracefully for unregistered types. */
export function jobLabel(type: string): string {
  return jobTypeDefinition(type)?.label ?? type;
}

export function jobSubtitle(ctx: JobTypeContext & { type: string }): string {
  if (ctx.statusData === null && ctx.options === null) return '';
  return jobTypeDefinition(ctx.type)?.describe(ctx) ?? '';
}

export function jobCounters(ctx: JobTypeContext & { type: string }): JobCounter[] {
  return jobTypeDefinition(ctx.type)?.counters(ctx) ?? [];
}
