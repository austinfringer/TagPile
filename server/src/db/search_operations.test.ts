import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './index.ts';
import { createTestDb } from '../test/helpers.ts';
import * as fileOps from './file_operations.ts';
import * as libOps from './library_operations.ts';
import * as tagOps from './tagging_operations.ts';
import { autocomplete, parseQuery, search, SearchSyntaxError } from './search_operations.ts';
import type { LocationMetadata } from './file_operations.ts';

describe('search_operations', () => {
  let db: Db;
  let libraryId: number;
  beforeEach(() => {
    db = createTestDb();
    libraryId = libOps.createLibrary(db, 'lib', '/data/lib');
  });
  afterEach(() => db.close());

  let nextHash = 0;
  /** Creates a file with one location in this library. */
  const makeFile = (path: string, size = 1, metadata?: LocationMetadata) => {
    const fileId = fileOps.createFile(db, `hash${nextHash++}`, size);
    fileOps.createLocation(db, path, libraryId, fileId, metadata);
    return fileId;
  };
  const tag = (name: string, parentId?: number) =>
    tagOps.createTag(db, { alias: name, libraryId, parentId });
  const tagFile = (fileId: number, tagId: number) => tagOps.tagFile(db, fileId, tagId, libraryId);
  const textValue = (fileId: number, tagId: number, text: string) =>
    tagOps.createTextFileValue(db, fileId, tagId, text, libraryId);
  const numberValue = (fileId: number, tagId: number, number: number) =>
    tagOps.createNumberFileValue(db, fileId, tagId, number, libraryId);

  /** Adds a `tag` value linking the (file, tagId) instance to the (file, refTagId) instance. */
  const linkValue = (fileId: number, tagId: number, refTagId: number) => {
    const valueId = db
      .prepare(`INSERT INTO file_tag_values (file_id, tag_id, kind) VALUES (?, ?, 'tag')`)
      .run(fileId, tagId).lastInsertRowid as number;
    db.prepare(
      `INSERT INTO file_tag_value_tag (value_id, file_id, ref_tag_id) VALUES (?, ?, ?)`,
    ).run(valueId, fileId, refTagId);
  };

  const run = (query: string, lib: number = libraryId) => search(db, query, lib).fileIds.sort();

  describe('bare terms', () => {
    it('matches a directly applied tag', () => {
      const cat = tag('cat');
      const withCat = makeFile('a.png');
      const without = makeFile('b.png');
      tagFile(withCat, cat);
      expect(run('cat')).toEqual([withCat]);
      expect(run('dog')).toEqual([]);
      expect(run('not dog')).toEqual([withCat, without].sort());
    });

    it('matches descendants transitively through parents', () => {
      const character = tag('character');
      const mario = tag('mario');
      tagOps.createParentTagValue(db, mario, character);
      const fileId = makeFile('a.png');
      tagFile(fileId, mario);
      expect(run('character')).toEqual([fileId]);
      expect(run('mario')).toEqual([fileId]);
    });

    it('matches tags that are used as values, because they are applied too', () => {
      const author = tag('author');
      const person = tag('person');
      const fileId = makeFile('a.png');
      tagFile(fileId, author);
      tagFile(fileId, person);
      linkValue(fileId, author, person);
      expect(run('person')).toEqual([fileId]);
    });

    it('resolves a path to the tag under that ancestor only', () => {
      const pet = tag('pet');
      const character = tag('character');
      const mario = tag('mario');
      const plumber = tag('plumber');
      tagOps.createParentTagValue(db, mario, pet);
      tagOps.createParentTagValue(db, plumber, character);

      const marioFile = makeFile('a.png');
      tagFile(marioFile, mario);
      const plumberFile = makeFile('b.png');
      tagFile(plumberFile, plumber);

      expect(run('pet/mario')).toEqual([marioFile]);
      expect(run('character/plumber')).toEqual([plumberFile]);
      //Not an ancestor chain: character is not above mario.
      expect(run('character/mario')).toEqual([]);
    });
  });

  describe('value filters', () => {
    let cat: number;
    let fileId: number;
    beforeEach(() => {
      cat = tag('cat');
      fileId = makeFile('a.png');
      tagFile(fileId, cat);
    });

    it('cat:mario and cat:"mario" match an exact text value', () => {
      textValue(fileId, cat, 'Mario');
      const substringOnly = makeFile('b.png');
      tagFile(substringOnly, cat);
      textValue(substringOnly, cat, 'A cat named Mario');
      expect(run('cat:mario')).toEqual([fileId]);
      expect(run('cat:"mario"')).toEqual([fileId]);
    });

    it('cat:~mario matches a text value containing the text as a substring', () => {
      textValue(fileId, cat, 'A cat named Mario');
      const exact = makeFile('b.png');
      tagFile(exact, cat);
      textValue(exact, cat, 'mario');
      const other = makeFile('c.png');
      tagFile(other, cat);
      textValue(other, cat, 'a dog');
      expect(run('cat:~mario')).toEqual([fileId, exact].sort());
      expect(run('cat:~"cat named"')).toEqual([fileId]);
    });

    it('cat:orange matches a text value or a tag value', () => {
      const orange = tag('orange');
      //File 1: text value equal to orange.
      textValue(fileId, cat, 'orange');
      //File 2: Cat has a tag value pointing at Orange.
      const withTag = makeFile('b.png');
      tagFile(withTag, cat);
      tagFile(withTag, orange);
      linkValue(withTag, cat, orange);
      //File 3: Cat exists but has no matching value.
      const plain = makeFile('c.png');
      tagFile(plain, cat);
      expect(run('cat:orange')).toEqual([fileId, withTag].sort());
      expect(run('cat:#orange')).toEqual([withTag]);
      expect(run('cat:~orange')).toEqual([fileId]);
    });

    it('page:>4 checks number values only', () => {
      const page = tag('page');
      const four = makeFile('b.png');
      tagFile(four, page);
      numberValue(four, page, 4);
      const nine = makeFile('c.png');
      tagFile(nine, page);
      numberValue(nine, page, 9);
      //A text value that mentions a number is not a number value.
      tagFile(fileId, page);
      textValue(fileId, page, '99');
      expect(run('page:>4')).toEqual([nine]);
      //A bare numeric value unions text and number kinds.
      expect(run('page:4')).toEqual([four]);
    });

    it('mario:shorts:blue is sugar for mario:shorts and shorts:blue', () => {
      const mario = tag('mario');
      const shorts = tag('shorts');
      tagFile(fileId, mario);
      tagFile(fileId, shorts);
      linkValue(fileId, mario, shorts);
      textValue(fileId, shorts, 'blue');

      const half = makeFile('b.png');
      tagFile(half, mario);
      tagFile(half, shorts);
      linkValue(half, mario, shorts); //shorts without the blue value

      expect(run('mario:shorts:blue')).toEqual([fileId]);
      expect(run('mario:shorts')).toEqual([fileId, half].sort());
    });

    it('cat:* matches any value on the instance', () => {
      textValue(fileId, cat, 'anything');
      const bare = makeFile('b.png');
      tagFile(bare, cat);
      expect(run('cat:*')).toEqual([fileId]);
      expect(run('description:*')).toEqual([]);
    });

    it('cat?anchor filters by kind, with and without "not"', () => {
      tagOps.createAnchorFileValue(
        db,
        fileId,
        cat,
        { tStart: 1, tEnd: 2, rx: 0, ry: 0, rw: 0.5, rh: 0.5 },
        libraryId,
      );
      const noAnchor = makeFile('b.png');
      tagFile(noAnchor, cat);
      textValue(noAnchor, cat, 'hello');
      const untagged = makeFile('c.png');
      expect(run('cat?anchor')).toEqual([fileId]);
      expect(run('not cat?anchor')).toEqual([noAnchor, untagged].sort());
      expect(() => run('cat?bogus')).toThrow(/Unknown value kind/);
    });

    it('*:person matches files where person is a value under any tag', () => {
      const author = tag('author');
      const person = tag('person');
      const direct = makeFile('b.png');
      tagFile(direct, person); //directly tagged, not used as a value
      tagFile(fileId, author);
      tagFile(fileId, person);
      linkValue(fileId, author, person);
      expect(run('*:person')).toEqual([fileId]);
    });
  });

  describe('boolean operators', () => {
    let cat: number, dog: number;
    let fCat: number, fDog: number, fBoth: number;
    beforeEach(() => {
      cat = tag('cat');
      dog = tag('dog');
      tag('bird');
      fCat = makeFile('cat.png');
      tagFile(fCat, cat);
      fDog = makeFile('dog.png');
      tagFile(fDog, dog);
      fBoth = makeFile('both.png');
      tagFile(fBoth, cat);
      tagFile(fBoth, dog);
    });

    it('intersects juxtaposed terms and explicit "and"', () => {
      expect(run('cat dog')).toEqual([fBoth]);
      expect(run('cat and dog')).toEqual([fBoth]);
    });

    it('"or" unions and binds looser than "and"', () => {
      expect(run('cat or dog')).toEqual([fCat, fDog, fBoth].sort());
      //bird dog or cat = (bird AND dog) OR cat
      expect(run('bird dog or cat')).toEqual([fCat, fBoth].sort());
    });

    it('supports parentheses and "not"', () => {
      expect(run('bird and (dog or cat)')).toEqual([]);
      expect(run('(cat or dog) not cat')).toEqual([fDog]);
      expect(run('not (cat or dog)')).toEqual([]);
    });

    it('respects visibility: another library neither matches nor leaks', () => {
      const otherLib = libOps.createLibrary(db, 'other', '/data/other');
      const otherCat = tagOps.createTag(db, { alias: 'cat', libraryId: otherLib });
      const otherFile = fileOps.createFile(db, 'other-hash', 1);
      fileOps.createLocation(db, 'cat.png', otherLib, otherFile);
      tagOps.tagFile(db, otherFile, otherCat, otherLib);
      expect(run('cat', otherLib)).toEqual([otherFile]);
      //This library's view is unchanged; the other file has no location here.
      expect(run('cat')).toEqual([fCat, fBoth].sort());
    });
  });

  describe('metadata selectors', () => {
    beforeEach(() => {
      makeFile('pic.png', 5 * 1024 * 1024, {
        extension: 'png',
        type: 'image',
        createdAt: Date.parse('2024-01-15'),
        modifiedAt: Date.parse('2024-06-01'),
      });
      makeFile('doc.txt', 512, {
        extension: 'txt',
        type: 'text',
        createdAt: Date.parse('2023-01-01'),
        modifiedAt: Date.parse('2023-02-01'),
      });
    });

    it('filters by extension, type, and size', () => {
      const [png, txt] = run('');
      expect(run('extension:png')).toEqual([png]);
      expect(run('extension:.PNG')).toEqual([png]);
      expect(run('type:text')).toEqual([txt]);
      expect(run('size:>1MB')).toEqual([png]);
      expect(run('size:<1KB')).toEqual([txt]);
    });

    it('filters by location created/modified dates', () => {
      const [png, txt] = run('');
      expect(run('created_at:>2024-01-01')).toEqual([png]);
      expect(run('modified_at:<2024-01-01')).toEqual([txt]);
    });

    it('matches when any location of the file matches', () => {
      const [png, txt] = run('') as [number, number];
      fileOps.createLocation(db, 'copy.txt', libraryId, png, {
        extension: 'txt',
        type: 'text',
        createdAt: null,
        modifiedAt: null,
      });
      expect(run('type:text')).toEqual([png, txt].sort());
      expect(run('extension:txt')).toEqual([png, txt].sort());
    });

    it('rejects malformed metadata terms', () => {
      expect(() => run('size')).toThrow(/needs a filter/);
      expect(() => run('size:big')).toThrow(/Invalid size value/);
      expect(() => run('created_at:later')).toThrow(/Invalid created_at/);
      expect(() => run('type?text')).toThrow(/not a tag/);
    });
  });

  describe('commands', () => {
    it('sorts by size, ascending or descending', () => {
      const small = makeFile('a.png', 10);
      const big = makeFile('b.png', 1000);
      expect(search(db, 'sort:size', libraryId).fileIds).toEqual([small, big]);
      expect(search(db, 'sort:-size', libraryId).fileIds).toEqual([big, small]);
    });

    it('breaks sort ties by file id', () => {
      const a = makeFile('a.png', 10);
      const b = makeFile('b.png', 10);
      const c = makeFile('c.png', 5);
      expect(search(db, 'sort:-size', libraryId).fileIds).toEqual([a, b, c]);
      expect(search(db, 'sort:size', libraryId).fileIds).toEqual([c, a, b]);
    });

    it('rejects group_by and unknown sort fields', () => {
      expect(() => search(db, 'group_by:type', libraryId)).toThrow(/group_by is not supported/);
      expect(() => search(db, 'sort:name', libraryId)).toThrow(/Unknown sort field/);
    });
  });

  describe('pagination', () => {
    let ids: number[];
    beforeEach(() => {
      const cat = tag('cat');
      ids = [];
      for (let i = 0; i < 5; i++) {
        const fileId = makeFile(`f${i}.png`, 100 - i);
        tagFile(fileId, cat);
        ids.push(fileId);
      }
      makeFile('untagged.png');
    });

    it('returns every match and the total when there is no limit', () => {
      expect(search(db, 'cat', libraryId)).toEqual({ total: 5, fileIds: ids });
    });

    it('returns one page with the total of all matches', () => {
      expect(search(db, 'cat', libraryId, { limit: 2 })).toEqual({
        total: 5,
        fileIds: ids.slice(0, 2),
      });
      expect(search(db, 'cat', libraryId, { limit: 2, offset: 2 })).toEqual({
        total: 5,
        fileIds: ids.slice(2, 4),
      });
      expect(search(db, 'cat', libraryId, { limit: 2, offset: 4 })).toEqual({
        total: 5,
        fileIds: ids.slice(4),
      });
      expect(search(db, 'cat', libraryId, { limit: 2, offset: 10 })).toEqual({
        total: 5,
        fileIds: [],
      });
    });

    it('skips the count when count is false', () => {
      expect(search(db, 'cat', libraryId, { limit: 2, offset: 2, count: false })).toEqual({
        total: null,
        fileIds: ids.slice(2, 4),
      });
    });

    it('does not scan the values of a tag for each file', () => {
      const note = tag('note');
      tagFile(ids[0]!, note);
      textValue(ids[0]!, note, 'blonde hair');
      const statements: string[] = [];
      const prepare = db.prepare.bind(db);
      db.prepare = ((sql: string) => (statements.push(sql), prepare(sql))) as typeof db.prepare;
      expect(search(db, 'note:~blonde', libraryId).fileIds).toEqual([ids[0]]);
      const sql = statements.find((s) => s.includes('ORDER BY'))!;
      const plan = (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(libraryId, note, '%blonde%') as {
          detail: string;
        }[]
      ).map((row) => row.detail);
      //A correlated subquery runs one time for each file; the value lookup must not be one.
      expect(plan.some((d) => d.startsWith('LIST SUBQUERY'))).toBe(true);
      expect(plan.some((d) => d.startsWith('CORRELATED'))).toBe(false);
    });

    it('accepts an offset with no limit', () => {
      expect(search(db, 'cat', libraryId, { offset: 3 }).fileIds).toEqual(ids.slice(3));
    });

    it('pages in sort order', () => {
      //Sizes fall as ids rise, so sort:size reverses the id order.
      const reversed = [...ids].reverse();
      expect(search(db, 'cat sort:size', libraryId, { limit: 3 })).toEqual({
        total: 5,
        fileIds: reversed.slice(0, 3),
      });
      expect(search(db, 'cat sort:size', libraryId, { limit: 3, offset: 3 }).fileIds).toEqual(
        reversed.slice(3),
      );
    });

    it('counts every file of the library for an empty query', () => {
      expect(search(db, '', libraryId, { limit: 1 }).total).toBe(6);
      expect(search(db, 'dog', libraryId, { limit: 1 })).toEqual({ total: 0, fileIds: [] });
    });
  });

  describe('parseQuery', () => {
    it('parses an empty query as matching everything', () => {
      expect(parseQuery('')).toEqual({ expr: null, sorts: [], groupBys: [] });
      const a = makeFile('a.png');
      const b = makeFile('b.png');
      expect(run('')).toEqual([a, b].sort());
    });

    it('expands the a:b:c chain sugar into a pair conjunction', () => {
      expect(parseQuery('mario:shorts:blue').expr).toMatchObject({
        type: 'and',
        children: [
          { specifier: { type: 'path', segments: ['mario'] } },
          { specifier: { type: 'path', segments: ['shorts'] } },
        ],
      });
    });

    it('rejects malformed queries', () => {
      for (const bad of [
        'cat?',
        '(cat',
        'cat)',
        'cat:',
        'cat:~',
        '~cat',
        '?dog',
        'a:"b":c',
        'a:~b:c',
        'and cat',
        '"open',
      ]) {
        expect(() => parseQuery(bad), bad).toThrow(SearchSyntaxError);
      }
    });

    it('matches aliases containing punctuation when quoted', () => {
      const alias = tag('has:colon');
      const fileId = makeFile('a.png');
      tagFile(fileId, alias);
      expect(run('"has:colon"')).toEqual([fileId]);
      expect(parseQuery('"has:colon"').expr).toMatchObject({
        specifier: { type: 'path', segments: ['has:colon'] },
      });
    });
  });

  describe('autocomplete', () => {
    const complete = (partial: string, limit?: number, lib: number = libraryId) =>
      autocomplete(db, partial, lib, limit);
    const texts = (partial: string, limit?: number) =>
      complete(partial, limit).completions.map((c) => c.text);
    const tagTexts = (partial: string, limit?: number) =>
      complete(partial, limit)
        .completions.filter((c) => c.kind === 'tag')
        .map((c) => c.text);
    /** Tags the given number of new files with `tagId`, to raise its file_count. */
    const use = (tagId: number, files: number) => {
      for (let i = 0; i < files; i++) tagFile(makeFile(`use${nextHash}.png`), tagId);
    };

    describe('specifier', () => {
      let cat: number, car: number, carrot: number;
      beforeEach(() => {
        carrot = tag('carrot');
        car = tag('car');
        cat = tag('cat');
        use(cat, 3);
        use(car, 1);
      });

      it('completes tags by alias prefix, most used first', () => {
        const result = complete('ca');
        expect(result.from).toBe(0);
        expect(result.to).toBe(2);
        expect(result.completions).toEqual([
          { text: 'cat', kind: 'tag', tagId: cat, fileCount: 3, parent: null },
          { text: 'car', kind: 'tag', tagId: car, fileCount: 1, parent: null },
          { text: 'carrot', kind: 'tag', tagId: carrot, fileCount: 0, parent: null },
        ]);
      });

      it('matches case-insensitively and on any alias, one completion per tag', () => {
        tagOps.addAlias(db, carrot, 'Karotte', libraryId);
        tagOps.addAlias(db, carrot, 'carota', libraryId);
        expect(tagTexts('CA')).toEqual(['cat', 'car', 'carrot']);
        expect(complete('kar').completions).toMatchObject([{ text: 'Karotte', tagId: carrot }]);
      });

      it('names the primary alias when the match came through a secondary alias', () => {
        tagOps.addAlias(db, carrot, 'Karotte', libraryId);
        expect(complete('kar').completions).toMatchObject([
          { text: 'Karotte', tagId: carrot, primary: 'carrot' },
        ]);
        // The primary alias itself needs no extra note.
        expect(complete('carro').completions).toMatchObject([
          expect.not.objectContaining({ primary: expect.anything() }),
        ]);
      });

      it('completes only the last term', () => {
        const result = complete('dog and (ca');
        expect(result).toMatchObject({ from: 9, to: 11 });
        expect(tagTexts('dog and (ca')).toEqual(['cat', 'car', 'carrot']);
        expect(complete('cat ')).toMatchObject({ from: 4, to: 4 });
      });

      it('applies the limit', () => {
        expect(tagTexts('ca', 2)).toEqual(['cat', 'car']);
        expect(texts('', 1)).toEqual(['cat']);
      });

      it('offers metadata fields, commands, and keywords that match the prefix', () => {
        tag('sorbet');
        expect(complete('s').completions.slice(0, 2)).toEqual([
          { text: 'size', kind: 'metadata' },
          { text: 'sort:', kind: 'command' },
        ]);
        expect(tagTexts('s')).toEqual(['sorbet']);
        expect(texts('ty')).toEqual(['type']);
        expect(texts('gr')).toEqual(['group_by:']);
        expect(texts('o')).toEqual(['or']);
        expect(texts('cat N')).toEqual(['not']);
        //Keywords only appear once something is typed.
        expect(complete('', 50).completions.some((c) => c.kind === 'keyword')).toBe(false);
      });

      it('shows the parent for disambiguation, preferring the primary parent', () => {
        const pet = tag('pet');
        const character = tag('character');
        const nintendo = tag('nintendo');
        const petMario = tag('mario', pet);
        const characterMario = tag('mario', character);
        tagOps.createParentTagValue(db, petMario, nintendo, { primary: true });
        const marios = complete('mar').completions;
        expect(marios).toHaveLength(2);
        expect(marios).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ tagId: petMario, parent: 'nintendo' }),
            expect.objectContaining({ tagId: characterMario, parent: 'character' }),
          ]),
        );
      });

      it('is scoped to the library', () => {
        const otherLib = libOps.createLibrary(db, 'other', '/data/other');
        tagOps.createTag(db, { alias: 'cathedral', libraryId: otherLib });
        expect(tagTexts('cat')).toEqual(['cat']);
        const otherTags = complete('ca', 10, otherLib).completions.filter((c) => c.kind === 'tag');
        expect(otherTags.map((c) => c.text)).toEqual(['cathedral']);
      });
    });

    describe('path segment', () => {
      let pet: number, mario: number, marmot: number, luigi: number;
      beforeEach(() => {
        const animal = tag('animal');
        pet = tag('pet', animal);
        mario = tag('mario', pet);
        marmot = tag('marmot', pet);
        luigi = tag('luigi', mario);
        const character = tag('character');
        tag('mario', character);
        use(marmot, 2);
      });

      it('completes only descendants of the earlier segments', () => {
        const result = complete('pet/ma');
        expect(result).toMatchObject({ from: 4, to: 6 });
        expect(result.completions.map((c) => c.tagId)).toEqual([marmot, mario]);
        expect(result.completions.map((c) => c.text)).toEqual(['marmot', 'mario']);
      });

      it('includes deeper descendants but not the ancestor itself', () => {
        expect(complete('pet/').completions.map((c) => c.tagId)).toEqual([marmot, luigi, mario]);
        expect(complete('animal/pet/lu').completions.map((c) => c.tagId)).toEqual([luigi]);
        expect(complete('animal/l')).toMatchObject({ from: 7 });
        expect(complete('animal/l').completions.map((c) => c.tagId)).toEqual([luigi]);
        expect(complete('animal/p').completions.map((c) => c.tagId)).toEqual([pet]);
      });

      it('returns nothing for an unknown or malformed earlier path', () => {
        expect(complete('nobody/ma').completions).toEqual([]);
        expect(complete('pet//ma').completions).toEqual([]);
        expect(complete('character/pet/ma').completions).toEqual([]);
      });
    });

    describe('value', () => {
      let orange: number;
      beforeEach(() => {
        tag('cat');
        orange = tag('orange');
      });

      it('completes tags after ":"', () => {
        const result = complete('cat:or');
        expect(result).toMatchObject({ from: 4, to: 6 });
        expect(result.completions).toEqual([
          { text: 'orange', kind: 'tag', tagId: orange, fileCount: 0, parent: null },
        ]);
        expect(complete('cat:').completions.map((c) => c.text)).toEqual(['cat', 'orange']);
        //Keywords are not quoted in a value: after ":" the parser takes any word.
        tag('not');
        expect(texts('cat:no')).toEqual(['not']);
      });

      it('keeps an explicit "#" prefix', () => {
        expect(complete('cat:#or')).toMatchObject({ from: 5, to: 7 });
        expect(texts('cat:#or')).toEqual(['orange']);
      });

      it('completes a path segment inside a value', () => {
        const color = tag('color');
        const red = tag('red', color);
        expect(complete('cat:color/r')).toMatchObject({ from: 10, to: 11 });
        expect(complete('cat:color/r').completions.map((c) => c.tagId)).toEqual([red]);
      });

      it('offers nothing for comparisons, "~", and "*"', () => {
        expect(complete('cat:>4').completions).toEqual([]);
        expect(complete('cat:~or').completions).toEqual([]);
        expect(complete('cat:*').completions).toEqual([]);
      });

      it('completes location types and extensions after the metadata names', () => {
        makeFile('a.png', 1, {
          extension: 'png',
          type: 'image',
          createdAt: null,
          modifiedAt: null,
        });
        makeFile('b.pdf', 1, {
          extension: 'pdf',
          type: 'document',
          createdAt: null,
          modifiedAt: null,
        });
        const otherLib = libOps.createLibrary(db, 'other', '/data/other');
        const other = fileOps.createFile(db, 'other-hash', 1);
        fileOps.createLocation(db, 'c.pptx', otherLib, other, {
          extension: 'pptx',
          type: 'other',
          createdAt: null,
          modifiedAt: null,
        });
        expect(complete('type:im')).toMatchObject({
          from: 5,
          completions: [{ text: 'image', kind: 'keyword' }],
        });
        expect(texts('type:')).toEqual(['document', 'image']);
        expect(texts('extension:p')).toEqual(['pdf', 'png']);
        expect(texts('extension:.pn')).toEqual(['png']);
        expect(complete('size:').completions).toEqual([]);
      });
    });

    it('completes sort fields after "sort:"', () => {
      tag('size');
      expect(texts('sort:')).toEqual([
        'size',
        'created_at',
        'modified_at',
        '-size',
        '-created_at',
        '-modified_at',
      ]);
      expect(complete('cat sort:-c')).toMatchObject({
        from: 9,
        to: 11,
        completions: [{ text: '-created_at', kind: 'keyword' }],
      });
    });

    it('completes value kinds after "?"', () => {
      tag('cat');
      expect(complete('cat?')).toMatchObject({ from: 4, to: 4 });
      expect(complete('cat?').completions).toEqual([
        { text: 'text', kind: 'valueKind' },
        { text: 'number', kind: 'valueKind' },
        { text: 'tag', kind: 'valueKind' },
        { text: 'anchor', kind: 'valueKind' },
      ]);
      expect(texts('cat?t')).toEqual(['text', 'tag']);
    });

    describe('quoting', () => {
      it('quotes tag text that the tokenizer would split or misread', () => {
        tag('big cat');
        tag('has:colon');
        tag('say "hi" \\o/');
        tag('a/b');
        tag('Not');
        expect(tagTexts('bi')).toEqual(['"big cat"']);
        expect(tagTexts('has')).toEqual(['"has:colon"']);
        expect(tagTexts('say')).toEqual(['"say \\"hi\\" \\\\o/"']);
        expect(tagTexts('a/')).toEqual([]); //read as a path, and no tag is named "a"
        expect(tagTexts('a')).toEqual(['"a/b"']);
        expect(tagTexts('no')).toEqual(['"Not"']);
      });

      it('accepts an unterminated quote as a partial quoted word', () => {
        tag('big cat');
        tag('a/b');
        tag('bird');
        expect(complete('dog "bi')).toMatchObject({ from: 4, to: 7 });
        expect(tagTexts('dog "bi')).toEqual(['"big cat"', 'bird']);
        //Inside quotes "/" is part of the name, not a path separator.
        expect(tagTexts('"a/')).toEqual(['"a/b"']);
        expect(() => complete('"')).not.toThrow();
        expect(() => complete('cat:"or \\')).not.toThrow();
        expect(complete('"').completions.map((c) => c.text)).toEqual([
          '"a/b"',
          '"big cat"',
          'bird',
        ]);
      });

      it('leaves out path segments that cannot be written unquoted', () => {
        const pet = tag('pet');
        tag('big cat', pet);
        const kitten = tag('kitten', pet);
        expect(complete('pet/').completions.map((c) => c.tagId)).toEqual([kitten]);
      });
    });
  });
});
