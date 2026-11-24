import type { Db } from './index.ts';
import { inClause, visibleFilesClause } from './library_operations.ts';

export type LocationRecord = {
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

export type fileRecord = {
  file_id: number;
  file_hash: string;
  size: number;
};

export type VisibleLocation = LocationRecord & { library_name: string };

export type visibleTag = {
  tag_id: number;
  library_id: number;
  /** Primary alias text, or null if the tag has no primary alias yet. */
  name: string | null;
  color: string | null;
};

export function checkPathExists(db: Db, path: string, libraryId: number): LocationRecord | null {
  const statement = db.prepare('SELECT * FROM locations WHERE path = ? AND library_id = ?');
  const result = statement.get(path, libraryId);
  return (result ?? null) as LocationRecord | null;
}

export function getFileById(db: Db, fileId: number): fileRecord | null {
  const statement = db.prepare('SELECT * FROM files WHERE file_id = ?');
  const result = statement.get(fileId);
  return (result ?? null) as fileRecord | null;
}

export function updateLocationLastSeen(db: Db, locationId: number): void {
  const statement = db.prepare('UPDATE locations SET last_seen = ? WHERE location_id = ?');
  statement.run(Date.now(), locationId);
}

export function createFile(db: Db, fileHash: string, size: number): number {
  const statement = db.prepare('INSERT INTO files (file_hash, size) VALUES (?, ?)');
  const result = statement.run(fileHash, size);
  return result.lastInsertRowid as number;
}

/** Points a location at new content, remembering what it held before. */
export function relinkLocation(db: Db, locationId: number, newFileId: number): void {
  const statement = db.prepare(
    'UPDATE locations SET previous_file_id = file_id, file_id = ? WHERE location_id = ?',
  );
  statement.run(newFileId, locationId);
}

/** Copies per-library data (currently: tags) from one file to another. Only `libraryId`'s tags
 *  move; the same content may be tagged independently by other libraries. */
export function migrateFileData(
  db: Db,
  oldFileId: number,
  newFileId: number,
  libraryId: number,
): void {
  //Copy over tags. file_count only grows for instances the insert actually adds.
  const tagIds = (
    db
      .prepare(
        `SELECT ftr.tag_id FROM file_tag_relationships ftr
         JOIN tags t ON t.tag_id = ftr.tag_id
         WHERE ftr.file_id = ? AND t.library_id = ?`,
      )
      .all(oldFileId, libraryId) as { tag_id: number }[]
  ).map((r) => r.tag_id);
  const insert = db.prepare(
    'INSERT OR IGNORE INTO file_tag_relationships (file_id, tag_id) VALUES (?, ?)',
  );
  const bump = db.prepare('UPDATE tags SET file_count = file_count + 1 WHERE tag_id = ?');
  db.transaction(() => {
    for (const tagId of tagIds) {
      if (insert.run(newFileId, tagId).changes > 0) bump.run(tagId);
    }
  })();
  //Later: copy over others as implemented.
}

/** File metadata held by a location: extension and type come from the path, the times come
 *  from the filesystem (milliseconds since the epoch). */
export type LocationMetadata = {
  extension: string | null;
  type: string;
  createdAt: number | null;
  modifiedAt: number | null;
};

const TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  bmp: 'image',
  tiff: 'image',
  svg: 'image',
  avif: 'image',
  heic: 'image',
  mp4: 'video',
  webm: 'video',
  mkv: 'video',
  mov: 'video',
  avi: 'video',
  m4v: 'video',
  mp3: 'audio',
  flac: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  opus: 'audio',
  aac: 'audio',
  txt: 'text',
  md: 'text',
  json: 'text',
  csv: 'text',
  log: 'text',
  xml: 'text',
  yaml: 'text',
  yml: 'text',
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  odt: 'document',
  rtf: 'document',
  zip: 'archive',
  tar: 'archive',
  gz: 'archive',
  rar: 'archive',
  '7z': 'archive',
};

