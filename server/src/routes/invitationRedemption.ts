import { Router } from 'express';
import type { Db } from '../db/index.ts';
import {
  applyInvitationPermissions,
  getInvitationByCode,
  markInvitationAsUsed,
} from '../db/invitation_operations.ts';
import { simpleTokenHash } from '../helpers.ts';
import { createUser, getUserByUsername } from '../db/auth_operations.ts';
import bcrypt from 'bcryptjs';
import { RateLimiter } from '../rateLimit.ts';
import { isValidUsername, isValidPassword, PASSWORD_RULE } from '../validation.ts';
import { BCRYPT_COST } from './auth.ts';

const REDEEM_FAILURES_PER_IP = 10;
const REDEEM_WINDOW_MS = 15 * 60 * 1000;

export interface InvitationRedeemDeps {
  db: Db;
}

export class InvitationRedemptionError extends Error {
  constructor(code: number, message: string) {
    super(message);
    this.name = 'InvitationRedemptionError';
    this.httpStatus = code;
  }
  httpStatus: number;
}

/** Returns the invitation for `hashedCode` when it can create `username`; throws otherwise. */
function checkInvitation(db: Db, hashedCode: string, username: string) {
  //return errors if used, expired, revoked, or not found
  const invitation = getInvitationByCode(db, hashedCode);
  if (!invitation) {
    throw new InvitationRedemptionError(401, 'Invalid code');
  }
  if (invitation.used) {
    throw new InvitationRedemptionError(401, 'Code already used');
  }
  if (new Date(invitation.expires_at) < new Date()) {
    throw new InvitationRedemptionError(401, 'Code expired');
  }
  if (invitation.revoked) {
    throw new InvitationRedemptionError(401, 'Invalid code');
  }
  //if the code is valid, but the username is taken
  if (getUserByUsername(db, username)) {
    throw new InvitationRedemptionError(409, 'Username already exists');
  }
  return invitation;
}

export function invitationRedemptionRouter({ db }: InvitationRedeemDeps) {
  const router = Router();
  const limiter = new RateLimiter(REDEEM_FAILURES_PER_IP, REDEEM_WINDOW_MS);

  router.post('/redeem', async (req, res) => {
    const { username, password, code } = req.body ?? {};

    if (!username || !password || !code) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (typeof username !== 'string' || typeof password !== 'string' || typeof code !== 'string') {
      return res.status(400).json({ error: 'username, password, and code must be strings' });
    }

    if (!isValidUsername(username)) {
      return res.status(400).json({ error: 'Invalid username' });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({ error: PASSWORD_RULE });
    }
    const ipKey = req.ip ?? 'unknown';
    const retryAfter = limiter.retryAfter(ipKey);
    if (retryAfter > 0) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    //hash the code before using it to look things up
    const hashedCode = simpleTokenHash(code);
    try {
      checkInvitation(db, hashedCode, username);
      // bcrypt is slow, so hash outside the transaction. The transaction checks again,
      // because another request can use the code while this one hashes.
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      db.transaction(() => {
        const invitation = checkInvitation(db, hashedCode, username);
        //we have a valid invitation and username, now we need to create the user
        const userId = createUser(db, username, '', passwordHash, Boolean(invitation.is_admin));
        //mark the invitation as used
        markInvitationAsUsed(db, hashedCode, userId);
        applyInvitationPermissions(db, invitation.id, userId);
      })();
    } catch (error) {
      if (error instanceof InvitationRedemptionError) {
        if (error.httpStatus === 401) limiter.fail(ipKey);
        return res.status(error.httpStatus).json({ error: error.message });
      }
      return res.status(500).json({ error: 'Internal server error' });
    }

    return res.status(200).json({ message: 'User created successfully' });
  });

  return router;
}
