import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loginTestUser } from '../test/helpers.ts';
import * as libOps from '../db/library_operations.ts';
import { createFile, createLocation, locationMetadata } from '../db/file_operations.ts';

describe('GET /api/files/:id', () => {
  const { app, db } = createTestApp();
  let alice: string;
  let bob: string;
  let mine: number;
  let theirs: number;
  let shared: number;
  let missingOnly: number;

  beforeAll(async () => {
    const a = await loginTestUser(app, db);
    const b = await loginTestUser(app, db, { username: 'bob', email: 'bob@example.com' });
    alice = a.cookie;
    bob = b.cookie;

    const libA = libOps.createLibrary(db, 'A', '/data/a');
    const libB = libOps.createLibrary(db, 'B', '/data/b');
    libOps.addMember(db, libA, a.user.id, 'owner');
    libOps.addMember(db, libB, b.user.id, 'owner');

    mine = createFile(db, 'mine', 1);
    theirs = createFile(db, 'theirs', 1);
    shared = createFile(db, 'shared', 1);
    missingOnly = createFile(db, 'gone', 1);
    createLocation(db, 'mine.jpg', libA, mine);
    createLocation(db, 'theirs.jpg', libB, theirs);
    createLocation(db, 'shared.jpg', libA, shared);
    createLocation(db, 'copy.jpg', libB, shared);
    const gone = createLocation(db, 'gone.jpg', libA, missingOnly);
    db.prepare('UPDATE locations SET missing = 1 WHERE location_id = ?').run(gone);

    const now = new Date().toISOString();
    const tag = (lib: number, name: string) => {
      const id = db
        .prepare('INSERT INTO tags (library_id, created_at, updated_at) VALUES (?, ?, ?)')
        .run(lib, now, now).lastInsertRowid as number;
      db.prepare(
        'INSERT INTO aliases (tag_id, library_id, text, is_primary) VALUES (?, ?, ?, 1)',
      ).run(id, lib, name);
      return id;
    };
    db.prepare('INSERT INTO file_tag_relationships (file_id, tag_id) VALUES (?, ?)').run(
      shared,
      tag(libA, 'alice-tag'),
    );
    db.prepare('INSERT INTO file_tag_relationships (file_id, tag_id) VALUES (?, ?)').run(
      shared,
      tag(libB, 'bob-tag'),
    );
  });
  afterAll(() => db.close());

  it('requires a session', async () => {
    await request(app).get(`/api/files/${mine}`).expect(401);
  });

  it('returns 400 for a non-integer id', async () => {
    const res = await request(app).get('/api/files/abc').set('Cookie', alice);
    expect(res.status).toBe(400);
  });

  it('returns a visible file with its locations and tags', async () => {
    const res = await request(app).get(`/api/files/${mine}`).set('Cookie', alice);
    expect(res.status).toBe(200);
    expect(res.body.file).toMatchObject({ file_id: mine, file_hash: 'mine', size: 1, tags: [] });
    expect(res.body.file.locations).toEqual([
      expect.objectContaining({ path: 'mine.jpg', library_name: 'A' }),
    ]);
    expect(res.body.file.locations[0]).not.toHaveProperty('root_path');
  });

  it('returns 404 for a file that only exists in another library', async () => {
    const res = await request(app).get(`/api/files/${theirs}`).set('Cookie', alice);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'File not found' });
  });

  it('returns 404 for an unknown id', async () => {
    await request(app).get('/api/files/999999').set('Cookie', alice).expect(404);
  });

  it('still shows a file whose only accessible location is missing', async () => {
    const res = await request(app).get(`/api/files/${missingOnly}`).set('Cookie', alice);
    expect(res.status).toBe(200);
    expect(res.body.file.locations).toEqual([expect.objectContaining({ missing: 1 })]);
  });

  it('only reveals locations and tags from the caller\u2019s libraries on shared content', async () => {
    const forAlice = await request(app).get(`/api/files/${shared}`).set('Cookie', alice);
    expect(forAlice.body.file.locations.map((l: { path: string }) => l.path)).toEqual([
      'shared.jpg',
    ]);
    expect(forAlice.body.file.tags.map((t: { name: string }) => t.name)).toEqual(['alice-tag']);

    const forBob = await request(app).get(`/api/files/${shared}`).set('Cookie', bob);
    expect(forBob.body.file.locations.map((l: { path: string }) => l.path)).toEqual(['copy.jpg']);
    expect(forBob.body.file.tags.map((t: { name: string }) => t.name)).toEqual(['bob-tag']);
  });
});

