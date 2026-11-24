import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './index.ts';
import { createTestDb } from '../test/helpers.ts';
import { ConflictError, NotFoundError, ValidationError } from './errors.ts';
import * as fileOps from './file_operations.ts';
import * as libOps from './library_operations.ts';
import * as tagOps from './tagging_operations.ts';

describe('tagging_operations', () => {
  let db: Db;
  let libraryId: number;
  beforeEach(() => {
    db = createTestDb();
    libraryId = libOps.createLibrary(db, 'lib', '/data/lib');
  });
  afterEach(() => db.close());

  const tag = (alias: string, lib = libraryId, parentId?: number) =>
    tagOps.createTag(db, { alias, libraryId: lib, parentId });

  const ancestorsOf = (tagId: number) =>
    db
      .prepare(`SELECT ancestor_id FROM tag_ancestors WHERE descendant_id = ? ORDER BY ancestor_id`)
      .all(tagId)
      .map((row) => (row as { ancestor_id: number }).ancestor_id);

  const fileCountOf = (tagId: number) => tagOps.getTag(db, tagId)!.file_count;

  const newFile = (hash: string, path: string, lib = libraryId) => {
    const fileId = fileOps.createFile(db, hash, 100);
    fileOps.createLocation(db, path, lib, fileId);
    return fileId;
  };

  describe('createTag', () => {
    it('sets the timestamps, color, category flag and primary alias', () => {
      const tagId = tagOps.createTag(db, {
        alias: '  mario ',
        libraryId,
        color: '#ff0000',
        isCategory: true,
      });
      const record = tagOps.getTag(db, tagId)!;
      expect(record).toEqual(
        expect.objectContaining({ library_id: libraryId, color: '#ff0000', is_category: 1 }),
      );
      expect(record.created_at).toBe(record.updated_at);
      expect(tagOps.getTagPrimaryAlias(db, tagId, libraryId)?.text).toBe('mario');
    });

    it('adds the parent in the same transaction', () => {
      const character = tag('character');
      const mario = tag('mario', libraryId, character);
      expect(ancestorsOf(mario)).toEqual([character, mario].sort((a, b) => a - b));
    });

    it('rejects a parent from another library and creates nothing', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const outsider = tag('outsider', otherLibraryId);
      expect(() => tag('mario', libraryId, outsider)).toThrow(NotFoundError);
      expect(tagOps.searchTagByAlias(db, 'mario', libraryId)).toBeUndefined();
    });

    it('rejects an empty or reserved alias (T7)', () => {
      expect(() => tag('')).toThrow(ValidationError);
      expect(() => tag('   ')).toThrow(ValidationError);
      expect(() => tag('*')).toThrow(ValidationError);
      expect(() => tagOps.validateAliasText(5)).toThrow(ValidationError);
      expect(tagOps.validateAliasText(' a* ')).toBe('a*');
    });
  });

  describe('updateTag', () => {
    it('sets color, category, and wikiText and updates updated_at', async () => {
      const tagId = tag('mario');
      const before = tagOps.getTag(db, tagId)!;
      expect(before.wiki_text).toBe('');
      await new Promise((resolve) => setTimeout(resolve, 5));
      tagOps.updateTag(db, tagId, libraryId, {
        color: '#00ff00',
        isCategory: true,
        wikiText: '# Mario\nNintendo mascot.',
      });
      const after = tagOps.getTag(db, tagId)!;
      expect(after.color).toBe('#00ff00');
      expect(after.is_category).toBe(1);
      expect(after.wiki_text).toBe('# Mario\nNintendo mascot.');
      expect(after.updated_at > before.updated_at).toBe(true);
      expect(after.created_at).toBe(before.created_at);
      tagOps.updateTag(db, tagId, libraryId, { color: null });
      expect(tagOps.getTag(db, tagId)!.color).toBeNull();
      expect(tagOps.getTag(db, tagId)!.is_category).toBe(1);
      expect(tagOps.getTag(db, tagId)!.wiki_text).toBe('# Mario\nNintendo mascot.');
    });

    it('rejects a tag from another library', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const outsider = tag('outsider', otherLibraryId);
      expect(() => tagOps.updateTag(db, outsider, libraryId, { color: '#000' })).toThrow(
        NotFoundError,
      );
    });
  });

  describe('aliases', () => {
    it('deletes a non-primary alias and leaves the primary intact', () => {
      const tagId = tag('main');
      tagOps.addAlias(db, tagId, 'other', libraryId);
      tagOps.deleteAlias(db, tagId, 'other', libraryId);
      const aliases = tagOps.getTagAliases(db, tagId, libraryId);
      expect(aliases).toEqual([expect.objectContaining({ text: 'main', is_primary: 1 })]);
    });

    it('promotes another alias when the primary is deleted', () => {
      const tagId = tag('main');
      tagOps.addAlias(db, tagId, 'other', libraryId);
      tagOps.deleteAlias(db, tagId, 'main', libraryId);
      expect(tagOps.getTagPrimaryAlias(db, tagId, libraryId)?.text).toBe('other');
    });

    it('throws when deleting the last alias and leaves it in place', () => {
      const tagId = tag('main');
      expect(() => tagOps.deleteAlias(db, tagId, 'main', libraryId)).toThrow(/last alias/);
      expect(() => tagOps.deleteAlias(db, tagId, 'main', libraryId)).toThrow(ConflictError);
      const alias = tagOps.getTagAliases(db, tagId, libraryId)[0]!;
      expect(() => tagOps.deleteAliasById(db, tagId, alias.alias_id, libraryId)).toThrow(
        ConflictError,
      );
      expect(tagOps.getTagAliases(db, tagId, libraryId)).toHaveLength(1);
    });

    it('looks up and deletes an alias by id', () => {
      const tagId = tag('main');
      const aliasId = tagOps.addAlias(db, tagId, 'other', libraryId);
      expect(tagOps.getAliasById(db, tagId, aliasId, libraryId).text).toBe('other');
      tagOps.deleteAliasById(db, tagId, aliasId, libraryId);
      expect(() => tagOps.getAliasById(db, tagId, aliasId, libraryId)).toThrow(NotFoundError);
    });

    it('rejects an alias id of another tag', () => {
      const a = tag('a');
      const b = tag('b');
      const aliasId = tagOps.addAlias(db, b, 'bee', libraryId);
      expect(() => tagOps.getAliasById(db, a, aliasId, libraryId)).toThrow(NotFoundError);
      expect(() => tagOps.deleteAliasById(db, a, aliasId, libraryId)).toThrow(NotFoundError);
    });

    it('derives library_id from the tag and checks the library argument (T6)', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const tagId = tag('main');
      expect(() => tagOps.addAlias(db, tagId, 'x', otherLibraryId)).toThrow(NotFoundError);
      expect(() => tagOps.setAliasPrimary(db, tagId, 'main', otherLibraryId)).toThrow(
        NotFoundError,
      );
      expect(() => tagOps.deleteAlias(db, tagId, 'main', otherLibraryId)).toThrow(NotFoundError);
      const aliasId = tagOps.addAlias(db, tagId, 'other', libraryId);
      expect(tagOps.getAliasById(db, tagId, aliasId, libraryId).library_id).toBe(libraryId);
      expect(db.prepare(`SELECT * FROM aliases WHERE library_id = ?`).all(otherLibraryId)).toEqual(
        [],
      );
    });

    it('rejects an empty or reserved alias text (T7)', () => {
      const tagId = tag('main');
      expect(() => tagOps.addAlias(db, tagId, ' ', libraryId)).toThrow(ValidationError);
      expect(() => tagOps.addAlias(db, tagId, '*', libraryId)).toThrow(ValidationError);
      expect(() => tagOps.addAlias(db, tagId, 'main', libraryId)).toThrow(ConflictError);
      expect(tagOps.getTagAliases(db, tagId, libraryId)).toHaveLength(1);
    });

    it('sets the primary alias, and leaves it intact for an unknown text (T5)', () => {
      const tagId = tag('main');
      tagOps.addAlias(db, tagId, 'other', libraryId);
      tagOps.setAliasPrimary(db, tagId, 'other', libraryId);
      expect(tagOps.getTagPrimaryAlias(db, tagId, libraryId)?.text).toBe('other');
      expect(() => tagOps.setAliasPrimary(db, tagId, 'missing', libraryId)).toThrow(NotFoundError);
      expect(tagOps.getTagPrimaryAlias(db, tagId, libraryId)?.text).toBe('other');
    });

    it('sets one shorthand, and leaves it intact for an unknown text (T5)', () => {
      const tagId = tag('main');
      tagOps.addAlias(db, tagId, 'm', libraryId);
      tagOps.addAlias(db, tagId, 'mn', libraryId);
      tagOps.setAliasShorthand(db, tagId, 'm', libraryId);
      tagOps.setAliasShorthand(db, tagId, 'mn', libraryId);
      expect(tagOps.getTagShorthand(db, tagId, libraryId)?.text).toBe('mn');
      expect(() => tagOps.setAliasShorthand(db, tagId, 'missing', libraryId)).toThrow(
        NotFoundError,
      );
      expect(tagOps.getTagShorthand(db, tagId, libraryId)?.text).toBe('mn');
    });

    it('updates alias text and clears shorthand or primary flags', () => {
      const tagId = tag('main');
      const otherId = tagOps.addAlias(db, tagId, 'other', libraryId);
      tagOps.updateAliasText(db, tagId, otherId, '  renamed ', libraryId);
      expect(tagOps.getAliasById(db, tagId, otherId, libraryId).text).toBe('renamed');

      expect(() => tagOps.updateAliasText(db, tagId, otherId, 'main', libraryId)).toThrow(
        ConflictError,
      );

      tagOps.setAliasShorthand(db, tagId, 'renamed', libraryId);
      expect(tagOps.getTagShorthand(db, tagId, libraryId)?.text).toBe('renamed');
      tagOps.clearAliasShorthand(db, tagId, otherId, libraryId);
      expect(tagOps.getTagShorthand(db, tagId, libraryId)).toBeUndefined();

      const mainId = tagOps.getTagPrimaryAlias(db, tagId, libraryId)!.alias_id;
      tagOps.clearAliasPrimary(db, tagId, mainId, libraryId);
      expect(tagOps.getTagPrimaryAlias(db, tagId, libraryId)?.alias_id).toBe(otherId);
    });
  });

  describe('sibling uniqueness', () => {
    it('allows the same alias under different parents', () => {
      const pet = tag('pet');
      const character = tag('character');
      const a = tag('mario', libraryId, pet);
      const b = tag('mario', libraryId, character);
      expect(a).not.toBe(b);
    });

    it('allows the same alias for a root and a child', () => {
      const character = tag('character');
      tag('mario', libraryId, character);
      expect(() => tag('mario')).not.toThrow();
    });

    it('rejects the same alias under one shared parent', () => {
      const character = tag('character');
      tag('mario', libraryId, character);
      expect(() => tag('mario', libraryId, character)).toThrow(ConflictError);
      const luigi = tag('luigi', libraryId, character);
      expect(() => tagOps.addAlias(db, luigi, 'mario', libraryId)).toThrow(ConflictError);
    });

    it('rejects the same alias between two roots, also as a second alias', () => {
      tag('mario');
      expect(() => tag('mario')).toThrow(ConflictError);
      const luigi = tag('luigi');
      expect(() => tagOps.addAlias(db, luigi, 'mario', libraryId)).toThrow(ConflictError);
      expect(tagOps.getTagAliases(db, luigi, libraryId)).toHaveLength(1);
    });

    it('allows the same root alias in another library', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      tag('mario');
      expect(() => tag('mario', otherLibraryId)).not.toThrow();
    });

    it('rejects adding a parent that causes a clash, and rolls back', () => {
      const character = tag('character');
      const pet = tag('pet');
      tag('mario', libraryId, character);
      const otherMario = tag('mario', libraryId, pet);
      expect(() => tagOps.createParentTagValue(db, otherMario, character)).toThrow(ConflictError);
      expect(ancestorsOf(otherMario)).toEqual([otherMario, pet].sort((a, b) => a - b));
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_relationships WHERE subject_tag_id = ? AND tag_id = ?`)
          .all(otherMario, character),
      ).toEqual([]);
    });

    it('rejects removing a parent that makes a root clash, by every removal path', () => {
      tag('mario');
      const character = tag('character');
      const child = tag('mario', libraryId, character);
      const parentValue = tagOps
        .getTagDetail(db, child, libraryId)
        .instances[0]!.values.find((v) => v.kind === 'parent')!;
      expect(() => tagOps.untagTag(db, child, character)).toThrow(ConflictError);
      expect(() => tagOps.deleteTagValue(db, child, character)).toThrow(ConflictError);
      expect(() => tagOps.deleteTagValueById(db, child, parentValue.valueId)).toThrow(
        ConflictError,
      );
      expect(() => tagOps.deleteTagValuesOfKind(db, child, character, 'parent')).toThrow(
        ConflictError,
      );
      //Every attempt rolled back: the parent and the closure rows stay.
      expect(ancestorsOf(child)).toEqual([character, child].sort((a, b) => a - b));
    });

    it('rejects deleting a tag whose children would clash with a root', () => {
      tag('mario');
      const character = tag('character');
      const child = tag('mario', libraryId, character);
      expect(() => tagOps.deleteTag(db, character, libraryId)).toThrow(ConflictError);
      expect(tagOps.getTag(db, character)).toBeDefined();
      expect(ancestorsOf(child)).toEqual([character, child].sort((a, b) => a - b));
    });

    it('rejects deleting a tag when a child that becomes a root clashes by a second alias', () => {
      tag('jumpman');
      const character = tag('character');
      const child = tag('mario', libraryId, character);
      tagOps.addAlias(db, child, 'jumpman', libraryId);
      expect(() => tagOps.deleteTag(db, character, libraryId)).toThrow(ConflictError);
      expect(tagOps.getTag(db, character)).toBeDefined();
    });

    it('allows deleting a tag when a child keeps another parent', () => {
      tag('mario');
      const character = tag('character');
      const plumber = tag('plumber');
      const child = tag('mario', libraryId, character);
      tagOps.createParentTagValue(db, child, plumber);
      expect(() => tagOps.deleteTag(db, character, libraryId)).not.toThrow();
    });
  });

  describe('tagFile', () => {
    let fileId: number;
    beforeEach(() => {
      fileId = newFile('hash1', 'a.png');
    });

    const instancesOf = (file: number) =>
      db
        .prepare(`SELECT tag_id FROM file_tag_relationships WHERE file_id = ? ORDER BY tag_id`)
        .all(file)
        .map((row) => (row as { tag_id: number }).tag_id);

    const linksFrom = (file: number, tagId: number) =>
      db
        .prepare(
          `SELECT t.ref_tag_id FROM file_tag_values v
           JOIN file_tag_value_tag t ON t.value_id = v.value_id
           WHERE v.file_id = ? AND v.tag_id = ? AND v.kind = 'tag' ORDER BY t.ref_tag_id`,
        )
        .all(file, tagId)
        .map((row) => (row as { ref_tag_id: number }).ref_tag_id);

    it('applies the tag to the file', () => {
      const tagId = tag('mario');
      tagOps.tagFile(db, fileId, tagId, libraryId);
      expect(instancesOf(fileId)).toEqual([tagId]);
    });

    it('throws when the file has no location in the library', () => {
      const tagId = tag('mario');
      const otherFileId = fileOps.createFile(db, 'hash2', 200);
      expect(() => tagOps.tagFile(db, otherFileId, tagId, libraryId)).toThrow(/no location/);
      expect(() => tagOps.tagFile(db, otherFileId, tagId, libraryId)).toThrow(NotFoundError);
      expect(instancesOf(otherFileId)).toEqual([]);
    });

    it('throws when the tag does not exist or belongs to another library', () => {
      expect(() => tagOps.tagFile(db, fileId, 999, libraryId)).toThrow(/not found/);
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const otherTagId = tag('mario', otherLibraryId);
      expect(() => tagOps.tagFile(db, fileId, otherTagId, libraryId)).toThrow(NotFoundError);
      expect(instancesOf(fileId)).toEqual([]);
    });

    it('applies component tags without a value link when they are not attributed', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createComponentTagValue(db, mario, overalls, { attributed: false });
      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(instancesOf(fileId)).toEqual([mario, overalls]);
      expect(linksFrom(fileId, overalls)).toEqual([]);
      expect(linksFrom(fileId, mario)).toEqual([]);
    });

    it('applies every component value of the tag', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      const hat = tag('hat');
      const mustache = tag('mustache');
      tagOps.createComponentTagValue(db, mario, overalls, { attributed: false });
      tagOps.createComponentTagValue(db, mario, hat, { recursive: true, attributed: false });
      tagOps.createComponentTagValue(db, mario, mustache, { attributed: true });
      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(instancesOf(fileId)).toEqual([mario, overalls, hat, mustache]);
      expect(linksFrom(fileId, overalls)).toEqual([]);
      expect(linksFrom(fileId, hat)).toEqual([]);
      expect(linksFrom(fileId, mustache)).toEqual([mario]);
      expect(linksFrom(fileId, mario)).toEqual([]);
    });

    it('links an attributed component one way, at its owner', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createComponentTagValue(db, mario, overalls, { attributed: true });
      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(linksFrom(fileId, overalls)).toEqual([mario]);
      expect(linksFrom(fileId, mario)).toEqual([]);
    });

    it("applies a component's own components only when the edge is recursive", () => {
      const mario = tag('mario');
      const peach = tag('peach');
      const overalls = tag('overalls');
      const straps = tag('straps');
      tagOps.createComponentTagValue(db, overalls, straps, { attributed: false });
      tagOps.createComponentTagValue(db, mario, overalls, { attributed: false });
      tagOps.createComponentTagValue(db, peach, overalls, { recursive: true, attributed: false });

      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(instancesOf(fileId)).toEqual([mario, overalls]);

      tagOps.tagFile(db, fileId, peach, libraryId);
      expect(instancesOf(fileId)).toEqual([mario, peach, overalls, straps]);
      expect(linksFrom(fileId, straps)).toEqual([]);
    });

    it('terminates on component cycles', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createComponentTagValue(db, mario, overalls, { recursive: true, attributed: true });
      tagOps.createComponentTagValue(db, overalls, mario, { recursive: true, attributed: true });
      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(instancesOf(fileId)).toEqual([mario, overalls]);
      expect(linksFrom(fileId, overalls)).toEqual([mario]);
      expect(linksFrom(fileId, mario)).toEqual([overalls]);
    });

    it('reuses an existing instance and only adds the missing link', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createComponentTagValue(db, mario, overalls, { attributed: true });
      tagOps.tagFile(db, fileId, overalls, libraryId);
      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(instancesOf(fileId)).toEqual([mario, overalls]);
      expect(linksFrom(fileId, overalls)).toEqual([mario]);
    });

    it('counts each tagged file once and ignores re-tags', () => {
      const mario = tag('mario');
      expect(fileCountOf(mario)).toBe(0);
      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(fileCountOf(mario)).toBe(1);
      const otherFileId = newFile('hash2', 'b.png');
      tagOps.tagFile(db, otherFileId, mario, libraryId);
      expect(fileCountOf(mario)).toBe(2);
      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(fileCountOf(mario)).toBe(2);
    });

    it('counts flattened component tags', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createComponentTagValue(db, mario, overalls, { attributed: false });
      tagOps.tagFile(db, fileId, mario, libraryId);
      expect(fileCountOf(mario)).toBe(1);
      expect(fileCountOf(overalls)).toBe(1);
      tagOps.tagFile(db, fileId, overalls, libraryId);
      expect(fileCountOf(overalls)).toBe(1);
    });
  });

  describe('untagFile', () => {
    let fileId: number;
    beforeEach(() => {
      fileId = newFile('hash1', 'a.png');
    });

    it('removes the instance and decrements the count', () => {
      const mario = tag('mario');
      tagOps.tagFile(db, fileId, mario, libraryId);
      tagOps.untagFile(db, fileId, mario, libraryId);
      expect(
        db.prepare(`SELECT tag_id FROM file_tag_relationships WHERE file_id = ?`).all(fileId),
      ).toEqual([]);
      expect(fileCountOf(mario)).toBe(0);
    });

    it('does not move the count when no instance existed', () => {
      const mario = tag('mario');
      const peach = tag('peach');
      tagOps.tagFile(db, fileId, peach, libraryId);
      tagOps.untagFile(db, fileId, mario, libraryId);
      expect(fileCountOf(mario)).toBe(0);
      expect(fileCountOf(peach)).toBe(1);
    });

    it('rejects a tag from another library and leaves the instance (T4)', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      fileOps.createLocation(db, 'a.png', otherLibraryId, fileId);
      const outsider = tag('outsider', otherLibraryId);
      tagOps.tagFile(db, fileId, outsider, otherLibraryId);
      expect(() => tagOps.untagFile(db, fileId, outsider, libraryId)).toThrow(NotFoundError);
      expect(fileCountOf(outsider)).toBe(1);
    });
  });

  describe('file values', () => {
    let fileId: number;
    let cat: number;
    beforeEach(() => {
      fileId = newFile('hash1', 'a.png');
      cat = tag('cat');
      tagOps.tagFile(db, fileId, cat, libraryId);
    });

    const valuesOf = (tagId: number) => {
      const instances = tagOps.getFileInstances(db, [fileId], libraryId).get(fileId)!;
      return instances.find((i) => i.tagId === tagId)?.values;
    };

    it('creates text and number values and returns their ids', () => {
      const textId = tagOps.createTextFileValue(db, fileId, cat, 'Mario', libraryId);
      const numberId = tagOps.createNumberFileValue(db, fileId, cat, 4, libraryId);
      expect(valuesOf(cat)).toEqual([
        { valueId: textId, kind: 'text', text: 'Mario' },
        { valueId: numberId, kind: 'number', number: 4 },
      ]);
    });

    it('rejects a non-finite number', () => {
      expect(() => tagOps.createNumberFileValue(db, fileId, cat, NaN, libraryId)).toThrow(
        ValidationError,
      );
      expect(() => tagOps.createNumberFileValue(db, fileId, cat, Infinity, libraryId)).toThrow(
        ValidationError,
      );
    });

    it('rejects a value when the tag is not applied or outside the library', () => {
      const dog = tag('dog');
      expect(() => tagOps.createTextFileValue(db, fileId, dog, 'x', libraryId)).toThrow(
        /not applied/,
      );
      expect(() => tagOps.createTextFileValue(db, fileId, dog, 'x', libraryId)).toThrow(
        NotFoundError,
      );
      const loose = fileOps.createFile(db, 'hash2', 1);
      expect(() => tagOps.createTextFileValue(db, loose, cat, 'x', libraryId)).toThrow(
        NotFoundError,
      );
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const outsider = tag('outsider', otherLibraryId);
      expect(() => tagOps.createTextFileValue(db, fileId, outsider, 'x', libraryId)).toThrow(
        NotFoundError,
      );
    });

    describe('anchors (T10)', () => {
      const noTime = { tStart: null, tEnd: null };
      const noRegion = { rx: null, ry: null, rw: null, rh: null };

      it('accepts a time part, a region part, or both', () => {
        const a = tagOps.createAnchorFileValue(db, fileId, cat, { tStart: 5 }, libraryId);
        const b = tagOps.createAnchorFileValue(
          db,
          fileId,
          cat,
          { rx: 0.1, ry: 0.2, rw: 0.5, rh: 0.8 },
          libraryId,
        );
        const c = tagOps.createAnchorFileValue(
          db,
          fileId,
          cat,
          { tStart: 1, tEnd: 2, rx: 0, ry: 0, rw: 1, rh: 1 },
          libraryId,
        );
        expect(valuesOf(cat)).toEqual([
          { valueId: a, kind: 'anchor', ...noRegion, tStart: 5, tEnd: null },
          { valueId: b, kind: 'anchor', ...noTime, rx: 0.1, ry: 0.2, rw: 0.5, rh: 0.8 },
          { valueId: c, kind: 'anchor', tStart: 1, tEnd: 2, rx: 0, ry: 0, rw: 1, rh: 1 },
        ]);
      });

      it.each<[string, tagOps.AnchorInput]>([
        ['empty', {}],
        ['tEnd without tStart', { tEnd: 3 }],
        ['negative tStart', { tStart: -1 }],
        ['tEnd before tStart', { tStart: 5, tEnd: 4 }],
        ['partial region', { rx: 0.1, ry: 0.1, rw: 0.1 }],
        ['region above 1', { rx: 0, ry: 0, rw: 1.5, rh: 0.5 }],
        ['negative region', { rx: -0.1, ry: 0, rw: 0.5, rh: 0.5 }],
        ['region overflow', { rx: 0.6, ry: 0, rw: 0.6, rh: 0.5 }],
        ['NaN', { tStart: NaN }],
      ])('rejects %s', (_name, anchor) => {
        expect(() => tagOps.createAnchorFileValue(db, fileId, cat, anchor, libraryId)).toThrow(
          ValidationError,
        );
        expect(valuesOf(cat)).toEqual([]);
      });
    });

    describe('createRefFileValue', () => {
      it('applies the ref tag first and adds the value (T2)', () => {
        const orange = tag('orange');
        const valueId = tagOps.createRefFileValue(db, fileId, cat, orange, libraryId);
        expect(valuesOf(cat)).toEqual([{ valueId, kind: 'tag', refTagId: orange }]);
        expect(valuesOf(orange)).toEqual([]);
        expect(fileCountOf(orange)).toBe(1);
      });

      it('reuses an applied ref tag without counting it again', () => {
        const orange = tag('orange');
        tagOps.tagFile(db, fileId, orange, libraryId);
        tagOps.createRefFileValue(db, fileId, cat, orange, libraryId);
        expect(fileCountOf(orange)).toBe(1);
      });

      it('rejects a duplicate ref, a self ref, and a ref outside the library', () => {
        const orange = tag('orange');
        tagOps.createRefFileValue(db, fileId, cat, orange, libraryId);
        expect(() => tagOps.createRefFileValue(db, fileId, cat, orange, libraryId)).toThrow(
          ConflictError,
        );
        expect(() => tagOps.createRefFileValue(db, fileId, cat, cat, libraryId)).toThrow(
          ValidationError,
        );
        const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
        const outsider = tag('outsider', otherLibraryId);
        expect(() => tagOps.createRefFileValue(db, fileId, cat, outsider, libraryId)).toThrow(
          NotFoundError,
        );
        expect(valuesOf(cat)).toHaveLength(1);
      });

      it('removes the value when the ref instance is removed', () => {
        const orange = tag('orange');
        tagOps.createRefFileValue(db, fileId, cat, orange, libraryId);
        tagOps.untagFile(db, fileId, orange, libraryId);
        expect(valuesOf(cat)).toEqual([]);
        //The base row goes too, not only the payload row.
        expect(db.prepare(`SELECT * FROM file_tag_values WHERE file_id = ?`).all(fileId)).toEqual(
          [],
        );
      });
    });

    it('deletes one value by id (T8)', () => {
      const a = tagOps.createTextFileValue(db, fileId, cat, 'a', libraryId);
      const b = tagOps.createTextFileValue(db, fileId, cat, 'b', libraryId);
      tagOps.deleteFileValueById(db, fileId, a, libraryId);
      expect(valuesOf(cat)).toEqual([{ valueId: b, kind: 'text', text: 'b' }]);
      expect(() => tagOps.deleteFileValueById(db, fileId, a, libraryId)).toThrow(NotFoundError);
      const otherFile = newFile('hash2', 'b.png');
      expect(() => tagOps.deleteFileValueById(db, otherFile, b, libraryId)).toThrow(NotFoundError);
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      expect(() => tagOps.deleteFileValueById(db, fileId, b, otherLibraryId)).toThrow(
        NotFoundError,
      );
      expect(valuesOf(cat)).toHaveLength(1);
    });

    it('deletes every value of the instance and keeps the instance', () => {
      tagOps.createTextFileValue(db, fileId, cat, 'a', libraryId);
      tagOps.createNumberFileValue(db, fileId, cat, 1, libraryId);
      tagOps.deleteFileValue(db, fileId, cat);
      expect(valuesOf(cat)).toEqual([]);
    });

    it('updates text, number, tag, and anchor values in place', () => {
      const orange = tag('orange');
      const black = tag('black');
      const textId = tagOps.createTextFileValue(db, fileId, cat, 'old', libraryId);
      const numId = tagOps.createNumberFileValue(db, fileId, cat, 1, libraryId);
      const refId = tagOps.createRefFileValue(db, fileId, cat, orange, libraryId);
      const anchorId = tagOps.createAnchorFileValue(db, fileId, cat, { tStart: 1 }, libraryId);

      tagOps.updateFileValueById(db, fileId, textId, { kind: 'text', text: 'new' }, libraryId);
      tagOps.updateFileValueById(db, fileId, numId, { kind: 'number', number: 9 }, libraryId);
      tagOps.updateFileValueById(db, fileId, refId, { kind: 'tag', refTagId: black }, libraryId);
      tagOps.updateFileValueById(
        db,
        fileId,
        anchorId,
        { kind: 'anchor', anchor: { tStart: 2, tEnd: 5 } },
        libraryId,
      );

      expect(valuesOf(cat)).toEqual([
        { valueId: textId, kind: 'text', text: 'new' },
        { valueId: numId, kind: 'number', number: 9 },
        { valueId: refId, kind: 'tag', refTagId: black },
        {
          valueId: anchorId,
          kind: 'anchor',
          tStart: 2,
          tEnd: 5,
          rx: null,
          ry: null,
          rw: null,
          rh: null,
        },
      ]);
      expect(fileCountOf(black)).toBe(1);
    });

    it('rejects invalid value updates', () => {
      const orange = tag('orange');
      const black = tag('black');
      const textId = tagOps.createTextFileValue(db, fileId, cat, 'old', libraryId);
      const refId = tagOps.createRefFileValue(db, fileId, cat, orange, libraryId);
      tagOps.createRefFileValue(db, fileId, cat, black, libraryId);

      expect(() =>
        tagOps.updateFileValueById(db, fileId, textId, { kind: 'number', number: 1 }, libraryId),
      ).toThrow(ValidationError);
      expect(() =>
        tagOps.updateFileValueById(db, fileId, textId, { kind: 'text', text: '' }, libraryId),
      ).toThrow(ValidationError);
      expect(() =>
        tagOps.updateFileValueById(db, fileId, refId, { kind: 'tag', refTagId: cat }, libraryId),
      ).toThrow(ValidationError);
      expect(() =>
        tagOps.updateFileValueById(db, fileId, refId, { kind: 'tag', refTagId: black }, libraryId),
      ).toThrow(ConflictError);
      expect(() =>
        tagOps.updateFileValueById(db, fileId, 9999, { kind: 'text', text: 'x' }, libraryId),
      ).toThrow(NotFoundError);
    });
  });

  describe('tagTag (T3)', () => {
    it('is idempotent', () => {
      const mario = tag('mario');
      const hero = tag('hero');
      tagOps.tagTag(db, mario, hero);
      tagOps.tagTag(db, mario, hero);
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_relationships WHERE subject_tag_id = ? AND tag_id = ?`)
          .all(mario, hero),
      ).toHaveLength(1);
    });

    it('rejects a missing tag, another library, and itself', () => {
      const mario = tag('mario');
      expect(() => tagOps.tagTag(db, mario, 999)).toThrow(NotFoundError);
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const outsider = tag('outsider', otherLibraryId);
      expect(() => tagOps.tagTag(db, mario, outsider)).toThrow(ValidationError);
      expect(() => tagOps.tagTag(db, mario, mario)).toThrow(ValidationError);
      expect(() => tagOps.createComponentTagValue(db, mario, outsider)).toThrow(ValidationError);
      expect(() => tagOps.createComponentTagValue(db, mario, mario)).toThrow(ValidationError);
    });
  });

  describe('tag values', () => {
    it('creates text and number values and the relationship (T1)', () => {
      const mario = tag('mario');
      const title = tag('title');
      const rating = tag('rating');
      const t = tagOps.createTextTagValue(db, mario, title, 'Super');
      const n = tagOps.createNumberTagValue(db, mario, rating, 8);
      const detail = tagOps.getTagDetail(db, mario, libraryId);
      expect(detail.instances).toEqual([
        { tagId: rating, name: 'rating', values: [{ valueId: n, kind: 'number', number: 8 }] },
        { tagId: title, name: 'title', values: [{ valueId: t, kind: 'text', text: 'Super' }] },
      ]);
    });

    it('creates a ref value, applying the ref, and rejects duplicate and self refs', () => {
      const mario = tag('mario');
      const author = tag('author');
      const miyamoto = tag('miyamoto');
      const valueId = tagOps.createRefTagValue(db, mario, author, miyamoto);
      const detail = tagOps.getTagDetail(db, mario, libraryId);
      expect(detail.instances).toEqual([
        { tagId: author, name: 'author', values: [{ valueId, kind: 'tag', refTagId: miyamoto }] },
        { tagId: miyamoto, name: 'miyamoto', values: [] },
      ]);
      expect(() => tagOps.createRefTagValue(db, mario, author, miyamoto)).toThrow(ConflictError);
      expect(() => tagOps.createRefTagValue(db, mario, author, author)).toThrow(ValidationError);
      expect(() => tagOps.createRefTagValue(db, mario, author, mario)).toThrow(ValidationError);
    });

    it('removes a ref value, base row included, when the ref instance is removed', () => {
      const mario = tag('mario');
      const author = tag('author');
      const miyamoto = tag('miyamoto');
      tagOps.createRefTagValue(db, mario, author, miyamoto);
      tagOps.untagTag(db, mario, miyamoto);
      expect(
        db.prepare(`SELECT * FROM tag_tag_values WHERE subject_tag_id = ?`).all(mario),
      ).toEqual([]);
    });

    it('updates the flags of an existing component value', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      const first = tagOps.createComponentTagValue(db, mario, overalls);
      const second = tagOps.createComponentTagValue(db, mario, overalls, {
        recursive: true,
        attributed: false,
      });
      expect(second).toBe(first);
      expect(tagOps.getTagDetail(db, mario, libraryId).instances[0]!.values).toEqual([
        { valueId: first, kind: 'component', recursive: true, attributed: false },
      ]);
    });

    it('deletes a value by id, and only on its subject (T8)', () => {
      const mario = tag('mario');
      const luigi = tag('luigi');
      const title = tag('title');
      const a = tagOps.createTextTagValue(db, mario, title, 'a');
      const b = tagOps.createTextTagValue(db, mario, title, 'b');
      expect(() => tagOps.deleteTagValueById(db, luigi, a)).toThrow(NotFoundError);
      tagOps.deleteTagValueById(db, mario, a);
      expect(tagOps.getTagDetail(db, mario, libraryId).instances[0]!.values).toEqual([
        { valueId: b, kind: 'text', text: 'b' },
      ]);
    });

    it('deletes only the parent value of an instance and repairs the closure (T8)', () => {
      const mario = tag('mario');
      const character = tag('character');
      tagOps.createParentTagValue(db, mario, character);
      const componentId = tagOps.createComponentTagValue(db, mario, character);
      tagOps.deleteTagValuesOfKind(db, mario, character, 'parent');
      expect(ancestorsOf(mario)).toEqual([mario]);
      expect(tagOps.getTagDetail(db, mario, libraryId).instances[0]!.values).toEqual([
        { valueId: componentId, kind: 'component', recursive: false, attributed: true },
      ]);
    });

    it('repairs the closure when a parent value is deleted by id', () => {
      const person = tag('person');
      const mario = tag('mario', libraryId, person);
      const luigi = tag('luigi', libraryId, mario);
      const parentValue = tagOps
        .getTagDetail(db, mario, libraryId)
        .instances[0]!.values.find((v) => v.kind === 'parent')!;
      tagOps.deleteTagValueById(db, mario, parentValue.valueId);
      expect(ancestorsOf(mario)).toEqual([mario]);
      expect(ancestorsOf(luigi)).toEqual([luigi, mario].sort((a, b) => a - b));
    });

    it('updates text, number, tag, parent, and component values in place', () => {
      const mario = tag('mario');
      const title = tag('title');
      const author = tag('author');
      const miyamoto = tag('miyamoto');
      const tezuka = tag('tezuka');
      const character = tag('character');
      const overalls = tag('overalls');

      const textId = tagOps.createTextTagValue(db, mario, title, 'old');
      const numId = tagOps.createNumberTagValue(db, mario, title, 1);
      const refId = tagOps.createRefTagValue(db, mario, author, miyamoto);
      const parentId = tagOps.createParentTagValue(db, mario, character, { primary: false });
      const compId = tagOps.createComponentTagValue(db, mario, overalls, {
        recursive: false,
        attributed: true,
      });

      tagOps.updateTagValueById(db, mario, textId, { kind: 'text', text: 'new' }, libraryId);
      tagOps.updateTagValueById(db, mario, numId, { kind: 'number', number: 10 }, libraryId);
      tagOps.updateTagValueById(db, mario, refId, { kind: 'tag', refTagId: tezuka }, libraryId);
      tagOps.updateTagValueById(db, mario, parentId, { kind: 'parent', primary: true }, libraryId);
      tagOps.updateTagValueById(
        db,
        mario,
        compId,
        { kind: 'component', recursive: true, attributed: false },
        libraryId,
      );

      const detail = tagOps.getTagDetail(db, mario, libraryId);
      const titleValues = detail.instances.find((i) => i.tagId === title)?.values;
      expect(titleValues).toEqual([
        { valueId: textId, kind: 'text', text: 'new' },
        { valueId: numId, kind: 'number', number: 10 },
      ]);
      expect(detail.instances.find((i) => i.tagId === author)?.values).toEqual([
        { valueId: refId, kind: 'tag', refTagId: tezuka },
      ]);
      expect(detail.instances.find((i) => i.tagId === character)?.values).toEqual([
        { valueId: parentId, kind: 'parent', primary: true },
      ]);
      expect(detail.instances.find((i) => i.tagId === overalls)?.values).toEqual([
        { valueId: compId, kind: 'component', recursive: true, attributed: false },
      ]);
    });
  });

  describe('createParentTagValue', () => {
    it('gives a new tag only a self row in the closure', () => {
      const mario = tag('mario');
      expect(ancestorsOf(mario)).toEqual([mario]);
    });

    it('adds the relationship and a non-primary parent value', () => {
      const mario = tag('mario');
      const character = tag('character');
      tagOps.createParentTagValue(db, mario, character);
      const relationship = db
        .prepare(`SELECT 1 FROM tag_tag_relationships WHERE subject_tag_id = ? AND tag_id = ?`)
        .get(mario, character);
      expect(relationship).toBeDefined();
      const value = db
        .prepare(
          `SELECT v.kind, p.is_primary, p.subject_tag_id FROM tag_tag_values v
           JOIN tag_tag_value_parent p ON p.value_id = v.value_id
           WHERE v.subject_tag_id = ? AND v.tag_id = ?`,
        )
        .get(mario, character) as { kind: string; is_primary: number; subject_tag_id: number };
      expect(value).toEqual({ kind: 'parent', is_primary: 0, subject_tag_id: mario });
    });

    it('reuses an existing relationship between the tags', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createComponentTagValue(db, mario, overalls, { attributed: false });
      tagOps.createParentTagValue(db, mario, overalls);
      const kinds = db
        .prepare(
          `SELECT kind FROM tag_tag_values WHERE subject_tag_id = ? AND tag_id = ? ORDER BY kind`,
        )
        .all(mario, overalls)
        .map((row) => (row as { kind: string }).kind);
      expect(kinds).toEqual(['component', 'parent']);
    });

    it('rejects a duplicate parent value (T13)', () => {
      const mario = tag('mario');
      const character = tag('character');
      tagOps.createParentTagValue(db, mario, character);
      expect(() => tagOps.createParentTagValue(db, mario, character)).toThrow(ConflictError);
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_values WHERE subject_tag_id = ? AND kind = 'parent'`)
          .all(mario),
      ).toHaveLength(1);
    });

    it('extends the closure transitively, for the subject and its descendants', () => {
      const person = tag('person');
      const character = tag('character');
      const mario = tag('mario');
      const luigi = tag('luigi');
      tagOps.createParentTagValue(db, character, person);
      tagOps.createParentTagValue(db, mario, character);
      tagOps.createParentTagValue(db, luigi, mario);
      expect(ancestorsOf(mario)).toEqual([character, mario, person].sort((a, b) => a - b));
      expect(ancestorsOf(luigi)).toEqual([character, luigi, mario, person].sort((a, b) => a - b));
    });

    it('updates existing descendants when a parent is added above the subject', () => {
      const character = tag('character');
      const mario = tag('mario');
      const plumber = tag('plumber');
      tagOps.createParentTagValue(db, mario, character);
      tagOps.createParentTagValue(db, character, plumber);
      expect(ancestorsOf(mario)).toEqual([character, mario, plumber].sort((a, b) => a - b));
    });

    it('rejects a tag as its own parent', () => {
      const mario = tag('mario');
      expect(() => tagOps.createParentTagValue(db, mario, mario)).toThrow(/own parent/);
      expect(() => tagOps.createParentTagValue(db, mario, mario)).toThrow(ValidationError);
    });

    it('rejects edges that close a cycle, direct or transitive', () => {
      const mario = tag('mario');
      const character = tag('character');
      const person = tag('person');
      tagOps.createParentTagValue(db, mario, character);
      expect(() => tagOps.createParentTagValue(db, character, mario)).toThrow(/cycle/);
      tagOps.createParentTagValue(db, character, person);
      expect(() => tagOps.createParentTagValue(db, person, mario)).toThrow(ConflictError);
    });

    it('allows several parents when no cycle forms', () => {
      const mario = tag('mario');
      const character = tag('character');
      const plumber = tag('plumber');
      tagOps.createParentTagValue(db, mario, character);
      tagOps.createParentTagValue(db, mario, plumber);
      expect(ancestorsOf(mario)).toEqual([character, mario, plumber].sort((a, b) => a - b));
    });

    it('throws when either tag is missing or in another library', () => {
      const mario = tag('mario');
      expect(() => tagOps.createParentTagValue(db, mario, 999)).toThrow(/not found/);
      expect(() => tagOps.createParentTagValue(db, 999, mario)).toThrow(NotFoundError);
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const outsider = tag('outsider', otherLibraryId);
      expect(() => tagOps.createParentTagValue(db, mario, outsider)).toThrow(
        /not in the same library/,
      );
    });
  });

  describe('primary parent (T9)', () => {
    const primariesOf = (tagId: number) =>
      tagOps
        .getTagDetail(db, tagId, libraryId)
        .instances.filter((i) => i.values.some((v) => v.kind === 'parent' && v.primary))
        .map((i) => i.tagId);

    it('keeps a single primary parent', () => {
      const mario = tag('mario');
      const character = tag('character');
      const plumber = tag('plumber');
      tagOps.createParentTagValue(db, mario, character, { primary: true });
      expect(primariesOf(mario)).toEqual([character]);
      tagOps.createParentTagValue(db, mario, plumber, { primary: true });
      expect(primariesOf(mario)).toEqual([plumber]);
      tagOps.setPrimaryParent(db, mario, character);
      expect(primariesOf(mario)).toEqual([character]);
    });

    it('rejects a tag that is not a parent', () => {
      const mario = tag('mario');
      const character = tag('character');
      const hat = tag('hat');
      tagOps.createParentTagValue(db, mario, character, { primary: true });
      tagOps.createComponentTagValue(db, mario, hat);
      expect(() => tagOps.setPrimaryParent(db, mario, hat)).toThrow(NotFoundError);
      expect(primariesOf(mario)).toEqual([character]);
    });
  });

  describe('deleteTag', () => {
    it('drops its closure rows and rebuilds the descendants left behind', () => {
      const person = tag('person');
      const character = tag('character');
      const plumber = tag('plumber');
      const mario = tag('mario');
      tagOps.createParentTagValue(db, character, person);
      tagOps.createParentTagValue(db, mario, character);
      tagOps.createParentTagValue(db, mario, plumber);
      //mario: parents character and plumber; character: parent person.
      tagOps.deleteTag(db, character, libraryId);
      expect(ancestorsOf(character)).toEqual([]);
      //Only the path through character is gone; plumber stays.
      expect(ancestorsOf(mario)).toEqual([mario, plumber].sort((a, b) => a - b));
    });

    it('rejects a tag from another library', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const outsider = tag('outsider', otherLibraryId);
      expect(() => tagOps.deleteTag(db, outsider, libraryId)).toThrow(NotFoundError);
      expect(tagOps.getTag(db, outsider)).toBeDefined();
    });

    it('cascades its aliases, instances, values, and incoming references', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createComponentTagValue(db, mario, overalls);
      const fileId = newFile('hash1', 'a.png');
      tagOps.tagFile(db, fileId, mario, libraryId);
      tagOps.tagFile(db, fileId, overalls, libraryId);
      db.prepare(`INSERT INTO file_tag_values (file_id, tag_id, kind) VALUES (?, ?, 'text')`).run(
        fileId,
        mario,
      );
      tagOps.deleteTag(db, mario, libraryId);

      expect(tagOps.getTag(db, mario)).toBeUndefined();
      expect(db.prepare(`SELECT * FROM aliases WHERE tag_id = ?`).all(mario)).toEqual([]);
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_relationships WHERE subject_tag_id = ? OR tag_id = ?`)
          .all(mario, mario),
      ).toEqual([]);
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_values WHERE subject_tag_id = ? OR tag_id = ?`)
          .all(mario, mario),
      ).toEqual([]);
      //The file keeps its overalls instance; the mario instance and its values are gone.
      const fileInstances = db
        .prepare(`SELECT tag_id FROM file_tag_relationships WHERE file_id = ?`)
        .all(fileId)
        .map((row) => (row as { tag_id: number }).tag_id);
      expect(fileInstances).toEqual([overalls]);
      expect(fileCountOf(overalls)).toBe(1);
      expect(
        db
          .prepare(`SELECT * FROM file_tag_values WHERE file_id = ? AND tag_id = ?`)
          .all(fileId, mario),
      ).toEqual([]);
      //No dangling value ids are left in any payload table.
      const orphans = db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM file_tag_value_text t
             WHERE NOT EXISTS (SELECT 1 FROM file_tag_values v WHERE v.value_id = t.value_id)) +
           (SELECT COUNT(*) FROM tag_tag_value_component c
             WHERE NOT EXISTS (SELECT 1 FROM tag_tag_values v WHERE v.value_id = c.value_id)) AS n`,
        )
        .get() as { n: number };
      expect(orphans.n).toBe(0);
    });
  });

  describe('untagTag', () => {
    it('repairs the closure when the removed relationship was a parent edge', () => {
      const person = tag('person');
      const character = tag('character');
      const plumber = tag('plumber');
      const mario = tag('mario');
      const luigi = tag('luigi');
      tagOps.createParentTagValue(db, character, person);
      tagOps.createParentTagValue(db, mario, character);
      tagOps.createParentTagValue(db, mario, plumber);
      tagOps.createParentTagValue(db, luigi, mario);
      tagOps.untagTag(db, mario, character);
      expect(ancestorsOf(mario)).toEqual([mario, plumber].sort((a, b) => a - b));
      expect(ancestorsOf(luigi)).toEqual([luigi, mario, plumber].sort((a, b) => a - b));
      //Tags above the removed edge are untouched.
      expect(ancestorsOf(character)).toEqual([character, person].sort((a, b) => a - b));
    });

    it('leaves the closure alone when no parent value was on the instance', () => {
      const plumber = tag('plumber');
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createParentTagValue(db, mario, plumber);
      tagOps.createComponentTagValue(db, mario, overalls);
      const before = ancestorsOf(mario);
      tagOps.untagTag(db, mario, overalls);
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_relationships WHERE subject_tag_id = ? AND tag_id = ?`)
          .all(mario, overalls),
      ).toEqual([]);
      expect(ancestorsOf(mario)).toEqual(before);
    });
  });

  describe('deleteTagValue', () => {
    it('deletes every value of the instance and keeps the instance itself', () => {
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createComponentTagValue(db, mario, overalls);
      tagOps.deleteTagValue(db, mario, overalls);
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_values WHERE subject_tag_id = ? AND tag_id = ?`)
          .all(mario, overalls),
      ).toEqual([]);
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_relationships WHERE subject_tag_id = ? AND tag_id = ?`)
          .get(mario, overalls),
      ).toBeDefined();
    });

    it('does not touch instances of the same tag on other subjects', () => {
      const character = tag('character');
      const mario = tag('mario');
      const luigi = tag('luigi');
      tagOps.createComponentTagValue(db, mario, character);
      tagOps.createComponentTagValue(db, luigi, character);
      tagOps.deleteTagValue(db, mario, character);
      expect(
        db
          .prepare(`SELECT * FROM tag_tag_values WHERE subject_tag_id = ? AND tag_id = ?`)
          .all(luigi, character),
      ).toHaveLength(1);
    });

    it('repairs the closure when a parent value is removed', () => {
      const person = tag('person');
      const character = tag('character');
      const plumber = tag('plumber');
      const mario = tag('mario');
      const luigi = tag('luigi');
      tagOps.createParentTagValue(db, character, person);
      tagOps.createParentTagValue(db, mario, character);
      tagOps.createParentTagValue(db, mario, plumber);
      tagOps.createParentTagValue(db, luigi, mario);
      tagOps.deleteTagValue(db, mario, character);
      expect(ancestorsOf(mario)).toEqual([mario, plumber].sort((a, b) => a - b));
      expect(ancestorsOf(luigi)).toEqual([luigi, mario, plumber].sort((a, b) => a - b));
      expect(ancestorsOf(character)).toEqual([character, person].sort((a, b) => a - b));
    });

    it('leaves the closure alone when no parent value was on the instance', () => {
      const plumber = tag('plumber');
      const mario = tag('mario');
      const overalls = tag('overalls');
      tagOps.createParentTagValue(db, mario, plumber);
      tagOps.createComponentTagValue(db, mario, overalls);
      const before = ancestorsOf(mario);
      tagOps.deleteTagValue(db, mario, overalls);
      expect(ancestorsOf(mario)).toEqual(before);
    });
  });

  describe('listTags (T12)', () => {
    let mario: number;
    let marioPet: number;
    let luigi: number;
    let character: number;
    beforeEach(() => {
      character = tag('character');
      const pet = tag('pet');
      mario = tag('Mario', libraryId, character);
      marioPet = tag('mario', libraryId, pet);
      tagOps.createParentTagValue(db, marioPet, character, { primary: false });
      tagOps.createParentTagValue(db, mario, pet, { primary: true });
      luigi = tag('luigi');
      tagOps.addAlias(db, luigi, 'green_mario', libraryId);
      const f1 = newFile('h1', 'a.png');
      const f2 = newFile('h2', 'b.png');
      tagOps.tagFile(db, f1, luigi, libraryId);
      tagOps.tagFile(db, f2, luigi, libraryId);
      tagOps.tagFile(db, f1, mario, libraryId);
    });

    it('matches any alias by case-insensitive prefix, ordered by file count then name', () => {
      const result = tagOps.listTags(db, libraryId, { q: 'MAR', limit: 10, offset: 0 });
      expect(result.total).toBe(2);
      expect(result.tags.map((t) => t.tagId)).toEqual([mario, marioPet]);
      const green = tagOps.listTags(db, libraryId, { q: 'green', limit: 10, offset: 0 });
      expect(green.tags).toEqual([
        {
          tagId: luigi,
          name: 'luigi',
          color: null,
          isCategory: false,
          fileCount: 2,
          parentName: null,
        },
      ]);
    });

    it('escapes LIKE wildcards', () => {
      expect(tagOps.listTags(db, libraryId, { q: 'green_', limit: 10, offset: 0 }).total).toBe(1);
      expect(tagOps.listTags(db, libraryId, { q: 'green%', limit: 10, offset: 0 }).total).toBe(0);
      expect(tagOps.listTags(db, libraryId, { q: '_', limit: 10, offset: 0 }).total).toBe(0);
    });

    it('returns the primary parent name, else any parent name', () => {
      const { tags } = tagOps.listTags(db, libraryId, { q: 'mario', limit: 10, offset: 0 });
      expect(tags.find((t) => t.tagId === mario)?.parentName).toBe('pet');
      expect(tags.find((t) => t.tagId === marioPet)?.parentName).toBe('pet');
      tagOps.setPrimaryParent(db, marioPet, character);
      const again = tagOps.listTags(db, libraryId, { q: 'mario', limit: 10, offset: 0 });
      expect(again.tags.find((t) => t.tagId === marioPet)?.parentName).toBe('character');
    });

    it('paginates and counts the total, and only lists the library', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      tag('mario', otherLibraryId);
      const all = tagOps.listTags(db, libraryId, { limit: 100, offset: 0 });
      expect(all.total).toBe(5);
      expect(all.tags.map((t) => t.tagId).slice(0, 2)).toEqual([luigi, mario]);
      const page = tagOps.listTags(db, libraryId, { limit: 2, offset: 2 });
      expect(page.total).toBe(5);
      expect(page.tags.map((t) => t.tagId)).toEqual(all.tags.slice(2, 4).map((t) => t.tagId));
    });
  });

  describe('getTagDetail (T12)', () => {
    it('returns the tag, its aliases, hierarchy, and its instances with values', () => {
      const entity = tag('entity');
      const character = tag('character', libraryId, entity);
      const overalls = tag('overalls');
      const mario = tag('mario', libraryId, character);
      const babyMario = tag('baby mario', libraryId, mario);
      const tinyMario = tag('tiny mario', libraryId, babyMario);
      tagOps.addAlias(db, mario, 'jumpman', libraryId);
      tagOps.setPrimaryParent(db, mario, character);
      const componentId = tagOps.createComponentTagValue(db, mario, overalls, { recursive: true });
      const detail = tagOps.getTagDetail(db, mario, libraryId);
      expect(detail.tag.tag_id).toBe(mario);
      expect(detail.aliases.map((a) => a.text)).toEqual(['mario', 'jumpman']);
      expect(detail.instances).toEqual([
        {
          tagId: character,
          name: 'character',
          values: [{ valueId: expect.any(Number), kind: 'parent', primary: true }],
        },
        {
          tagId: overalls,
          name: 'overalls',
          values: [{ valueId: componentId, kind: 'component', recursive: true, attributed: true }],
        },
      ]);
      expect(detail.parents).toEqual([{ tagId: character, name: 'character', color: null }]);
      expect(detail.ancestors).toEqual([
        { tagId: character, name: 'character', color: null },
        { tagId: entity, name: 'entity', color: null },
      ]);
      expect(detail.children).toEqual([{ tagId: babyMario, name: 'baby mario', color: null }]);
      expect(detail.descendants).toEqual([
        { tagId: babyMario, name: 'baby mario', color: null },
        { tagId: tinyMario, name: 'tiny mario', color: null },
      ]);
    });

    it('throws NotFoundError for a tag of another library', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const outsider = tag('outsider', otherLibraryId);
      expect(() => tagOps.getTagDetail(db, outsider, libraryId)).toThrow(NotFoundError);
      expect(() => tagOps.getTagDetail(db, 999, libraryId)).toThrow(NotFoundError);
    });
  });

  describe('getFileInstances (T12)', () => {
    it('groups instances by file, ordered by name, with an empty list for untagged files', () => {
      const f1 = newFile('h1', 'a.png');
      const f2 = newFile('h2', 'b.png');
      const zebra = tag('zebra');
      const apple = tag('apple');
      tagOps.tagFile(db, f1, zebra, libraryId);
      tagOps.tagFile(db, f1, apple, libraryId);
      const refId = tagOps.createRefFileValue(db, f1, zebra, apple, libraryId);
      const textId = tagOps.createTextFileValue(db, f1, apple, 'red', libraryId);
      const result = tagOps.getFileInstances(db, [f1, f2], libraryId);
      expect([...result.keys()]).toEqual([f1, f2]);
      expect(result.get(f1)).toEqual([
        { tagId: apple, name: 'apple', values: [{ valueId: textId, kind: 'text', text: 'red' }] },
        { tagId: zebra, name: 'zebra', values: [{ valueId: refId, kind: 'tag', refTagId: apple }] },
      ]);
      expect(result.get(f2)).toEqual([]);
      expect(tagOps.getFileInstances(db, [], libraryId).size).toBe(0);
    });

    it('only returns tags of the library', () => {
      const otherLibraryId = libOps.createLibrary(db, 'other', '/data/other');
      const fileId = newFile('h1', 'a.png');
      fileOps.createLocation(db, 'a.png', otherLibraryId, fileId);
      const mine = tag('mine');
      const theirs = tag('theirs', otherLibraryId);
      tagOps.tagFile(db, fileId, mine, libraryId);
      tagOps.tagFile(db, fileId, theirs, otherLibraryId);
      tagOps.createTextFileValue(db, fileId, theirs, 'secret', otherLibraryId);
      expect(tagOps.getFileInstances(db, [fileId], libraryId).get(fileId)).toEqual([
        { tagId: mine, name: 'mine', values: [] },
      ]);
    });
  });
});
