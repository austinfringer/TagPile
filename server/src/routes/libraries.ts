import { Router, type Request, type Response } from 'express';
import * as fs from 'node:fs';
import * as Path from 'node:path';
import type { Config } from '../config.ts';
import type { Db } from '../db/index.ts';
import * as libOps from '../db/library_operations.ts';
import { resolveLibraryScope } from './libraryScope.ts';
import { getUserById } from '../db/auth_operations.ts';
import { isUniqueViolation, requireAdmin, userIdOf } from './util.ts';

/** The subset of node:fs needed to validate a root path; injectable for tests. */
export interface LibraryFs {
  statSync(path: string): { isDirectory(): boolean };
  /** Resolves symbolic links; throws when the path does not exist. */
  realpathSync(path: string): string;
}

export interface LibraryDeps {
  db: Db;
  config: Pick<Config, 'libraryRoots' | 'databasePath'>;
  fs?: LibraryFs;
}

//One message for every rejected path, so the reply does not show what exists on the server.
const ROOT_REJECTED =
  'rootPath is not an allowed library directory. The server operator sets the allowed directories in LIBRARY_ROOTS.';
const ROOT_OVERLAPS = 'rootPath overlaps another library';

/** The path with symbolic links resolved, or null when it is not an existing directory. */
function realDirectory(libFs: LibraryFs, path: string): string | null {
  try {
    const real = libOps.normalizeRootPath(libFs.realpathSync(libOps.normalizeRootPath(path)));
    return libFs.statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/**
 * Validates a root path from a request body; replies with 400 and returns null when invalid.
 * A valid root is an existing directory that, with symbolic links resolved, is in one of
 * `config.libraryRoots` and does not overlap the directory of the database.
 */
function validateRootPath(
  libFs: LibraryFs,
  config: LibraryDeps['config'],
  raw: unknown,
  res: Response,
): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || !Path.isAbsolute(raw)) {
    res.status(400).json({ error: 'rootPath must be an absolute path' });
    return null;
  }
  const real = realDirectory(libFs, raw);
  const allowed =
    real !== null &&
    config.libraryRoots.some((base) => {
      const realBase = realDirectory(libFs, base);
      return realBase !== null && libOps.isWithin(real, realBase);
    });
  if (real === null || !allowed || overlapsDataDir(libFs, config.databasePath, real)) {
    res.status(400).json({ error: ROOT_REJECTED });
    return null;
  }
  return real;
}

/** The database directory holds password hashes and the JWT secret; no library may expose it. */
function overlapsDataDir(libFs: LibraryFs, databasePath: string, real: string): boolean {
  if (databasePath === ':memory:') return false;
  const dataDir = Path.dirname(Path.resolve(databasePath));
  const realDataDir = realDirectory(libFs, dataDir) ?? dataDir;
  return libOps.isWithin(real, realDataDir) || libOps.isWithin(realDataDir, real);
}

export function librariesRouter({ db, config, fs: libFs = fs }: LibraryDeps) {
  const router = Router();

  /** The absolute root path is shown only to admins and to members who manage the library. */
  const present = (lib: libOps.LibraryRecord, role: libOps.LibraryRole, userId: string) => ({
    ...lib,
    root_path: role.can_manage_library || getUserById(db, userId)?.is_admin ? lib.root_path : null,
    role: role.name,
    permissions: {
      canRead: !!role.can_read,
      canCreateTag: !!role.can_create_tag,
      canTagFiles: !!role.can_tag_files,
      canManageLibrary: !!role.can_manage_library,
    },
  });

  /** Resolves `:id` to a library the caller is a member of; replies 404 otherwise. */
  const resolveLibrary = (req: Request, res: Response) => {
    const scope = resolveLibraryScope(db, req, req.params.id);
    if (!scope) res.status(404).json({ error: 'Library not found' });
    return scope;
  };

  router.get('/libraries', (req, res) => {
    const userId = userIdOf(req);
    const libraries = libOps
      .listLibraries(db, libOps.accessibleLibraryIds(db, userId))
      .map((lib) => present(lib, libOps.getMemberRole(db, lib.library_id, userId)!, userId));
    res.status(200).json({ libraries });
  });

  router.post('/libraries', (req, res) => {
    const userId = requireAdmin(db, req, res);
    if (!userId) return;
    const { name, rootPath } = req.body ?? {};
    if (typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'name is required' });
    }
    const validPath = validateRootPath(libFs, config, rootPath, res);
    if (validPath === null) return;

    try {
      const libraryId = db.transaction(() => {
        const id = libOps.createLibrary(db, name.trim(), validPath);
        libOps.addMember(db, id, userId, 'owner');
        return id;
      })();
      const library = libOps.getLibraryById(db, libraryId)!;
      res
        .status(201)
        .json({ library: present(library, libOps.getMemberRole(db, libraryId, userId)!, userId) });
    } catch (error) {
      if (error instanceof libOps.LibraryOverlapError) {
        return res.status(409).json({ error: ROOT_OVERLAPS });
      }
      if (isUniqueViolation(error)) {
        return res
          .status(409)
          .json({ error: 'A library with that name or root path already exists' });
      }
      throw error;
    }
  });

  router.get('/libraries/:id', (req, res) => {
    const ctx = resolveLibrary(req, res);
    if (!ctx) return;
    res.status(200).json({ library: present(ctx.library, ctx.role, ctx.userId) });
  });

  router.put('/libraries/:id', (req, res) => {
    const ctx = resolveLibrary(req, res);
    if (!ctx) return;
    if (!ctx.role.can_manage_library) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { name, rootPath } = req.body ?? {};
    if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) {
      return res.status(400).json({ error: 'name must be a non-empty string' });
    }
    let validPath: string | undefined;
    if (rootPath !== undefined) {
      if (!requireAdmin(db, req, res)) return;
      const checked = validateRootPath(libFs, config, rootPath, res);
      if (checked === null) return;
      validPath = checked;
    }

    try {
      libOps.updateLibrary(db, ctx.library.library_id, {
        name: typeof name === 'string' ? name.trim() : undefined,
        rootPath: validPath,
      });
    } catch (error) {
      if (error instanceof libOps.LibraryOverlapError) {
        return res.status(409).json({ error: ROOT_OVERLAPS });
      }
      if (isUniqueViolation(error)) {
        return res
          .status(409)
          .json({ error: 'A library with that name or root path already exists' });
      }
      throw error;
    }
    const library = libOps.getLibraryById(db, ctx.library.library_id)!;
    res.status(200).json({ library: present(library, ctx.role, ctx.userId) });
  });

  router.delete('/libraries/:id', (req, res) => {
    const ctx = resolveLibrary(req, res);
    if (!ctx) return;
    if (!ctx.role.can_manage_library) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    libOps.deleteLibrary(db, ctx.library.library_id);
    res.status(204).send();
  });

  return router;
}
