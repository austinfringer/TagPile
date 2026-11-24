import { describe, expect, it } from 'vitest';
import type { JobSummary } from '../api';
import { formatDuration, isActiveJob, jobMessage, statusLabel } from './present';

const baseJob: JobSummary = {
  id: 'j1',
  type: 'library-scan',
  status: 'running',
  userId: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  startedAt: null,
  completedAt: null,
  error: null,
  options: null,
  statusData: null,
  canManage: true,
};

describe('statusLabel', () => {
  it('humanizes only the complete status', () => {
    expect(statusLabel('complete')).toBe('completed');
    expect(statusLabel('running')).toBe('running');
    expect(statusLabel('queued')).toBe('queued');
  });
});

describe('isActiveJob', () => {
  it.each([
    ['queued', true],
    ['running', true],
    ['complete', false],
    ['error', false],
    ['halted', false],
  ] as const)('%s → %s', (status, expected) => {
    expect(isActiveJob({ ...baseJob, status })).toBe(expected);
  });
});

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [500, '1s'],
    [45_000, '45s'],
    [134_000, '2m 14s'],
    [3_725_000, '1h 2m 5s'],
  ])('formats %ims as %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('jobMessage', () => {
  it('shows the live message while running', () => {
    const job = { ...baseJob, statusData: { state: 'running' as const, message: 'running...' } };
    expect(jobMessage(job)).toBe('running...');
  });

  it('computes a duration phrase for completed jobs', () => {
    const job = {
      ...baseJob,
      status: 'complete' as const,
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:02:14Z',
    };
    expect(jobMessage(job)).toBe('completed in 2m 14s');
  });

  it('includes the error for failed jobs', () => {
    const job = { ...baseJob, status: 'error' as const, error: 'boom' };
    expect(jobMessage(job)).toBe('failed: boom');
  });

  it('marks queued jobs', () => {
    expect(jobMessage({ ...baseJob, status: 'queued' })).toBe('queued');
  });
});
