import * as Path from 'node:path';
import type { Db } from './index.ts';

export type LibraryRecord = {
  library_id: number;
  name: string;
  root_path: string;
  created_at: string;
  updated_at: string;
};

export type LibraryRole = {
  role_id: number;
  name: string;
  can_read: number;
  can_create_tag: number;
  can_tag_files: number;
  can_manage_library: number;
};

export type LibraryMemberRecord = {
  library_id: number;
  user_id: string;
  role_id: number;
  created_at: string;
};

export type LibraryRoleName = 'owner' | 'editor' | 'viewer';

export class LibraryOverlapError extends Error {
  readonly other: LibraryRecord;
  constructor(other: LibraryRecord) {
    super(`Root path overlaps library "${other.name}" (${other.root_path})`);
    this.name = 'LibraryOverlapError';
    this.other = other;
  }
}

/** Absolute, resolved, no trailing separator (except for a bare filesystem root). */
export function normalizeRootPath(path: string): string {
  const resolved = Path.resolve(path);
  const root = Path.parse(resolved).root;
  return resolved.length > root.length && resolved.endsWith(Path.sep)
    ? resolved.slice(0, -1)
    : resolved;
}

/** True when `child` equals `parent` or is below it. Both must be normalized. */
export const isWithin = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(Path.sep) ? parent : parent + Path.sep);

/** Libraries may not nest. Returns the first library whose root equals, contains, or is contained by `rootPath`. */
export function findOverlappingLibrary(
  db: Db,
  rootPath: string,
  excludeLibraryId?: number,
): LibraryRecord | null {
  const target = normalizeRootPath(rootPath);
  const all = db.prepare('SELECT * FROM libraries').all() as LibraryRecord[];
  return (
    all.find(
      (lib) =>
        lib.library_id !== excludeLibraryId &&
        (isWithin(target, lib.root_path) || isWithin(lib.root_path, target)),
    ) ?? null
  );
}

export function getLibraryById(db: Db, libraryId: number): LibraryRecord | null {
  return (db.prepare('SELECT * FROM libraries WHERE library_id = ?').get(libraryId) ??
    null) as LibraryRecord | null;
}

function inClause(ids: readonly number[]) {
  return { sql: ids.map(() => '?').join(', '), params: [...ids] };
}

export function listLibraries(db: Db, libraryIds: readonly number[]): LibraryRecord[] {
  if (libraryIds.length === 0) return [];
  const { sql, params } = inClause(libraryIds);
  return db
    .prepare(`SELECT * FROM libraries WHERE library_id IN (${sql}) ORDER BY name`)
    .all(...params) as LibraryRecord[];
}

export function createLibrary(db: Db, name: string, rootPath: string): number {
  const normalized = normalizeRootPath(rootPath);
  const overlap = findOverlappingLibrary(db, normalized);
  if (overlap) throw new LibraryOverlapError(overlap);
  const now = new Date().toISOString();
  const result = db
    .prepare('INSERT INTO libraries (name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, normalized, now, now);
  return result.lastInsertRowid as number;
}

export function updateLibrary(
  db: Db,
  libraryId: number,
  { name, rootPath }: { name?: string; rootPath?: string },
): void {
  const sets: string[] = [];
  const params: string[] = [];
  if (name !== undefined) {
    sets.push('name = ?');
    params.push(name);
  }
  if (rootPath !== undefined) {
    const normalized = normalizeRootPath(rootPath);
    const overlap = findOverlappingLibrary(db, normalized, libraryId);
    if (overlap) throw new LibraryOverlapError(overlap);
    sets.push('root_path = ?');
    params.push(normalized);
  }
  if (sets.length === 0) return;
  sets.push('updated_at = ?');
  params.push(new Date().toISOString());
  db.prepare(`UPDATE libraries SET ${sets.join(', ')} WHERE library_id = ?`).run(
    ...params,
    libraryId,
  );
}

/** Files are global; once a library's locations are gone, any file no longer referenced anywhere is garbage. */
export function deleteOrphanFiles(db: Db): number {
  //The cascade below would silently drop tag instances of orphan files, so their counts
  //must move first.
  db.prepare(
    `UPDATE tags SET file_count = file_count - (
       SELECT COUNT(*) FROM file_tag_relationships ftr
       WHERE ftr.tag_id = tags.tag_id
         AND NOT EXISTS (
           SELECT 1 FROM locations
           WHERE file_id = ftr.file_id OR previous_file_id = ftr.file_id
         )
     )`,
  ).run();
  return db
    .prepare(
      `DELETE FROM files WHERE NOT EXISTS (
         SELECT 1 FROM locations WHERE file_id = files.file_id OR previous_file_id = files.file_id
       )`,
    )
    .run().changes;
}

export function deleteLibrary(db: Db, libraryId: number): void {
  db.transaction(() => {
    db.prepare('DELETE FROM libraries WHERE library_id = ?').run(libraryId);
    deleteOrphanFiles(db);
  })();
}

export function getRoleByName(db: Db, name: LibraryRoleName): LibraryRole {
  const role = db.prepare('SELECT * FROM roles WHERE name = ?').get(name) as
    LibraryRole | undefined;
  if (!role) throw new Error(`Role "${name}" is not defined`);
  return role;
}

export function addMember(db: Db, libraryId: number, userId: string, role: LibraryRoleName): void {
  db.prepare(
    'INSERT INTO library_members (library_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(libraryId, userId, getRoleByName(db, role).role_id, new Date().toISOString());
}

export function getMemberRole(db: Db, libraryId: number, userId: string): LibraryRole | null {
  return (db
    .prepare(
      `SELECT roles.* FROM roles
       JOIN library_members ON roles.role_id = library_members.role_id
       WHERE library_members.library_id = ? AND library_members.user_id = ?`,
    )
    .get(libraryId, userId) ?? null) as LibraryRole | null;
}

export function accessibleLibraryIds(db: Db, userId: string): number[] {
  const rows = db
    .prepare(
      `SELECT library_members.library_id FROM library_members
       JOIN roles ON roles.role_id = library_members.role_id
       WHERE library_members.user_id = ? AND roles.can_read = 1`,
    )
    .all(userId) as { library_id: number }[];
  return rows.map((r) => r.library_id);
}

/**
 * SQL fragment restricting a `files` row (aliased as `fileAlias`) to those with at least one
 * location, missing or not, in one of `libraryIds`. Yields `0 = 1` for an empty set.
 */
export function visibleFilesClause(fileAlias: string, libraryIds: readonly number[]) {
  if (libraryIds.length === 0) return { sql: '0 = 1', params: [] as number[] };
  const { sql, params } = inClause(libraryIds);
  return {
    sql: `EXISTS (SELECT 1 FROM locations vl WHERE vl.file_id = ${fileAlias}.file_id AND vl.library_id IN (${sql}))`,
    params,
  };
}

export { inClause };
