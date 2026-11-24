import * as crypto from 'node:crypto';

//used for high-entropy random values (not user-chosen secrets), so unlike passwords
//they're hashed deterministically (no per-hash salt) to allow lookup by equality in the db.

export function simpleTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
