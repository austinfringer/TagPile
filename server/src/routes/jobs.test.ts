import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobRecord, getJobRecord } from '../db/job_operations.ts';
import * as libOps from '../db/library_operations.ts';
import { JobManager, type JobCallbacks, type JobModule } from '../services/jobManager.ts';
import { PreviewService } from '../services/previewService.ts';
import { openDatabase } from '../db/index.ts';
import { createTestApp, createTestDb, loginTestUser, type TestUser } from '../test/helpers.ts';

/** Flushes pending setImmediate callbacks (how JobManager schedules steps). */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function ticks(n: number) {
  for (let i = 0; i < n; i++) await tick();
}

type TestOptions = { steps: number };

/** Runs `steps` steps then completes; `steps: Infinity` keeps it running until halted. */
const testModule: JobModule<TestOptions> = {
  name: 'test-job',
  parseOptions(raw) {
    if (typeof raw !== 'object' || raw === null || typeof (raw as TestOptions).steps !== 'number') {
      throw new Error('steps must be a number');
    }
    return { steps: (raw as TestOptions).steps };
  },
  createJob(options, _db, callbacks: JobCallbacks) {
    let executed = 0;
    let halted = false;
    return {
      execute() {
        executed++;
        if (executed >= options.steps) callbacks.jobComplete();
        else callbacks.stepComplete();
      },
      halt() {
        halted = true;
      },
      status: () => ({ state: halted ? 'halted' : 'running', executed }),
    };
  },
};

