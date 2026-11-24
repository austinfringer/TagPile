import type { Db } from './index.ts';
import type { User, RefreshTokenRecord } from './types.ts';

export function createUser(
  db: Db,
  username: string,
  email: string,
  passwordHash: string,
  isAdmin = false,
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const stmt = db.prepare(
    'INSERT INTO users (id, username, email, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  stmt.run(id, username, email, passwordHash, isAdmin ? 1 : 0, now, now);
  return id;
}

export function getUserByUsername(db: Db, username: string): User | undefined {
  const stmt = db.prepare<[string], User>('SELECT * FROM users WHERE username = ?');
  return stmt.get(username);
}

export function getUserById(db: Db, id: string): User | undefined {
  const stmt = db.prepare<[string], User>('SELECT * FROM users WHERE id = ?');
  return stmt.get(id);
}

export interface UserSummary {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export function listUsers(db: Db): UserSummary[] {
  return db
    .prepare<[], { id: string; username: string; is_admin: number; created_at: string }>(
      'SELECT id, username, is_admin, created_at FROM users ORDER BY username COLLATE NOCASE',
    )
    .all()
    .map((u) => ({
      id: u.id,
      username: u.username,
      isAdmin: Boolean(u.is_admin),
      createdAt: u.created_at,
    }));
}

export function updatePasswordHash(db: Db, userId: string, passwordHash: string) {
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    passwordHash,
    new Date().toISOString(),
    userId,
  );
}

/** Deletes a user and the user's sessions. Invitations and jobs keep their rows; their
 *  reference to the user becomes null. Library memberships go by `ON DELETE CASCADE`. */
export function deleteUser(db: Db, userId: string): boolean {
  return db.transaction(() => {
    db.prepare('UPDATE refresh_tokens SET replaces = NULL WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM refresh_tokens WHERE user_id = ?').run(userId);
    db.prepare('UPDATE invitations SET issuer_id = NULL WHERE issuer_id = ?').run(userId);
    db.prepare('UPDATE invitations SET claimant_id = NULL WHERE claimant_id = ?').run(userId);
    db.prepare('UPDATE jobs SET user_id = NULL WHERE user_id = ?').run(userId);
    return db.prepare('DELETE FROM users WHERE id = ?').run(userId).changes > 0;
  })();
}

export function invalidateRefreshToken(db: Db, tokenId: string) {
  db.prepare('UPDATE refresh_tokens SET revoked = 1, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    tokenId,
  );
}

/** Revokes every session of a user. */
export function invalidateAllRefreshTokens(db: Db, userId: string) {
  db.prepare(
    'UPDATE refresh_tokens SET revoked = 1, updated_at = ? WHERE user_id = ? AND revoked = 0',
  ).run(new Date().toISOString(), userId);
}

/** True when a newer token replaced this one, that is, the token was used for a refresh. */
export function wasRefreshTokenRotated(db: Db, tokenId: string): boolean {
  return (
    db
      .prepare<[string], { n: number }>('SELECT 1 AS n FROM refresh_tokens WHERE replaces = ?')
      .get(tokenId) !== undefined
  );
}

/** Deletes refresh tokens that expired before `now`. A revoked token stays until it expires,
 *  so a reuse of a rotated token is still detected. */
export function deleteExpiredRefreshTokens(db: Db, now = new Date()): number {
  const iso = now.toISOString();
  return db.transaction(() => {
    db.prepare(
      `UPDATE refresh_tokens SET replaces = NULL
       WHERE replaces IN (SELECT id FROM refresh_tokens WHERE expires_at <= ?)`,
    ).run(iso);
    return db.prepare('DELETE FROM refresh_tokens WHERE expires_at <= ?').run(iso).changes;
  })();
}

export function createRefreshToken(db: Db, token: RefreshTokenRecord) {
  const stmt = db.prepare(
    'INSERT INTO refresh_tokens (id, user_id, token_hash, created_at, updated_at, expires_at, revoked, replaces) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  stmt.run(
    token.id,
    token.user_id,
    token.token_hash,
    token.created_at,
    token.updated_at,
    token.expires_at,
    token.revoked ? 1 : 0,
    token.replaces,
  );
}

export function searchRefreshToken(db: Db, tokenHash: string): RefreshTokenRecord | undefined {
  const stmt = db.prepare<[string], RefreshTokenRecord>(
    'SELECT * FROM refresh_tokens WHERE token_hash = ?',
  );
  return stmt.get(tokenHash);
}
