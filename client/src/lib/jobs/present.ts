import type { JobLifecycleStatus, JobSummary } from '../api';
import type { JobCounter } from './registry';

export type { JobCounter };

export function statusLabel(status: JobLifecycleStatus): string {
  switch (status) {
    case 'complete':
      return 'completed';
    default:
      return status;
  }
}

/** Active jobs are accent-coloured in the mockup; finished ones are neutral. */
export function isActiveJob(job: JobSummary): boolean {
  return job.status === 'running' || job.status === 'queued';
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** The "Message: ..." line under a job's title. */
export function jobMessage(job: JobSummary): string {
  if (job.status === 'complete' && job.startedAt && job.completedAt) {
    const duration = new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime();
    return `completed in ${formatDuration(duration)}`;
  }
  if (job.status === 'error') {
    return job.error ? `failed: ${job.error}` : 'failed';
  }
  if (job.status === 'queued') return 'queued';
  return job.statusData?.message ?? statusLabel(job.status);
}