describe('job routes', () => {
  const db = createTestDb();
  const jobManager = new JobManager(db);
  jobManager.registerModule(testModule);
  const { app } = createTestApp(db, {
    jobManager,
    previewService: new PreviewService(openDatabase(':memory:')),
  });
  let cookie: string;
  let user: TestUser;

  beforeAll(async () => {
    ({ cookie, user } = await loginTestUser(app, db));
  });
  beforeEach(() => {
    jobManager.clearJobs();
  });
  afterAll(async () => {
    jobManager.clearJobs();
    await tick();
    db.close();
  });

  const startJob = async (body: object) => {
    const res = await request(app).post('/api/jobs').set('Cookie', cookie).send(body);
    expect(res.status).toBe(201);
    return res.body.id as string;
  };

  describe('authentication', () => {
    it.each([
      ['post', '/api/jobs'],
      ['get', '/api/jobs'],
      ['get', '/api/jobs/some-id'],
      ['put', '/api/jobs/some-id'],
      ['delete', '/api/jobs/some-id'],
      ['delete', '/api/jobs'],
    ] as const)('rejects %s %s without a session', async (method, path) => {
      const spy = vi.spyOn(jobManager, 'clearJobs');
      const res = await request(app)[method](path).send({ jobType: 'test-job', options: {} });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid JWT' });
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('POST /api/jobs', () => {
    it('starts a job and returns its id', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', cookie)
        .send({ jobType: 'test-job', options: { steps: 1 } });

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: expect.any(String) });
      const record = getJobRecord(db, res.body.id)!;
      expect(record).toMatchObject({ type: 'test-job', user_id: user.id });
      expect(JSON.parse(record.options!)).toEqual({ steps: 1 });

      await ticks(2);
      expect(getJobRecord(db, res.body.id)!.status).toBe('complete');
    });

    it('returns 400 for an unknown job type', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', cookie)
        .send({ jobType: 'nope', options: {} });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'No job module registered with name "nope"' });
      expect(jobManager.getJobs()).toEqual([]);
    });

    it('returns 400 when the module rejects the options', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', cookie)
        .send({ jobType: 'test-job', options: { steps: 'many' } });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'steps must be a number' });
      expect(jobManager.getJobs()).toEqual([]);
    });

    it('returns 400 when the body is missing', async () => {
      const res = await request(app).post('/api/jobs').set('Cookie', cookie);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/No job module registered/);
    });

    it('refuses a library-scan for a library the caller is not a member of', async () => {
      const libraryId = libOps.createLibrary(db, 'private', '/data/private');
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', cookie)
        .send({ jobType: 'library-scan', options: { libraryId } });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Library not found' });
      expect(jobManager.getJobs()).toEqual([]);
    });

    it('refuses a json-import for a library the caller is not a member of', async () => {
      const libraryId = libOps.createLibrary(db, 'private-import', '/data/private-import');
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', cookie)
        .send({ jobType: 'json-import', options: { libraryId, path: 'a', tagId: 1 } });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Library not found' });
      expect(jobManager.getJobs()).toEqual([]);
    });

    it('lets a member start a library-scan', async () => {
      const libraryId = libOps.createLibrary(db, 'mine', '/data/mine');
      libOps.addMember(db, libraryId, user.id, 'owner');
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', cookie)
        .send({ jobType: 'library-scan', options: { libraryId } });
      expect(res.status).toBe(400);
      // No library-scan module is registered on this test manager, which proves the membership
      // check passed and we fell through to the manager's own validation.
      expect(res.body.error).toMatch(/No job module registered with name "library-scan"/);
    });
  });

  describe('GET /api/jobs', () => {
    it('returns an empty list when there are no jobs', async () => {
      const res = await request(app).get('/api/jobs').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ jobs: [] });
    });

    it('lists all jobs', async () => {
      const a = await startJob({ jobType: 'test-job', options: { steps: 1e9 } });
      const b = await startJob({ jobType: 'test-job', options: { steps: 1e9 } });

      const res = await request(app).get('/api/jobs').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.jobs).toHaveLength(2);
      expect(res.body.jobs.map((j: { id: string }) => j.id).sort()).toEqual([a, b].sort());
      expect(res.body.jobs.find((j: { id: string }) => j.id === a).status).toBe('running');
      expect(res.body.jobs.find((j: { id: string }) => j.id === b).status).toBe('queued');
    });
  });

  describe('GET /api/jobs/:id', () => {
    it('returns the job record', async () => {
      const id = await startJob({ jobType: 'test-job', options: { steps: 2 } });
      await ticks(3);

      const res = await request(app).get(`/api/jobs/${id}`).set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.job).toMatchObject({
        id,
        type: 'test-job',
        status: 'complete',
        canManage: true,
      });
      expect(res.body.job.options).toEqual({ steps: 2 });
      expect(res.body.job.statusData).toMatchObject({ state: 'complete', executed: 2 });
    });

    it('includes the live counters of a running job', async () => {
      const id = await startJob({ jobType: 'test-job', options: { steps: 1e9 } });
      await tick();

      const single = await request(app).get(`/api/jobs/${id}`).set('Cookie', cookie);
      expect(single.body.job.statusData).toMatchObject({ state: 'running' });
      expect(single.body.job.statusData.executed).toBeGreaterThan(0);

      const list = await request(app).get('/api/jobs').set('Cookie', cookie);
      expect(list.body.jobs[0].statusData).toMatchObject({ state: 'running' });
      expect(list.body.jobs[0].statusData.executed).toBeGreaterThan(0);
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).get('/api/jobs/does-not-exist').set('Cookie', cookie);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Job not found' });
    });
  });

  describe('PUT /api/jobs/:id', () => {
    it('halts a running job', async () => {
      const id = await startJob({ jobType: 'test-job', options: { steps: 1e9 } });
      await tick();

      const res = await request(app).put(`/api/jobs/${id}`).set('Cookie', cookie);
      expect(res.status).toBe(204);
      expect(res.body).toEqual({});
      expect(getJobRecord(db, id)!.status).toBe('halted');
    });

    it('does not change a finished job', async () => {
      const id = await startJob({ jobType: 'test-job', options: { steps: 1 } });
      await ticks(2);

      const res = await request(app).put(`/api/jobs/${id}`).set('Cookie', cookie);
      expect(res.status).toBe(204);
      expect(getJobRecord(db, id)!.status).toBe('complete');
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).put('/api/jobs/does-not-exist').set('Cookie', cookie);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Job not found' });
    });
  });

  describe('DELETE /api/jobs/:id', () => {
    it('halts and removes an active job', async () => {
      const id = await startJob({ jobType: 'test-job', options: { steps: 1e9 } });

      const res = await request(app).delete(`/api/jobs/${id}`).set('Cookie', cookie);
      expect(res.status).toBe(204);
      expect(getJobRecord(db, id)).toBeUndefined();
    });

    it('leaves other jobs untouched', async () => {
      const a = await startJob({ jobType: 'test-job', options: { steps: 1e9 } });
      const b = await startJob({ jobType: 'test-job', options: { steps: 1e9 } });

      await request(app).delete(`/api/jobs/${b}`).set('Cookie', cookie).expect(204);
      expect(getJobRecord(db, a)!.status).toBe('running');
      expect(getJobRecord(db, b)).toBeUndefined();
    });

    it('returns 404 for an unknown id', async () => {
      const res = await request(app).delete('/api/jobs/does-not-exist').set('Cookie', cookie);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Job not found' });
    });

    it('returns 404 when deleting the same job twice', async () => {
      const id = await startJob({ jobType: 'test-job', options: { steps: 1 } });
      await request(app).delete(`/api/jobs/${id}`).set('Cookie', cookie).expect(204);
      await request(app).delete(`/api/jobs/${id}`).set('Cookie', cookie).expect(404);
    });
  });

  describe('authorization for a non-admin user', () => {
    let bobCookie: string;
    let bob: TestUser;
    let libraryId: number;

    beforeAll(async () => {
      ({ cookie: bobCookie, user: bob } = await loginTestUser(app, db, {
        username: 'bob',
        email: 'bob@example.com',
        isAdmin: false,
      }));
      libraryId = libOps.createLibrary(db, 'shared', '/data/shared');
      libOps.addMember(db, libraryId, user.id, 'owner');
    });

    const setRole = (role: libOps.LibraryRoleName | null) => {
      db.prepare('DELETE FROM library_members WHERE library_id = ? AND user_id = ?').run(
        libraryId,
        bob.id,
      );
      if (role) libOps.addMember(db, libraryId, bob.id, role);
    };

    /** A job the admin started in the shared library. The real module is not registered, so
     *  only the record is written. */
    const libraryJob = () => {
      const id = randomUUID();
      createJobRecord(db, { id, type: 'library-scan', userId: user.id, options: { libraryId } });
      return id;
    };

    it('may not start a job type that is not a library job', async () => {
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', bobCookie)
        .send({ jobType: 'test-job', options: { steps: 1 } });
      expect(res.status).toBe(403);
      expect(jobManager.getJobs()).toEqual([]);
    });

    it.each([
      ['viewer', 'library-scan', {}],
      ['editor', 'library-scan', {}],
      ['viewer', 'json-import', { path: 'a', tagId: 1 }],
    ] as const)('refuses a %s who starts %s', async (role, jobType, extra) => {
      setRole(role);
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', bobCookie)
        .send({ jobType, options: { libraryId, ...extra } });
      expect(res.status).toBe(403);
    });

    it('refuses json-import with createIfMissing when the role cannot create tags', async () => {
      db.prepare(
        `INSERT OR IGNORE INTO roles (name, can_read, can_create_tag, can_tag_files, can_manage_library)
         VALUES ('tagger', 1, 0, 1, 0)`,
      ).run();
      setRole(null);
      db.prepare(
        `INSERT INTO library_members (library_id, user_id, role_id, created_at)
         SELECT ?, ?, role_id, datetime('now') FROM roles WHERE name = 'tagger'`,
      ).run(libraryId, bob.id);
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', bobCookie)
        .send({ jobType: 'json-import', options: { libraryId, createIfMissing: true } });
      expect(res.status).toBe(403);
    });

    it('lets an editor start json-import', async () => {
      setRole('editor');
      const res = await request(app)
        .post('/api/jobs')
        .set('Cookie', bobCookie)
        .send({ jobType: 'json-import', options: { libraryId, createIfMissing: true } });
      expect(res.body.error).toMatch(/No job module registered with name "json-import"/);
    });

    it('hides jobs of other users and of libraries the user is not a member of', async () => {
      setRole(null);
      const libJob = libraryJob();
      const adminJob = await startJob({ jobType: 'test-job', options: { steps: 1e9 } });

      const list = await request(app).get('/api/jobs').set('Cookie', bobCookie);
      expect(list.body).toEqual({ jobs: [] });
      for (const id of [libJob, adminJob]) {
        await request(app).get(`/api/jobs/${id}`).set('Cookie', bobCookie).expect(404);
        await request(app).put(`/api/jobs/${id}`).set('Cookie', bobCookie).expect(404);
        await request(app).delete(`/api/jobs/${id}`).set('Cookie', bobCookie).expect(404);
      }
      await request(app).delete('/api/jobs').set('Cookie', bobCookie).expect(204);
      expect(getJobRecord(db, libJob)).toBeDefined();
      expect(getJobRecord(db, adminJob)!.status).toBe('running');
    });

    it('shows a library job to a viewer but does not let the viewer stop or delete it', async () => {
      setRole('viewer');
      const id = libraryJob();
      const list = await request(app).get('/api/jobs').set('Cookie', bobCookie);
      expect(list.body.jobs.map((j: { id: string }) => j.id)).toEqual([id]);
      expect(list.body.jobs[0].canManage).toBe(false);
      const single = await request(app).get(`/api/jobs/${id}`).set('Cookie', bobCookie);
      expect(single.status).toBe(200);
      expect(single.body.job.canManage).toBe(false);
      await request(app).put(`/api/jobs/${id}`).set('Cookie', bobCookie).expect(403);
      await request(app).delete(`/api/jobs/${id}`).set('Cookie', bobCookie).expect(403);
      await request(app).delete('/api/jobs').set('Cookie', bobCookie).expect(204);
      expect(getJobRecord(db, id)).toBeDefined();
    });

    it('lets a library owner delete a library job', async () => {
      setRole('owner');
      const id = libraryJob();
      const single = await request(app).get(`/api/jobs/${id}`).set('Cookie', bobCookie);
      expect(single.body.job.canManage).toBe(true);
      await request(app).delete(`/api/jobs/${id}`).set('Cookie', bobCookie).expect(204);
      expect(getJobRecord(db, id)).toBeUndefined();
    });
  });

  describe('DELETE /api/jobs', () => {
    it('halts and removes every job', async () => {
      await startJob({ jobType: 'test-job', options: { steps: 1e9 } });
      await startJob({ jobType: 'test-job', options: { steps: 1e9 } });
      await startJob({ jobType: 'test-job', options: { steps: 1 } });

      const res = await request(app).delete('/api/jobs').set('Cookie', cookie);
      expect(res.status).toBe(204);
      expect(jobManager.getJobs()).toEqual([]);

      const list = await request(app).get('/api/jobs').set('Cookie', cookie);
      expect(list.body).toEqual({ jobs: [] });
    });
  });
});
