import bcrypt from 'bcryptjs';
import { parseSetCookie, stringifyCookie, type SetCookie } from 'cookie';
import { jwtVerify, SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, deleteUser } from '../db/auth_operations.ts';
import { createTestApp, loginTestUser } from '../test/helpers.ts';

// Parses the `Set-Cookie` response headers into `SetCookie` objects (name, value, and attributes).
function getSetCookies(res: request.Response): SetCookie[] {
  const raw = (res.headers['set-cookie'] ?? []) as unknown as string[];
  return raw.map((c) => parseSetCookie(c));
}

function getSetCookie(res: request.Response, name: string): SetCookie | undefined {
  return getSetCookies(res).find((c) => c.name === name);
}

// Builds a `Cookie` request header carrying the named cookies from a previous response, since
// supertest doesn't persist cookies between requests the way a browser would.
function cookieHeader(res: request.Response, names: string[]): string {
  const cookies = getSetCookies(res).filter((c) => names.includes(c.name));
  return stringifyCookie(Object.fromEntries(cookies.map((c) => [c.name, c.value ?? ''])));
}

describe('auth routes', () => {
  const { app, db } = createTestApp();
  afterAll(() => db.close());

  beforeEach(() => {
    db.exec('DELETE FROM refresh_tokens; DELETE FROM users;');
    createUser(db, 'alice', 'alice@example.com', bcrypt.hashSync('correct-horse', 10));
  });

  describe('POST /api/auth/login', () => {
    it('rejects an unknown username', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'nobody', password: 'whatever' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid credentials' });
    });

    it('rejects an incorrect password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'wrong-password' });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid credentials' });
    });

    it('issues jwt and refreshToken cookies on valid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });

      expect(res.status).toBe(200);
      const jwtCookie = getSetCookie(res, 'jwt');
      const refreshCookie = getSetCookie(res, 'refreshToken');
      expect(jwtCookie?.value).toBeTruthy();
      expect(refreshCookie?.value).toBeTruthy();
      expect(jwtCookie?.httpOnly).toBe(true);
      expect(refreshCookie?.httpOnly).toBe(true);
    });

    it('signs a jwt whose payload references the logged-in user', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });

      const token = getSetCookie(res, 'jwt')!.value!;
      const { payload } = await jwtVerify(token, new TextEncoder().encode('test-secret'));

      const user = db.prepare('SELECT id FROM users WHERE username = ?').get('alice') as {
        id: string;
      };
      expect(payload.userId).toBe(user.id);
    });

    it('keeps the session of another device valid', async () => {
      const first = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });

      await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(first, ['refreshToken']));
      expect(res.status).toBe(200);
    });

    it.each([
      ['no body', undefined],
      ['a non-string username', { username: ['alice'], password: 'correct-horse' }],
      ['a non-string password', { username: 'alice', password: 12345678 }],
    ])('answers 400 for %s', async (_label, body) => {
      const req = request(app).post('/api/auth/login');
      const res = await (body === undefined ? req : req.send(body));
      expect(res.status).toBe(400);
    });

    it('deletes expired refresh tokens', async () => {
      await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      db.prepare('UPDATE refresh_tokens SET expires_at = ?').run(
        new Date(Date.now() - 1000).toISOString(),
      );
      await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const { n } = db.prepare('SELECT COUNT(*) AS n FROM refresh_tokens').get() as { n: number };
      expect(n).toBe(1);
    });

    it('sends cookies without the Secure attribute by default', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      expect(getSetCookie(res, 'jwt')?.secure).toBeFalsy();
    });
  });

  describe('login rate limit', () => {
    it('blocks a username after 10 failures, also for the correct password', async () => {
      const { app: limitedApp, db: limitedDb } = createTestApp();
      createUser(limitedDb, 'dave', '', bcrypt.hashSync('correct-horse', 4));
      for (let i = 0; i < 10; i++) {
        const res = await request(limitedApp)
          .post('/api/auth/login')
          .send({ username: 'dave', password: `wrong-${i}` });
        expect(res.status).toBe(401);
      }
      const blocked = await request(limitedApp)
        .post('/api/auth/login')
        .send({ username: 'DAVE', password: 'correct-horse' });
      expect(blocked.status).toBe(429);
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      limitedDb.close();
    });

    it('resets the count after a successful login', async () => {
      const { app: limitedApp, db: limitedDb } = createTestApp();
      createUser(limitedDb, 'erin', '', bcrypt.hashSync('correct-horse', 4));
      const attempt = (password: string) =>
        request(limitedApp).post('/api/auth/login').send({ username: 'erin', password });
      for (let i = 0; i < 9; i++) await attempt('wrong');
      expect((await attempt('correct-horse')).status).toBe(200);
      for (let i = 0; i < 9; i++) await attempt('wrong');
      expect((await attempt('correct-horse')).status).toBe(200);
      limitedDb.close();
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes the refresh token and clears both cookies', async () => {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const cookie = cookieHeader(login, ['jwt', 'refreshToken']);

      const res = await request(app).post('/api/auth/logout').set('Cookie', cookie);
      expect(res.status).toBe(204);
      expect(getSetCookie(res, 'jwt')?.value).toBe('');
      expect(getSetCookie(res, 'refreshToken')?.value).toBe('');

      const refresh = await request(app).post('/api/auth/refresh').set('Cookie', cookie);
      expect(refresh.status).toBe(401);
    });

    it('answers 204 with no session', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(204);
    });

    it('does not end the sessions of other devices', async () => {
      const first = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const second = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookieHeader(first, ['refreshToken']));
      const refresh = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(second, ['refreshToken']));
      expect(refresh.status).toBe(200);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the logged-in user', async () => {
      const { user, cookie } = await loginTestUser(app, db, { username: 'meuser' });
      const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ user: { id: user.id, username: 'meuser', isAdmin: true } });
    });
  });

  describe('POST /api/auth/password', () => {
    it('changes the password and ends every other session', async () => {
      const other = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });

      const res = await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookieHeader(login, ['jwt']))
        .send({ currentPassword: 'correct-horse', newPassword: 'a new pässword' });
      expect(res.status).toBe(204);

      const refreshOther = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(other, ['refreshToken']));
      expect(refreshOther.status).toBe(401);
      const refreshOwn = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(res, ['refreshToken']));
      expect(refreshOwn.status).toBe(200);

      const oldLogin = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      expect(oldLogin.status).toBe(401);
      const newLogin = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'a new pässword' });
      expect(newLogin.status).toBe(200);
    });

    it('rejects the JWT of another session after a password change', async () => {
      const other = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      // The JWT must be older than the change by at least one second (JWT iat is in seconds).
      db.prepare('UPDATE users SET updated_at = ?').run(new Date(Date.now() - 5000).toISOString());
      const jwt = await new SignJWT({
        userId: (db.prepare('SELECT id FROM users').get() as { id: string }).id,
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 3)
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode('test-secret'));
      expect((await request(app).get('/api/auth/me').set('Cookie', `jwt=${jwt}`)).status).toBe(200);

      await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookieHeader(other, ['jwt']))
        .send({ currentPassword: 'correct-horse', newPassword: 'another-password' });

      const res = await request(app).get('/api/auth/me').set('Cookie', `jwt=${jwt}`);
      expect(res.status).toBe(401);
    });

    it('rejects a wrong current password', async () => {
      const { cookie } = await loginTestUser(app, db, { username: 'pwuser' });
      const res = await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookie)
        .send({ currentPassword: 'wrong', newPassword: 'long-enough' });
      expect(res.status).toBe(403);
    });

    it('rejects a new password that breaks the rule', async () => {
      const { cookie } = await loginTestUser(app, db, { username: 'pwuser2' });
      const res = await request(app)
        .post('/api/auth/password')
        .set('Cookie', cookie)
        .send({ currentPassword: 'correct-horse', newPassword: 'short' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least 8 characters/);
    });

    it('rejects non-string fields', async () => {
      const { cookie } = await loginTestUser(app, db, { username: 'pwuser3' });
      const res = await request(app).post('/api/auth/password').set('Cookie', cookie).send({});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('rejects a request with no refreshToken cookie', async () => {
      const res = await request(app).post('/api/auth/refresh');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid refresh token' });
    });

    it('rejects an unrecognized refresh token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', 'refreshToken=not-a-real-token');
      expect(res.status).toBe(401);
    });

    it('issues a new jwt and rotates the refresh token', async () => {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const loginRefreshCookieHeader = cookieHeader(login, ['refreshToken']);

      const refresh = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', loginRefreshCookieHeader);
      expect(refresh.status).toBe(200);
      expect(getSetCookie(refresh, 'jwt')?.value).toBeTruthy();

      const refreshedRefreshToken = getSetCookie(refresh, 'refreshToken')?.value;
      expect(refreshedRefreshToken).toBeTruthy();
      expect(refreshedRefreshToken).not.toBe(getSetCookie(login, 'refreshToken')?.value);
    });

    it('rejects reuse of a refresh token after it has been rotated', async () => {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const loginRefreshCookieHeader = cookieHeader(login, ['refreshToken']);

      await request(app).post('/api/auth/refresh').set('Cookie', loginRefreshCookieHeader);

      const reuse = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', loginRefreshCookieHeader);
      expect(reuse.status).toBe(401);
    });

    it('revokes every session of the user when a rotated token comes back later', async () => {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const otherDevice = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const rotated = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(login, ['refreshToken']));
      db.prepare('UPDATE refresh_tokens SET updated_at = ? WHERE revoked = 1').run(
        new Date(Date.now() - 60_000).toISOString(),
      );

      const reuse = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(login, ['refreshToken']));
      expect(reuse.status).toBe(401);

      for (const res of [rotated, otherDevice]) {
        const refresh = await request(app)
          .post('/api/auth/refresh')
          .set('Cookie', cookieHeader(res, ['refreshToken']));
        expect(refresh.status).toBe(401);
      }
    });

    it('keeps the new session when a rotated token comes back within the grace time', async () => {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const rotated = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(login, ['refreshToken']));
      await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(login, ['refreshToken']));
      const refresh = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(rotated, ['refreshToken']));
      expect(refresh.status).toBe(200);
    });

    it('does not revoke other sessions when a logged-out token comes back', async () => {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      const otherDevice = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookieHeader(login, ['refreshToken']));
      db.prepare('UPDATE refresh_tokens SET updated_at = ? WHERE revoked = 1').run(
        new Date(Date.now() - 60_000).toISOString(),
      );
      await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(login, ['refreshToken']));
      const refresh = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(otherDevice, ['refreshToken']));
      expect(refresh.status).toBe(200);
    });

    it('rejects an expired refresh token', async () => {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });
      db.prepare('UPDATE refresh_tokens SET expires_at = ?').run(
        new Date(Date.now() - 1000).toISOString(),
      );
      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(login, ['refreshToken']));
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid refresh token' });
    });

    it('allows chaining refreshes with the newest token', async () => {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ username: 'alice', password: 'correct-horse' });

      const secondResponse = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(login, ['refreshToken']));

      const thirdResponse = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', cookieHeader(secondResponse, ['refreshToken']));
      expect(thirdResponse.status).toBe(200);
    });
  });

  describe('Authentication middleware', () => {
    it('rejects a request with no jwt cookie', async () => {
      const res = await request(app).get('/api/auth/me');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid JWT' });
    });

    it('rejects a request with an invalid jwt cookie', async () => {
      const res = await request(app).get('/api/auth/me').set('Cookie', 'jwt=not-a-real-jwt');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid JWT' });
    });

    it('rejects a request with an expired jwt cookie', async () => {
      const { cookie } = await loginTestUser(app, db, {
        username: 'bob',
        email: 'bob@example.com',
      });
      const expiredJwt = await new SignJWT({ userId: 'whoever' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt(Math.floor(Date.now() / 1000) - 60)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 30)
        .sign(new TextEncoder().encode('test-secret'));
      const staleRefreshCookie = cookie
        .split('; ')
        .filter((c) => !c.startsWith('jwt='))
        .concat(`jwt=${expiredJwt}`)
        .join('; ');

      const res = await request(app).get('/api/auth/me').set('Cookie', staleRefreshCookie);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'Invalid JWT' });
    });

    it('rejects a valid jwt whose user no longer exists', async () => {
      const { user, cookie } = await loginTestUser(app, db, { username: 'gone' });
      deleteUser(db, user.id);
      const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
      expect(res.status).toBe(401);
    });

    it('allows a request with a valid jwt cookie', async () => {
      const { cookie } = await loginTestUser(app, db, {
        username: 'carol',
        email: 'carol@example.com',
      });
      const res = await request(app).get('/api/auth/me').set('Cookie', cookie);
      expect(res.status).toBe(200);
    });
  });
});
