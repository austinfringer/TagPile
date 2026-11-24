import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../db/index.ts';
import { getJobRecord, listJobRecords } from '../db/job_operations.ts';
import { createTestDb, createTestUser } from '../test/helpers.ts';
import {
  JobManager,
  type Job,
  type JobCallbacks,
  type JobModule,
  type JobStatus,
} from './jobManager.ts';

/** Flushes pending setImmediate callbacks (how JobManager schedules steps). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function ticks(n: number) {
  for (let i = 0; i < n; i++) await tick();
}

type ScriptedOptions = { steps: number; failAt?: number; label?: string };

/** A job that runs `steps` steps and then completes (or fails at step `failAt`). */
class ScriptedJob implements Job {
  executed = 0;
  halted = false;
  options: ScriptedOptions;
  private callbacks: JobCallbacks;
  constructor(options: ScriptedOptions, callbacks: JobCallbacks) {
    this.options = options;
    this.callbacks = callbacks;
  }
  execute() {
    this.executed++;
    if (this.options.failAt === this.executed) {
      this.callbacks.jobFailed(new Error(`boom at ${this.executed}`));
      return;
    }
    if (this.executed >= this.options.steps) {
      this.callbacks.jobComplete();
      return;
    }
    this.callbacks.stepComplete();
  }
  halt() {
    this.halted = true;
  }
  status(): JobStatus {
    return {
      state: this.halted ? 'halted' : 'running',
      executed: this.executed,
      label: this.options.label,
    };
  }
}

function scriptedModule(name = 'scripted') {
  const jobs: ScriptedJob[] = [];
  const module: JobModule<ScriptedOptions> = {
    name,
    parseOptions(raw) {
      if (
        typeof raw !== 'object' ||
        raw === null ||
        typeof (raw as ScriptedOptions).steps !== 'number'
      ) {
        throw new Error('bad options');
      }
      return raw as ScriptedOptions;
    },
    createJob(options, _db, callbacks) {
      const job = new ScriptedJob(options, callbacks);
      jobs.push(job);
      return job;
    },
  };
  return { module, jobs };
}

