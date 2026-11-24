import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from './index.ts';
import {
  clearJobRecords,
  completeJobRecord,
  createJobRecord,
  deleteJobRecord,
  failInterruptedJobRecords,
  failJobRecord,
  getJobRecord,
  haltJobRecord,
  listJobRecords,
  markJobRunning,
  updateJobStatusData,
} from './job_operations.ts';
import { createTestDb, createTestUser } from '../test/helpers.ts';

describe('job_operations', () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  const create = (id: string, options: unknown = { a: 1 }, userId: string | null = null) =>
    createJobRecord(db, { id, type: 'test', userId, options });

  it('creates a queued record with JSON-encoded options and timestamps', () => {
    const user = createTestUser(db);
    create('j1', { dirs: ['x'] }, user.id);
    expect(getJobRecord(db, 'j1')).toEqual({
      id: 'j1',
      type: 'test',
      status: 'queued',
      user_id: user.id,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      started_at: null,
      completed_at: null,
      options: '{"dirs":["x"]}',
      status_data: null,
      error: null,
    });
  });

  it('stores undefined options as JSON null', () => {
    createJobRecord(db, { id: 'j1', type: 'test', userId: null, options: undefined });
    expect(getJobRecord(db, 'j1')!.options).toBe('null');
  });

  it('rejects duplicate ids', () => {
    create('j1');
    expect(() => create('j1')).toThrow();
  });

  it('rejects unknown user ids', () => {
    expect(() => create('j1', {}, 'no-such-user')).toThrow();
  });

  it('markJobRunning sets status and started_at', () => {
    create('j1');
    vi.setSystemTime(new Date('2026-01-01T00:00:01.000Z'));
    markJobRunning(db, 'j1');
    expect(getJobRecord(db, 'j1')).toMatchObject({
      status: 'running',
      started_at: '2026-01-01T00:00:01.000Z',
      updated_at: '2026-01-01T00:00:01.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  });

  it('updateJobStatusData stores JSON without changing status', () => {
    create('j1');
    updateJobStatusData(db, 'j1', { filesScanned: 3 });
    expect(getJobRecord(db, 'j1')).toMatchObject({
      status: 'queued',
      status_data: '{"filesScanned":3}',
    });
  });

  it.each([
    ['complete', completeJobRecord, null],
    ['halted', haltJobRecord, null],
  ] as const)('%s finishes the record', (status, fn, error) => {
    create('j1');
    vi.setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    fn(db, 'j1', { n: 1 });
    expect(getJobRecord(db, 'j1')).toMatchObject({
      status,
      completed_at: '2026-01-01T00:00:05.000Z',
      updated_at: '2026-01-01T00:00:05.000Z',
      status_data: '{"n":1}',
      error,
    });
  });

  it('failJobRecord records Error messages and stringifies other values', () => {
    create('j1');
    create('j2');
    failJobRecord(db, 'j1', null, new Error('boom'));
    failJobRecord(db, 'j2', undefined, 42);
    expect(getJobRecord(db, 'j1')).toMatchObject({
      status: 'error',
      error: 'boom',
      status_data: 'null',
    });
    expect(getJobRecord(db, 'j2')).toMatchObject({ status: 'error', error: '42' });
  });

  it('failInterruptedJobRecords fails only queued and running records', () => {
    create('queued');
    create('running');
    markJobRunning(db, 'running');
    create('done');
    completeJobRecord(db, 'done', { n: 1 });
    vi.setSystemTime(new Date('2026-01-01T00:00:09.000Z'));
    expect(failInterruptedJobRecords(db)).toBe(2);
    for (const id of ['queued', 'running']) {
      expect(getJobRecord(db, id)).toMatchObject({
        status: 'error',
        error: 'The server stopped before the job finished',
        completed_at: '2026-01-01T00:00:09.000Z',
        updated_at: '2026-01-01T00:00:09.000Z',
      });
    }
    expect(getJobRecord(db, 'done')).toMatchObject({
      status: 'complete',
      completed_at: '2026-01-01T00:00:00.000Z',
      error: null,
    });
    expect(failInterruptedJobRecords(db)).toBe(0);
  });

  it('getJobRecord returns undefined for unknown ids', () => {
    expect(getJobRecord(db, 'nope')).toBeUndefined();
  });

  it('listJobRecords returns newest first', () => {
    create('old');
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    create('new');
    expect(listJobRecords(db).map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('deleteJobRecord removes only the given record', () => {
    create('j1');
    create('j2');
    deleteJobRecord(db, 'j1');
    deleteJobRecord(db, 'nope');
    expect(listJobRecords(db).map((r) => r.id)).toEqual(['j2']);
  });

  it('clearJobRecords removes everything', () => {
    create('j1');
    create('j2');
    clearJobRecords(db);
    expect(listJobRecords(db)).toEqual([]);
  });
});
