import type { Request, Response } from 'express';
import type { JWTVerifyResult } from 'jose';
import { getUserById } from '../db/auth_operations.ts';
import { ConflictError, NotFoundError, ValidationError } from '../db/errors.ts';
import type { Db } from '../db/index.ts';
import { SearchSyntaxError } from '../db/search_operations.ts';

export const userIdOf = (req: Request): string => {
  const { userId } = (req as Request & { jwtPayload: JWTVerifyResult }).jwtPayload.payload;
  if (typeof userId !== 'string') throw new Error('JWT payload has no userId');
  return userId;
};

/** Returns the caller's user id when the caller is an admin; replies 403 and returns null otherwise. */
export function requireAdmin(db: Db, req: Request, res: Response): string | null {
  const userId = userIdOf(req);
  const user = getUserById(db, userId);
  if (!user || !user.is_admin) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return userId;
}

export const parseId = (raw: unknown): number | null =>
  typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;

export const isPositiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Reads a non-negative integer query parameter. A missing value gives `fallback`, a value
 *  above `max` gives `max`, and anything that is not a non-negative integer gives null. */
export function parseQueryInt(raw: unknown, fallback: number, max = Infinity): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  return Math.min(Number(raw), max);
}

/** Reads a string query parameter; a missing value gives ''. Returns null for a repeated or
 *  nested parameter. */
export function parseQueryString(raw: unknown): string | null {
  if (raw === undefined) return '';
  return typeof raw === 'string' ? raw : null;
}

export const isUniqueViolation = (error: unknown) =>
  error instanceof Error && /UNIQUE constraint failed/.test(error.message);

/** Maps a db-layer error to its HTTP status and replies. Anything unknown is rethrown so the
 *  app's error handler answers 500. `extra` is merged into the JSON body. */
export function sendError(res: Response, err: unknown, extra: object = {}): void {
  const status =
    err instanceof NotFoundError
      ? 404
      : err instanceof ConflictError || isUniqueViolation(err)
        ? 409
        : err instanceof ValidationError || err instanceof SearchSyntaxError
          ? 400
          : null;
  if (status === null) throw err;
  res.status(status).json({ error: (err as Error).message, ...extra });
}
