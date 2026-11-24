import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as libOps from '../db/library_operations.ts';
import { createFile, createLocation, locationMetadata } from '../db/file_operations.ts';
import { createTestApp, loginTestUser } from '../test/helpers.ts';

type TestFile = { fileId: number; path: string; bytes: Buffer };

describe('preview routes', () => {
  const { app, db } = createTestApp();
  let alice: string; //owner of A
  let rootA: string;
  let rootB: string;
  let large: TestFile; //800x600 -> resized webp preview
  let small: TestFile; //100x100 -> served as the original
  let text: TestFile; //txt -> no preview
  let secret: TestFile; //in B, invisible to alice

  const getBinary = async (path: string, cookie = alice) =>
    request(app)
      .get(path)
      .set('Cookie', cookie)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

  beforeAll(async () => {
    const a = await loginTestUser(app, db);
    const b = await loginTestUser(app, db, { username: 'bob', email: 'bob@example.com' });
    alice = a.cookie;

    rootA = mkdtempSync(join(tmpdir(), 'tagpile-previews-a-'));
    rootB = mkdtempSync(join(tmpdir(), 'tagpile-previews-b-'));
    const libA = libOps.createLibrary(db, 'A', rootA);
    const libB = libOps.createLibrary(db, 'B', rootB);
    libOps.addMember(db, libA, a.user.id, 'owner');
    libOps.addMember(db, libB, b.user.id, 'owner');

    const buffers = {
      'large.png': await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } },
      })
        .png()
        .toBuffer(),
      'small.png': await sharp({
        create: { width: 100, height: 100, channels: 3, background: { r: 40, g: 200, b: 40 } },
      })
        .png()
        .toBuffer(),
      'doc.txt': Buffer.from('plain text, not an image'),
      'secret.png': await sharp({
        create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 40, b: 200 } },
      })
        .png()
        .toBuffer(),
    };

    const addFile = (root: string, libraryId: number, path: string): TestFile => {
      const bytes = buffers[path as keyof typeof buffers];
      writeFileSync(join(root, path), bytes);
      const fileId = createFile(db, `hash-${path}`, bytes.length);
      createLocation(db, path, libraryId, fileId, locationMetadata(path, 0, 0));
      return { fileId, path, bytes };
    };

    large = addFile(rootA, libA, 'large.png');
    small = addFile(rootA, libA, 'small.png');
    text = addFile(rootA, libA, 'doc.txt');
    secret = addFile(rootB, libB, 'secret.png');
  });

  afterAll(() => {
    db.close();
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  });

  describe('GET /api/previews/:id', () => {
    it('rejects a non-integer file id', async () => {
      const res = await request(app).get('/api/previews/nope').set('Cookie', alice);
      expect(res.status).toBe(400);
    });

    it('returns 404 for an unknown file', async () => {
      const res = await request(app).get('/api/previews/9999').set('Cookie', alice);
      expect(res.status).toBe(404);
    });

    it('returns 404 for a file the caller cannot see', async () => {
      const res = await request(app).get(`/api/previews/${secret.fileId}`).set('Cookie', alice);
      expect(res.status).toBe(404);
    });

    it('serves a large image as a resized webp preview', async () => {
      const res = await getBinary(`/api/previews/${large.fileId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      const body = res.body as Buffer;
      expect(body.equals(large.bytes)).toBe(false);
      const meta = await sharp(body).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(256);
      expect(meta.height).toBe(256);
    });

    it('serves a small image unchanged, with its original content type', async () => {
      const res = await getBinary(`/api/previews/${small.fileId}`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect((res.body as Buffer).equals(small.bytes)).toBe(true);
    });

    it('answers 204 for a non-image file', async () => {
      const res = await request(app).get(`/api/previews/${text.fileId}`).set('Cookie', alice);
      expect(res.status).toBe(204);
    });

    it('serves subsequent requests from the cache', async () => {
      const res = await getBinary(`/api/previews/${large.fileId}`);
      expect(res.status).toBe(200);
      const meta = await sharp(res.body as Buffer).metadata();
      expect(meta.format).toBe('webp');
    });
  });

  describe('POST /api/previews', () => {
    it('rejects malformed id lists', async () => {
      for (const ids of [[], 'nope', ['1'], [1.5], [-3]]) {
        const res = await request(app).post('/api/previews').set('Cookie', alice).send({ ids });
        expect(res.status).toBe(400);
      }
    });

    it('returns previews for image files and omits files without a preview', async () => {
      const res = await request(app)
        .post('/api/previews')
        .set('Cookie', alice)
        .send({ ids: [large.fileId, small.fileId, text.fileId] });
      expect(res.status).toBe(200);
      const previews = res.body.previews as {
        fileId: number;
        type: string;
        mime: string;
        data: string;
      }[];
      const byId = new Map(previews.map((p) => [p.fileId, p]));
      expect(byId.has(large.fileId)).toBe(true);
      expect(byId.has(small.fileId)).toBe(true);
      expect(byId.get(large.fileId)!.type).toBe('image');
      expect(byId.get(large.fileId)!.mime).toBe('image/webp');
      expect(byId.get(small.fileId)!.mime).toBe('image/png');
      expect(byId.has(text.fileId)).toBe(false);
      expect(res.body.notFound).toEqual([]);
      const smallData = Buffer.from(byId.get(small.fileId)!.data, 'base64');
      expect(smallData.equals(small.bytes)).toBe(true);
    });

    it('lists files invisible to the caller in notFound', async () => {
      const res = await request(app)
        .post('/api/previews')
        .set('Cookie', alice)
        .send({ ids: [large.fileId, secret.fileId, 9999] });
      expect(res.status).toBe(200);
      expect(res.body.notFound).toEqual([secret.fileId, 9999]);
      const ids = (res.body.previews as { fileId: number }[]).map((p) => p.fileId);
      expect(ids).toEqual([large.fileId]);
    });
  });
});
