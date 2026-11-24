import Database from 'better-sqlite3';
import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';

import { MAX_BATCH_PREVIEWS } from '../routes/previews.ts';
import { PreviewService, type PreviewRow } from './previewService.ts';

type FakeFile = { buffer: Buffer; extension: string };

/** Builds a `getOriginal` callback over the given files and tracks how often each hash is fetched. */
function fakeFileSource(files: Record<string, FakeFile>) {
  const fetchCounts: Record<string, number> = {};
  const getOriginal = async (hash: string) => {
    const file = files[hash];
    if (!file) throw new Error(`No fake file for hash ${hash}`);
    fetchCounts[hash] = (fetchCounts[hash] ?? 0) + 1;
    return file;
  };
  return { getOriginal, fetchCounts };
}

function readRows(db: InstanceType<typeof Database>): PreviewRow[] {
  return db.prepare('SELECT hash, preview, type, is_original FROM previews').all() as PreviewRow[];
}

function readRow(db: InstanceType<typeof Database>, hash: string): PreviewRow {
  return db
    .prepare('SELECT hash, preview, type, is_original FROM previews WHERE hash = ?')
    .get(hash) as PreviewRow;
}

let largePng: Buffer; // 800x600 -> needs a resized preview
let smallPng: Buffer; // 100x100 -> small enough to serve as the original
let smallPngB: Buffer; // 64x64, second "original" file so collections can mix
const txtFile: FakeFile = { buffer: Buffer.from('plain text, not an image'), extension: 'TXT' };

beforeAll(async () => {
  largePng = await sharp({
    create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
  smallPng = await sharp({
    create: { width: 100, height: 100, channels: 3, background: { r: 40, g: 200, b: 40 } },
  })
    .png()
    .toBuffer();
  smallPngB = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 40, g: 40, b: 200 } },
  })
    .png()
    .toBuffer();
});

function fakeFilesA(): Record<string, FakeFile> {
  return {
    'a-large': { buffer: largePng, extension: 'PNG' },
    'a-small': { buffer: smallPng, extension: 'PNG' },
    'a-text': txtFile,
  };
}

function fakeFilesB(filesA: Record<string, FakeFile>): Record<string, FakeFile> {
  return {
    ...filesA,
    'b-large': { buffer: largePng, extension: 'PNG' },
    'b-small': { buffer: smallPngB, extension: 'PNG' },
    'b-text': { buffer: Buffer.from('another non-image document'), extension: 'TXT' },
  };
}

describe('PreviewService construction', () => {
  it('constructs against an in-memory database and creates the previews table', () => {
    const db = new Database(':memory:');
    new PreviewService(db);
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'previews'")
      .get();
    expect(table).toBeTruthy();
  });

  it('accepts a custom maxSize setting', () => {
    const db = new Database(':memory:');
    expect(() => new PreviewService(db, { maxSize: 4 })).not.toThrow();
  });
});

// BUG: the `getPreviews` cache query selects only `preview`, so no returned row carries a `hash`.
// Every requested hash therefore counts as missing: cached rows are re-fetched and re-generated on
// each call, the regenerated rows are appended alongside the stale cache rows, and result rows
// cannot be matched back to their hash. This test encodes the intended behavior
it('serves cached hashes from the db and only generates previews for new files', async () => {
  const filesA = fakeFilesA();
  const filesB = fakeFilesB(filesA);
  const source = fakeFileSource(filesB);
  const db = new Database(':memory:');
  const service = new PreviewService(db);

  const hashesA = Object.keys(filesA);
  const rowsA = await service.getPreviews(hashesA, source.getOriginal);
  expect(rowsA).toHaveLength(hashesA.length);
  for (const hash of hashesA) {
    expect(source.fetchCounts[hash]).toBe(1);
  }
  expect(readRows(db)).toHaveLength(hashesA.length);

  const hashesB = ['a-large', 'a-text', 'b-large', 'b-small', 'b-text'];
  const rowsB = await service.getPreviews(hashesB, source.getOriginal);

  // Every requested hash gets exactly one row back.
  expect(rowsB).toHaveLength(hashesB.length);
  const byHash = new Map(rowsB.map((row) => [row.hash, row]));
  for (const hash of hashesB) {
    expect(byHash.has(hash)).toBe(true);
  }

  // The subset of A came from the db: no re-fetch, no re-generation.
  expect(source.fetchCounts['a-large']).toBe(1);
  expect(source.fetchCounts['a-text']).toBe(1);

  // The new files were fetched once each and generated.
  for (const hash of ['b-large', 'b-small', 'b-text']) {
    expect(source.fetchCounts[hash]).toBe(1);
  }

  const rowFromCache = byHash.get('a-large')!;
  expect(rowFromCache.type).toBe('image');
  expect(rowFromCache.preview.length).toBeGreaterThan(0);
});

it('returns no rows for an empty request', async () => {
  const db = new Database(':memory:');
  const service = new PreviewService(db);
  const { getOriginal } = fakeFileSource({});
  await expect(service.getPreviews([], getOriginal)).resolves.toEqual([]);
});