/** Lowercase extension without the dot, or null when the path has none. */
export function extensionFromPath(path: string): string | null {
  const base = path.replace(/.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return base.slice(dot + 1).toLowerCase();
}

/** Broad category behind `type:` selectors, derived from the extension. */
export function fileTypeForExtension(extension: string | null): string {
  if (extension === null) return 'other';
  return TYPE_BY_EXTENSION[extension] ?? 'other';
}

/** Builds the location metadata for a path from filesystem stat times (epoch ms). */
export function locationMetadata(
  path: string,
  birthtimeMs: number | null,
  mtimeMs: number | null,
): LocationMetadata {
  const extension = extensionFromPath(path);
  return {
    extension,
    type: fileTypeForExtension(extension),
    createdAt: birthtimeMs,
    modifiedAt: mtimeMs,
  };
}

export function createLocation(
  db: Db,
  path: string,
  libraryId: number,
  fileId: number,
  metadata?: LocationMetadata,
): number {
  const statement = db.prepare(
    `INSERT INTO locations (path, library_id, file_id, last_seen, extension, type, created_at, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const result = statement.run(
    path,
    libraryId,
    fileId,
    Date.now(),
    metadata?.extension ?? null,
    metadata?.type ?? null,
    metadata?.createdAt ?? null,
    metadata?.modifiedAt ?? null,
  );
  return result.lastInsertRowid as number;
}

export function getFileByHash(db: Db, fileHash: string): fileRecord | null {
  const statement = db.prepare('SELECT * FROM files WHERE file_hash = ?');
  const result = statement.get(fileHash);
  return (result ?? null) as fileRecord | null;
}

export function fileHasLocationInLibrary(db: Db, fileId: number, libraryId: number): boolean {
  const statement = db.prepare(
    'SELECT 1 FROM locations WHERE file_id = ? AND library_id = ? LIMIT 1',
  );
  return statement.get(fileId, libraryId) !== undefined;
}

/** All paths a file has in one library (used to report duplicate groups during a scan). */
export function getFileLocationPathsInLibrary(db: Db, fileId: number, libraryId: number): string[] {
  const statement = db.prepare(
    'SELECT path, missing FROM locations WHERE file_id = ? AND library_id = ?',
  );
  const rows = statement.all(fileId, libraryId) as { path: string; missing: number }[];
  return rows.filter((row) => !row.missing).map((row) => row.path);
}

export function getStaleLocations(
  db: Db,
  libraryId: number,
  timeThreshold: number,
  pathPrefix: string[] = [],
): LocationRecord[] {
  const patterns = pathPrefix.map((prefix) => prefix.replace(/[\\%_]/g, '\\$&') + '%');
  const prefixClause = patterns.length
    ? ` AND (${patterns.map(() => "path LIKE ? ESCAPE '\\'").join(' OR ')})`
    : '';
  const statement = db.prepare(
    `SELECT * FROM locations WHERE library_id = ? AND last_seen < ?${prefixClause}`,
  );
  const result = statement.all(libraryId, timeThreshold, ...patterns);
  return result as LocationRecord[];
}

export function updateLocationMissing(db: Db, locationId: number): void {
  const statement = db.prepare('UPDATE locations SET missing = 1 WHERE location_id = ?');
  statement.run(locationId);
}

/** A file is visible iff it has a location (missing or not) in one of `libraryIds`. */
export function getVisibleFile(
  db: Db,
  fileId: number,
  libraryIds: readonly number[],
): fileRecord | null {
  const visible = visibleFilesClause('f', libraryIds);
  const statement = db.prepare(`SELECT f.* FROM files f WHERE f.file_id = ? AND ${visible.sql}`);
  return (statement.get(fileId, ...visible.params) ?? null) as fileRecord | null;
}

export function getVisibleLocations(
  db: Db,
  fileId: number,
  libraryIds: readonly number[],
): VisibleLocation[] {
  if (libraryIds.length === 0) return [];
  const { sql, params } = inClause(libraryIds);
  const statement = db.prepare(
    `SELECT l.*, lib.name AS library_name FROM locations l
     JOIN libraries lib ON lib.library_id = l.library_id
     WHERE l.file_id = ? AND l.library_id IN (${sql})
     ORDER BY l.library_id, l.path`,
  );
  return statement.all(fileId, ...params) as VisibleLocation[];
}

export function getVisibleTags(
  db: Db,
  fileId: number,
  libraryIds: readonly number[],
): visibleTag[] {
  if (libraryIds.length === 0) return [];
  const { sql, params } = inClause(libraryIds);
  const statement = db.prepare(
    `SELECT t.tag_id, t.library_id, a.text AS name, t.color FROM file_tag_relationships ftr
     JOIN tags t ON t.tag_id = ftr.tag_id
     LEFT JOIN aliases a ON a.tag_id = t.tag_id AND a.is_primary = 1
     WHERE ftr.file_id = ? AND t.library_id IN (${sql})
     ORDER BY t.library_id, a.text`,
  );
  return statement.all(fileId, ...params) as visibleTag[];
}

//SQLite limits the number of bound parameters, so long id lists are queried in chunks.
const ID_CHUNK = 900;

function chunks(ids: readonly number[]): number[][] {
  const unique = [...new Set(ids)];
  const out: number[][] = [];
  for (let i = 0; i < unique.length; i += ID_CHUNK) out.push(unique.slice(i, i + ID_CHUNK));
  return out;
}

/** The ids among `fileIds` that have at least one location (missing or not) in `libraryId`. */
export function filesInLibrary(db: Db, fileIds: readonly number[], libraryId: number): Set<number> {
  const found = new Set<number>();
  for (const chunk of chunks(fileIds)) {
    const { sql, params } = inClause(chunk);
    const rows = db
      .prepare(
        `SELECT DISTINCT file_id FROM locations WHERE library_id = ? AND file_id IN (${sql})`,
      )
      .all(libraryId, ...params) as { file_id: number }[];
    for (const row of rows) found.add(row.file_id);
  }
  return found;
}

/** Every location of each file in `libraryId`, ordered by path. Files with no location there
 *  are left out of the map. */
export function getLocationsInLibrary(
  db: Db,
  fileIds: readonly number[],
  libraryId: number,
): Map<number, LocationRecord[]> {
  const byFile = new Map<number, LocationRecord[]>();
  for (const chunk of chunks(fileIds)) {
    const { sql, params } = inClause(chunk);
    const rows = db
      .prepare(
        `SELECT * FROM locations WHERE library_id = ? AND file_id IN (${sql})
         ORDER BY file_id, path`,
      )
      .all(libraryId, ...params) as LocationRecord[];
    for (const row of rows) {
      const list = byFile.get(row.file_id);
      if (list) list.push(row);
      else byFile.set(row.file_id, [row]);
    }
  }
  return byFile;
}

/** What a file grid shows for one file, as seen from one library. */
export type FileSummary = {
  fileId: number;
  /** Basename of `path`. */
  name: string;
  /** The first non-missing location by path, or the first location if all are missing. */
  path: string;
  type: string | null;
  extension: string | null;
  size: number;
  /** True when every location of the file in this library is missing. */
  missing: boolean;
  locationCount: number;
};

/** Summaries in the order of `fileIds`. Ids with no location in `libraryId` are skipped. */
export function getFileSummaries(
  db: Db,
  fileIds: readonly number[],
  libraryId: number,
): FileSummary[] {
  const locations = getLocationsInLibrary(db, fileIds, libraryId);
  const sizes = new Map<number, number>();
  for (const chunk of chunks([...locations.keys()])) {
    const { sql, params } = inClause(chunk);
    const rows = db
      .prepare(`SELECT file_id, size FROM files WHERE file_id IN (${sql})`)
      .all(...params) as { file_id: number; size: number }[];
    for (const row of rows) sizes.set(row.file_id, row.size);
  }

  const summaries: FileSummary[] = [];
  for (const fileId of fileIds) {
    const list = locations.get(fileId);
    if (!list) continue;
    const present = list.find((l) => !l.missing);
    const shown = present ?? list[0]!;
    summaries.push({
      fileId,
      name: shown.path.replace(/.*[\\/]/, ''),
      path: shown.path,
      type: shown.type,
      extension: shown.extension,
      size: sizes.get(fileId) ?? 0,
      missing: present === undefined,
      locationCount: list.length,
    });
  }
  return summaries;
}