describe('JobManager', () => {
  let db: Db;
  let manager: JobManager;
  let jobs: ScriptedJob[];

  beforeEach(() => {
    db = createTestDb();
    manager = new JobManager(db);
    ({ jobs } = (() => {
      const m = scriptedModule();
      manager.registerModule(m.module);
      return m;
    })());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    // Stop any still-scheduled steps before closing the db they would write to.
    manager.clearJobs();
    await tick();
    db.close();
    vi.restoreAllMocks();
  });

  describe('startJob', () => {
    it('throws for an unregistered module', () => {
      expect(() => manager.startJob('nope', {})).toThrow(/No job module registered/);
      expect(listJobRecords(db)).toEqual([]);
    });

    it('propagates parseOptions errors and records nothing', () => {
      expect(() => manager.startJob('scripted', { steps: 'x' })).toThrow(/bad options/);
      expect(listJobRecords(db)).toEqual([]);
      expect(jobs).toEqual([]);
    });

    it('creates a queued record with the parsed options and user id', () => {
      const user = createTestUser(db);
      const id = manager.startJob('scripted', { steps: 1 }, user.id);
      const record = getJobRecord(db, id)!;
      expect(record).toMatchObject({ id, type: 'scripted', user_id: user.id });
      expect(JSON.parse(record.options!)).toEqual({ steps: 1 });
      expect(['queued', 'running']).toContain(record.status);
    });

    it('defaults user id to null', () => {
      const id = manager.startJob('scripted', { steps: 1 });
      expect(getJobRecord(db, id)!.user_id).toBeNull();
    });

    it('does not execute synchronously', () => {
      manager.startJob('scripted', { steps: 3 });
      expect(jobs[0]!.executed).toBe(0);
    });
  });

  describe('execution', () => {
    it('runs a job step by step until it completes and persists the final status', async () => {
      const id = manager.startJob('scripted', { steps: 3, label: 'x' });
      expect(getJobRecord(db, id)!.status).toBe('running');
      expect(getJobRecord(db, id)!.started_at).not.toBeNull();

      await tick();
      expect(jobs[0]!.executed).toBe(1);
      await ticks(5);
      expect(jobs[0]!.executed).toBe(3);

      const record = getJobRecord(db, id)!;
      expect(record.status).toBe('complete');
      expect(record.completed_at).not.toBeNull();
      expect(record.error).toBeNull();
      expect(JSON.parse(record.status_data!)).toMatchObject({ executed: 3, label: 'x' });
    });

    it('runs queued jobs one at a time, in order', async () => {
      const a = manager.startJob('scripted', { steps: 2 });
      const b = manager.startJob('scripted', { steps: 1 });
      expect(getJobRecord(db, a)!.status).toBe('running');
      expect(getJobRecord(db, b)!.status).toBe('queued');

      await tick();
      expect(jobs[0]!.executed).toBe(1);
      expect(jobs[1]!.executed).toBe(0);

      await ticks(5);
      expect(getJobRecord(db, a)!.status).toBe('complete');
      expect(getJobRecord(db, b)!.status).toBe('complete');
      expect(jobs[1]!.executed).toBe(1);
    });

    it('records failures with the error message and moves on to the next job', async () => {
      const a = manager.startJob('scripted', { steps: 5, failAt: 2 });
      const b = manager.startJob('scripted', { steps: 1 });
      await ticks(5);

      const record = getJobRecord(db, a)!;
      expect(record.status).toBe('error');
      expect(record.error).toBe('boom at 2');
      expect(jobs[0]!.executed).toBe(2);
      expect(getJobRecord(db, b)!.status).toBe('complete');
    });

    it('stringifies non-Error failures', async () => {
      const { module } = scriptedModule('thrower');
      module.createJob = (_o, _db, callbacks) => ({
        execute: () => callbacks.jobFailed('plain string'),
        status: () => ({ state: 'error' }),
      });
      manager.registerModule(module);
      const id = manager.startJob('thrower', { steps: 1 });
      await tick();
      expect(getJobRecord(db, id)!.error).toBe('plain string');
    });

    it('ignores callbacks from a job that already finished', async () => {
      const id = manager.startJob('scripted', { steps: 1 });
      await ticks(2);
      expect(getJobRecord(db, id)!.status).toBe('complete');

      // The job object still holds its callbacks; late calls must not corrupt state.
      jobs[0]!.execute();
      await ticks(2);
      expect(getJobRecord(db, id)!.status).toBe('complete');
      expect(jobs[0]!.executed).toBe(2);
    });
  });

  describe('getStatus / getJob', () => {
    it('returns live status for active jobs', async () => {
      const id = manager.startJob('scripted', { steps: 3, label: 'live' });
      expect(manager.getStatus(id)).toMatchObject({ state: 'running', executed: 0, label: 'live' });
      await tick();
      expect(manager.getStatus(id)).toMatchObject({ state: 'running', executed: 1 });
    });

    it('returns live status for queued jobs', () => {
      manager.startJob('scripted', { steps: 3 });
      const queued = manager.startJob('scripted', { steps: 3, label: 'q' });
      expect(manager.getStatus(queued)).toMatchObject({
        state: 'running',
        executed: 0,
        label: 'q',
      });
    });

    it('reconstructs status from the record for finished jobs', async () => {
      const id = manager.startJob('scripted', { steps: 1, label: 'done' });
      await ticks(2);
      expect(manager.getStatus(id)).toEqual({ state: 'complete', executed: 1, label: 'done' });
    });

    it('uses the recorded error as the message for failed jobs', async () => {
      const id = manager.startJob('scripted', { steps: 1, failAt: 1 });
      await ticks(2);
      expect(manager.getStatus(id)).toMatchObject({ state: 'error', message: 'boom at 1' });
    });

    it('returns undefined for unknown ids', () => {
      expect(manager.getStatus('nope')).toBeUndefined();
      expect(manager.getJob('nope')).toBeUndefined();
    });

    it('getJob returns the raw record', () => {
      const id = manager.startJob('scripted', { steps: 1 });
      expect(manager.getJob(id)).toMatchObject({ id, type: 'scripted' });
    });
  });

  describe('haltJob', () => {
    it('halts the running job, stops stepping it, and starts the next one', async () => {
      const a = manager.startJob('scripted', { steps: 10 });
      const b = manager.startJob('scripted', { steps: 1 });
      await tick();
      expect(jobs[0]!.executed).toBe(1);

      manager.haltJob(a);
      expect(jobs[0]!.halted).toBe(true);
      expect(getJobRecord(db, a)!.status).toBe('halted');
      expect(JSON.parse(getJobRecord(db, a)!.status_data!)).toMatchObject({ state: 'halted' });

      await ticks(3);
      expect(jobs[0]!.executed).toBe(1);
      expect(getJobRecord(db, b)!.status).toBe('complete');
    });

    it('removes a queued job without disturbing the running one', async () => {
      const a = manager.startJob('scripted', { steps: 2 });
      const b = manager.startJob('scripted', { steps: 1 });
      manager.haltJob(b);

      expect(getJobRecord(db, b)!.status).toBe('halted');
      expect(jobs[1]!.halted).toBe(true);
      await ticks(4);
      expect(getJobRecord(db, a)!.status).toBe('complete');
      expect(jobs[1]!.executed).toBe(0);
    });

    it('is a no-op for finished or unknown jobs', async () => {
      const id = manager.startJob('scripted', { steps: 1 });
      await ticks(2);
      manager.haltJob(id);
      manager.haltJob('nope');
      expect(getJobRecord(db, id)!.status).toBe('complete');
      expect(jobs[0]!.halted).toBe(false);
    });

    it('works for jobs without a halt method', () => {
      const { module } = scriptedModule('nohalt');
      module.createJob = () => ({ execute: () => {}, status: () => ({ state: 'running' }) });
      manager.registerModule(module);
      const id = manager.startJob('nohalt', { steps: 1 });
      expect(() => manager.haltJob(id)).not.toThrow();
      expect(getJobRecord(db, id)!.status).toBe('halted');
    });
  });

  describe('deleteJob / clearJobs', () => {
    it('deleteJob halts an active job and removes its record', async () => {
      const id = manager.startJob('scripted', { steps: 10 });
      manager.deleteJob(id);
      expect(jobs[0]!.halted).toBe(true);
      expect(getJobRecord(db, id)).toBeUndefined();
      expect(manager.getStatus(id)).toBeUndefined();
      await ticks(2);
      expect(jobs[0]!.executed).toBe(0);
    });

    it('deleteJob removes finished records', async () => {
      const id = manager.startJob('scripted', { steps: 1 });
      await ticks(2);
      manager.deleteJob(id);
      expect(getJobRecord(db, id)).toBeUndefined();
    });

    it('clearJobs halts everything and empties the table', async () => {
      manager.startJob('scripted', { steps: 10 });
      manager.startJob('scripted', { steps: 10 });
      manager.startJob('scripted', { steps: 10 });
      await tick();

      manager.clearJobs();
      expect(jobs.every((j) => j.halted)).toBe(true);
      expect(listJobRecords(db)).toEqual([]);

      await ticks(3);
      expect(jobs.map((j) => j.executed)).toEqual([1, 0, 0]);

      // Manager is still usable afterwards
      const id = manager.startJob('scripted', { steps: 1 });
      await ticks(2);
      expect(getJobRecord(db, id)!.status).toBe('complete');
    });
  });
});
