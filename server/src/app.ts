import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db/index.ts';
import type { Config } from './config.ts';
import type { AppServices } from './services/index.ts';

import { accountRouter, authRouter, authMiddleware, verifyJwtCookie } from './routes/auth.ts';
import { healthRouter } from './routes/health.ts';
import { invitationRedemptionRouter } from './routes/invitationRedemption.ts';
import { invitationsRouter } from './routes/invitations.ts';
import { jobRouter } from './routes/jobs.ts';
import { filesRouter } from './routes/files.ts';
import { librariesRouter } from './routes/libraries.ts';
import { libraryFilesRouter } from './routes/libraryFiles.ts';
import { libraryScope } from './routes/libraryScope.ts';
import { libraryTagsRouter } from './routes/libraryTags.ts';
import { previewsRouter } from './routes/previews.ts';
import { usersRouter } from './routes/users.ts';

export interface StaticAssets {
  get(key: string): Buffer | string | undefined;
}

export interface AppOptions {
  db: Db;
  version: string;
  /** Absolute path to the built client (`client/dist`). When set and present, it is served as static files. */
  staticDir?: string;
  /** Embedded static assets (e.g. from Node SEA). Used when `staticDir` is not present. */
  staticAssets?: StaticAssets;
  /** Configuration object containing server settings. */
  config: Config;
  /** Services object containing shared services. */
  services: AppServices;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/** Sent on every response. The client loads all its scripts and styles from `/assets`, and
 *  previews are `data:` URLs. Routes can replace a header, as the file content route does. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

function mimeTypeFor(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  return MIME_TYPES[ext] ?? 'application/octet-stream';
}

export function createApp({
  db,
  version,
  staticDir,
  staticAssets,
  config,
  services,
}: AppOptions): Express {
  if (!config.jwtSecret) throw new Error('config.jwtSecret is empty');
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  const headers = config.tls
    ? { ...SECURITY_HEADERS, 'Strict-Transport-Security': 'max-age=31536000' }
    : SECURITY_HEADERS;
  app.use((_req, res, next) => {
    res.set(headers);
    next();
  });
  app.use(express.json());

  app.use('/api', authRouter({ db, config }));
  app.use('/api', healthRouter({ db, version, config }));
  app.use('/api/invitation', invitationRedemptionRouter({ db }));
  app.use('/api', authMiddleware({ db, config }));
  app.use('/api', accountRouter({ db, config }));
  app.use('/api', invitationsRouter({ db }));
  app.use('/api', usersRouter({ db }));
  app.use('/api', jobRouter({ db, jobManager: services.jobManager }));
  app.use('/api', librariesRouter({ db, config }));
  app.use(
    '/api/libraries/:libraryId',
    libraryScope({ db }),
    libraryFilesRouter({ db }),
    libraryTagsRouter({ db }),
  );
  app.use('/api', filesRouter({ db }));
  app.use('/api', previewsRouter({ db, previewService: services.previewService }));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  if (staticDir && existsSync(staticDir)) {
    // Hashed build assets (JS/CSS/etc.) are just compiled code, not sensitive, so they're
    // served publicly. Only the HTML "pages" below are gated.
    app.use('/assets', express.static(join(staticDir, 'assets')));

    // The login page is the one page that must be reachable without a session.
    app.get(['/login', '/login.html'], (_req, res) => {
      res.sendFile(join(staticDir, 'login.html'));
    });

    // Every other page requires a valid session; unauthenticated requests never receive the
    // app shell, they're redirected to /login before any client JS runs.
    app.get('/{*splat}', async (req, res) => {
      const jwt = await verifyJwtCookie(config, req.headers.cookie);
      if (!jwt) {
        return res.redirect('/login');
      }
      res.sendFile(join(staticDir, 'index.html'));
    });
  } else if (staticAssets) {
    app.get('/assets/{*assetPath}', (req, res) => {
      const raw = (req.params as { assetPath?: string | string[] }).assetPath;
      const rel = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
      const asset = staticAssets.get(`assets/${rel}`);
      if (asset === undefined) {
        return res.status(404).end();
      }
      res.type(mimeTypeFor(rel)).send(asset);
    });

    app.get(['/login', '/login.html'], (_req, res) => {
      const loginHtml = staticAssets.get('login.html');
      if (loginHtml === undefined) return res.status(404).end();
      res.type('text/html; charset=utf-8').send(loginHtml);
    });

    app.get('/{*splat}', async (req, res) => {
      const jwt = await verifyJwtCookie(config, req.headers.cookie);
      if (!jwt) {
        return res.redirect('/login');
      }
      const indexHtml = staticAssets.get('index.html');
      if (indexHtml === undefined) return res.status(404).end();
      res.type('text/html; charset=utf-8').send(indexHtml);
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
