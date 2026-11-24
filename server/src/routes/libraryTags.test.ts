import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loginTestUser } from '../test/helpers.ts';
import * as libOps from '../db/library_operations.ts';
import * as tagOps from '../db/tagging_operations.ts';

describe('library tag routes', () => {
  const { app, db } = createTestApp();
  let alice: string; //owner of A
  let carol: string; //viewer of A
  let bob: string; //owner of B, not a member of A
  let libA: number;
  let libB: number;
  let seq = 0;

  const name = () => `tag${++seq}`;
  const tag = (libraryId = libA, alias = name()) => tagOps.createTag(db, { alias, libraryId });
  const base = () => `/api/libraries/${libA}`;
  const get = (path: string, cookie = alice) =>
    request(app).get(`${base()}${path}`).set('Cookie', cookie);
  const send = (
    method: 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
    cookie = alice,
  ) => request(app)[method](`${base()}${path}`).set('Cookie', cookie).send(body);
  const detail = (tagId: number) => tagOps.getTagDetail(db, tagId, libA);
  const parentValue = (tagId: number, parentId: number) =>
    detail(tagId)
      .instances.find((i) => i.tagId === parentId)
      ?.values.find((v) => v.kind === 'parent');

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
  });
  afterAll(() => db.close());

  describe('scope and permissions', () => {
    it('returns 404 for a non-member', async () => {
      const res = await get('/tags', bob);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Library not found' });
    });

    it('lets a viewer read but not write', async () => {
      const t = tag();
      await get('/tags', carol).expect(200);
      await get(`/tags/${t}`, carol).expect(200);
      await send('post', '/tags', { alias: name() }, carol).expect(403);
      await send('patch', `/tags/${t}`, { color: 'red' }, carol).expect(403);
      await send('delete', `/tags/${t}`, undefined, carol).expect(403);
    });

    it('returns 404 for a tag of another library and for a bad id', async () => {
      const other = tag(libB);
      const res = await get(`/tags/${other}`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Tag not found' });
      await get('/tags/abc').expect(404);
      await send('put', `/tags/${tag()}/parents/${other}`).expect(404);
      await send('put', `/tags/${tag()}/tags/${other}`).expect(404);
    });
  });

  describe('tag CRUD', () => {
    it('creates, reads, updates and deletes a tag', async () => {
      const alias = name();
      const created = await send('post', '/tags', { alias, color: '#f00', isCategory: true });
      expect(created.status).toBe(201);
      const tagId = created.body.tag.tag.tag_id;
      expect(created.body.tag).toMatchObject({
        tag: { library_id: libA, color: '#f00', is_category: 1 },
        aliases: [{ text: alias, is_primary: 1 }],
        instances: [],
      });

      const read = await get(`/tags/${tagId}`);
      expect(read.body.tag.tag.tag_id).toBe(tagId);

      const patched = await send('patch', `/tags/${tagId}`, {
        color: null,
        isCategory: false,
        wikiText: 'Some **wiki** text',
      });
      expect(patched.status).toBe(200);
      expect(patched.body.tag.tag).toMatchObject({
        color: null,
        is_category: 0,
        wiki_text: 'Some **wiki** text',
      });

      await send('delete', `/tags/${tagId}`).expect(204);
      await get(`/tags/${tagId}`).expect(404);
    });

    it('creates a tag under a parent', async () => {
      const parent = tag();
      const res = await send('post', '/tags', { alias: name(), parentId: parent });
      expect(res.status).toBe(201);
      expect(res.body.tag.instances).toEqual([
        expect.objectContaining({
          tagId: parent,
          values: [expect.objectContaining({ kind: 'parent' })],
        }),
      ]);
      await send('post', '/tags', { alias: name(), parentId: tag(libB) }).expect(404);
    });

    it('lists and searches tags', async () => {
      tag(libA, 'listme-one');
      tag(libA, 'listme-two');
      tag(libB, 'listme-three');
      const res = await get('/tags?q=listme&limit=1');
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.tags).toHaveLength(1);
      await get('/tags?limit=x').expect(400);
    });

    it('rejects bad bodies and duplicate root names', async () => {
      await send('post', '/tags', {}).expect(400);
      await send('post', '/tags', { alias: '  ' }).expect(400);
      await send('post', '/tags', { alias: name(), isCategory: 'yes' }).expect(400);
      await send('post', '/tags', { alias: name(), parentId: 'x' }).expect(400);
      tag(libA, 'twin');
      await send('post', '/tags', { alias: 'twin' }).expect(409);
      await send('patch', `/tags/${tag()}`, { color: 5 }).expect(400);
      await send('patch', `/tags/${tag()}`, { wikiText: 123 }).expect(400);
      await send('post', '/tags', { alias: name(), wikiText: 123 }).expect(400);
    });
  });

  describe('aliases', () => {
    it('adds, flags and deletes aliases', async () => {
      const t = tag();
      const added = await send('post', `/tags/${t}/aliases`, { text: 'other' });
      expect(added.status).toBe(201);
      const alias = added.body.tag.aliases.find((a: { text: string }) => a.text === 'other');
      expect(alias).toMatchObject({ is_primary: 0 });

      const flagged = await send('patch', `/tags/${t}/aliases/${alias.alias_id}`, {
        primary: true,
        shorthand: true,
      });
      expect(flagged.status).toBe(200);
      expect(flagged.body.tag.aliases[0]).toMatchObject({
        text: 'other',
        is_primary: 1,
        is_shorthand: 1,
      });

      await send('delete', `/tags/${t}/aliases/${alias.alias_id}`).expect(204);
      const [last] = detail(t).aliases;
      expect(last).toMatchObject({ is_primary: 1 });
      const res = await send('delete', `/tags/${t}/aliases/${last!.alias_id}`);
      expect(res.status).toBe(409);

      const renamed = await send('patch', `/tags/${t}/aliases/${last!.alias_id}`, {
        text: 'renamed-last',
        shorthand: false,
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body.tag.aliases[0]).toMatchObject({
        text: 'renamed-last',
        is_primary: 1,
        is_shorthand: 0,
      });
    });

    it('returns 409 for an alias a sibling already uses', async () => {
      const parent = tag();
      const a = tagOps.createTag(db, { alias: name(), libraryId: libA, parentId: parent });
      const b = tagOps.createTag(db, { alias: name(), libraryId: libA, parentId: parent });
      await send('post', `/tags/${b}/aliases`, { text: 'shared' }).expect(201);
      await send('post', `/tags/${a}/aliases`, { text: 'shared' }).expect(409);
    });

    it('returns 404 for an alias of another tag and 400 for a bad body', async () => {
      const t = tag();
      const other = detail(tag()).aliases[0]!;
      await send('patch', `/tags/${t}/aliases/${other.alias_id}`, { primary: true }).expect(404);
      await send('delete', `/tags/${t}/aliases/${other.alias_id}`).expect(404);
      await send('patch', `/tags/${t}/aliases/abc`, { primary: true }).expect(404);
      const own = detail(t).aliases[0]!;
      await send('patch', `/tags/${t}/aliases/${own.alias_id}`, { primary: false }).expect(400);
      await send('post', `/tags/${t}/aliases`, {}).expect(400);
    });
  });

  describe('parents', () => {
    it('adds parents, sets the primary, and removes them', async () => {
      const t = tag();
      const p1 = tag();
      const p2 = tag();
      await send('put', `/tags/${t}/parents/${p1}`, { primary: true }).expect(204);
      await send('put', `/tags/${t}/parents/${p2}`).expect(204);
      expect(parentValue(t, p1)).toMatchObject({ primary: true });
      expect(parentValue(t, p2)).toMatchObject({ primary: false });

      //Idempotent; only `primary: true` changes an existing parent.
      await send('put', `/tags/${t}/parents/${p2}`).expect(204);
      expect(parentValue(t, p1)).toMatchObject({ primary: true });
      await send('put', `/tags/${t}/parents/${p2}`, { primary: true }).expect(204);
      expect(parentValue(t, p1)).toMatchObject({ primary: false });
      expect(parentValue(t, p2)).toMatchObject({ primary: true });

      await send('delete', `/tags/${t}/parents/${p1}`).expect(204);
      expect(parentValue(t, p1)).toBeUndefined();
      await send('delete', `/tags/${t}/parents/${p1}`).expect(404);
    });

    it('returns 409 for a cycle and 400 for a self parent', async () => {
      const a = tag();
      const b = tag();
      await send('put', `/tags/${b}/parents/${a}`).expect(204);
      const res = await send('put', `/tags/${a}/parents/${b}`);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/cycle/);
      await send('put', `/tags/${a}/parents/${a}`).expect(400);
      await send('put', `/tags/${a}/parents/${b}`, { primary: 'yes' }).expect(400);
    });
  });

  describe('components', () => {
    it('adds, updates and removes a component', async () => {
      const t = tag();
      const c = tag();
      const component = () =>
        detail(t)
          .instances.find((i) => i.tagId === c)
          ?.values.find((v) => v.kind === 'component');
      await send('put', `/tags/${t}/components/${c}`).expect(204);
      expect(component()).toMatchObject({ recursive: false, attributed: true });
      await send('put', `/tags/${t}/components/${c}`, {
        recursive: true,
        attributed: false,
      }).expect(204);
      expect(component()).toMatchObject({ recursive: true, attributed: false });
      await send('delete', `/tags/${t}/components/${c}`).expect(204);
      expect(component()).toBeUndefined();
      await send('delete', `/tags/${t}/components/${c}`).expect(404);
      await send('put', `/tags/${t}/components/${c}`, { recursive: 1 }).expect(400);
    });
  });

  describe('tags on tags', () => {
    it('applies a tag, adds values, and removes them', async () => {
      const subject = tag();
      const t = tag();
      const ref = tag();
      await send('put', `/tags/${subject}/tags/${t}`).expect(204);
      await send('put', `/tags/${subject}/tags/${t}`).expect(204);

      const text = await send('post', `/tags/${subject}/tags/${t}/values`, {
        kind: 'text',
        text: 'hi',
      });
      expect(text.status).toBe(201);
      expect(text.body.value).toEqual({ valueId: expect.any(Number), kind: 'text', text: 'hi' });
      const num = await send('post', `/tags/${subject}/tags/${t}/values`, {
        kind: 'number',
        number: 2,
      });
      expect(num.body.value).toMatchObject({ kind: 'number', number: 2 });
      const refValue = await send('post', `/tags/${subject}/tags/${t}/values`, {
        kind: 'tag',
        refTagId: ref,
      });
      expect(refValue.body.value).toMatchObject({ kind: 'tag', refTagId: ref });
      await send('post', `/tags/${subject}/tags/${t}/values`, {
        kind: 'tag',
        refTagId: ref,
      }).expect(409);

      const updatedText = await send(
        'patch',
        `/tags/${subject}/values/${text.body.value.valueId}`,
        {
          kind: 'text',
          text: 'hello',
        },
      );
      expect(updatedText.status).toBe(200);
      expect(updatedText.body.value).toEqual({
        valueId: text.body.value.valueId,
        kind: 'text',
        text: 'hello',
      });

      await send('delete', `/tags/${subject}/values/${text.body.value.valueId}`).expect(204);
      await send('delete', `/tags/${subject}/values/${text.body.value.valueId}`).expect(404);

      await send('delete', `/tags/${subject}/tags/${t}`).expect(204);
      expect(detail(subject).instances.map((i) => i.tagId)).toEqual([ref]);
    });

    it('rejects bad values', async () => {
      const subject = tag();
      const t = tag();
      const path = `/tags/${subject}/tags/${t}/values`;
      await send('post', path, { kind: 'anchor' }).expect(400);
      await send('post', path, { kind: 'number', number: 'x' }).expect(400);
      await send('post', path, { kind: 'tag', refTagId: tag(libB) }).expect(404);
      await send('put', `/tags/${subject}/tags/${subject}`).expect(400);
    });
  });

  describe('tag graph', () => {
    it('returns every tag of the library and the edges between them', async () => {
      const parent = tag();
      const child = tag();
      const part = tag();
      const other = tag(libB);
      tagOps.addAlias(db, child, `${name()}-alias`, libA);
      tagOps.createParentTagValue(db, child, parent, { primary: true });
      tagOps.createComponentTagValue(db, child, part, {});
      tagOps.createTextTagValue(db, child, part, 'note');
      tagOps.tagTag(db, parent, part);

      const res = await get('/tag-graph', carol).expect(200);
      const tags = res.body.tags as { tagId: number; name: string; aliases: string[] }[];
      const ids = tags.map((t) => t.tagId);
      expect(ids).toEqual(expect.arrayContaining([parent, child, part]));
      expect(ids).not.toContain(other);
      expect(tags.find((t) => t.tagId === child)?.aliases).toHaveLength(1);
      expect(tags.find((t) => t.tagId === parent)?.aliases).toEqual([]);

      const edges = res.body.edges as { subjectTagId: number; tagId: number }[];
      const edge = (subject: number, tagId: number) =>
        edges.find((e) => e.subjectTagId === subject && e.tagId === tagId);
      expect(edge(child, parent)).toEqual({
        subjectTagId: child,
        tagId: parent,
        parent: true,
        primary: true,
        component: false,
        valueCount: 0,
      });
      expect(edge(child, part)).toMatchObject({ parent: false, component: true, valueCount: 1 });
      expect(edge(parent, part)).toMatchObject({ parent: false, component: false, valueCount: 0 });
    });

    it('returns 404 for a non-member', async () => {
      await get('/tag-graph', bob).expect(404);
    });
  });
});
