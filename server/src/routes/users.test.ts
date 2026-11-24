import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, loginTestUser } from '../test/helpers.ts';

describe('users routes', () => {
  const { app, db } = createTestApp();
  afterAll(() => db.close());

  beforeEach(() => {
    db.exec('DELETE FROM jobs; DELETE FROM invitations; DELETE FROM refresh_tokens;');
    db.exec('DELETE FROM library_members; DELETE FROM libraries; DELETE FROM users;');
  });

  it('lists users for an admin', async () => {
    const { cookie } = await loginTestUser(app, db, { username: 'admin' });
    await loginTestUser(app, db, { username: 'member', isAdmin: false });
    const res = await request(app).get('/api/users').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.users.map((u: { username: string }) => u.username)).toEqual([
      'admin',
      'member',
    ]);
    expect(res.body.users[0]).not.toHaveProperty('password_hash');
  });

  it('refuses the list and removal to a non-admin', async () => {
    const { user: admin } = await loginTestUser(app, db, { username: 'admin' });
    const { cookie } = await loginTestUser(app, db, { username: 'member', isAdmin: false });
    expect((await request(app).get('/api/users').set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).delete(`/api/users/${admin.id}`).set('Cookie', cookie)).status).toBe(
      403,
    );
  });

  it('removes a user and ends the sessions of that user', async () => {
    const { cookie } = await loginTestUser(app, db, { username: 'admin' });
    const { user: member, cookie: memberCookie } = await loginTestUser(app, db, {
      username: 'member',
      isAdmin: false,
    });
    const now = new Date().toISOString();
    const lib = db
      .prepare(
        'INSERT INTO libraries (name, root_path, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run('Lib', '/data/lib', now, now);
    db.prepare(
      "INSERT INTO library_members (library_id, user_id, role_id, created_at) VALUES (?, ?, (SELECT role_id FROM roles WHERE name = 'viewer'), ?)",
    ).run(lib.lastInsertRowid, member.id, now);
    db.prepare(
      "INSERT INTO jobs (id, type, status, user_id, created_at, updated_at) VALUES ('j1', 'x', 'complete', ?, ?, ?)",
    ).run(member.id, now, now);

    const res = await request(app).delete(`/api/users/${member.id}`).set('Cookie', cookie);
    expect(res.status).toBe(204);

    expect((await request(app).get('/api/auth/me').set('Cookie', memberCookie)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', memberCookie)).status).toBe(
      401,
    );
    expect(db.prepare('SELECT user_id FROM jobs').get()).toEqual({ user_id: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM library_members').get()).toEqual({ n: 0 });
  });

  it('refuses to remove the caller', async () => {
    const { user, cookie } = await loginTestUser(app, db, { username: 'admin' });
    const res = await request(app).delete(`/api/users/${user.id}`).set('Cookie', cookie);
    expect(res.status).toBe(409);
  });

  it('answers 404 for an unknown user', async () => {
    const { cookie } = await loginTestUser(app, db, { username: 'admin' });
    const res = await request(app).delete('/api/users/nobody').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});
