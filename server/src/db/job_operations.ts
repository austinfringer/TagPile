import type { Db } from './index.ts';
import type { JobLifecycleStatus, JobRecord } from './types.ts';

export function createJobRecord(
  db: Db,
  job: { id: string; type: string; userId: string | null; options: unknown },
) {
  const stmt = db.prepare(
    `INSERT INTO jobs (id, type, status, user_id, created_at, updated_at, options)
     VALUES (?, ?, 'queued', ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  stmt.run(job.id, job.type, job.userId, now, now, JSON.stringify(job.options ?? null));
}

export function markJobRunning(db: Db, id: string) {
  const now = new Date().toISOString();
  db.prepare(`UPDATE jobs SET status = 'running', started_at = ?, updated_at = ? WHERE id = ?`).run(
    now,
    now,
    id,
  );
}

export function updateJobStatusData(db: Db, id: string, status_data: unknown) {
  db.prepare('UPDATE jobs SET status_data = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(status_data ?? null),
    new Date().toISOString(),
    id,
  );
}

function finishJob(
  db: Db,
  id: string,
  status: Exclude<JobLifecycleStatus, 'queued' | 'running'>,
  status_data: unknown,
  error: string | null,
) {
  const now = new Date().toISOString();
  db.prepare(
    'UPDATE jobs SET status = ?, completed_at = ?, updated_at = ?, status_data = ?, error = ? WHERE id = ?',
  ).run(status, now, now, JSON.stringify(status_data ?? null), error, id);
}

export function completeJobRecord(db: Db, id: string, status_data: unknown) {
  finishJob(db, id, 'complete', status_data, null);
}

export function haltJobRecord(db: Db, id: string, status_data: unknown) {
  finishJob(db, id, 'halted', status_data, null);
}

export function failJobRecord(db: Db, id: string, status_data: unknown, error: unknown) {
  finishJob(db, id, 'error', status_data, error instanceof Error ? error.message : String(error));
}

/** Marks jobs that were queued or running when the server stopped as failed. Jobs live in
 *  memory only, so nothing can resume them. Call at startup, before a job starts. Returns the
 *  number of jobs it changed. */
export function failInterruptedJobRecords(db: Db): number {
  const now = new Date().toISOString();
  return db
    .prepare(
      `UPDATE jobs SET status = 'error', error = ?, completed_at = ?, updated_at = ?
       WHERE status IN ('queued', 'running')`,
    )
    .run('The server stopped before the job finished', now, now).changes;
}

export function getJobRecord(db: Db, id: string): JobRecord | undefined {
  return db.prepare<[string], JobRecord>('SELECT * FROM jobs WHERE id = ?').get(id);
}

export function listJobRecords(db: Db): JobRecord[] {
  return db.prepare<[], JobRecord>('SELECT * FROM jobs ORDER BY created_at DESC').all();
}

export function deleteJobRecord(db: Db, id: string) {
  db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

export function clearJobRecords(db: Db) {
  db.prepare('DELETE FROM jobs').run();
}
