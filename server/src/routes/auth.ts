import {
  Router,
  type CookieOptions,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import bcrypt from 'bcryptjs';
import type { RefreshTokenRecord } from '../db/types.ts';
import { parseCookie } from 'cookie';
import * as auth from '../db/auth_operations.ts';
import { SignJWT, jwtVerify } from 'jose';
import * as crypto from 'node:crypto';
import type { Db } from '../db/index.ts';
import type { Config } from '../config.ts';
import { simpleTokenHash } from '../helpers.ts';
import { RateLimiter } from '../rateLimit.ts';
import { isValidPassword, PASSWORD_RULE } from '../validation.ts';
import { userIdOf } from './util.ts';

export interface AuthDeps {
  db: Db;
  config: Config;
}

export const BCRYPT_COST = 10;
const REFRESH_TOKEN_MAX_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
/** A rotated token that comes back within this time is a race between two tabs, not a theft. */
const REUSE_GRACE_MS = 30 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_FAILURES_PER_USER = 10;
const LOGIN_FAILURES_PER_IP = 50;

/** Verifies the `jwt` cookie from a request's `Cookie` header, returning the decoded
 *  JWT result on success or `null` if the cookie is missing or invalid. */
export async function verifyJwtCookie(config: Config, cookieHeader: string | undefined) {
  const cookies = parseCookie(cookieHeader || '');
  try {
    return await jwtVerify(cookies.jwt ?? '', new TextEncoder().encode(config.jwtSecret));
  } catch {
    return null;
  }
}

/** Accepts a request with a valid `jwt` cookie whose user still exists. A JWT issued before
 *  the user row last changed (for example a password change) is rejected; the client then
 *  refreshes, which fails if the change also revoked the session. */
export function authMiddleware({ db, config }: AuthDeps) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const jwt = await verifyJwtCookie(config, req.headers.cookie);
    const userId = jwt?.payload.userId;
    const user = typeof userId === 'string' ? auth.getUserById(db, userId) : undefined;
    const changedAt = user ? Math.floor(Date.parse(user.updated_at) / 1000) : NaN;
    if (!jwt || !user || (jwt.payload.iat ?? 0) < changedAt) {
      return res.status(401).json({ error: 'Invalid JWT' });
    }
    (req as Request & { jwtPayload: typeof jwt }).jwtPayload = jwt;
    next();
  };
}

const cookieOptions = (config: Config): CookieOptions => ({
  httpOnly: true,
  secure: config.cookieSecure,
  sameSite: 'strict',
});

/** Sets the `jwt` and `refreshToken` session cookies on a response. */
export function setAuthCookies(res: Response, config: Config, jwt: string, refreshToken: string) {
  res.cookie('refreshToken', refreshToken, {
    ...cookieOptions(config),
    maxAge: REFRESH_TOKEN_MAX_AGE,
  });
  res.cookie('jwt', jwt, cookieOptions(config));
}

function clearAuthCookies(res: Response, config: Config) {
  res.clearCookie('refreshToken', cookieOptions(config));
  res.clearCookie('jwt', cookieOptions(config));
}

/** Validates the `refreshToken` cookie from a request's `Cookie` header. On success it rotates
 *  the refresh token and returns a fresh JWT and refresh token; otherwise returns `null`.
 *  A rotated token that is presented again after `REUSE_GRACE_MS` means that someone copied
 *  it, so every session of that user is revoked. */
export async function refreshSession(db: Db, config: Config, cookieHeader: string | undefined) {
  const refreshToken = parseCookie(cookieHeader || '').refreshToken;
  if (!refreshToken) return null;
  const record = auth.searchRefreshToken(db, simpleTokenHash(refreshToken));
  if (!record) return null;
  if (record.revoked) {
    if (
      Date.now() - Date.parse(record.updated_at) > REUSE_GRACE_MS &&
      auth.wasRefreshTokenRotated(db, record.id)
    ) {
      auth.invalidateAllRefreshTokens(db, record.user_id);
    }
    return null;
  }
  if (record.expires_at <= new Date().toISOString()) return null;
  if (!auth.getUserById(db, record.user_id)) return null;
  return createSession(db, config, record.user_id, record.id);
}

/** Issues a JWT and a new refresh token. `replacesTokenId` is the token that this refresh
 *  consumes; it is revoked in the same transaction. */
