//Finds the on-disk bytes of a file for the content and preview routes.

import { realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/index.ts';
import { inClause, isWithin, normalizeRootPath } from '../db/library_operations.ts';

export type ContentLocation = { fullPath: string; extension: string; size: number };

type Key = { fileId: number } | { fileHash: string };

/**
 * Finds a readable copy of a file: a non-missing location in one of `libraryIds` that is a
 * regular file. Symbolic links are resolved first, and the real path must stay inside the
 * real library root, so a link in a library cannot expose a file outside it. Returns null
 * when no location qualifies; callers answer 404.
 */
export async function findContent(
  db: Db,
  key: Key,
  libraryIds: readonly number[],
): Promise<ContentLocation | null> {
  if (libraryIds.length === 0) return null;
  const { sql, params } = inClause(libraryIds);
  const [where, value] =
    'fileId' in key ? ['l.file_id = ?', key.fileId] : ['f.file_hash = ?', key.fileHash];
  const candidates = db
    .prepare(
      `SELECT l.path, l.extension, lib.root_path
       FROM locations l
       JOIN files f ON f.file_id = l.file_id
       JOIN libraries lib ON lib.library_id = l.library_id
       WHERE ${where} AND l.missing = 0 AND l.library_id IN (${sql})
       ORDER BY l.location_id`,
    )
    .all(value, ...params) as { path: string; extension: string | null; root_path: string }[];

  for (const location of candidates) {
    try {
      const root = normalizeRootPath(await realpath(location.root_path));
      const fullPath = normalizeRootPath(await realpath(join(root, location.path)));
      if (!isWithin(fullPath, root) || fullPath === root) continue;
      const info = await stat(fullPath);
      if (!info.isFile()) continue;
      const extension = location.extension ?? /\.([^.]+)$/.exec(location.path)?.[1] ?? '';
      return { fullPath, extension: extension.toLowerCase(), size: info.size };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw err;
    }
  }
  return null;
}
