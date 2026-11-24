import type { Db } from '../db/index.ts';
import { Router, type Request } from 'express';
import type { JobManager, JobStatus } from '../services/jobManager.ts';
import { getUserById } from '../db/auth_operations.ts';
import { getMemberRole } from '../db/library_operations.ts';
import type { JobRecord } from '../db/types.ts';
import type { Capability } from './libraryScope.ts';
import { userIdOf } from './util.ts';

/** API-facing job summary: the persisted record with parsed options plus the job's current
 *  status payload (live counters for active jobs, the final snapshot for finished ones). */
export interface JobSummary {
  id: string;
  type: string;
  status: JobRecord['status'];
  userId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  options: unknown;
  statusData: JobStatus | null;
  /** True when the caller may halt and delete the job. */
  canManage: boolean;
}

function present(jobManager: JobManager, record: JobRecord, access: Access): JobSummary {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    userId: record.user_id,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    startedAt: record.started_at,
    completedAt: record.completed_at,
    error: record.error,
    options: record.options !== null ? JSON.parse(record.options) : null,
    statusData: jobManager.getStatus(record.id) ?? null,
    canManage: access === 'manage',
  };
}

export interface JobDeps {
  db: Db;
  jobManager: JobManager;
}

/** The capabilities each library job needs in its library. Other job types are admin-only. */
const LIBRARY_JOBS: Record<string, (options: Record<string, unknown>) => Capability[]> = {
  'library-scan': () => ['can_manage_library'],
  'json-import': (options) =>
    options.createIfMissing === true ? ['can_tag_files', 'can_create_tag'] : ['can_tag_files'],
};

const libraryIdOf = (options: unknown): unknown =>
  (options as { libraryId?: unknown } | null)?.libraryId;

type Access = 'none' | 'view' | 'manage';

export function jobRouter({ db, jobManager }: JobDeps) {
  const router = Router();

  const isAdmin = (userId: string) => !!getUserById(db, userId)?.is_admin;

  /** Admins and the user who started a job manage it. Members of the job's library see it;
   *  members with `can_manage_library` also manage it. Everyone else does not see it. */
  const accessTo = (record: JobRecord, userId: string, admin: boolean): Access => {
    if (admin || record.user_id === userId) return 'manage';
    const libraryId = record.options !== null ? libraryIdOf(JSON.parse(record.options)) : null;
    if (typeof libraryId !== 'number') return 'none';
    const role = getMemberRole(db, libraryId, userId);
    return !role ? 'none' : role.can_manage_library ? 'manage' : 'view';
  };

  /** Finds a job the caller can see; null when it does not exist or is hidden. */
  const findJob = (req: Request) => {
    const userId = userIdOf(req);
    const record = jobManager.getJob(String(req.params.id));
    const access = record ? accessTo(record, userId, isAdmin(userId)) : 'none';
    return record && access !== 'none' ? { record, access } : null;
  };

  router.post('/jobs', (req, res) => {
    const { jobType, options } = req.body ?? {};
    const userId = userIdOf(req);
    const capabilities = typeof jobType === 'string' ? LIBRARY_JOBS[jobType] : undefined;

    if (capabilities) {
      const libraryId = libraryIdOf(options);
      // A missing or malformed libraryId falls through so parseOptions produces the 400.
      if (typeof libraryId === 'number') {
        const role = getMemberRole(db, libraryId, userId);
        if (!role) return res.status(404).json({ error: 'Library not found' });
        if (!capabilities(options as Record<string, unknown>).every((c) => role[c])) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      }
    } else if (!isAdmin(userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    try {
      const jobId = jobManager.startJob(jobType, options, userId);
      res.status(201).json({ id: jobId });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  router.get('/jobs', (req, res) => {
    const userId = userIdOf(req);
    const admin = isAdmin(userId);
    const jobs = jobManager
      .getJobs()
      .map((job) => ({ job, access: accessTo(job, userId, admin) }))
      .filter(({ access }) => access !== 'none')
      .map(({ job, access }) => present(jobManager, job, access));
    res.status(200).json({ jobs });
  });

  router.get('/jobs/:id', (req, res) => {
    const found = findJob(req);
    if (!found) return res.status(404).json({ error: 'Job not found' });
    res.status(200).json({ job: present(jobManager, found.record, found.access) });
  });

  router.put('/jobs/:id', (req, res) => {
    const found = findJob(req);
    if (!found) return res.status(404).json({ error: 'Job not found' });
    if (found.access !== 'manage') return res.status(403).json({ error: 'Forbidden' });
    jobManager.haltJob(found.record.id);
    res.status(204).send();
  });

  router.delete('/jobs/:id', (req, res) => {
    const found = findJob(req);
    if (!found) return res.status(404).json({ error: 'Job not found' });
    if (found.access !== 'manage') return res.status(403).json({ error: 'Forbidden' });
    jobManager.deleteJob(found.record.id);
    res.status(204).send();
  });

  /** Deletes every job the caller manages. */
  router.delete('/jobs', (req, res) => {
    const userId = userIdOf(req);
    const admin = isAdmin(userId);
    for (const job of jobManager.getJobs()) {
      if (accessTo(job, userId, admin) === 'manage') jobManager.deleteJob(job.id);
    }
    res.status(204).send();
  });

  return router;
}
