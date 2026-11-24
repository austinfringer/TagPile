import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loginTestUser } from '../test/helpers.ts';
import * as libOps from '../db/library_operations.ts';
import * as tagOps from '../db/tagging_operations.ts';
import { createFile, createLocation, locationMetadata } from '../db/file_operations.ts';

describe('library file routes', () => {
  const { app, db } = createTestApp();
  let alice: string; //owner of A
  let carol: string; //viewer of A
  let bob: string; //owner of B, not a member of A
  let libA: number;
  let libB: number;
  let files: number[]; //in A, by path a.jpg, b.png, c.txt
  let fileB: number;
  let seq = 0;

  const tag = (libraryId = libA) => tagOps.createTag(db, { alias: `tag${++seq}`, libraryId });
  const base = () => `/api/libraries/${libA}`;
  const get = (path: string, cookie = alice) =>
    request(app).get(`${base()}${path}`).set('Cookie', cookie);
  const send = (
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
    cookie = alice,
  ) => request(app)[method](`${base()}${path}`).set('Cookie', cookie).send(body);
  const fileCount = (tagId: number) => tagOps.getTag(db, tagId)!.file_count;
  const instances = (fileIds: number[]) => tagOps.getFileInstances(db, fileIds, libA);
  const counts = () =>
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM file_tag_relationships) AS rels,
                (SELECT COUNT(*) FROM file_tag_values) AS vals`,
      )
      .get();

  beforeAll(async () => {
    const a = await loginTestUser(app, db);
    const c = await loginTestUser(app, db, { username: 'carol', email: 'carol@example.com' });
    const b = await loginTestUser(app, db, { username: 'bob', email: 'bob@example.com' });
    alice = a.cookie;
    carol = c.cookie;
    bob = b.cookie;
    libA = libOps.createLibrary(db, 'A', '/data/a');
    libB = libOps.createLibrary(db, 'B', '/data/b');
    libOps.addMember(db, libA, a.user.id, 'owner');
    libOps.addMember(db, libA, c.user.id, 'viewer');
    libOps.addMember(db, libB, b.user.id, 'owner');

    files = ['a.jpg', 'b.png', 'c.txt'].map((path, i) => {
      const id = createFile(db, `hash-${path}`, (i + 1) * 10);
      createLocation(db, path, libA, id, locationMetadata(path, 0, 0));
      return id;
    });
    fileB = createFile(db, 'hash-b', 5);
    createLocation(db, 'other.jpg', libB, fileB);
  });
  afterAll(() => db.close());

  describe('scope and permissions', () => {
    it('returns 404 for a non-member and for an unknown library', async () => {
      const res = await get('/files', bob);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Library not found' });
      await request(app).get('/api/libraries/9999/files').set('Cookie', alice).expect(404);
      await request(app).get('/api/libraries/abc/files').set('Cookie', alice).expect(404);
    });

    it('requires a session', async () => {
      await request(app).get(`${base()}/files`).expect(401);
    });

    it('lets a viewer read but not write', async () => {
      const t = tag();
      await get('/files', carol).expect(200);
      await get(`/files/${files[0]}`, carol).expect(200);
      const res = await send('put', `/files/${files[0]}/tags/${t}`, undefined, carol);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Forbidden' });
      await send('post', '/files/batch', { fileIds: [files[0]], ops: [] }, carol).expect(403);
    });

    it('returns JSON 404 for an unknown path under a library', async () => {
      const res = await get('/nope');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    });

    it('keeps the existing library routes', async () => {
      const res = await request(app).get(`/api/libraries/${libA}`).set('Cookie', alice);
      expect(res.status).toBe(200);
      expect(res.body.library).toMatchObject({ name: 'A', role: 'owner' });
    });
  });

  describe('GET /files', () => {
    it('pages through the results with a total', async () => {
      const res = await get('/files?limit=2&offset=0');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.files.map((f: { fileId: number }) => f.fileId)).toEqual(files.slice(0, 2));
      expect(res.body.files[0]).toMatchObject({ name: 'a.jpg', size: 10, missing: false });

      const page2 = await get('/files?limit=2&offset=2');
      expect(page2.body).toMatchObject({ total: 3, files: [{ fileId: files[2] }] });
    });

    it('skips the count with count=0', async () => {
      const res = await get('/files?limit=2&offset=2&count=0');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: null, files: [{ fileId: files[2] }] });
    });

    it('filters by the query', async () => {
      const t = tag();
      tagOps.tagFile(db, files[1]!, t, libA);
      const res = await get(`/files?q=tag${seq}`);
      expect(res.body).toMatchObject({ total: 1, files: [{ fileId: files[1] }] });
    });

    it('clamps a large limit and rejects a bad one', async () => {
      await get('/files?limit=100000').expect(200);
      await get('/files?limit=-1').expect(400);
      await get('/files?offset=x').expect(400);
    });

    it('returns 400 for a syntax error', async () => {
      const res = await get(`/files?q=${encodeURIComponent('(')}`);
      expect(res.status).toBe(400);
    });
  });

  describe('GET /autocomplete', () => {
    it('completes tag names of the library only', async () => {
      tagOps.createTag(db, { alias: 'zebra', libraryId: libA });
      tagOps.createTag(db, { alias: 'zulu', libraryId: libB });
      const res = await get('/autocomplete?q=z');
      expect(res.status).toBe(200);
      expect(res.body.completions).toEqual([
        expect.objectContaining({ text: 'zebra', kind: 'tag' }),
      ]);
      expect(res.body).toMatchObject({ from: 0, to: 1 });
      await get('/autocomplete?q=z&limit=x').expect(400);
    });
  });

  describe('GET /files/:fileId', () => {
    it('returns the summary, locations and instances', async () => {
      const t = tag();
      tagOps.tagFile(db, files[2]!, t, libA);
      const res = await get(`/files/${files[2]}`);
      expect(res.status).toBe(200);
      expect(res.body.file).toMatchObject({ fileId: files[2], name: 'c.txt', locationCount: 1 });
      expect(res.body.locations).toEqual([expect.objectContaining({ path: 'c.txt' })]);
      expect(res.body.instances).toContainEqual({ tagId: t, name: `tag${seq}`, values: [] });
      expect(res.body.tags[t]).toMatchObject({ tagId: t, name: `tag${seq}` });
    });

    it('returns 404 for a file of another library and for a bad id', async () => {
      const res = await get(`/files/${fileB}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'File not found' });
      await get('/files/abc').expect(404);
    });
  });

  describe('POST /files/query', () => {
    it('returns the found files in order and lists the others', async () => {
      const res = await send('post', '/files/query', {
        ids: [files[1], fileB, files[0], 9999],
        include: ['locations', 'instances'],
      });
      expect(res.status).toBe(200);
      expect(res.body.files.map((f: { fileId: number }) => f.fileId)).toEqual([files[1], files[0]]);
      expect(res.body.files[0].locations).toEqual([expect.objectContaining({ path: 'b.png' })]);
      expect(Array.isArray(res.body.files[0].instances)).toBe(true);
      expect(res.body.notFound).toEqual([fileB, 9999]);
    });

    it('leaves out what was not asked for', async () => {
      const res = await send('post', '/files/query', { ids: [files[0]] });
      expect(res.body.files[0]).not.toHaveProperty('locations');
      expect(res.body.files[0]).not.toHaveProperty('instances');
      expect(res.body).not.toHaveProperty('tags');
    });

    it('includes tag summaries for attached tags, refTagId values, and category parents when instances are requested', async () => {
      const category = tagOps.createTag(db, {
        alias: `cat${++seq}`,
        libraryId: libA,
        color: '#1416b2',
        isCategory: true,
      });
      const child = tagOps.createTag(db, {
        alias: `child${++seq}`,
        libraryId: libA,
        color: '#10b981',
        parentId: category,
      });
      const ref = tagOps.createTag(db, {
        alias: `ref${++seq}`,
        libraryId: libA,
        color: '#ec4899',
      });
      tagOps.tagFile(db, files[0]!, child, libA);
      tagOps.createRefFileValue(db, files[0]!, child, ref, libA);

      const res = await send('post', '/files/query', {
        ids: [files[0]],
        include: ['instances'],
      });
      expect(res.status).toBe(200);
      expect(res.body.tags[child]).toMatchObject({
        tagId: child,
        color: '#10b981',
        isCategory: false,
      });
      expect(res.body.tags[child].parentName).toBe(res.body.tags[category].name);
      expect(res.body.tags[category]).toMatchObject({
        tagId: category,
        color: '#1416b2',
        isCategory: true,
      });
      expect(res.body.tags[ref]).toMatchObject({
        tagId: ref,
        color: '#ec4899',
        isCategory: false,
      });
    });

    it.each([
      [{}],
      [{ ids: [] }],
      [{ ids: [1.5] }],
      [{ ids: ['1'] }],
      [{ ids: Array.from({ length: 501 }, (_, i) => i + 1) }],
      [{ ids: [1], include: ['tags'] }],
    ])('returns 400 for %j', async (body) => {
      await send('post', '/files/query', body).expect(400);
    });
  });

  describe('single tag routes', () => {
    it('applies a tag idempotently and removes it', async () => {
      const t = tag();
      await send('put', `/files/${files[0]}/tags/${t}`).expect(204);
      await send('put', `/files/${files[0]}/tags/${t}`).expect(204);
      expect(fileCount(t)).toBe(1);
      await send('delete', `/files/${files[0]}/tags/${t}`).expect(204);
      expect(fileCount(t)).toBe(0);
    });

    it('returns 404 for a tag or a file of another library', async () => {
      const t = tag();
      const other = tag(libB);
      const res = await send('put', `/files/${files[0]}/tags/${other}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Tag not found' });
      await send('put', `/files/${fileB}/tags/${t}`).expect(404);
      await send('put', `/files/${files[0]}/tags/abc`).expect(404);
    });

    it('adds and deletes values', async () => {
      const t = tag();
      const ref = tag();
      await send('put', `/files/${files[0]}/tags/${t}`).expect(204);

      const text = await send('post', `/files/${files[0]}/tags/${t}/values`, {
        kind: 'text',
        text: 'hello',
      });
      expect(text.status).toBe(201);
      expect(text.body.value).toEqual({ valueId: expect.any(Number), kind: 'text', text: 'hello' });

      const num = await send('post', `/files/${files[0]}/tags/${t}/values`, {
        kind: 'number',
        number: 4,
      });
      expect(num.body.value).toMatchObject({ kind: 'number', number: 4 });

      const refValue = await send('post', `/files/${files[0]}/tags/${t}/values`, {
        kind: 'tag',
        refTagId: ref,
      });
      expect(refValue.body.value).toMatchObject({ kind: 'tag', refTagId: ref });
      expect(fileCount(ref)).toBe(1);

      const anchor = await send('post', `/files/${files[0]}/tags/${t}/values`, {
        kind: 'anchor',
        anchor: { tStart: 1, tEnd: 2 },
      });
      expect(anchor.body.value).toEqual({
        valueId: expect.any(Number),
        kind: 'anchor',
        tStart: 1,
        tEnd: 2,
        rx: null,
        ry: null,
        rw: null,
        rh: null,
      });

      await send('delete', `/files/${files[0]}/values/${text.body.value.valueId}`).expect(204);
      await send('delete', `/files/${files[0]}/values/${text.body.value.valueId}`).expect(404);
      const patched = await send('patch', `/files/${files[0]}/values/${num.body.value.valueId}`, {
        kind: 'number',
        number: 42,
      });
      expect(patched.status).toBe(200);
      expect(patched.body.value).toEqual({
        valueId: num.body.value.valueId,
        kind: 'number',
        number: 42,
      });
      const values = instances([files[0]!])
        .get(files[0]!)!
        .find((i) => i.tagId === t)!.values;
      expect(values.map((v) => v.kind)).toEqual(['number', 'tag', 'anchor']);
    });

    it('rejects bad values', async () => {
      const t = tag();
      await send('put', `/files/${files[0]}/tags/${t}`).expect(204);
      const path = `/files/${files[0]}/tags/${t}/values`;
      await send('post', path, { kind: 'text', text: '' }).expect(400);
      await send('post', path, { kind: 'colour' }).expect(400);
      await send('post', path, { kind: 'anchor', anchor: { tStart: 'x' } }).expect(400);
      //Passes the shape check; the DB layer rejects the range.
      await send('post', path, { kind: 'anchor', anchor: { tStart: 5, tEnd: 1 } }).expect(400);
      await send('post', path, { kind: 'tag', refTagId: tag(libB) }).expect(404);
      await send('post', path, { kind: 'tag', refTagId: t }).expect(400);
    });

    it('returns 404 when the tag is not applied', async () => {
      const t = tag();
      await send('post', `/files/${files[0]}/tags/${t}/values`, {
        kind: 'number',
        number: 1,
      }).expect(404);
    });
  });

  describe('POST /files/batch', () => {
    it('gives the same result as the single routes', async () => {
      const t = tag();
      const ref = tag();
      const ops = [
        { op: 'tag', tagId: t },
        { op: 'addValue', tagId: t, value: { kind: 'text', text: 'x' } },
        { op: 'addValue', tagId: t, value: { kind: 'tag', refTagId: ref } },
      ];
      const res = await send('post', '/files/batch', { fileIds: [files[0], files[1]], ops });
      expect(res.status).toBe(200);
      expect(res.body.files.map((f: { fileId: number }) => f.fileId)).toEqual([files[0], files[1]]);

      await send('put', `/files/${files[2]}/tags/${t}`).expect(204);
      await send('post', `/files/${files[2]}/tags/${t}/values`, { kind: 'text', text: 'x' });
      await send('post', `/files/${files[2]}/tags/${t}/values`, { kind: 'tag', refTagId: ref });

      const strip = (fileId: number) =>
        instances([fileId])
          .get(fileId)!
          .filter((i) => i.tagId === t || i.tagId === ref)
          .map((i) => ({ ...i, values: i.values.map(({ valueId: _, ...v }) => v) }));
      expect(strip(files[0]!)).toEqual(strip(files[2]!));
      expect(strip(files[1]!)).toEqual(strip(files[2]!));
      expect(fileCount(t)).toBe(3);
      expect(fileCount(ref)).toBe(3);
    });

    it('applies the tag implicitly for addValue, untags and clears values', async () => {
      const t = tag();
      const fileIds = [files[0], files[1]];
      await send('post', '/files/batch', {
        fileIds,
        ops: [{ op: 'addValue', tagId: t, value: { kind: 'number', number: 3 } }],
      }).expect(200);
      expect(fileCount(t)).toBe(2);
      await send('post', '/files/batch', {
        fileIds,
        ops: [{ op: 'clearValues', tagId: t }],
      }).expect(200);
      expect(
        instances([files[0]!])
          .get(files[0]!)!
          .find((i) => i.tagId === t)!.values,
      ).toEqual([]);
      await send('post', '/files/batch', { fileIds, ops: [{ op: 'untag', tagId: t }] }).expect(200);
      expect(fileCount(t)).toBe(0);
    });

    it('rolls back everything when an op fails in the DB', async () => {
      const t = tag();
      const ref = tag();
      const before = counts();
      const res = await send('post', '/files/batch', {
        fileIds: [files[0], files[1]],
        ops: [
          { op: 'tag', tagId: t },
          { op: 'addValue', tagId: t, value: { kind: 'tag', refTagId: ref } },
          { op: 'addValue', tagId: t, value: { kind: 'tag', refTagId: ref } }, //duplicate ref
        ],
      });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ opIndex: 2, fileId: files[0] });
      expect(counts()).toEqual(before);
      expect(fileCount(t)).toBe(0);
      expect(fileCount(ref)).toBe(0);
    });

    it('rolls back when an anchor passes the shape check but fails in the DB', async () => {
      const t = tag();
      const before = counts();
      const res = await send('post', '/files/batch', {
        fileIds: [files[0], files[1]],
        ops: [
          { op: 'tag', tagId: t },
          { op: 'addValue', tagId: t, value: { kind: 'anchor', anchor: { rx: 0.5 } } },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ opIndex: 1, fileId: files[0] });
      expect(res.body.error).toMatch(/region/);
      expect(counts()).toEqual(before);
      expect(fileCount(t)).toBe(0);
    });

    it('validates every op and id before it writes', async () => {
      const t = tag();
      const before = counts();
      const fileIds = [files[0]];

      const shape = await send('post', '/files/batch', {
        fileIds,
        ops: [
          { op: 'tag', tagId: t },
          { op: 'paint', tagId: t },
        ],
      });
      expect(shape.status).toBe(400);
      expect(shape.body.opIndex).toBe(1);

      const badValue = await send('post', '/files/batch', {
        fileIds,
        ops: [{ op: 'addValue', tagId: t, value: { kind: 'text' } }],
      });
      expect(badValue.status).toBe(400);
      expect(badValue.body.opIndex).toBe(0);

      const otherTag = await send('post', '/files/batch', {
        fileIds,
        ops: [
          { op: 'tag', tagId: t },
          { op: 'tag', tagId: tag(libB) },
        ],
      });
      expect(otherTag.status).toBe(404);
      expect(otherTag.body).toMatchObject({ error: 'Tag not found', opIndex: 1 });

      const otherRef = await send('post', '/files/batch', {
        fileIds,
        ops: [{ op: 'addValue', tagId: t, value: { kind: 'tag', refTagId: tag(libB) } }],
      });
      expect(otherRef.status).toBe(404);
      expect(otherRef.body.opIndex).toBe(0);

      const otherFile = await send('post', '/files/batch', {
        fileIds: [files[0], fileB],
        ops: [{ op: 'tag', tagId: t }],
      });
      expect(otherFile.status).toBe(404);
      expect(otherFile.body).toEqual({ error: 'File not found', fileId: fileB });

      expect(counts()).toEqual(before);
      expect(fileCount(t)).toBe(0);
    });

    it.each([
      ['no fileIds', { ops: [{ op: 'tag', tagId: 1 }] }],
      ['empty fileIds', { fileIds: [], ops: [{ op: 'tag', tagId: 1 }] }],
      [
        '501 fileIds',
        { fileIds: Array.from({ length: 501 }, (_, i) => i + 1), ops: [{ op: 'tag', tagId: 1 }] },
      ],
      ['no ops', { fileIds: [1], ops: [] }],
      [
        '51 ops',
        { fileIds: [1], ops: Array.from({ length: 51 }, () => ({ op: 'tag', tagId: 1 })) },
      ],
    ])('returns 400 for %s', async (_name, body) => {
      await send('post', '/files/batch', body).expect(400);
    });
  });
});
