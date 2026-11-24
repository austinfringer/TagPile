import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Path from 'node:path';
import * as crypto from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { JobCallbacks, JobStatus } from '../services/jobManager.ts';
import { createTestDb } from '../test/helpers.ts';
import { createLibrary } from '../db/library_operations.ts';
import LibraryScanModule, { isSafeSubpath, makeIgnoreMatcher, type ScanFs } from './libraryScan.ts';
import { fakeFs, SymLink, type Tree } from '../test/fakeFs.ts';

const ROOT = '/library';

/** Routes lookups to one of several fake trees by library root. */
function multiRootFs(trees: Record<string, Tree>): ScanFs {
  const fss = Object.entries(trees).map(([root, tree]) => [root, fakeFs(tree, root)] as const);
  const pick = (p: string) => {
    const hit = fss.find(([root]) => p === root || p.startsWith(root + Path.sep));
    if (!hit) throw new Error(`ENOENT: ${p}`);
    return hit[1];
  };
  const byFd = new Map<number, ScanFs>();
  return {
    lstatSync: (p) => pick(p).lstatSync(p),
    readdirSync: (p) => pick(p).readdirSync(p),
    existsSync: (p) => pick(p).existsSync(p),
    readFileSync: (p) => pick(p).readFileSync(p),
    openSync: (p, flags) => {
      const fd = pick(p).openSync(p, flags);
      byFd.set(fd, pick(p));
      return fd;
    },
    readSync: (fd, ...rest) => byFd.get(fd)!.readSync(fd, ...rest),
    closeSync: (fd) => byFd.get(fd)!.closeSync(fd),
  };
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

type LocationRow = {
  location_id: number;
  file_id: number;
  library_id: number;
  path: string;
  last_seen: number;
  missing: number;
  previous_file_id: number | null;
  extension: string | null;
  type: string | null;
  created_at: number | null;
  modified_at: number | null;
};
type FileRow = { file_id: number; file_hash: string; size: number };

const locations = (db: Db, libraryId?: number) =>
  libraryId === undefined
    ? db.prepare<[], LocationRow>('SELECT * FROM locations ORDER BY path').all()
    : db
        .prepare<[number], LocationRow>(
          'SELECT * FROM locations WHERE library_id = ? ORDER BY path',
        )
        .all(libraryId);
const files = (db: Db) => db.prepare<[], FileRow>('SELECT * FROM files ORDER BY file_id').all();

function createTag(db: Db, libraryId: number, name: string): number {
  const now = new Date().toISOString();
  const tagId = db
    .prepare('INSERT INTO tags (library_id, created_at, updated_at) VALUES (?, ?, ?)')
    .run(libraryId, now, now).lastInsertRowid as number;
  db.prepare('INSERT INTO aliases (tag_id, library_id, text, is_primary) VALUES (?, ?, ?, 1)').run(
    tagId,
    libraryId,
    name,
  );
  return tagId;
}
const tagFile = (db: Db, fileId: number, tagId: number) =>
  db
    .prepare('INSERT INTO file_tag_relationships (file_id, tag_id) VALUES (?, ?)')
    .run(fileId, tagId);
const tagsOn = (db: Db, fileId: number) =>
  db
    .prepare<[number], { tag_id: number }>(
      'SELECT tag_id FROM file_tag_relationships WHERE file_id = ? ORDER BY tag_id',
    )
    .all(fileId)
    .map((r) => r.tag_id);

/** Runs the job to completion (or failure), driving it the same way JobManager would. */
function runScan(module: LibraryScanModule, db: Db, rawOptions: unknown) {
  const callbacks = {
    stepComplete: vi.fn(),
    jobComplete: vi.fn(),
    jobFailed: vi.fn(),
  } satisfies JobCallbacks;
  const job = module.createJob(module.parseOptions(rawOptions), db, callbacks);
  let steps = 0;
  while (!callbacks.jobComplete.mock.calls.length && !callbacks.jobFailed.mock.calls.length) {
    if (++steps > 1000) throw new Error('scan did not terminate');
    job.execute();
  }
  return { job, callbacks, status: job.status(), steps };
}

describe('isSafeSubpath', () => {
  it.each(['', '.', 'a', 'a/b', 'a/../b', './a'])('accepts %j', (p) => {
    expect(isSafeSubpath(p)).toBe(true);
  });
  it.each(['/abs', '..', '../a', 'a/../..'])('rejects %j', (p) => {
    expect(isSafeSubpath(p)).toBe(false);
  });
});

describe('LibraryScanModule.parseOptions', () => {
  const module = new LibraryScanModule({ fs: fakeFs({}) });

  it('accepts a valid options object', () => {
    expect(module.parseOptions({ libraryId: 1, subpath: 'a', ignorePaths: ['b'] })).toEqual({
      libraryId: 1,
      subpath: 'a',
      ignorePaths: ['b'],
    });
  });

  it('allows optional fields to be omitted', () => {
    expect(module.parseOptions({ libraryId: 1 })).toEqual({
      libraryId: 1,
      subpath: undefined,
      ignorePaths: undefined,
    });
  });

  it.each([null, undefined, 'x', 42])('rejects non-object input %j', (raw) => {
    expect(() => module.parseOptions(raw)).toThrow(/must be an object/);
  });

  it.each([{}, { libraryId: '1' }, { libraryId: 1.5 }])('rejects bad libraryId %j', (raw) => {
    expect(() => module.parseOptions(raw)).toThrow(/libraryId must be an integer/);
  });

  it('rejects bad subpath and ignorePaths', () => {
    expect(() => module.parseOptions({ libraryId: 1, subpath: ['a'] })).toThrow(/subpath must/);
    expect(() => module.parseOptions({ libraryId: 1, subpath: '/etc' })).toThrow(/subpath must/);
    expect(() => module.parseOptions({ libraryId: 1, subpath: '../x' })).toThrow(/subpath must/);
    expect(() => module.parseOptions({ libraryId: 1, ignorePaths: [null] })).toThrow(
      /ignorePaths must be/,
    );
  });
});

describe('LibraryScanJob', () => {
  let db: Db;
  let libraryId: number;
  beforeEach(() => {
    db = createTestDb();
    libraryId = createLibrary(db, 'lib', ROOT);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it('throws when the library does not exist', () => {
    const module = new LibraryScanModule({ fs: fakeFs({}) });
    const callbacks = { stepComplete: vi.fn(), jobComplete: vi.fn(), jobFailed: vi.fn() };
    expect(() => module.createJob({ libraryId: 999 }, db, callbacks)).toThrow(/Library not found/);
  });

  it('completes with an empty root and an empty database', () => {
    const module = new LibraryScanModule({ fs: fakeFs({}) });
    const { callbacks, status } = runScan(module, db, { libraryId });
    expect(status.state).toBe('complete');
    expect(callbacks.jobComplete).toHaveBeenCalledOnce();
    expect(callbacks.jobFailed).not.toHaveBeenCalled();
    expect(locations(db)).toEqual([]);
  });

  it('calls stepComplete after every non-terminal step', () => {
    const module = new LibraryScanModule({ fs: fakeFs({ a: 'A', b: 'B' }) });
    const { callbacks, steps } = runScan(module, db, { libraryId });
    expect(callbacks.stepComplete).toHaveBeenCalledTimes(steps - 1);
  });

  it('scans the whole root when subpath is omitted, creating a file + location per file', () => {
    const module = new LibraryScanModule({
      fs: fakeFs({ photos: { 'a.jpg': 'aaa', nested: { 'b.jpg': 'bbb' } }, 'c.txt': 'ccc' }),
    });
    const { status } = runScan(module, db, { libraryId });

    expect(locations(db).map((l) => l.path)).toEqual([
      'c.txt',
      'photos/a.jpg',
      'photos/nested/b.jpg',
    ]);
    expect(
      files(db)
        .map((f) => [f.file_hash, f.size])
        .sort(),
    ).toEqual(
      [
        [sha256('aaa'), 3],
        [sha256('bbb'), 3],
        [sha256('ccc'), 3],
      ].sort(),
    );
    expect(status).toMatchObject({
      state: 'complete',
      filesScanned: 3,
      filesCreated: 3,
      filesMigrated: 0,
      duplicateFiles: 0,
      idleFiles: 0,
      missingLocations: 0,
    });
  });

  it('records file metadata (extension, type, stat times) on new locations', () => {
    const module = new LibraryScanModule({
      fs: fakeFs({ 'a.jpg': 'aaa', notes: { 'b.MD': 'bbb', noext: 'ccc' } }),
    });
    runScan(module, db, { libraryId });

    const byPath = Object.fromEntries(locations(db).map((l) => [l.path, l]));
    expect(byPath['a.jpg']).toMatchObject({ extension: 'jpg', type: 'image' });
    expect(byPath['notes/b.MD']).toMatchObject({ extension: 'md', type: 'text' });
    expect(byPath['notes/noext']).toMatchObject({ extension: null, type: 'other' });
    for (const location of locations(db)) {
      expect(location.created_at).toBe(1_000_000);
      expect(location.modified_at).toBe(2_000_000);
    }
  });

  it('does not follow symbolic links to files or directories', () => {
    const module = new LibraryScanModule({
      fs: multiRootFs({
        [ROOT]: {
          'a.jpg': 'aaa',
          'outside.jpg': new SymLink('/outside/secret.jpg'),
          loop: new SymLink(ROOT),
        },
        '/outside': { 'secret.jpg': 'secret' },
      }),
    });
    const { status } = runScan(module, db, { libraryId });
    expect(locations(db).map((l) => l.path)).toEqual(['a.jpg']);
    expect(files(db).map((f) => f.file_hash)).toEqual([sha256('aaa')]);
    expect(status).toMatchObject({ state: 'complete', entriesSkipped: 2, filesScanned: 1 });
  });

  it('hashes a large file over several steps and closes it', () => {
    const fs = fakeFs({ 'big.bin': 'abcdefghij', 'small.bin': 'xyz' });
    const closeSync = vi.spyOn(fs, 'closeSync');
    const module = new LibraryScanModule({ fs, chunkSize: 4 });
    const { status, steps } = runScan(module, db, { libraryId });
    expect(
      files(db)
        .map((f) => [f.file_hash, f.size])
        .sort(),
    ).toEqual(
      [
        [sha256('abcdefghij'), 10],
        [sha256('xyz'), 3],
      ].sort(),
    );
    expect(status).toMatchObject({ state: 'complete', filesCreated: 2 });
    // root, big.bin (3 chunks), small.bin, then the switch to the reverse pass
    expect(steps).toBe(6);
    expect(closeSync).toHaveBeenCalledTimes(2);
  });

  it('closes a file that is still being hashed when the job is halted', () => {
    const fs = fakeFs({ 'big.bin': 'abcdefghij' });
    const closeSync = vi.spyOn(fs, 'closeSync');
    const module = new LibraryScanModule({ fs, chunkSize: 4 });
    const callbacks = { stepComplete: vi.fn(), jobComplete: vi.fn(), jobFailed: vi.fn() };
    const job = module.createJob({ libraryId }, db, callbacks);
    job.execute(); // root
    job.execute(); // first chunk of big.bin
    job.halt?.();
    expect(closeSync).toHaveBeenCalledOnce();
    expect(files(db)).toEqual([]);
  });

  it('only scans the requested subpath', () => {
    const module = new LibraryScanModule({
      fs: fakeFs({ in: { 'a.jpg': 'aaa' }, out: { 'b.jpg': 'bbb' } }),
    });
    runScan(module, db, { libraryId, subpath: 'in' });
    expect(locations(db).map((l) => l.path)).toEqual(['in/a.jpg']);
  });

  it('links a new location to an existing file when the content hash is already known', () => {
    const module = new LibraryScanModule({ fs: fakeFs({ 'a.jpg': 'same', 'copy.jpg': 'same' }) });
    const { status } = runScan(module, db, { libraryId });

    const allFiles = files(db);
    expect(allFiles).toHaveLength(1);
    expect(locations(db).map((l) => l.file_id)).toEqual([
      allFiles[0]!.file_id,
      allFiles[0]!.file_id,
    ]);
    expect(status).toMatchObject({ filesScanned: 2, filesCreated: 1, duplicateFiles: 1 });
  });

  it('records duplicate groups with their sibling paths for the detail view', () => {
    const fs = fakeFs({ 'a.jpg': 'same', sub: { 'b.jpg': 'same' } });
    const module = new LibraryScanModule({ fs });
    const { status } = runScan(module, db, { libraryId });
    const duplicates = status.duplicates as { path: string; siblings: string[] }[];

    expect(status.duplicateFiles).toBe(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0]!.siblings).toHaveLength(1);
    const paths = locations(db).map((l) => l.path);
    expect([duplicates[0]!.path, ...duplicates[0]!.siblings].sort()).toEqual(paths);
  });

  it('records migrated paths for the detail view', () => {
    const fs = fakeFs({ 'a.jpg': 'v1' });
    const module = new LibraryScanModule({ fs });
    runScan(module, db, { libraryId });
    fs.tree['a.jpg'] = 'v2';
    db.prepare('UPDATE locations SET last_seen = 1').run();

    const { status } = runScan(module, db, { libraryId });
    expect(status.filesMigrated).toBe(1);
    expect(status.migrated).toEqual([{ path: 'a.jpg' }]);
  });

  it('leaves known, unchanged locations idle and bumps last_seen', () => {
    const module = new LibraryScanModule({ fs: fakeFs({ 'a.jpg': 'aaa' }) });
    runScan(module, db, { libraryId });
    const before = locations(db)[0]!;
    db.prepare('UPDATE locations SET last_seen = 1').run();

    const { status } = runScan(module, db, { libraryId });

    expect(status).toMatchObject({
      filesScanned: 1,
      idleFiles: 1,
      filesCreated: 0,
      filesMigrated: 0,
    });
    const after = locations(db)[0]!;
    expect(after.file_id).toBe(before.file_id);
    expect(after.last_seen).toBeGreaterThan(1);
    expect(files(db)).toHaveLength(1);
  });

  it('relinks a location whose content changed, remembering the previous file and copying tags', () => {
    const fs = fakeFs({ 'a.jpg': 'v1' });
    const module = new LibraryScanModule({ fs });
    runScan(module, db, { libraryId });
    const oldFile = files(db)[0]!;
    const tagId = createTag(db, libraryId, 'keep');
    tagFile(db, oldFile.file_id, tagId);

    fs.tree['a.jpg'] = 'v2';
    db.prepare('UPDATE locations SET last_seen = 1').run();
    const { status } = runScan(module, db, { libraryId });

    expect(status).toMatchObject({
      filesScanned: 1,
      filesMigrated: 1,
      idleFiles: 0,
      filesCreated: 0,
    });
    const allFiles = files(db);
    expect(allFiles).toHaveLength(2);
    const newFile = allFiles.find((f) => f.file_id !== oldFile.file_id)!;
    expect(newFile.file_hash).toBe(sha256('v2'));
    expect(locations(db)[0]).toMatchObject({
      file_id: newFile.file_id,
      previous_file_id: oldFile.file_id,
    });
    expect(tagsOn(db, newFile.file_id)).toEqual([tagId]);
  });

  it('relinks to the existing file row when content reverts to known bytes', () => {
    const fs = fakeFs({ 'a.jpg': 'v1' });
    const module = new LibraryScanModule({ fs });
    runScan(module, db, { libraryId });
    fs.tree['a.jpg'] = 'v2';
    db.prepare('UPDATE locations SET last_seen = 1').run();
    runScan(module, db, { libraryId });
    fs.tree['a.jpg'] = 'v1';
    db.prepare('UPDATE locations SET last_seen = 1').run();
    const { status } = runScan(module, db, { libraryId });

    expect(status).toMatchObject({ filesMigrated: 1, filesCreated: 0 });
    expect(files(db)).toHaveLength(2);
    expect(locations(db)[0]!.file_id).toBe(
      files(db).find((f) => f.file_hash === sha256('v1'))!.file_id,
    );
  });

  it('only copies this library\u2019s tags when content changes', () => {
    const other = createLibrary(db, 'other', '/other');
    const fs = multiRootFs({ [ROOT]: { 'a.jpg': 'v1' }, '/other': { 'b.jpg': 'v1' } });
    const module = new LibraryScanModule({ fs });
    runScan(module, db, { libraryId });
    runScan(module, db, { libraryId: other });
    const shared = files(db)[0]!;
    const mine = createTag(db, libraryId, 'mine');
    const theirs = createTag(db, other, 'theirs');
    tagFile(db, shared.file_id, mine);
    tagFile(db, shared.file_id, theirs);

    const module2 = new LibraryScanModule({
      fs: multiRootFs({ [ROOT]: { 'a.jpg': 'v2' }, '/other': { 'b.jpg': 'v1' } }),
    });
    db.prepare('UPDATE locations SET last_seen = 1').run();
    runScan(module2, db, { libraryId });

    const newFile = files(db).find((f) => f.file_hash === sha256('v2'))!;
    expect(tagsOn(db, newFile.file_id)).toEqual([mine]);
    expect(tagsOn(db, shared.file_id).sort()).toEqual([mine, theirs].sort());
  });

  it('marks locations that were not seen in the forward scan as missing', () => {
    const fs = fakeFs({ 'a.jpg': 'aaa', 'gone.jpg': 'ggg' });
    const module = new LibraryScanModule({ fs });
    runScan(module, db, { libraryId });

    delete fs.tree['gone.jpg'];
    // Both scans can run within the same millisecond; age the rows so they count as stale.
    db.prepare('UPDATE locations SET last_seen = 1').run();
    const { status } = runScan(module, db, { libraryId });

    expect(status).toMatchObject({ missingLocations: 1, staleLocationsOnDisk: 0, idleFiles: 1 });
    const byPath = Object.fromEntries(locations(db).map((l) => [l.path, l.missing]));
    expect(byPath).toEqual({ 'a.jpg': 0, 'gone.jpg': 1 });
  });

  it('counts a stale location whose file still exists on disk as on disk rather than missing', () => {
    // A location that is stale (never seen) but whose file exists: the forward walk doesn't list
    // it (empty root) yet existsSync says it is there.
    db.prepare('INSERT INTO files (file_hash, size) VALUES (?, 1)').run('x');
    db.prepare(
      'INSERT INTO locations (file_id, library_id, path, last_seen) VALUES (1, ?, ?, 0)',
    ).run(libraryId, 'a.jpg');
    const fs = fakeFs({});
    fs.existsSync = () => true;
    const { status } = runScan(new LibraryScanModule({ fs }), db, { libraryId });

    expect(status).toMatchObject({ staleLocationsOnDisk: 1, missingLocations: 0 });
    expect(locations(db)[0]!.missing).toBe(0);
  });

  it('only reverse-scans locations under the requested subpath', () => {
    const fs = fakeFs({
      in: { 'a.jpg': 'aaa' },
      inner: { 'c.jpg': 'ccc' },
      out: { 'b.jpg': 'bbb' },
    });
    const module = new LibraryScanModule({ fs });
    runScan(module, db, { libraryId });

    delete fs.tree['out'];
    delete fs.tree['inner'];
    db.prepare('UPDATE locations SET last_seen = 0').run();
    const { status } = runScan(module, db, { libraryId, subpath: 'in' });

    // `inner/` shares the prefix string but is a different directory and must be left alone
    expect(status).toMatchObject({ missingLocations: 0, idleFiles: 1 });
    expect(locations(db).every((l) => l.missing === 0)).toBe(true);
  });

  it('shares file rows across libraries but counts the first sighting in a library as created', () => {
    const other = createLibrary(db, 'other', '/other');
    const fs = multiRootFs({ [ROOT]: { 'a.jpg': 'same' }, '/other': { 'b.jpg': 'same' } });
    const module = new LibraryScanModule({ fs });

    const first = runScan(module, db, { libraryId });
    const second = runScan(module, db, { libraryId: other });

    expect(first.status).toMatchObject({ filesCreated: 1, duplicateFiles: 0 });
    // Known bytes, but new to `other`: not reported as a duplicate.
    expect(second.status).toMatchObject({ filesCreated: 1, duplicateFiles: 0 });
    expect(files(db)).toHaveLength(1);
    expect(locations(db, libraryId)).toHaveLength(1);
    expect(locations(db, other)).toHaveLength(1);
  });

  it('does not touch another library\u2019s locations', () => {
    const otherLibrary = createLibrary(db, 'other', '/other');
    db.prepare('INSERT INTO files (file_hash, size) VALUES (?, 1)').run('x');
    db.prepare(
      'INSERT INTO locations (file_id, library_id, path, last_seen) VALUES (1, ?, ?, 0)',
    ).run(otherLibrary, 'a.jpg');
    const module = new LibraryScanModule({ fs: fakeFs({ 'a.jpg': 'aaa' }) });
    const { status } = runScan(module, db, { libraryId });

    expect(status).toMatchObject({ filesCreated: 1, missingLocations: 0 });
    expect(locations(db, otherLibrary)[0]!.missing).toBe(0);
  });

  it('reports failure when the filesystem throws', () => {
    const fs = fakeFs({ 'a.jpg': 'aaa' });
    fs.readSync = () => {
      throw new Error('EACCES');
    };
    const closeSync = vi.spyOn(fs, 'closeSync');
    const module = new LibraryScanModule({ fs });
    const { callbacks, status } = runScan(module, db, { libraryId });

    expect(closeSync).toHaveBeenCalledOnce();
    expect(callbacks.jobFailed).toHaveBeenCalledOnce();
    expect(callbacks.jobFailed.mock.calls[0]![0]).toMatchObject({ message: 'EACCES' });
    expect(callbacks.jobComplete).not.toHaveBeenCalled();
    expect(status).toMatchObject({ state: 'error', message: 'Error during scan' });
    expect(locations(db)).toEqual([]);
  });

  it('fails when a location points at a nonexistent file row', () => {
    const module = new LibraryScanModule({ fs: fakeFs({ 'a.jpg': 'aaa' }) });
    db.pragma('foreign_keys = OFF');
    db.prepare(
      'INSERT INTO locations (file_id, library_id, path, last_seen) VALUES (999, ?, ?, 0)',
    ).run(libraryId, 'a.jpg');
    db.pragma('foreign_keys = ON');
    const { callbacks } = runScan(module, db, { libraryId });
    expect(callbacks.jobFailed.mock.calls[0]![0]).toMatchObject({
      message: 'Location without file found in database',
    });
  });

  it('halt() marks the status as halted', () => {
    const module = new LibraryScanModule({ fs: fakeFs({ 'a.jpg': 'aaa' }) });
    const job = module.createJob({ libraryId }, db, {
      stepComplete: vi.fn(),
      jobComplete: vi.fn(),
      jobFailed: vi.fn(),
    });
    expect(job.status().state).toBe('running');
    job.halt?.();
    expect((job.status() as JobStatus).state).toBe('halted');
  });

  it('ignores files by name and by glob pattern', () => {
    const module = new LibraryScanModule({
      fs: fakeFs({ 'keep.jpg': 'kkk', 'Thumbs.db': 'ttt', 'scratch.tmp': 'sss' }),
    });
    const { status } = runScan(module, db, {
      libraryId,
      ignorePaths: ['Thumbs.db', '*.tmp'],
    });

    expect(locations(db).map((l) => l.path)).toEqual(['keep.jpg']);
    expect(status).toMatchObject({
      state: 'complete',
      filesScanned: 1,
      filesCreated: 1,
      entriesIgnored: 2,
    });
  });

  it('ignores a directory anywhere in the tree, including its contents', () => {
    const module = new LibraryScanModule({
      fs: fakeFs({
        'a.jpg': 'aaa',
        node_modules: { 'b.js': 'bbb', nested: { 'c.js': 'ccc' } },
        deep: { node_modules: { 'd.js': 'ddd' } },
      }),
    });
    const { status } = runScan(module, db, { libraryId, ignorePaths: ['node_modules'] });

    expect(locations(db).map((l) => l.path)).toEqual(['a.jpg']);
    expect(status).toMatchObject({ filesScanned: 1, entriesIgnored: 2 });
  });

  it('matches ignore patterns against the root-relative path as well as the name', () => {
    const module = new LibraryScanModule({
      fs: fakeFs({
        build: { 'out.js': 'ooo', keep: { 'x.js': 'xxx' } },
        src: { build: { 'y.js': 'yyy' } },
      }),
    });
    const { status } = runScan(module, db, {
      libraryId,
      ignorePaths: ['build/out.js', '*/build'],
    });

    expect(locations(db).map((l) => l.path)).toEqual(['build/keep/x.js']);
    expect(status.entriesIgnored).toBe(2);
  });

  it('does not mark a previously scanned, now-ignored location as missing', () => {
    const fs = fakeFs({ 'keep.jpg': 'kkk', 'skip.jpg': 'sss' });
    const module = new LibraryScanModule({ fs });
    runScan(module, db, { libraryId });
    db.prepare('UPDATE locations SET last_seen = 1').run();

    const { status } = runScan(module, db, { libraryId, ignorePaths: ['skip.jpg'] });

    expect(status).toMatchObject({ missingLocations: 0, idleFiles: 1, entriesIgnored: 1 });
    const byPath = Object.fromEntries(locations(db).map((l) => [l.path, l.missing]));
    expect(byPath).toEqual({ 'keep.jpg': 0, 'skip.jpg': 0 });
  });
});

describe('makeIgnoreMatcher', () => {
  it('matches nothing for an empty or blank-only ignore list', () => {
    expect(makeIgnoreMatcher([])('anything')).toBe(false);
    expect(makeIgnoreMatcher(['', '  '])('anything')).toBe(false);
  });

  it('matches names at any depth and full paths', () => {
    const isIgnored = makeIgnoreMatcher(['*.log', 'cache', 'docs/private/*']);
    expect(isIgnored('a.log')).toBe(true);
    expect(isIgnored('deep/nested/b.log')).toBe(true);
    expect(isIgnored('cache')).toBe(true);
    expect(isIgnored('x/cache')).toBe(true);
    expect(isIgnored('docs/private/secret.txt')).toBe(true);
    expect(isIgnored('docs/public/secret.txt')).toBe(false);
    expect(isIgnored('a.txt')).toBe(false);
    // `cache` is a name, not a substring: it must not match `mycache`
    expect(isIgnored('mycache')).toBe(false);
  });

  it('treats patterns case-sensitively and supports ?', () => {
    const isIgnored = makeIgnoreMatcher(['?.tmp']);
    expect(isIgnored('a.tmp')).toBe(true);
    expect(isIgnored('ab.tmp')).toBe(false);
    expect(makeIgnoreMatcher(['A.LOG'])('a.log')).toBe(false);
  });
});
