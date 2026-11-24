import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Path from 'node:path';
import type { Db } from '../db/index.ts';
import type { JobCallbacks, JobStatus } from '../services/jobManager.ts';
import { createTestDb } from '../test/helpers.ts';
import { createLibrary } from '../db/library_operations.ts';
import * as taggingOps from '../db/tagging_operations.ts';
import LibraryScanModule, { type ScanFs } from './libraryScan.ts';
import JsonImportModule, { getByDotPath } from './jsonImport.ts';
import { fakeFs, SymLink } from '../test/fakeFs.ts';

const ROOT = '/library';

/** Runs a job to completion (or failure), driving it the same way JobManager would. */
function runJob(
  module: JsonImportModule | LibraryScanModule,
  db: Db,
  rawOptions: unknown,
): { callbacks: Record<keyof JobCallbacks, ReturnType<typeof vi.fn>>; status: JobStatus } {
  const callbacks = {
    stepComplete: vi.fn(),
    jobComplete: vi.fn(),
    jobFailed: vi.fn(),
  } satisfies JobCallbacks;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const job = module.createJob(module.parseOptions(rawOptions) as any, db, callbacks);
  let steps = 0;
  while (!callbacks.jobComplete.mock.calls.length && !callbacks.jobFailed.mock.calls.length) {
    if (++steps > 1000) throw new Error('job did not terminate');
    job.execute();
  }
  return { callbacks, status: job.status() };
}

/** Populates the db with the library's files, the way a user would before importing. */
function scanIntoDb(db: Db, libraryId: number, fs: ScanFs) {
  runJob(new LibraryScanModule({ fs }), db, { libraryId });
}

const fileIdAt = (db: Db, path: string, libraryId: number): number =>
  (
    db
      .prepare<[string, number], { file_id: number }>(
        'SELECT file_id FROM locations WHERE path = ? AND library_id = ?',
      )
      .get(path, libraryId) as { file_id: number }
  ).file_id;

const tagsOn = (db: Db, fileId: number): number[] =>
  db
    .prepare<[number], { tag_id: number }>(
      'SELECT tag_id FROM file_tag_relationships WHERE file_id = ? ORDER BY tag_id',
    )
    .all(fileId)
    .map((r) => r.tag_id);

const textValues = (db: Db, fileId: number, tagId: number): string[] =>
  db
    .prepare<[number, number], { text_value: string }>(
      `SELECT t.text_value FROM file_tag_values v
       JOIN file_tag_value_text t ON t.value_id = v.value_id
       WHERE v.file_id = ? AND v.tag_id = ? AND v.kind = 'text'
       ORDER BY t.text_value`,
    )
    .all(fileId, tagId)
    .map((r) => r.text_value);

const numberValues = (db: Db, fileId: number, tagId: number): number[] =>
  db
    .prepare<[number, number], { num_value: number }>(
      `SELECT n.num_value FROM file_tag_values v
       JOIN file_tag_value_number n ON n.value_id = v.value_id
       WHERE v.file_id = ? AND v.tag_id = ? AND v.kind = 'number'
       ORDER BY n.num_value`,
    )
    .all(fileId, tagId)
    .map((r) => r.num_value);

describe('getByDotPath', () => {
  const data = { author: { name: 'Ada', tags: ['x', 'y'] }, top: 1 };
  it('walks object segments', () => {
    expect(getByDotPath(data, 'author.name')).toBe('Ada');
    expect(getByDotPath(data, 'top')).toBe(1);
    expect(getByDotPath(data, 'author.tags')).toEqual(['x', 'y']);
  });
  it('returns undefined when a segment misses or hits a non-object', () => {
    expect(getByDotPath(data, 'author.missing')).toBeUndefined();
    expect(getByDotPath(data, 'top.deeper')).toBeUndefined();
    expect(getByDotPath(data, 'author.tags.0')).toBeUndefined();
  });
});