async function createSession(
  db: Db,
  config: Config,
  userId: string,
  replacesTokenId: string | null = null,
) {
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  const record: RefreshTokenRecord = {
    id: crypto.randomUUID(),
    user_id: userId,
    token_hash: simpleTokenHash(refreshToken),
    created_at: now,
    updated_at: now,
    expires_at: new Date(Date.now() + REFRESH_TOKEN_MAX_AGE).toISOString(),
    revoked: false,
    replaces: replacesTokenId,
  };
  db.transaction(() => {
    if (replacesTokenId) auth.invalidateRefreshToken(db, replacesTokenId);
    auth.createRefreshToken(db, record);
  })();
  return { jwt: await createJWT(userId, config.jwtSecret), refreshToken };
}

let dummyHash: Promise<string> | null = null;

/** Compares against a fixed hash when the user does not exist, so the reply time does not
 *  show which usernames exist. */
async function checkPassword(password: string, hash: string | undefined): Promise<boolean> {
  dummyHash ??= bcrypt.hash('not-a-password', BCRYPT_COST);
  const ok = await bcrypt.compare(password, hash ?? (await dummyHash));
  return ok && hash !== undefined;
}

function tooManyAttempts(res: Response, retryAfter: number) {
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ error: 'Too many attempts. Try again later.' });
}

/** Login, refresh, and logout. These routes work without a valid JWT. */
export function authRouter({ db, config }: AuthDeps) {
  const router = Router();
  const userLimiter = new RateLimiter(LOGIN_FAILURES_PER_USER, LOGIN_WINDOW_MS);
  const ipLimiter = new RateLimiter(LOGIN_FAILURES_PER_IP, LOGIN_WINDOW_MS);

  router.post('/auth/login', async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password must be strings' });
    }
    const userKey = username.toLowerCase();
    const ipKey = req.ip ?? 'unknown';
    const retryAfter = Math.max(userLimiter.retryAfter(userKey), ipLimiter.retryAfter(ipKey));
    if (retryAfter > 0) return tooManyAttempts(res, retryAfter);

    userLimiter.fail(userKey);
    ipLimiter.fail(ipKey);
    const user = auth.getUserByUsername(db, username);
    if (!(await checkPassword(password, user?.password_hash))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    userLimiter.reset(userKey);
    ipLimiter.undo(ipKey);
    auth.deleteExpiredRefreshTokens(db);
    const session = await createSession(db, config, user!.id);
    setAuthCookies(res, config, session.jwt, session.refreshToken);
    return res.status(200).send();
  });

  router.post('/auth/refresh', async (req, res) => {
    const session = await refreshSession(db, config, req.headers.cookie);
    if (!session) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }
    setAuthCookies(res, config, session.jwt, session.refreshToken);
    return res.status(200).send();
  });

  router.post('/auth/logout', (req, res) => {
    const refreshToken = parseCookie(req.headers.cookie || '').refreshToken;
    const record = refreshToken && auth.searchRefreshToken(db, simpleTokenHash(refreshToken));
    if (record && !record.revoked) auth.invalidateRefreshToken(db, record.id);
    clearAuthCookies(res, config);
    return res.status(204).send();
  });

  return router;
}

/** Routes for the logged-in user. Mount after `authMiddleware`. */
export function accountRouter({ db, config }: AuthDeps) {
  const router = Router();
  const limiter = new RateLimiter(LOGIN_FAILURES_PER_USER, LOGIN_WINDOW_MS);

  router.get('/auth/me', (req, res) => {
    const user = auth.getUserById(db, userIdOf(req))!;
    res.json({ user: { id: user.id, username: user.username, isAdmin: Boolean(user.is_admin) } });
  });

  /** Changes the caller's password, ends every session of the caller, and starts a new
   *  session for this client. */
  router.post('/auth/password', async (req, res) => {
    const userId = userIdOf(req);
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'currentPassword and newPassword must be strings' });
    }
    const retryAfter = limiter.retryAfter(userId);
    if (retryAfter > 0) return tooManyAttempts(res, retryAfter);
    limiter.fail(userId);
    const user = auth.getUserById(db, userId)!;
    if (!(await checkPassword(currentPassword, user.password_hash))) {
      return res.status(403).json({ error: 'Current password is not correct' });
    }
    limiter.reset(userId);
    if (!isValidPassword(newPassword)) {
      return res.status(400).json({ error: PASSWORD_RULE });
    }
    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    db.transaction(() => {
      auth.updatePasswordHash(db, userId, hash);
      auth.invalidateAllRefreshTokens(db, userId);
    })();
    const session = await createSession(db, config, userId);
    setAuthCookies(res, config, session.jwt, session.refreshToken);
    return res.status(204).send();
  });

  return router;
}

function createJWT(userId: string, jwtSecret: string) {
  return new SignJWT({ userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(jwtSecret));
}
