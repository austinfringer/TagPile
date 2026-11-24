import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { openDatabase } from '../db/index.ts';
import { createServices } from '../services/index.ts';
import { createTestDb, loginTestUser } from '../test/helpers.ts';
import * as libOps from '../db/library_operations.ts';
import { librariesRouter, type LibraryFs } from './libraries.ts';
import express from 'express';
import { authMiddleware } from './auth.ts';

/** Directories that "exist" for root validation. */
const DIRS = new Set([
  '/data',
  '/data/a',
  '/data/b',
  '/data/a/sub',
  '/data/c',
  '/data/db',
  '/outside',
  '/outside/secret',
]);
const FILES = new Set(['/data/file.txt']);
/** Symbolic links: path -> target. */
const LINKS = new Map([['/data/link', '/outside/secret']]);
const fakeFs: LibraryFs = {
  realpathSync: (p) => {
    const real = LINKS.get(p) ?? p;
    if (!DIRS.has(real) && !FILES.has(real)) throw new Error('ENOENT');
    return real;
  },
  statSync: (p) => ({ isDirectory: () => DIRS.has(p) }),
};

describe('library routes', () => {
  const db = createTestDb();
  const config = loadConfig({
    JWT_SECRET: 'test-secret',
    LIBRARY_ROOTS: '/data',
    DATABASE_PATH: '/data/db/tagpile.sqlite',
  });
  const services = createServices(db, openDatabase(':memory:'));
  // Logins go through the real app; library requests go through a copy of the API stack with an
  // fs-injected libraries router so no real directories are needed.
  const loginApp = createApp({ db, version: 'test', config, services });
  const buildApp = (routerConfig = config) => {
    const built = express();
    built.use(express.json());
    built.use('/api', authMiddleware({ db, config }));
    built.use('/api', librariesRouter({ db, config: routerConfig, fs: fakeFs }));
    return built;
  };
  const app = buildApp();

  let alice: string;
  let bob: string;
  let carol: string;
  let carolId: string;

  beforeAll(async () => {
    alice = (await loginTestUser(loginApp, db)).cookie;
    bob = (await loginTestUser(loginApp, db, { username: 'bob', email: 'bob@example.com' })).cookie;
    const nonAdmin = await loginTestUser(loginApp, db, {
      username: 'carol',
      email: 'carol@example.com',
      isAdmin: false,
    });
    carol = nonAdmin.cookie;
    carolId = nonAdmin.user.id;
  });
  beforeEach(() => {
    db.prepare('DELETE FROM libraries').run();
  });
  afterAll(() => db.close());

  const create = (cookie: string, body: object) =>
    request(app).post('/api/libraries').set('Cookie', cookie).send(body);

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/libraries');
    expect(res.status).toBe(401);
  });

  describe('POST /api/libraries', () => {
    it('creates a library and makes the caller its owner', async () => {
      const res = await create(alice, { name: 'A', rootPath: '/data/a/' });
      expect(res.status).toBe(201);
      expect(res.body.library).toMatchObject({
        name: 'A',
        root_path: '/data/a',
        role: 'owner',
        permissions: { canManageLibrary: true, canRead: true },
      });
    });

    it.each([
      [{ rootPath: '/data/a' }, /name is required/],
      [{ name: ' ', rootPath: '/data/a' }, /name is required/],
      [{ name: 'A' }, /absolute path/],
      [{ name: 'A', rootPath: 'data/a' }, /absolute path/],
    ])('returns 400 for %j', async (body, message) => {
      const res = await create(alice, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(message);
    });

    it('returns 403 for a user who is not an admin', async () => {
      const res = await create(carol, { name: 'A', rootPath: '/data/a' });
      expect(res.status).toBe(403);
      // The reply must not show if the path exists.
      const missing = await create(carol, { name: 'A', rootPath: '/data/missing' });
      expect(missing.status).toBe(403);
      expect(missing.body).toEqual(res.body);
    });

    it.each([
      ['a missing path in an allowed directory', '/data/missing'],
      ['a file', '/data/file.txt'],
      ['a directory outside the allowed directories', '/outside'],
      ['a missing path outside the allowed directories', '/outside/missing'],
      ['a symbolic link that points outside the allowed directories', '/data/link'],
      ['the database directory', '/data/db'],
      ['a directory that contains the database directory', '/data'],
    ])('returns the same 400 for %s', async (_label, rootPath) => {
      const res = await create(alice, { name: 'A', rootPath });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: expect.stringMatching(/not an allowed library directory/),
      });
      const reference = await create(alice, { name: 'A', rootPath: '/outside/missing' });
      expect(res.body).toEqual(reference.body);
    });

    it('rejects every path when LIBRARY_ROOTS is empty', async () => {
      const closed = buildApp(loadConfig({ JWT_SECRET: 'test-secret' }));
      const res = await request(closed)
        .post('/api/libraries')
        .set('Cookie', alice)
        .send({ name: 'A', rootPath: '/data/a' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not an allowed library directory/);
    });

    it('returns 409 when the root nests with another library, without details of that library', async () => {
      await create(bob, { name: 'B', rootPath: '/data/a' }).expect(201);
      const res = await create(alice, { name: 'A', rootPath: '/data/a/sub' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/overlaps/);
      expect(res.body.error).not.toMatch(/"B"|\/data\/a/);
    });

    it('returns 409 on a duplicate name', async () => {
      await create(alice, { name: 'A', rootPath: '/data/a' }).expect(201);
      const res = await create(alice, { name: 'A', rootPath: '/data/b' });
      expect(res.status).toBe(409);
    });
  });

  describe('GET /api/libraries', () => {
    it('lists only the caller\u2019s libraries with their role', async () => {
      const a = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      await create(bob, { name: 'B', rootPath: '/data/b' });
      const bobUser = db.prepare('SELECT id FROM users WHERE username = ?').get('bob') as {
        id: string;
      };
      libOps.addMember(db, a, bobUser.id, 'viewer');

      const forAlice = await request(app).get('/api/libraries').set('Cookie', alice);
      expect(
        forAlice.body.libraries.map((l: { name: string; role: string }) => [l.name, l.role]),
      ).toEqual([['A', 'owner']]);
      const forBob = await request(app).get('/api/libraries').set('Cookie', bob);
      expect(
        forBob.body.libraries.map((l: { name: string; role: string }) => [l.name, l.role]),
      ).toEqual([
        ['A', 'viewer'],
        ['B', 'owner'],
      ]);
    });

    it('hides the root path from a member who cannot manage the library', async () => {
      const a = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      libOps.addMember(db, a, carolId, 'editor');
      const forCarol = await request(app).get('/api/libraries').set('Cookie', carol);
      expect(forCarol.body.libraries).toEqual([
        expect.objectContaining({ name: 'A', root_path: null }),
      ]);
      const single = await request(app).get(`/api/libraries/${a}`).set('Cookie', carol);
      expect(single.body.library.root_path).toBeNull();
    });
  });

  describe('GET /api/libraries/:id', () => {
    it('returns the library for a member and 404 for anyone else', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      await request(app).get(`/api/libraries/${id}`).set('Cookie', alice).expect(200);
      const res = await request(app).get(`/api/libraries/${id}`).set('Cookie', bob);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Library not found' });
    });

    it('returns 404 for a non-numeric or unknown id', async () => {
      await request(app).get('/api/libraries/abc').set('Cookie', alice).expect(404);
      await request(app).get('/api/libraries/9999').set('Cookie', alice).expect(404);
    });
  });

  describe('PUT /api/libraries/:id', () => {
    it('lets an owner rename and relink', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      const res = await request(app)
        .put(`/api/libraries/${id}`)
        .set('Cookie', alice)
        .send({ name: 'Renamed', rootPath: '/data/c' });
      expect(res.status).toBe(200);
      expect(res.body.library).toMatchObject({ name: 'Renamed', root_path: '/data/c' });
    });

    it('lets an owner who is not an admin rename, but not relink', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      libOps.addMember(db, id, carolId, 'owner');
      await request(app)
        .put(`/api/libraries/${id}`)
        .set('Cookie', carol)
        .send({ rootPath: '/data/c' })
        .expect(403);
      const res = await request(app)
        .put(`/api/libraries/${id}`)
        .set('Cookie', carol)
        .send({ name: 'Renamed' });
      expect(res.status).toBe(200);
      expect(res.body.library).toMatchObject({ name: 'Renamed', root_path: '/data/a' });
    });

    it('rejects a relink to a path outside the allowed directories', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      const res = await request(app)
        .put(`/api/libraries/${id}`)
        .set('Cookie', alice)
        .send({ rootPath: '/outside' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not an allowed library directory/);
    });

    it('returns 403 for a viewer and 404 for a non-member', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      await request(app)
        .put(`/api/libraries/${id}`)
        .set('Cookie', bob)
        .send({ name: 'x' })
        .expect(404);
      const bobUser = db.prepare('SELECT id FROM users WHERE username = ?').get('bob') as {
        id: string;
      };
      libOps.addMember(db, id, bobUser.id, 'viewer');
      await request(app)
        .put(`/api/libraries/${id}`)
        .set('Cookie', bob)
        .send({ name: 'x' })
        .expect(403);
    });

    it('returns 409 when relinking into another library', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      await create(bob, { name: 'B', rootPath: '/data/b' }).expect(201);
      const res = await request(app)
        .put(`/api/libraries/${id}`)
        .set('Cookie', alice)
        .send({ rootPath: '/data/b' });
      expect(res.status).toBe(409);
    });

    it('validates the new root path', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      const res = await request(app)
        .put(`/api/libraries/${id}`)
        .set('Cookie', alice)
        .send({ rootPath: '/nope' });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/libraries/:id', () => {
    it('lets an owner delete and makes the library disappear', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      await request(app).delete(`/api/libraries/${id}`).set('Cookie', alice).expect(204);
      await request(app).get(`/api/libraries/${id}`).set('Cookie', alice).expect(404);
    });

    it('returns 403 for a viewer', async () => {
      const id = (await create(alice, { name: 'A', rootPath: '/data/a' })).body.library.library_id;
      const bobUser = db.prepare('SELECT id FROM users WHERE username = ?').get('bob') as {
        id: string;
      };
      libOps.addMember(db, id, bobUser.id, 'viewer');
      await request(app).delete(`/api/libraries/${id}`).set('Cookie', bob).expect(403);
    });
  });
});
