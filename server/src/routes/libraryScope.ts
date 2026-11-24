import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Db } from '../db/index.ts';
import * as libOps from '../db/library_operations.ts';
import { parseId, userIdOf } from './util.ts';

export type LibraryScope = {
  library: libOps.LibraryRecord;
  role: libOps.LibraryRole;
  userId: string;
};

export type Capability = 'can_read' | 'can_create_tag' | 'can_tag_files' | 'can_manage_library';

/** Resolves `:id` (or `:libraryId`) to a library the caller is a member of. Returns null when
 *  the id is malformed, the library does not exist, or the caller is not a member. */
export function resolveLibraryScope(db: Db, req: Request, rawId: unknown): LibraryScope | null {
  const id = parseId(rawId);
  const userId = userIdOf(req);
  const library = id === null ? null : libOps.getLibraryById(db, id);
  const role = library ? libOps.getMemberRole(db, library.library_id, userId) : null;
  return library && role ? { library, role, userId } : null;
}

/** Gate for routes under `/api/libraries/:libraryId`. A caller who is not a member gets the
 *  same 404 as for a library that does not exist. Stores the scope in `res.locals.scope`. */
export function libraryScope({ db }: { db: Db }): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const scope = resolveLibraryScope(db, req, req.params.libraryId);
    if (!scope) {
      res.status(404).json({ error: 'Library not found' });
      return;
    }
    res.locals.scope = scope;
    next();
  };
}

export const scopeOf = (res: Response): LibraryScope => res.locals.scope as LibraryScope;

/** Replies 403 unless the caller's role in the scoped library has `capability`. */
export function requireCapability(capability: Capability): RequestHandler {
  return (_req, res, next) => {
    if (!scopeOf(res).role[capability]) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
