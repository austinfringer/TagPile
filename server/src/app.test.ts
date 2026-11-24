import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, SECURITY_HEADERS } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/index.ts';
import { createServices } from './services/index.ts';
import { createTestApp, createTestDb, loginTestUser } from './test/helpers.ts';

describe('API', () => {
  const { app, db } = createTestApp();
  afterAll(() => db.close());

  beforeEach(() => {
    db.exec('DELETE FROM refresh_tokens; DELETE FROM users;');
  });

  it('GET /api/health reports ok when logged in', async () => {
    const { cookie } = await loginTestUser(app, db);
    const res = await request(app).get('/api/health').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', version: 'test' });
    expect(typeof res.body.uptime).toBe('number');
  });

  it('GET /api/health reports only the status when not logged in', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /api/health reports only the status for an invalid jwt', async () => {
    const res = await request(app).get('/api/health').set('Cookie', 'jwt=not-a-real-jwt');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('returns JSON 404 for unknown API routes when logged in', async () => {
    const { cookie } = await loginTestUser(app, db);
    const res = await request(app).get('/api/nope').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('returns 401 for unknown API routes when not logged in', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid JWT' });
  });

  it('does not expose x-powered-by', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sends the security headers on every response', async () => {
    const res = await request(app).get('/api/health');
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers[name.toLowerCase()]).toBe(value);
    }
    expect(res.headers['content-security-policy']).toMatch(/frame-ancestors 'none'/);
  });
});

describe('HTTPS mode', () => {
  it('sends Strict-Transport-Security and Secure cookies only with TLS files', async () => {
    const db = createTestDb();
    const services = createServices(db, openDatabase(':memory:'));
    const tlsApp = createApp({
      db,
      version: 'test',
      services,
      config: loadConfig({ JWT_SECRET: 's', TLS_CERT_FILE: 'cert', TLS_KEY_FILE: 'key' }),
    });
    const plainApp = createApp({
      db,
      version: 'test',
      services,
      config: loadConfig({ JWT_SECRET: 's' }),
    });
    expect((await request(tlsApp).get('/api/health')).headers['strict-transport-security']).toBe(
      'max-age=31536000',
    );
    expect(
      (await request(plainApp).get('/api/health')).headers['strict-transport-security'],
    ).toBeUndefined();

    const { cookie } = await loginTestUser(tlsApp, db);
    expect(cookie).toContain('jwt=');
    const res = await request(tlsApp)
      .post('/api/auth/login')
      .send({ username: 'alice', password: 'correct-horse' });
    const setCookies = res.headers['set-cookie'] as unknown as string[];
    expect(setCookies.every((c) => /;\s*Secure/i.test(c))).toBe(true);
    db.close();
  });
});

describe('createApp', () => {
  it('rejects a config with no JWT secret', () => {
    const db = createTestDb();
    try {
      expect(() =>
        createApp({
          db,
          version: 'test',
          config: loadConfig({}),
          services: createServices(db, openDatabase(':memory:')),
        }),
      ).toThrow(/jwtSecret/);
    } finally {
      db.close();
    }
  });
});

describe('static client serving', () => {
  const staticDir = mkdtempSync(join(tmpdir(), 'tagpile-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(staticDir, 'login.html'), '<h1>login</h1>');
  const db = createTestDb();
  const app = createApp({
    db,
    version: 'test',
    staticDir,
    config: loadConfig({ JWT_SECRET: 'test-secret' }),
    services: createServices(db, openDatabase(':memory:')),
  });

  afterAll(() => {
    db.close();
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('serves the login page at /login without a session', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('login');
  });

  it('redirects the root to /login when not logged in', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('redirects client-side routes to /login when not logged in', async () => {
    const res = await request(app).get('/some/deep/route');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('serves index.html at the root when logged in', async () => {
    const { cookie } = await loginTestUser(app, db, { username: 'static-root' });
    const res = await request(app).get('/').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('home');
  });

  it('falls back to index.html for client-side routes when logged in', async () => {
    const { cookie } = await loginTestUser(app, db, { username: 'static-deep-route' });
    const res = await request(app).get('/some/deep/route').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('home');
  });

  it('redirects to /login on an expired jwt, even with a valid refresh token', async () => {
    const { cookie } = await loginTestUser(app, db, { username: 'static-refresh' });
    const refreshCookie = cookie.split('; ').find((c) => c.startsWith('refreshToken='));

    const res = await request(app).get('/').set('Cookie', refreshCookie!);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/login');
  });

  it('returns 401 for missing routes if not logged in', async () => {
    const res = await request(app).get('/api/missing');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid JWT' });
  });

  it('still returns JSON 404 under /api if logged in', async () => {
    const { cookie } = await loginTestUser(app, db, { username: 'static-404' });
    const res = await request(app).get('/api/missing').set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('embedded static assets serving (SEA)', () => {
  const assets = new Map<string, Buffer | string>([
    ['index.html', '<h1>sea-home</h1>'],
    ['login.html', '<h1>sea-login</h1>'],
    ['assets/main-abc.js', 'console.log("sea");'],
    ['assets/main-abc.css', 'body { color: red; }'],
  ]);
  const db = createTestDb();
  const app = createApp({
    db,
    version: 'test',
    staticAssets: {
      get: (key) => assets.get(key),
    },
    config: loadConfig({ JWT_SECRET: 'test-secret' }),
    services: createServices(db, openDatabase(':memory:')),
  });

  afterAll(() => {
    db.close();
  });

  it('serves login.html at /login without auth', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('sea-login');
  });

  it('serves embedded assets with proper mime types without auth', async () => {
    const jsRes = await request(app).get('/assets/main-abc.js');
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers['content-type']).toContain('application/javascript');
    expect(jsRes.text).toContain('console.log("sea")');

    const cssRes = await request(app).get('/assets/main-abc.css');
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers['content-type']).toContain('text/css');
    expect(cssRes.text).toContain('body { color: red; }');

    const missingRes = await request(app).get('/assets/missing.js');
    expect(missingRes.status).toBe(404);
  });

  it('redirects unauthenticated root requests to /login and serves index.html when logged in', async () => {
    const unauth = await request(app).get('/');
    expect(unauth.status).toBe(302);
    expect(unauth.headers.location).toBe('/login');

    const { cookie } = await loginTestUser(app, db, { username: 'sea-user' });
    const auth = await request(app).get('/tag').set('Cookie', cookie);
    expect(auth.status).toBe(200);
    expect(auth.headers['content-type']).toContain('text/html');
    expect(auth.text).toContain('sea-home');
  });
});
