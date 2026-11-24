import type { Db } from './db/index.ts';
import { createInvitation } from './db/invitation_operations.ts';
import { simpleTokenHash } from './helpers.ts';
import * as crypto from 'node:crypto';

//This should be pulled out into its own "invitation creation" function
/** With no users, revokes the setup codes of earlier starts and creates one new admin
 *  invitation. Codes are stored hashed and cannot be printed again, so each start prints a
 *  new code and only that code is valid. Returns the code, or `null` when a user exists. */
export function checkIfFirstTimeSetup(db: Db): string | null {
  // Check if there are any users in the database
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number })
    .count;
  if (userCount !== 0) return null;

  const code = crypto.randomBytes(32).toString('hex');
  db.transaction(() => {
    db.prepare(
      'UPDATE invitations SET revoked = 1, updated_at = ? WHERE issuer_id IS NULL AND used = 0 AND revoked = 0',
    ).run(new Date().toISOString());
    createInvitation(db, {
      id: crypto.randomUUID(),
      code_hash: simpleTokenHash(code),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      revoked: false,
      used: false,
      is_admin: true,
      issuer_id: null,
      claimant_id: null,
    });
  })();

  console.log(`First time setup complete. Invitation code: ${code}`);
  return code;
}

const JWT_SECRET_META_KEY = 'jwt_secret';

/** Returns the JWT signing secret stored in the database, generating and persisting a new
 *  one on first boot. The secret lives and dies with the database, so deleting the
 *  database invalidates every issued session token. `JWT_SECRET` in the environment
 *  overrides this (checked by the caller). */
export function ensureJwtSecret(db: Db): string {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(JWT_SECRET_META_KEY) as
    { value: string } | undefined;
  if (row) {
    return row.value;
  }
  const secret = crypto.randomBytes(48).toString('hex');
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(JWT_SECRET_META_KEY, secret);
  return secret;
}
