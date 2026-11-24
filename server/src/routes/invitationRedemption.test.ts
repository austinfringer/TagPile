import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import { createInvitation, getInvitationByCode } from '../db/invitation_operations.ts';
import { createUser, getUserByUsername } from '../db/auth_operations.ts';
import { simpleTokenHash } from '../helpers.ts';
import { createTestApp } from '../test/helpers.ts';
import type { InvitationRecord } from '../db/types.ts';

describe('POST /api/invitation/redeem', () => {
  const { app, db } = createTestApp();
  afterAll(() => db.close());

  let issuerId: string;

  beforeEach(() => {
    db.exec('DELETE FROM invitations; DELETE FROM refresh_tokens; DELETE FROM users;');
    createUser(db, 'issuer', 'issuer@example.com', 'unused-hash');
    issuerId = getUserByUsername(db, 'issuer')!.id;
  });

  /** Inserts an invitation whose plaintext code is `code`, returning that code. */
  function seedInvitation(code: string, overrides: Partial<InvitationRecord> = {}): string {
    const now = new Date();
    createInvitation(db, {
      id: crypto.randomUUID(),
      code_hash: simpleTokenHash(code),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60_000).toISOString(),
      revoked: false,
      used: false,
      issuer_id: issuerId,
      claimant_id: null,
      ...overrides,
    });
    return code;
  }

  it('rejects a request missing username', async () => {
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ password: 'correct-horse', code: 'some-code' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('rejects a request missing password', async () => {
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', code: 'some-code' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('rejects a request missing code', async () => {
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', password: 'correct-horse' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required fields' });
  });

  it('rejects an invalid username', async () => {
    const code = seedInvitation('valid-code-1');
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'not valid!', password: 'correct-horse', code });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid username' });
  });

  it('rejects an invalid password', async () => {
    const code = seedInvitation('valid-code-2');
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', password: 'a', code });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Password must have at least 8 characters and at most 72 bytes',
    });
  });

  it('answers 400 for non-string fields and for no body', async () => {
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: ['newuser'], password: 'correct-horse', code: 'c' });
    expect(res.status).toBe(400);
    expect((await request(app).post('/api/invitation/redeem')).status).toBe(400);
  });

  it('accepts a password with spaces and non-ASCII characters', async () => {
    const code = seedInvitation('unicode-password-code');
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'unicodeuser', password: 'ein schönes Passwort', code });
    expect(res.status).toBe(200);
  });

  it('blocks an address after 10 bad codes', async () => {
    const { app: limitedApp, db: limitedDb } = createTestApp();
    const attempt = () =>
      request(limitedApp)
        .post('/api/invitation/redeem')
        .send({ username: 'guesser', password: 'correct-horse', code: 'wrong' });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    limitedDb.close();
  });

  it('rejects an unknown code', async () => {
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', password: 'correct-horse', code: 'never-issued' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid code' });
  });

  it('rejects a code that has already been used', async () => {
    const code = seedInvitation('used-code', { used: true });
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', password: 'correct-horse', code });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Code already used' });
  });

  it('rejects an expired code', async () => {
    const code = seedInvitation('expired-code', {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', password: 'correct-horse', code });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Code expired' });
  });

  it('rejects a revoked code', async () => {
    const code = seedInvitation('revoked-code', { revoked: true });
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', password: 'correct-horse', code });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid code' });
  });

  it('rejects a valid code when the username is already taken', async () => {
    createUser(db, 'newuser', 'existing@example.com', 'unused-hash');
    const code = seedInvitation('taken-username-code');
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', password: 'correct-horse', code });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Username already exists' });
  });

  it('creates the user and marks the invitation as used on success', async () => {
    const code = seedInvitation('good-code');
    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newuser', password: 'correct-horse', code });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'User created successfully' });

    const user = getUserByUsername(db, 'newuser');
    expect(user).toBeTruthy();

    const invitation = getInvitationByCode(db, simpleTokenHash(code));
    expect(invitation?.used).toBeTruthy();
    expect(invitation?.claimant_id).toBe(user!.id);
  });

  it('applies admin flag and per-library roles from the invitation when redeemed', async () => {
    const now = new Date();
    const libResult = db
      .prepare(
        'INSERT INTO libraries (name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('Photos', '/data/photos', now.toISOString(), now.toISOString());
    const libraryId = Number(libResult.lastInsertRowid);

    const code = 'admin-with-lib-code';
    createInvitation(
      db,
      {
        id: crypto.randomUUID(),
        code_hash: simpleTokenHash(code),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 60_000).toISOString(),
        revoked: false,
        used: false,
        is_admin: true,
        issuer_id: issuerId,
        claimant_id: null,
      },
      [{ libraryId, role: 'editor' }],
    );

    const res = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'invitedadmin', password: 'correct-horse', code });

    expect(res.status).toBe(200);
    const user = getUserByUsername(db, 'invitedadmin');
    expect(Boolean(user?.is_admin)).toBe(true);

    const membership = db
      .prepare(
        `SELECT r.name FROM library_members lm
         JOIN roles r ON r.role_id = lm.role_id
         WHERE lm.library_id = ? AND lm.user_id = ?`,
      )
      .get(libraryId, user!.id) as { name: string } | undefined;
    expect(membership?.name).toBe('editor');
  });
});