describe('image previews', () => {
  it('resizes a large image to a 256x256 webp preview', async () => {
    const db = new Database(':memory:');
    const service = new PreviewService(db);
    const { getOriginal, fetchCounts } = fakeFileSource({
      big: { buffer: largePng, extension: 'PNG' },
    });

    await service.preparePreview('big', getOriginal);
    expect(fetchCounts['big']).toBe(1);

    const row = readRow(db, 'big');
    expect(row.type).toBe('image');
    expect(row.is_original).toBe(0);
    expect(row.preview.length).toBeGreaterThan(0);
    expect(row.preview.equals(largePng)).toBe(false);

    const meta = await sharp(row.preview).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it('serves a small image unchanged as the original', async () => {
    const db = new Database(':memory:');
    const service = new PreviewService(db);
    const { getOriginal } = fakeFileSource({ small: { buffer: smallPng, extension: 'PNG' } });

    await service.preparePreview('small', getOriginal);

    const row = readRow(db, 'small');
    expect(row.type).toBe('image');
    expect(row.preview.equals(smallPng)).toBe(true);
  });

  // BUG: `generatePreview` computes `is_original = 1` for small originals but never passes it to
  // `savePreview` (which defaults to 0), and the row it returns also hardcodes `is_original: 0`.
  // The flag is therefore never set.
  it('marks previews served from the original with is_original = 1', async () => {
    const db = new Database(':memory:');
    const service = new PreviewService(db);
    const { getOriginal } = fakeFileSource({ small: { buffer: smallPng, extension: 'PNG' } });

    await service.preparePreview('small', getOriginal);

    expect(readRow(db, 'small').is_original).toBe(1);
  });

  // BUG: the extension check is case-sensitive (`'PNG'`, `'JPEG'`, ...), so a lowercase '.png'
  // image takes the non-image path and gets an empty preview instead of a resized one.
  it('treats lowercase image extensions as images', async () => {
    const db = new Database(':memory:');
    const service = new PreviewService(db);
    const { getOriginal } = fakeFileSource({ lower: { buffer: smallPng, extension: 'png' } });

    await service.preparePreview('lower', getOriginal);

    expect(readRow(db, 'lower').type).toBe('image');
  });
});

describe('non-image files', () => {
  it('stores an empty preview buffer keyed by the file extension', async () => {
    const db = new Database(':memory:');
    const service = new PreviewService(db);
    const { getOriginal, fetchCounts } = fakeFileSource({ doc: txtFile });

    await service.preparePreview('doc', getOriginal);
    expect(fetchCounts['doc']).toBe(1);

    const row = readRow(db, 'doc');
    expect(row.type).toBe('txt');
    expect(row.is_original).toBe(0);
    expect(Buffer.isBuffer(row.preview)).toBe(true);
    expect(row.preview.length).toBe(0);
  });

  it('rejects when bytes claim an image extension but cannot be decoded', async () => {
    const db = new Database(':memory:');
    const service = new PreviewService(db);
    const { getOriginal } = fakeFileSource({
      corrupt: { buffer: Buffer.from('this is not really a PNG'), extension: 'PNG' },
    });

    await expect(service.preparePreview('corrupt', getOriginal)).rejects.toThrow();
  });
});

it('shrinks the table to maxSize after generating more previews than it can hold', async () => {
  const filesA = fakeFilesA();
  const filesB = fakeFilesB(filesA);
  const source = fakeFileSource(filesB);
  const maxSize = 3;
  const db = new Database(':memory:');
  const service = new PreviewService(db, { maxSize });

  // Collections A and B together generate 6 previews (3 shared hashes are already cached).
  const hashesA = Object.keys(filesA);
  await service.getPreviews(hashesA, source.getOriginal);
  await service.getPreviews(
    ['a-large', 'a-text', 'b-large', 'b-small', 'b-text'],
    source.getOriginal,
  );

  const uniqueHashCount = new Set([...hashesA, 'b-large', 'b-small', 'b-text']).size;
  expect(uniqueHashCount).toBeGreaterThan(maxSize);
  expect(readRows(db)).toHaveLength(maxSize);
});

it('keeps every preview of a full batch with the default size', async () => {
  const hashes = Array.from({ length: MAX_BATCH_PREVIEWS + 1 }, (_, i) => `t${i}`);
  const source = fakeFileSource(Object.fromEntries(hashes.map((h) => [h, txtFile])));
  const db = new Database(':memory:');
  const service = new PreviewService(db);

  await service.getPreviews(hashes, source.getOriginal);
  expect(readRows(db)).toHaveLength(hashes.length);
});

it('does not trim the cache when every preview came from the cache', async () => {
  const source = fakeFileSource(fakeFilesA());
  const db = new Database(':memory:');
  const service = new PreviewService(db, { maxSize: 2 });
  const insert = db.prepare("INSERT INTO previews (hash, preview, type) VALUES (?, x'', 'txt')");
  for (const hash of ['x1', 'x2', 'x3']) insert.run(hash);

  await service.getPreviews(['x1', 'x2'], source.getOriginal);
  expect(readRows(db)).toHaveLength(3);
});