describe('JsonImportModule.parseOptions', () => {
  const module = new JsonImportModule({ fs: fakeFs({}) });

  it('accepts a valid non-direct options object', () => {
    expect(module.parseOptions({ libraryId: 1, path: 'author.name', tagId: 7 })).toEqual({
      libraryId: 1,
      paths: [{ path: 'author.name', tagId: 7, direct: undefined }],
      ignorePaths: undefined,
      subpath: undefined,
      createIfMissing: undefined,
    });
  });

  it('accepts direct mode with the creation conveniences', () => {
    expect(
      module.parseOptions({
        libraryId: 1,
        path: 'author.name',
        direct: true,
        createIfMissing: true,
        parentTagId: 3,
        color: ' #aabbcc ',
      }),
    ).toMatchObject({
      paths: [{ path: 'author.name', direct: true }],
      createIfMissing: true,
      parentTagId: 3,
      color: '#aabbcc',
    });
  });

  it('accepts multiple paths with independent modes and tags', () => {
    expect(
      module.parseOptions({
        libraryId: 1,
        paths: [
          { path: 'author.name', tagId: 7, tagName: 'Author' },
          { path: 'people', direct: true },
        ],
        createIfMissing: true,
      }),
    ).toMatchObject({
      paths: [
        { path: 'author.name', tagId: 7, tagName: 'Author' },
        { path: 'people', direct: true },
      ],
      createIfMissing: true,
    });
  });

  it('requires at least one path and validates each path rule', () => {
    expect(() => module.parseOptions({ libraryId: 1, paths: [] })).toThrow(
      /paths must be a non-empty array/,
    );
    expect(() => module.parseOptions({ libraryId: 1, paths: [{ path: 'a' }] })).toThrow(
      /tagId must be an integer/,
    );
    expect(() =>
      module.parseOptions({ libraryId: 1, paths: [{ path: 'a', direct: true, tagId: 1 }] }),
    ).toThrow(/tagId must be omitted in direct mode/);
  });

  it.each([null, undefined, 'x', 42])('rejects non-object input %j', (raw) => {
    expect(() => module.parseOptions(raw)).toThrow(/must be an object/);
  });

  it.each([{}, { libraryId: '1', path: 'a', tagId: 1 }])('rejects bad libraryId %j', (raw) => {
    expect(() => module.parseOptions(raw)).toThrow(/libraryId must be an integer/);
  });

  it('rejects bad paths', () => {
    expect(() => module.parseOptions({ libraryId: 1, path: '', tagId: 1 })).toThrow(/path must/);
    expect(() => module.parseOptions({ libraryId: 1, path: 'a..b', tagId: 1 })).toThrow(
      /path must/,
    );
    expect(() => module.parseOptions({ libraryId: 1, tagId: 1 })).toThrow(/path must/);
  });

  it('requires tagId in non-direct mode and forbids it in direct mode', () => {
    expect(() => module.parseOptions({ libraryId: 1, path: 'a' })).toThrow(
      /tagId must be an integer/,
    );
    expect(() => module.parseOptions({ libraryId: 1, path: 'a', direct: true, tagId: 1 })).toThrow(
      /tagId must be omitted in direct mode/,
    );
  });

  it('forbids creation conveniences outside their mode', () => {
    expect(() =>
      module.parseOptions({ libraryId: 1, path: 'a', tagId: 1, createIfMissing: true }),
    ).toThrow(/require direct mode/);
    expect(() =>
      module.parseOptions({ libraryId: 1, path: 'a', direct: true, parentTagId: 2 }),
    ).toThrow(/require createIfMissing/);
    expect(() =>
      module.parseOptions({ libraryId: 1, path: 'a', direct: true, color: 'red' }),
    ).toThrow(/require createIfMissing/);
  });
});

