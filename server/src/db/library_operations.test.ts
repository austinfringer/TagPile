import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './index.ts';
import { createTestDb, createTestUser } from '../test/helpers.ts';
import * as libOps from './library_operations.ts';
import * as tagOps from './tagging_operations.ts';
import { createFile, createLocation, getFileById, getVisibleFile } from './file_operations.ts';

describe('library_operations', () => {
  let db: Db;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => db.close());

  describe('normalizeRootPath', () => {
    it('resolves and strips a trailing separator', () => {
      expect(libOps.normalizeRootPath('/a/b/')).toBe('/a/b');
      expect(libOps.normalizeRootPath('/a/./b/../c')).toBe('/a/c');
    });
    it('leaves the filesystem root alone', () => {
      expect(libOps.normalizeRootPath('/')).toBe('/');
    });
  });

  describe('createLibrary', () => {
    it('stores the normalized root and timestamps', () => {
      const id = libOps.createLibrary(db, 'lib', '/data/lib/');
      expect(libOps.getLibraryById(db, id)).toMatchObject({
        name: 'lib',
        root_path: '/data/lib',
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
    });

    it('rejects a root equal to an existing library', () => {
      libOps.createLibrary(db, 'a', '/data/a');
      expect(() => libOps.createLibrary(db, 'b', '/data/a/')).toThrow(libOps.LibraryOverlapError);
    });

    it('rejects a root inside an existing library', () => {
      libOps.createLibrary(db, 'a', '/data/a');
      expect(() => libOps.createLibrary(db, 'b', '/data/a/sub')).toThrow(/overlaps library "a"/);
    });

    it('rejects a root that contains an existing library', () => {
      libOps.createLibrary(db, 'a', '/data/a/sub');
      expect(() => libOps.createLibrary(db, 'b', '/data/a')).toThrow(/overlaps library "a"/);
    });

    it('allows siblings, including ones sharing a string prefix', () => {
      libOps.createLibrary(db, 'a', '/data/a');
      expect(() => libOps.createLibrary(db, 'b', '/data/b')).not.toThrow();
      expect(() => libOps.createLibrary(db, 'ab', '/data/ab')).not.toThrow();
    });

    it('rejects duplicate names', () => {
      libOps.createLibrary(db, 'a', '/data/a');
      expect(() => libOps.createLibrary(db, 'a', '/data/b')).toThrow(/UNIQUE/);
    });
  });

  describe('updateLibrary', () => {
    it('renames and relinks, keeping relative locations intact', () => {
      const id = libOps.createLibrary(db, 'a', '/data/a');
      const fileId = createFile(db, 'h', 1);
      createLocation(db, 'x/y.jpg', id, fileId);

      libOps.updateLibrary(db, id, { name: 'renamed', rootPath: '/moved/a/' });

      expect(libOps.getLibraryById(db, id)).toMatchObject({
        name: 'renamed',
        root_path: '/moved/a',
      });
      expect(db.prepare('SELECT path FROM locations WHERE library_id = ?').get(id)).toEqual({
        path: 'x/y.jpg',
      });
    });

    it('does not count the library itself as an overlap', () => {
      const id = libOps.createLibrary(db, 'a', '/data/a');
      expect(() => libOps.updateLibrary(db, id, { rootPath: '/data/a' })).not.toThrow();
    });

    it('rejects relinking into another library', () => {
      const id = libOps.createLibrary(db, 'a', '/data/a');
      libOps.createLibrary(db, 'b', '/data/b');
      expect(() => libOps.updateLibrary(db, id, { rootPath: '/data/b/inner' })).toThrow(
        libOps.LibraryOverlapError,
      );
    });

    it('is a no-op with no fields', () => {
      const id = libOps.createLibrary(db, 'a', '/data/a');
      const before = libOps.getLibraryById(db, id);
      libOps.updateLibrary(db, id, {});
      expect(libOps.getLibraryById(db, id)).toEqual(before);
    });
  });

  describe('deleteLibrary', () => {
    it('cascades members, locations and tags, and sweeps files nobody references', () => {
      const user = createTestUser(db);
      const a = libOps.createLibrary(db, 'a', '/data/a');
      const b = libOps.createLibrary(db, 'b', '/data/b');
      libOps.addMember(db, a, user.id, 'owner');
      const onlyA = createFile(db, 'only-a', 1);
      const shared = createFile(db, 'shared', 1);
      createLocation(db, 'x', a, onlyA);
      createLocation(db, 'y', a, shared);
      createLocation(db, 'z', b, shared);
      const now = new Date().toISOString();
      db.prepare('INSERT INTO tags (library_id, created_at, updated_at) VALUES (?, ?, ?)').run(
        a,
        now,
        now,
      );

      libOps.deleteLibrary(db, a);

      expect(libOps.getLibraryById(db, a)).toBeNull();
      expect(libOps.accessibleLibraryIds(db, user.id)).toEqual([]);
      expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT COUNT(*) AS n FROM locations').get()).toEqual({ n: 1 });
      expect(getFileById(db, onlyA)).toBeNull();
      expect(getFileById(db, shared)).not.toBeNull();
    });

    it('keeps files that are only referenced as a location\u2019s previous content', () => {
      const a = libOps.createLibrary(db, 'a', '/data/a');
      const b = libOps.createLibrary(db, 'b', '/data/b');
      const old = createFile(db, 'old', 1);
      const current = createFile(db, 'new', 1);
      createLocation(db, 'x', a, old);
      const loc = createLocation(db, 'y', b, current);
      db.prepare('UPDATE locations SET previous_file_id = ? WHERE location_id = ?').run(old, loc);

      libOps.deleteLibrary(db, a);

      expect(getFileById(db, old)).not.toBeNull();
    });

    it('decrements tag counts for instances lost with orphan files', () => {
      const a = libOps.createLibrary(db, 'a', '/data/a');
      const fileId = createFile(db, 'f', 1);
      createLocation(db, 'x', a, fileId);
      const tagId = tagOps.createTag(db, { alias: 'mario', libraryId: a });
      tagOps.tagFile(db, fileId, tagId, a);
      expect((tagOps.getTag(db, tagId) as { file_count: number }).file_count).toBe(1);

      db.prepare('DELETE FROM locations WHERE file_id = ?').run(fileId);
      expect(libOps.deleteOrphanFiles(db)).toBe(1);

      expect(getFileById(db, fileId)).toBeNull();
      expect((tagOps.getTag(db, tagId) as { file_count: number }).file_count).toBe(0);
    });
  });

  describe('members and access', () => {
    it('resolves roles by name and exposes their capabilities', () => {
      const user = createTestUser(db);
      const id = libOps.createLibrary(db, 'a', '/data/a');
      libOps.addMember(db, id, user.id, 'viewer');
      expect(libOps.getMemberRole(db, id, user.id)).toMatchObject({
        name: 'viewer',
        can_read: 1,
        can_create_tag: 0,
        can_tag_files: 0,
        can_manage_library: 0,
      });
      expect(libOps.getRoleByName(db, 'owner')).toMatchObject({ can_manage_library: 1 });
    });

    it('returns null for non-members', () => {
      const user = createTestUser(db);
      const id = libOps.createLibrary(db, 'a', '/data/a');
      expect(libOps.getMemberRole(db, id, user.id)).toBeNull();
    });

    it('lists only libraries the user belongs to', () => {
      const alice = createTestUser(db);
      const bob = createTestUser(db, { username: 'bob', email: 'bob@example.com' });
      const a = libOps.createLibrary(db, 'a', '/data/a');
      const b = libOps.createLibrary(db, 'b', '/data/b');
      libOps.createLibrary(db, 'c', '/data/c');
      libOps.addMember(db, a, alice.id, 'owner');
      libOps.addMember(db, b, alice.id, 'viewer');
      libOps.addMember(db, b, bob.id, 'owner');

      expect(libOps.accessibleLibraryIds(db, alice.id).sort()).toEqual([a, b].sort());
      expect(libOps.accessibleLibraryIds(db, bob.id)).toEqual([b]);
      expect(
        libOps.listLibraries(db, libOps.accessibleLibraryIds(db, alice.id)).map((l) => l.name),
      ).toEqual(['a', 'b']);
      expect(libOps.listLibraries(db, [])).toEqual([]);
    });
  });

  describe('visibleFilesClause', () => {
    it('shows a file through any location in an accessible library, missing or not', () => {
      const a = libOps.createLibrary(db, 'a', '/data/a');
      const b = libOps.createLibrary(db, 'b', '/data/b');
      const inA = createFile(db, 'in-a', 1);
      const inB = createFile(db, 'in-b', 1);
      const both = createFile(db, 'both', 1);
      const loc = createLocation(db, 'x', a, inA);
      createLocation(db, 'y', b, inB);
      createLocation(db, 'p', a, both);
      createLocation(db, 'q', b, both);
      db.prepare('UPDATE locations SET missing = 1 WHERE location_id = ?').run(loc);

      expect(getVisibleFile(db, inA, [a])).not.toBeNull();
      expect(getVisibleFile(db, inB, [a])).toBeNull();
      expect(getVisibleFile(db, both, [a])).not.toBeNull();
      expect(getVisibleFile(db, both, [b])).not.toBeNull();
      expect(getVisibleFile(db, inA, [])).toBeNull();
    });
  });
});