describe('GET /api/files/:id/content', () => {
  const { app, db } = createTestApp();
  let alice: string;
  let rootA: string;
  let rootB: string;
  let png: { fileId: number; bytes: Buffer };
  let tiff: { fileId: number; bytes: Buffer };
  let text: number;
  let secret: number;
  let gone: number;
  let svg: number;
  let linked: number;

  const getBinary = (path: string) =>
    request(app)
      .get(path)
      .set('Cookie', alice)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

  beforeAll(async () => {
    const a = await loginTestUser(app, db);
    const b = await loginTestUser(app, db, { username: 'carol', email: 'carol@example.com' });
    alice = a.cookie;

    rootA = mkdtempSync(join(tmpdir(), 'tagpile-content-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'tagpile-content-b-'));
    const libA = libOps.createLibrary(db, 'CA', rootA);
    const libB = libOps.createLibrary(db, 'CB', rootB);
    libOps.addMember(db, libA, a.user.id, 'owner');
    libOps.addMember(db, libB, b.user.id, 'owner');

    const addFile = (
      root: string,
      libraryId: number,
      path: string,
      bytes: Buffer,
    ): { fileId: number; bytes: Buffer } => {
      writeFileSync(join(root, path), bytes);
      const fileId = createFile(db, `content-${path}`, bytes.length);
      createLocation(db, path, libraryId, fileId, locationMetadata(path, 0, 0));
      return { fileId, bytes };
    };

    png = addFile(
      rootA,
      libA,
      'photo.png',
      await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } },
      })
        .png()
        .toBuffer(),
    );
    tiff = addFile(
      rootA,
      libA,
      'scan.tiff',
      await sharp({
        create: { width: 32, height: 32, channels: 3, background: { r: 40, g: 200, b: 40 } },
      })
        .tiff()
        .toBuffer(),
    );
    text = addFile(rootA, libA, 'notes.txt', Buffer.from('plain text, not an image')).fileId;
    secret = addFile(
      rootB,
      libB,
      'hidden.png',
      await sharp({
        create: { width: 16, height: 16, channels: 3, background: { r: 40, g: 40, b: 200 } },
      })
        .png()
        .toBuffer(),
    ).fileId;
    gone = createFile(db, 'content-gone', 1);
    db.prepare('UPDATE locations SET missing = 1 WHERE location_id = ?').run(
      createLocation(db, 'gone.png', libA, gone),
    );
    svg = addFile(
      rootA,
      libA,
      'icon.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
    ).fileId;
    symlinkSync(join(rootB, 'hidden.png'), join(rootA, 'linked.png'));
    linked = createFile(db, 'content-linked', 1);
    createLocation(db, 'linked.png', libA, linked, locationMetadata('linked.png', 0, 0));
  });

  afterAll(() => {
    db.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  it('requires a session', async () => {
    await request(app).get(`/api/files/${png.fileId}/content`).expect(401);
  });

  it('returns 400 for a non-integer id', async () => {
    const res = await request(app).get('/api/files/abc/content').set('Cookie', alice);
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown id', async () => {
    await request(app).get('/api/files/999999/content').set('Cookie', alice).expect(404);
  });

  it('returns 404 for a file outside the caller\u2019s libraries', async () => {
    await request(app).get(`/api/files/${secret}/content`).set('Cookie', alice).expect(404);
  });

  it('returns 404 when every visible location is missing', async () => {
    await request(app).get(`/api/files/${gone}/content`).set('Cookie', alice).expect(404);
  });

  it('serves a web-ready original unchanged, with its own content type', async () => {
    const res = await getBinary(`/api/files/${png.fileId}/content`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect((res.body as Buffer).equals(png.bytes)).toBe(true);
  });

  it('converts a non-web-ready image to PNG', async () => {
    const res = await getBinary(`/api/files/${tiff.fileId}/content`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    const meta = await sharp(res.body as Buffer).metadata();
    expect(meta.format).toBe('png');
    expect(meta.width).toBe(32);
  });

  it('answers 415 for non-image content', async () => {
    const res = await request(app).get(`/api/files/${text}/content`).set('Cookie', alice);
    expect(res.status).toBe(415);
  });

  it('returns 404 for a location that is a symbolic link to a file outside the root', async () => {
    await request(app).get(`/api/files/${linked}/content`).set('Cookie', alice).expect(404);
  });

  it('serves an SVG with a policy that stops its scripts', async () => {
    const res = await getBinary(`/api/files/${svg}/content`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/svg+xml');
    expect(res.headers['content-security-policy']).toMatch(/sandbox/);
    expect(res.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers a Range request with the requested bytes', async () => {
    const res = await getBinary(`/api/files/${png.fileId}/content`).set('Range', 'bytes=0-7');
    expect(res.status).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 0-7/${png.bytes.length}`);
    expect((res.body as Buffer).equals(png.bytes.subarray(0, 8))).toBe(true);
  });
});
