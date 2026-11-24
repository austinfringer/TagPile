import { randomUUID } from 'node:crypto';
import { optimizeDatabase, type Db } from '../db/index.ts';
import {
  clearJobRecords,
  completeJobRecord,
  createJobRecord,
  deleteJobRecord,
  failJobRecord,
  getJobRecord,
  haltJobRecord,
  listJobRecords,
  markJobRunning,
} from '../db/job_operations.ts';
import type { JobLifecycleStatus, JobRecord } from '../db/types.ts';

export interface JobStatus {
  state: 'running' | 'complete' | 'error' | 'halted';
  message?: string;
  [key: string]: unknown;
}

export interface JobCallbacks {
  stepComplete(): void;
  jobComplete(): void;
  jobFailed(error: unknown): void;
}

export interface Job {
  execute(): void;
  status(): JobStatus;
  halt?(): void;
}

export interface JobModule<TOptions = unknown> {
  name: string;
  parseOptions(raw: unknown): TOptions;
  createJob(options: TOptions, db: Db, callbacks: JobCallbacks): Job;
}

interface QueueEntry {
  id: string;
  type: string;
  userId: string | null;
  status: JobLifecycleStatus;
  job: Job;
}

function isActive(entry: QueueEntry): boolean {
  return entry.status === 'queued' || entry.status === 'running';
}

function recordToStatus(record: JobRecord): JobStatus {
  const status_data = record.status_data
    ? (JSON.parse(record.status_data) as Partial<JobStatus>)
    : {};
  if (record.status === 'queued' || record.status === 'running') {
    return { ...status_data, state: 'running' };
  }
  return {
    ...status_data,
    state: record.status,
    ...(record.error ? { message: record.error } : {}),
  };
}

export class JobManager {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private modules = new Map<string, JobModule<any>>();
  private queue: QueueEntry[] = [];
  private current: QueueEntry | null = null;
  private db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  public registerModule<TOptions>(module: JobModule<TOptions>) {
    this.modules.set(module.name, module);
  }

  public startJob(moduleName: string, rawOptions: unknown, userId: string | null = null): string {
    const module = this.modules.get(moduleName);
    if (!module) {
      throw new Error(`No job module registered with name "${moduleName}"`);
    }
    const options: unknown = module.parseOptions(rawOptions);

    const id = randomUUID();
    const entry: QueueEntry = {
      id,
      type: moduleName,
      userId,
      status: 'queued',
      job: undefined as unknown as Job,
    };
    entry.job = module.createJob(options, this.db, {
      stepComplete: () => this.onStepComplete(entry),
      jobComplete: () => this.onJobComplete(entry),
      jobFailed: (error) => this.onJobFailed(entry, error),
    });

    createJobRecord(this.db, { id, type: moduleName, userId, options });
    this.queue.push(entry);
    this.pump();
    return id;
  }

  public getStatus(id: string): JobStatus | undefined {
    const entry = this.findEntry(id);
    if (entry) {
      return entry.job.status();
    }
    const record = getJobRecord(this.db, id);
    return record ? recordToStatus(record) : undefined;
  }

  public getJob(id: string): JobRecord | undefined {
    return getJobRecord(this.db, id);
  }

  public getJobs(): JobRecord[] {
    return listJobRecords(this.db);
  }

  public haltJob(id: string) {
    const entry = this.findEntry(id);
    if (!entry || !isActive(entry)) {
      return;
    }

    entry.status = 'halted';
    entry.job.halt?.();
    haltJobRecord(this.db, id, entry.job.status());

    if (this.current === entry) {
      this.current = null;
      this.pump();
    } else {
      this.queue = this.queue.filter((queued) => queued !== entry);
    }
  }

  public deleteJob(id: string) {
    this.haltJob(id);
    deleteJobRecord(this.db, id);
  }

  public clearJobs() {
    for (const entry of [...this.queue]) {
      this.haltJob(entry.id);
    }
    if (this.current) {
      this.haltJob(this.current.id);
    }
    clearJobRecords(this.db);
  }

  private findEntry(id: string): QueueEntry | undefined {
    if (this.current?.id === id) {
      return this.current;
    }
    return this.queue.find((entry) => entry.id === id);
  }

  private pump() {
    if (this.current || this.queue.length === 0) {
      return;
    }
    this.current = this.queue.shift() ?? null;
    if (this.current) {
      this.current.status = 'running';
      markJobRunning(this.db, this.current.id);
      this.scheduleStep(this.current);
    }
  }

  private scheduleStep(entry: QueueEntry) {
    setImmediate(() => {
      if (!isActive(entry)) {
        return;
      }
      entry.job.execute.call(entry.job);
    });
  }

  private onStepComplete(entry: QueueEntry) {
    if (this.current !== entry || !isActive(entry)) {
      return;
    }
    this.scheduleStep(entry);
  }

  private onJobComplete(entry: QueueEntry) {
    if (!isActive(entry)) {
      return;
    }
    entry.status = 'complete';
    completeJobRecord(this.db, entry.id, entry.job.status());
    optimizeDatabase(this.db);
    if (this.current === entry) {
      this.current = null;
    }
    this.pump();
  }

  private onJobFailed(entry: QueueEntry, error: unknown) {
    if (!isActive(entry)) {
      return;
    }
    console.error(`Job "${entry.type}" (${entry.id}) failed:`, error);
    entry.status = 'error';
    failJobRecord(this.db, entry.id, entry.job.status(), error);
    optimizeDatabase(this.db);
    if (this.current === entry) {
      this.current = null;
    }
    this.pump();
  }
}
