import * as crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Db } from '../db/index.ts';
import {
  createInvitation,
  getInvitationById,
  getInvitationDetails,
  listInvitations,
  revokeInvitation,
  type InvitationLibraryRoleInput,
} from '../db/invitation_operations.ts';
import { getLibraryById, type LibraryRoleName } from '../db/library_operations.ts';
import { simpleTokenHash } from '../helpers.ts';
import { isPositiveInt, requireAdmin } from './util.ts';

export interface InvitationsDeps {
  db: Db;
}

const VALID_ROLES = new Set<LibraryRoleName>(['owner', 'editor', 'viewer']);
const DEFAULT_EXPIRES_IN_SECONDS = 24 * 60 * 60;
export const MAX_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;

function parseLibraryRoles(
  db: Db,
  raw: unknown,
  res: Response,
): InvitationLibraryRoleInput[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: 'libraryRoles must be an array' });
    return null;
  }
  const seen = new Set<number>();
  const parsed: InvitationLibraryRoleInput[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      res.status(400).json({ error: 'Invalid library role entry' });
      return null;
    }
    const { libraryId, role } = item as { libraryId?: unknown; role?: unknown };
    if (!isPositiveInt(libraryId)) {
      res.status(400).json({ error: 'libraryId must be a positive integer' });
      return null;
    }
    if (typeof role !== 'string' || !VALID_ROLES.has(role as LibraryRoleName)) {
      res.status(400).json({ error: 'role must be owner, editor, or viewer' });
      return null;
    }
    if (seen.has(libraryId)) {
      res.status(400).json({ error: 'Duplicate libraryId in libraryRoles' });
      return null;
    }
    if (!getLibraryById(db, libraryId)) {
      res.status(404).json({ error: `Library ${libraryId} not found` });
      return null;
    }
    seen.add(libraryId);
    parsed.push({ libraryId, role: role as LibraryRoleName });
  }
  return parsed;
}

export function invitationsRouter({ db }: InvitationsDeps) {
  const router = Router();

  router.get('/invitations', (req, res) => {
    if (!requireAdmin(db, req, res)) return;
    res.status(200).json({ invitations: listInvitations(db) });
  });

  router.post('/invitations', (req, res) => {
    const issuerId = requireAdmin(db, req, res);
    if (!issuerId) return;

    const {
      isAdmin = false,
      expiresInSeconds = DEFAULT_EXPIRES_IN_SECONDS,
      libraryRoles,
    } = req.body ?? {};

    if (typeof isAdmin !== 'boolean') {
      return res.status(400).json({ error: 'isAdmin must be a boolean' });
    }
    if (
      typeof expiresInSeconds !== 'number' ||
      !Number.isFinite(expiresInSeconds) ||
      expiresInSeconds <= 0 ||
      expiresInSeconds > MAX_EXPIRES_IN_SECONDS
    ) {
      return res.status(400).json({
        error: `expiresInSeconds must be a positive number no larger than ${MAX_EXPIRES_IN_SECONDS}`,
      });
    }

    const parsedRoles = parseLibraryRoles(db, libraryRoles, res);
    if (parsedRoles === null) return;

    const id = crypto.randomUUID();
    const code = crypto.randomBytes(32).toString('hex');
    const now = new Date();
    const nowIso = now.toISOString();
    const expiresAtIso = new Date(now.getTime() + expiresInSeconds * 1000).toISOString();

    db.transaction(() => {
      createInvitation(
        db,
        {
          id,
          code_hash: simpleTokenHash(code),
          created_at: nowIso,
          updated_at: nowIso,
          expires_at: expiresAtIso,
          revoked: false,
          used: false,
          is_admin: isAdmin,
          issuer_id: issuerId,
          claimant_id: null,
        },
        parsedRoles,
      );
    })();

    const invitation = getInvitationDetails(db, id)!;
    res.status(201).json({ code, invitation });
  });

  const handleRevoke = (req: Request, res: Response) => {
    if (!requireAdmin(db, req, res)) return;
    const id = String(req.params.id ?? '');
    const existing = getInvitationById(db, id);
    if (!existing) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    if (existing.used) {
      return res.status(409).json({ error: 'Cannot revoke a used invitation' });
    }
    revokeInvitation(db, id);
    const invitation = getInvitationDetails(db, id)!;
    return res.status(200).json({ invitation });
  };

  router.post('/invitations/:id/revoke', handleRevoke);
  router.delete('/invitations/:id', handleRevoke);

  return router;
}
