import type { Db } from './index.ts';
import { getRoleByName, type LibraryRoleName } from './library_operations.ts';
import type { InvitationRecord } from './types.ts';

export type InvitationLibraryRoleInput = {
  libraryId: number;
  role: LibraryRoleName;
};

export type InvitationLibraryGrant = {
  libraryId: number;
  libraryName: string;
  role: LibraryRoleName;
};

export type InvitationStatus = 'pending' | 'used' | 'revoked' | 'expired';

export type InvitationDetails = {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  revoked: boolean;
  used: boolean;
  status: InvitationStatus;
  isAdmin: boolean;
  issuerId: string | null;
  issuerUsername: string | null;
  claimantId: string | null;
  claimantUsername: string | null;
  libraryRoles: InvitationLibraryGrant[];
};

export function createInvitation(
  db: Db,
  invitation: InvitationRecord,
  libraryRoles: readonly InvitationLibraryRoleInput[] = [],
) {
  const stmt = db.prepare(
    'INSERT INTO invitations (id, code_hash, created_at, updated_at, expires_at, revoked, used, is_admin, issuer_id, claimant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );

  stmt.run(
    invitation.id,
    invitation.code_hash,
    invitation.created_at,
    invitation.updated_at,
    invitation.expires_at,
    invitation.revoked ? 1 : 0,
    invitation.used ? 1 : 0,
    invitation.is_admin ? 1 : 0,
    invitation.issuer_id,
    invitation.claimant_id,
  );

  if (libraryRoles.length > 0) {
    const grantStmt = db.prepare(
      'INSERT INTO invitation_library_members (invitation_id, library_id, role_id) VALUES (?, ?, ?)',
    );
    for (const grant of libraryRoles) {
      const role = getRoleByName(db, grant.role);
      grantStmt.run(invitation.id, grant.libraryId, role.role_id);
    }
  }
}

export function getInvitationByCode(db: Db, code_hash: string): InvitationRecord | undefined {
  const stmt = db.prepare('SELECT * FROM invitations WHERE code_hash = ?');
  return stmt.get(code_hash) as InvitationRecord | undefined;
}

export function getInvitationById(db: Db, id: string): InvitationRecord | undefined {
  const stmt = db.prepare('SELECT * FROM invitations WHERE id = ?');
  return stmt.get(id) as InvitationRecord | undefined;
}

export function markInvitationAsUsed(db: Db, code_hash: string, claimant_id: string | null = null) {
  const stmt = db.prepare(
    'UPDATE invitations SET used = 1, claimant_id = COALESCE(?, claimant_id), updated_at = ? WHERE code_hash = ?',
  );
  stmt.run(claimant_id, new Date().toISOString(), code_hash);
}

export function applyInvitationPermissions(db: Db, invitationId: string, userId: string) {
  const grants = db
    .prepare('SELECT library_id, role_id FROM invitation_library_members WHERE invitation_id = ?')
    .all(invitationId) as { library_id: number; role_id: number }[];
  if (grants.length === 0) return;
  const now = new Date().toISOString();
  const insertMember = db.prepare(
    'INSERT OR REPLACE INTO library_members (library_id, user_id, role_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const grant of grants) {
    insertMember.run(grant.library_id, userId, grant.role_id, now);
  }
}

export function revokeInvitation(db: Db, id: string): boolean {
  const result = db
    .prepare('UPDATE invitations SET revoked = 1, updated_at = ? WHERE id = ? AND used = 0')
    .run(new Date().toISOString(), id);
  return result.changes > 0;
}

type RawInvitationRow = {
  id: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  revoked: number;
  used: number;
  is_admin: number;
  issuer_id: string | null;
  issuer_username: string | null;
  claimant_id: string | null;
  claimant_username: string | null;
};

type RawGrantRow = {
  invitation_id: string;
  library_id: number;
  library_name: string;
  role_name: LibraryRoleName;
};

function computeStatus(row: RawInvitationRow, nowIso: string): InvitationStatus {
  if (row.used) return 'used';
  if (row.revoked) return 'revoked';
  if (row.expires_at <= nowIso) return 'expired';
  return 'pending';
}

function hydrateInvitations(db: Db, rows: RawInvitationRow[]): InvitationDetails[] {
  if (rows.length === 0) return [];
  const grantRows = db
    .prepare(
      `SELECT ilm.invitation_id, ilm.library_id, l.name AS library_name, r.name AS role_name
       FROM invitation_library_members ilm
       JOIN libraries l ON l.library_id = ilm.library_id
       JOIN roles r ON r.role_id = ilm.role_id
       ORDER BY l.name`,
    )
    .all() as RawGrantRow[];

  const grantsByInvitation = new Map<string, InvitationLibraryGrant[]>();
  for (const g of grantRows) {
    const list = grantsByInvitation.get(g.invitation_id) ?? [];
    list.push({
      libraryId: g.library_id,
      libraryName: g.library_name,
      role: g.role_name,
    });
    grantsByInvitation.set(g.invitation_id, list);
  }

  const nowIso = new Date().toISOString();
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
    revoked: Boolean(row.revoked),
    used: Boolean(row.used),
    status: computeStatus(row, nowIso),
    isAdmin: Boolean(row.is_admin),
    issuerId: row.issuer_id,
    issuerUsername: row.issuer_username ?? null,
    claimantId: row.claimant_id,
    claimantUsername: row.claimant_username ?? null,
    libraryRoles: grantsByInvitation.get(row.id) ?? [],
  }));
}

const SELECT_INVITATION_DETAILS = `
  SELECT
    i.id,
    i.created_at,
    i.updated_at,
    i.expires_at,
    i.revoked,
    i.used,
    i.is_admin,
    i.issuer_id,
    issuer.username AS issuer_username,
    i.claimant_id,
    claimant.username AS claimant_username
  FROM invitations i
  LEFT JOIN users issuer ON issuer.id = i.issuer_id
  LEFT JOIN users claimant ON claimant.id = i.claimant_id
`;

export function listInvitations(db: Db): InvitationDetails[] {
  const rows = db
    .prepare(`${SELECT_INVITATION_DETAILS} ORDER BY i.created_at DESC, i.rowid DESC`)
    .all() as RawInvitationRow[];
  return hydrateInvitations(db, rows);
}

export function getInvitationDetails(db: Db, id: string): InvitationDetails | null {
  const row = db.prepare(`${SELECT_INVITATION_DETAILS} WHERE i.id = ?`).get(id) as
    RawInvitationRow | undefined;
  if (!row) return null;
  return hydrateInvitations(db, [row])[0] ?? null;
}
