import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './index.ts';
import { createTestDb } from '../test/helpers.ts';
import * as libOps from './library_operations.ts';
import {
  createFile,
  createLocation,
  filesInLibrary,
  getFileSummaries,
  getLocationsInLibrary,
  locationMetadata,
  migrateFileData,
  updateLocationMissing,
} from './file_operations.ts';

describe('file_operations', () => {
  let db: Db;
  let libraryId: number;
  let otherLib: number;
  beforeEach(() => {
    db = createTestDb();
    libraryId = libOps.createLibrary(db, 'lib', '/data/lib');
    otherLib = libOps.createLibrary(db, 'other', '/data/other');
  });
  afterEach(() => db.close());

  let nextHash = 0;
  const makeFile = (size = 1) => createFile(db, `hash${nextHash++}`, size);
  const locate = (fileId: number, path: string, lib: number = libraryId) =>
    createLocation(db, path, lib, fileId, locationMetadata(path, null, null));

  /** Inserts a tag directly, so these tests do not depend on tagging_operations. */
  const insertTag = (lib: number = libraryId) => {
    const now = new Date().toISOString();
    return db
      .prepare('INSERT INTO tags (library_id, created_at, updated_at) VALUES (?, ?, ?)')
      .run(lib, now, now).lastInsertRowid as number;
  };
  const applyTag = (fileId: number, tagId: number) => {
    db.prepare('INSERT INTO file_tag_relationships (file_id, tag_id) VALUES (?, ?)').run(
      fileId,
      tagId,
    );
    db.prepare('UPDATE tags SET file_count = file_count + 1 WHERE tag_id = ?').run(tagId);
  };
  const fileCount = (tagId: number) =>
    (
      db.prepare('SELECT file_count FROM tags WHERE tag_id = ?').get(tagId) as {
        file_count: number;
      }
    ).file_count;
  const tagsOf = (fileId: number) =>
    (
      db
        .prepare('SELECT tag_id FROM file_tag_relationships WHERE file_id = ? ORDER BY tag_id')
        .all(fileId) as { tag_id: number }[]
    ).map((r) => r.tag_id);

  describe('migrateFileData', () => {
    it('copies only the scanning library tags and bumps file_count for new rows only', () => {
      const oldFile = makeFile();
      const newFile = makeFile();
      const a = insertTag();
      const b = insertTag();
      const foreign = insertTag(otherLib);
      applyTag(oldFile, a);
      applyTag(oldFile, b);
      applyTag(oldFile, foreign);
      //The new content already has `b`, so copying must not count it again.
      applyTag(newFile, b);

      migrateFileData(db, oldFile, newFile, libraryId);

      expect(tagsOf(newFile)).toEqual([a, b]);
      expect(fileCount(a)).toBe(2);
      expect(fileCount(b)).toBe(2);
      expect(fileCount(foreign)).toBe(1);
    });

    it('keeps file_count equal to the real instance count', () => {
      const oldFile = makeFile();
      const newFile = makeFile();
      const a = insertTag();
      applyTag(oldFile, a);
      migrateFileData(db, oldFile, newFile, libraryId);
      migrateFileData(db, oldFile, newFile, libraryId);
      const actual = (
        db.prepare('SELECT COUNT(*) AS n FROM file_tag_relationships WHERE tag_id = ?').get(a) as {
          n: number;
        }
      ).n;
      expect(fileCount(a)).toBe(actual);
      expect(actual).toBe(2);
    });
  });

  describe('filesInLibrary', () => {
    it('returns the ids with a location in the library, missing or not', () => {
      const here = makeFile();
      locate(here, 'a.png');
      const missing = makeFile();
      updateLocationMissing(db, locate(missing, 'b.png'));
      const elsewhere = makeFile();
      locate(elsewhere, 'c.png', otherLib);
      const nowhere = makeFile();

      expect(filesInLibrary(db, [here, missing, elsewhere, nowhere, 9999], libraryId)).toEqual(
        new Set([here, missing]),
      );
      expect(filesInLibrary(db, [], libraryId)).toEqual(new Set());
    });

    it('handles more ids than one statement can bind', () => {
      const ids: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const id = makeFile();
        locate(id, `f${i}.txt`);
        ids.push(id);
      }
      const result = filesInLibrary(db, [...ids, 123456], libraryId);
      expect(result.size).toBe(1000);
      expect(result.has(ids[999]!)).toBe(true);
    });
  });

  describe('getLocationsInLibrary', () => {
    it('groups locations by file, ordered by path, in this library only', () => {
      const f = makeFile();
      locate(f, 'z/last.png');
      locate(f, 'a/first.png');
      locate(f, 'x.png', otherLib);
      const g = makeFile();
      locate(g, 'g.png', otherLib);

      const result = getLocationsInLibrary(db, [f, g], libraryId);
      expect([...result.keys()]).toEqual([f]);
      expect(result.get(f)!.map((l) => l.path)).toEqual(['a/first.png', 'z/last.png']);
      expect(getLocationsInLibrary(db, [], libraryId).size).toBe(0);
    });
  });

  describe('getFileSummaries', () => {
    it('summarizes files in the given order and skips files outside the library', () => {
      const big = makeFile(2048);
      locate(big, 'photos/b.png');
      updateLocationMissing(db, locate(big, 'photos/a.jpg'));
      locate(big, 'c.txt', otherLib);
      const gone = makeFile(10);
      updateLocationMissing(db, locate(gone, 'old/z.mp4'));
      updateLocationMissing(db, locate(gone, 'old/y.mp4'));
      const foreign = makeFile();
      locate(foreign, 'f.png', otherLib);

      expect(getFileSummaries(db, [gone, foreign, big], libraryId)).toEqual([
        {
          fileId: gone,
          name: 'y.mp4',
          path: 'old/y.mp4',
          type: 'video',
          extension: 'mp4',
          size: 10,
          missing: true,
          locationCount: 2,
        },
        {
          fileId: big,
          name: 'b.png',
          path: 'photos/b.png',
          type: 'image',
          extension: 'png',
          size: 2048,
          missing: false,
          locationCount: 2,
        },
      ]);
      expect(getFileSummaries(db, [], libraryId)).toEqual([]);
    });
  });
});
