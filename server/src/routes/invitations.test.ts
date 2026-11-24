import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createLibrary, getMemberRole } from '../db/library_operations.ts';
import { getUserByUsername } from '../db/auth_operations.ts';
import { createTestApp, loginTestUser } from '../test/helpers.ts';

describe('/api/invitations routes', () => {
  const { app, db } = createTestApp();
  afterAll(() => db.close());

  let adminCookie: string;
  let memberCookie: string;

  beforeEach(async () => {
    db.exec(
      'DELETE FROM invitation_library_members; DELETE FROM invitations; DELETE FROM library_members; DELETE FROM libraries; DELETE FROM refresh_tokens; DELETE FROM users;',
    );
    adminCookie = (await loginTestUser(app, db, { username: 'admin', isAdmin: true })).cookie;
    memberCookie = (
      await loginTestUser(app, db, {
        username: 'member',
        email: 'member@example.com',
        isAdmin: false,
      })
    ).cookie;
  });

  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/invitations');
    expect(res.status).toBe(401);
  });

  it('forbids non-admin users from listing, creating, or revoking invitations', async () => {
    const listRes = await request(app).get('/api/invitations').set('Cookie', memberCookie);
    expect(listRes.status).toBe(403);

    const createRes = await request(app)
      .post('/api/invitations')
      .set('Cookie', memberCookie)
      .send({});
    expect(createRes.status).toBe(403);

    const revokeRes = await request(app)
      .post('/api/invitations/some-id/revoke')
      .set('Cookie', memberCookie);
    expect(revokeRes.status).toBe(403);
  });

  it('creates an invitation with global and per-library roles and lists it as pending', async () => {
    const libId = createLibrary(db, 'Photos', '/data/photos');

    const createRes = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({
        isAdmin: false,
        expiresInSeconds: 3600,
        libraryRoles: [{ libraryId: libId, role: 'editor' }],
      });

    expect(createRes.status).toBe(201);
    expect(typeof createRes.body.code).toBe('string');
    expect(createRes.body.code.length).toBeGreaterThan(10);
    expect(createRes.body.invitation).toMatchObject({
      status: 'pending',
      used: false,
      revoked: false,
      isAdmin: false,
      issuerUsername: 'admin',
      claimantUsername: null,
      libraryRoles: [{ libraryId: libId, libraryName: 'Photos', role: 'editor' }],
    });

    const listRes = await request(app).get('/api/invitations').set('Cookie', adminCookie);
    expect(listRes.status).toBe(200);
    expect(listRes.body.invitations).toHaveLength(1);
    expect(listRes.body.invitations[0]).toMatchObject({
      id: createRes.body.invitation.id,
      status: 'pending',
      libraryRoles: [{ libraryId: libId, libraryName: 'Photos', role: 'editor' }],
    });
  });

  it('records the created user and grants permissions when a created invitation is redeemed', async () => {
    const libId = createLibrary(db, 'Docs', '/data/docs');

    const createRes = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({
        isAdmin: true,
        libraryRoles: [{ libraryId: libId, role: 'viewer' }],
      });
    const { code, invitation } = createRes.body as {
      code: string;
      invitation: { id: string };
    };

    const redeemRes = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'newcomer', password: 'correct-horse', code });
    expect(redeemRes.status).toBe(200);

    const listRes = await request(app).get('/api/invitations').set('Cookie', adminCookie);
    expect(listRes.body.invitations[0]).toMatchObject({
      id: invitation.id,
      used: true,
      status: 'used',
      isAdmin: true,
      claimantUsername: 'newcomer',
    });

    const createdUser = getUserByUsername(db, 'newcomer')!;
    expect(Boolean(createdUser.is_admin)).toBe(true);
    expect(getMemberRole(db, libId, createdUser.id)?.name).toBe('viewer');
  });

  it('revokes a pending invitation and prevents redemption', async () => {
    const createRes = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({});
    const { code, invitation } = createRes.body as {
      code: string;
      invitation: { id: string };
    };

    const revokeRes = await request(app)
      .post(`/api/invitations/${invitation.id}/revoke`)
      .set('Cookie', adminCookie);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.invitation).toMatchObject({
      id: invitation.id,
      revoked: true,
      status: 'revoked',
    });

    const redeemRes = await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'lateuser', password: 'correct-horse', code });
    expect(redeemRes.status).toBe(401);
  });

  it('returns 404 when revoking an unknown invitation and 409 when revoking a used one', async () => {
    const missing = await request(app)
      .post('/api/invitations/non-existent/revoke')
      .set('Cookie', adminCookie);
    expect(missing.status).toBe(404);

    const createRes = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({});
    const { code, invitation } = createRes.body as {
      code: string;
      invitation: { id: string };
    };
    await request(app)
      .post('/api/invitation/redeem')
      .send({ username: 'usedbyme', password: 'correct-horse', code });

    const usedRevoke = await request(app)
      .post(`/api/invitations/${invitation.id}/revoke`)
      .set('Cookie', adminCookie);
    expect(usedRevoke.status).toBe(409);
  });

  it('validates create invitation payload', async () => {
    const badAdmin = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({ isAdmin: 'yes' });
    expect(badAdmin.status).toBe(400);

    const badExpiry = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({ expiresInSeconds: -5 });
    expect(badExpiry.status).toBe(400);

    const hugeExpiry = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({ expiresInSeconds: 1e300 });
    expect(hugeExpiry.status).toBe(400);

    const thirtyDays = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({ expiresInSeconds: 30 * 24 * 60 * 60 });
    expect(thirtyDays.status).toBe(201);

    const badRole = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({ libraryRoles: [{ libraryId: 1, role: 'superadmin' }] });
    expect(badRole.status).toBe(400);

    const missingLib = await request(app)
      .post('/api/invitations')
      .set('Cookie', adminCookie)
      .send({ libraryRoles: [{ libraryId: 999, role: 'viewer' }] });
    expect(missingLib.status).toBe(404);
  });
});