describe('JsonImportJob', () => {
  let db: Db;
  let libraryId: number;
  let authorTag: number;

  beforeEach(() => {
    db = createTestDb();
    libraryId = createLibrary(db, 'lib', ROOT);
    authorTag = taggingOps.createTag(db, { alias: 'Author', libraryId });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('throws when the library does not exist', () => {
    const module = new JsonImportModule({ fs: fakeFs({}) });
    const callbacks = { stepComplete: vi.fn(), jobComplete: vi.fn(), jobFailed: vi.fn() };
    expect(() =>
      module.createJob({ libraryId: 999, paths: [{ path: 'a', tagId: authorTag }] }, db, callbacks),
    ).toThrow(/Library not found/);
  });

  it('throws when the tag does not exist in the library', () => {
    const module = new JsonImportModule({ fs: fakeFs({}) });
    const callbacks = { stepComplete: vi.fn(), jobComplete: vi.fn(), jobFailed: vi.fn() };
    expect(() =>
      module.createJob({ libraryId, paths: [{ path: 'a', tagId: 999 }] }, db, callbacks),
    ).toThrow(/not found/);
  });

  it('completes with an empty root', () => {
    const module = new JsonImportModule({ fs: fakeFs({}) });
    const { callbacks, status } = runJob(module, db, { libraryId, path: 'a', tagId: authorTag });
    expect(status.state).toBe('complete');
    expect(callbacks.jobComplete).toHaveBeenCalledOnce();
    expect(callbacks.jobFailed).not.toHaveBeenCalled();
  });

  it('matches a sidecar by stripping ".json" and applies a text value', () => {
    const fs = fakeFs({
      'photo.jpg': 'jpeg-bytes',
      'photo.jpg.json': JSON.stringify({ author: { name: 'Ada' } }),
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { status } = runJob(module, db, { libraryId, path: 'author.name', tagId: authorTag });

    expect(status).toMatchObject({
      state: 'complete',
      jsonFilesFound: 1,
      filesTagged: 1,
      valuesApplied: 1,
    });
    const fileId = fileIdAt(db, 'photo.jpg', libraryId);
    expect(tagsOn(db, fileId)).toEqual([authorTag]);
    expect(textValues(db, fileId, authorTag)).toEqual(['Ada']);
    //The sidecar itself is never a target
    expect(status.imports).toEqual([{ json: 'photo.jpg.json', targets: ['photo.jpg'] }]);
  });

  it('does not read a linked sidecar or use a link as a target', () => {
    const fs = fakeFs({
      'photo.jpg': 'jpeg-bytes',
      'photo.jpg.json': new SymLink('/etc/secret.json'),
      'other.json': JSON.stringify({ author: { name: 'Ada' } }),
      'other.jpg': new SymLink(`${ROOT}/photo.jpg`),
    });
    const readFileSync = vi.spyOn(fs, 'readFileSync');
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { status } = runJob(module, db, { libraryId, path: 'author.name', tagId: authorTag });

    expect(readFileSync.mock.calls.map(([p]) => p)).toEqual([Path.join(ROOT, 'other.json')]);
    expect(status).toMatchObject({ state: 'complete', jsonFilesFound: 1, filesTagged: 0 });
    expect(tagsOn(db, fileIdAt(db, 'photo.jpg', libraryId))).toEqual([]);
  });

  it('matches a bare sidecar to every same-stem non-JSON sibling', () => {
    const fs = fakeFs({
      'photo.jpg': 'jpeg',
      'photo.png': 'png',
      'photo.json': JSON.stringify({ author: 'Ada' }),
      'other.txt': 'txt',
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { status } = runJob(module, db, { libraryId, path: 'author', tagId: authorTag });

    expect(status).toMatchObject({ filesTagged: 2, valuesApplied: 2 });
    for (const p of ['photo.jpg', 'photo.png']) {
      expect(textValues(db, fileIdAt(db, p, libraryId), authorTag)).toEqual(['Ada']);
    }
    expect(textValues(db, fileIdAt(db, 'other.txt', libraryId), authorTag)).toEqual([]);
  });

  it('counts sidecars with no sibling on disk or no location in the db', () => {
    const fs = fakeFs({
      'known.jpg': 'jpeg',
      'known.json': JSON.stringify({ a: 'x' }),
      'lonely.json': JSON.stringify({ a: 'x' }),
    });
    const module = new JsonImportModule({ fs });
    //Scan before the data file appears, so "known.json" has a sibling on disk but no location row.
    scanIntoDb(db, libraryId, fakeFs({ 'known.json': JSON.stringify({ a: 'x' }) }));
    const { status } = runJob(module, db, { libraryId, path: 'a', tagId: authorTag });

    expect(status).toMatchObject({
      jsonFilesFound: 2,
      skippedUnknownTargets: 2,
      filesTagged: 0,
    });
  });

  it('counts invalid JSON without failing the job', () => {
    const fs = fakeFs({ 'a.jpg': 'jpeg', 'a.jpg.json': '{not json' });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { callbacks, status } = runJob(module, db, { libraryId, path: 'a', tagId: authorTag });

    expect(callbacks.jobComplete).toHaveBeenCalledOnce();
    expect(status).toMatchObject({ state: 'complete', invalidJson: 1, filesTagged: 0 });
    expect(status.errors).toEqual([{ path: 'a.jpg.json', reason: 'Invalid JSON' }]);
  });

  it('expands arrays and maps value kinds: number, boolean, null, object', () => {
    const fs = fakeFs({
      'a.jpg': 'jpeg',
      'a.jpg.json': JSON.stringify({ data: [1, 'two', true, null, { skip: 'me' }] }),
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { status } = runJob(module, db, { libraryId, path: 'data', tagId: authorTag });

    expect(status).toMatchObject({ valuesApplied: 3, skippedValues: 1 });
    const fileId = fileIdAt(db, 'a.jpg', libraryId);
    expect(tagsOn(db, fileId)).toEqual([authorTag]); //null still applies the tag
    expect(textValues(db, fileId, authorTag)).toEqual(['true', 'two']);
    expect(numberValues(db, fileId, authorTag)).toEqual([1]);
  });

  it('skips a missing path, counts a miss, and does not apply the tag', () => {
    const fs = fakeFs({
      'a.jpg': 'jpeg',
      'a.jpg.json': JSON.stringify({ other: 'x' }),
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { callbacks, status } = runJob(module, db, {
      libraryId,
      path: 'a.b',
      tagId: authorTag,
    });

    expect(callbacks.jobComplete).toHaveBeenCalledOnce();
    expect(status).toMatchObject({ valuesApplied: 0, skippedValues: 0, filesTagged: 0 });
    expect(status.pathStats).toEqual([
      {
        path: 'a.b',
        tagId: authorTag,
        direct: false,
        applications: 0,
        tagsCreated: 0,
        misses: 1,
      },
    ]);
    expect(status.misses).toEqual([{ json: 'a.jpg.json', path: 'a.b', reason: 'Path not found' }]);
    expect(tagsOn(db, fileIdAt(db, 'a.jpg', libraryId))).toEqual([]);
  });

  it('applies multiple paths independently and reports malformed and missing values', () => {
    const fs = fakeFs({
      'a.jpg': 'jpeg',
      'a.jpg.json': JSON.stringify({
        author: { name: 'Ada' },
        names: ['Ada', 'Bob'],
        empty: '',
        malformed: { value: 'not scalar' },
      }),
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { callbacks, status } = runJob(module, db, {
      libraryId,
      paths: [
        { path: 'author.name', tagId: authorTag, tagName: 'Author' },
        { path: 'names', direct: true },
        { path: 'empty', tagId: authorTag, tagName: 'Author' },
        { path: 'malformed', tagId: authorTag, tagName: 'Author' },
        { path: 'absent.value', tagId: authorTag, tagName: 'Author' },
      ],
      createIfMissing: true,
    });

    expect(callbacks.jobComplete).toHaveBeenCalledOnce();
    expect(callbacks.jobFailed).not.toHaveBeenCalled();
    expect(status).toMatchObject({
      valuesApplied: 3,
      tagsCreated: 2,
      filesTagged: 1,
      skippedValues: 2,
    });
    expect(status.pathStats).toEqual([
      {
        path: 'author.name',
        tagId: authorTag,
        tagName: 'Author',
        direct: false,
        applications: 1,
        tagsCreated: 0,
        misses: 0,
      },
      {
        path: 'names',
        direct: true,
        applications: 2,
        tagsCreated: 2,
        misses: 0,
      },
      {
        path: 'empty',
        tagId: authorTag,
        tagName: 'Author',
        direct: false,
        applications: 0,
        tagsCreated: 0,
        misses: 1,
      },
      {
        path: 'malformed',
        tagId: authorTag,
        tagName: 'Author',
        direct: false,
        applications: 0,
        tagsCreated: 0,
        misses: 1,
      },
      {
        path: 'absent.value',
        tagId: authorTag,
        tagName: 'Author',
        direct: false,
        applications: 0,
        tagsCreated: 0,
        misses: 1,
      },
    ]);
    expect(status.misses).toEqual([
      { json: 'a.jpg.json', path: 'empty', reason: 'No usable value at path' },
      { json: 'a.jpg.json', path: 'malformed', reason: 'No usable value at path' },
      { json: 'a.jpg.json', path: 'absent.value', reason: 'Path not found' },
    ]);
    const fileId = fileIdAt(db, 'a.jpg', libraryId);
    const ada = taggingOps.searchTagByAlias(db, 'Ada', libraryId)!;
    const bob = taggingOps.searchTagByAlias(db, 'Bob', libraryId)!;
    expect(tagsOn(db, fileId).sort()).toEqual([authorTag, ada.tag_id, bob.tag_id].sort());
    expect(textValues(db, fileId, authorTag)).toEqual(['Ada']);
  });

  it('honors the ignore list and the subpath', () => {
    //The data files carry distinct bytes; files are content-addressed and shared rows would
    //make the assertion meaningless.
    const fs = fakeFs({
      in: {
        'a.jpg': 'jpeg-a',
        'a.jpg.json': JSON.stringify({ a: 'in' }),
        skip: { 'b.jpg': 'jpeg-b', 'b.jpg.json': JSON.stringify({ a: 'skipped' }) },
      },
      out: { 'c.jpg': 'jpeg-c', 'c.jpg.json': JSON.stringify({ a: 'out' }) },
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { status } = runJob(module, db, {
      libraryId,
      path: 'a',
      tagId: authorTag,
      subpath: 'in',
      ignorePaths: ['skip'],
    });

    expect(status).toMatchObject({ jsonFilesFound: 1, filesTagged: 1 });
    expect(textValues(db, fileIdAt(db, 'in/a.jpg', libraryId), authorTag)).toEqual(['in']);
    expect(tagsOn(db, fileIdAt(db, 'in/skip/b.jpg', libraryId))).toEqual([]);
  });

  it('direct mode applies existing tags by name, alias-aware', () => {
    const aliasTag = taggingOps.createTag(db, { alias: 'Ada Lovelace', libraryId });
    taggingOps.addAlias(db, aliasTag, 'Countess', libraryId);
    const fs = fakeFs({
      'a.jpg': 'jpeg',
      'a.jpg.json': JSON.stringify({ people: ['Countess', 'Ada Lovelace', 'Nobody'] }),
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { status } = runJob(module, db, { libraryId, path: 'people', direct: true });

    expect(status).toMatchObject({ valuesApplied: 2, missingTagNames: 1, tagsCreated: 0 });
    expect(tagsOn(db, fileIdAt(db, 'a.jpg', libraryId))).toEqual([aliasTag]);
    expect(taggingOps.getTag(db, aliasTag)?.file_count).toBe(1);
  });

  it('direct mode with createIfMissing creates tags with parent and color', () => {
    const parent = taggingOps.createTag(db, { alias: 'People', libraryId, isCategory: true });
    const fs = fakeFs({
      'a.jpg': 'jpeg',
      'a.jpg.json': JSON.stringify({ names: ['Ada', 'Bob'] }),
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { status } = runJob(module, db, {
      libraryId,
      path: 'names',
      direct: true,
      createIfMissing: true,
      parentTagId: parent,
      color: '#ff0000',
    });

    expect(status).toMatchObject({ valuesApplied: 2, tagsCreated: 2, missingTagNames: 0 });
    const fileId = fileIdAt(db, 'a.jpg', libraryId);
    const ada = taggingOps.searchTagByAlias(db, 'Ada', libraryId)!;
    const bob = taggingOps.searchTagByAlias(db, 'Bob', libraryId)!;
    expect(ada.tag_id).not.toBe(parent);
    expect(tagsOn(db, fileId).sort()).toEqual([ada.tag_id, bob.tag_id].sort());
    expect(taggingOps.getTag(db, ada.tag_id)).toMatchObject({ color: '#ff0000' });
    const parents = db
      .prepare<[number], { tag_id: number }>(
        `SELECT tag_id FROM tag_tag_values WHERE subject_tag_id = ? AND kind = 'parent'`,
      )
      .all(ada.tag_id)
      .map((r) => r.tag_id);
    expect(parents).toEqual([parent]);
  });

  it('direct mode reuses created tags across files', () => {
    const fs = fakeFs({
      'a.jpg': 'jpeg',
      'a.jpg.json': JSON.stringify({ name: 'Ada' }),
      sub: { 'b.jpg': 'jpeg2', 'b.jpg.json': JSON.stringify({ name: 'Ada' }) },
    });
    const module = new JsonImportModule({ fs });
    scanIntoDb(db, libraryId, fs);
    const { status } = runJob(module, db, {
      libraryId,
      path: 'name',
      direct: true,
      createIfMissing: true,
    });

    expect(status.tagsCreated).toBe(1);
    const ada = taggingOps.searchTagByAlias(db, 'Ada', libraryId)!;
    expect(tagsOn(db, fileIdAt(db, 'a.jpg', libraryId))).toEqual([ada.tag_id]);
    expect(tagsOn(db, fileIdAt(db, 'sub/b.jpg', libraryId))).toEqual([ada.tag_id]);
  });

  it('reports failure when the filesystem throws', () => {
    const fs = fakeFs({ 'a.jpg.json': JSON.stringify({ a: 1 }) });
    fs.readFileSync = () => {
      throw new Error('EACCES');
    };
    const module = new JsonImportModule({ fs });
    const { callbacks, status } = runJob(module, db, { libraryId, path: 'a', tagId: authorTag });

    expect(callbacks.jobFailed).toHaveBeenCalledOnce();
    expect(status.state).toBe('error');
  });

  it('halt() marks the status as halted', () => {
    const module = new JsonImportModule({ fs: fakeFs({}) });
    const job = module.createJob({ libraryId, paths: [{ path: 'a', tagId: authorTag }] }, db, {
      stepComplete: vi.fn(),
      jobComplete: vi.fn(),
      jobFailed: vi.fn(),
    });
    expect(job.status().state).toBe('running');
    job.halt?.();
    expect(job.status().state).toBe('halted');
  });
});
