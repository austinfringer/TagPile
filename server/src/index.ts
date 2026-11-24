import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type StaticAssets } from './app.ts';
import { isLoopbackHost, loadConfig } from './config.ts';
import { deleteExpiredRefreshTokens } from './db/auth_operations.ts';
import { openDatabase, optimizeDatabase, runMigrations } from './db/index.ts';
import { failInterruptedJobRecords } from './db/job_operations.ts';
import { checkIfFirstTimeSetup, ensureJwtSecret } from './firstTimeSetup.ts';
import { createServices } from './services/index.ts';

declare const __TAGPILE_VERSION__: string | undefined;

interface SeaModule {
  isSea(): boolean;
  getRawAsset(key: string): ArrayBuffer;
  getAssetKeys(): string[];
}

function getSea(): SeaModule | null {
  try {
    const req = createRequire(process.execPath);
    const sea = req('node:sea') as SeaModule;
    return sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

function loadDotEnvIfExists(envPath: string) {
  if (!existsSync(envPath)) return;
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envPath);
      return;
    }
    const content = readFileSync(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // Ignore .env parse errors
  }
}

function openBrowser(url: string) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    // Best-effort browser launch
  }
}

const sea = getSea();
const isSea = sea !== null;
const exeDir = dirname(process.execPath);

if (isSea) {
  loadDotEnvIfExists(join(exeDir, '.env'));
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'production';
  }
  if (!process.env.DATABASE_PATH) {
    process.env.DATABASE_PATH = join(exeDir, 'data', 'tagpile.sqlite');
  }
}

const here = isSea ? exeDir : dirname(fileURLToPath(import.meta.url));
const serverRoot = isSea ? exeDir : resolve(here, '..');
const version =
  typeof __TAGPILE_VERSION__ !== 'undefined'
    ? __TAGPILE_VERSION__
    : (
        JSON.parse(readFileSync(resolve(serverRoot, 'package.json'), 'utf8')) as {
          version: string;
        }
      ).version;

const config = loadConfig();
const db = openDatabase(config.databasePath);
const applied = runMigrations(db);
if (applied.length) console.log(`Applied migrations: ${applied.join(', ')}`);
deleteExpiredRefreshTokens(db);
const interrupted = failInterruptedJobRecords(db);
if (interrupted > 0) console.log(`Marked ${interrupted} interrupted job(s) as failed`);
optimizeDatabase(db, { allTables: true });

// An explicit JWT_SECRET wins; otherwise the secret is generated on first boot and stored
// in the database, so deleting the database invalidates all issued session tokens.
if (!config.jwtSecret) {
  config.jwtSecret = ensureJwtSecret(db);
}

// The preview cache lives in its own database file next to the core db. It holds no
// migrations: the PreviewService creates its table on open.
const previewsDb = openDatabase(
  config.databasePath === ':memory:'
    ? ':memory:'
    : join(dirname(config.databasePath), 'previews.sqlite'),
);

// First time setup
checkIfFirstTimeSetup(db);

if (config.libraryRoots.length === 0) {
  console.warn(
    'LIBRARY_ROOTS is not set. No library can be created or moved until you set it (see README).',
  );
} else {
  console.log(`Library roots: ${config.libraryRoots.join(', ')}`);
  for (const root of config.libraryRoots) {
    if (!existsSync(root)) console.warn(`Library root does not exist: ${root}`);
  }
}

const seaStaticAssets: StaticAssets | undefined = sea
  ? {
      get(key: string) {
        try {
          return Buffer.from(sea.getRawAsset(key));
        } catch {
          return undefined;
        }
      },
    }
  : undefined;

const candidateStaticDir = isSea
  ? resolve(exeDir, 'client')
  : resolve(serverRoot, '../client/dist');

const app = createApp({
  db,
  version,
  staticDir: config.isProduction && existsSync(candidateStaticDir) ? candidateStaticDir : undefined,
  staticAssets: config.isProduction ? seaStaticAssets : undefined,
  config,
  services: createServices(db, previewsDb),
});

// HTTPS when the operator supplies a certificate and key; otherwise plain HTTP, which is
// safe only on loopback or a trusted network.
const scheme = config.tls ? 'https' : 'http';
const server = config.tls
  ? createHttpsServer(
      { cert: readFileSync(config.tls.certFile), key: readFileSync(config.tls.keyFile) },
      app,
    )
  : createHttpServer(app);
if (!config.tls && !isLoopbackHost(config.host)) {
  console.warn(
    `Serving plain HTTP on ${config.host}. Passwords and session cookies cross the network ` +
      'unencrypted. Set TLS_CERT_FILE and TLS_KEY_FILE, or use HOST=127.0.0.1 (see README).',
  );
}

server.listen(config.port, config.host, () => {
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
  const url = `${scheme}://${displayHost}:${config.port}`;
  console.log(`TagPile server listening on ${scheme}://${config.host}:${config.port} (${url})`);
  const shouldOpen =
    process.env.OPEN_BROWSER === '1' ||
    process.env.OPEN_BROWSER === 'true' ||
    process.argv.includes('--open');
  if (shouldOpen) {
    openBrowser(url);
  }
});

function shutdown(signal: string) {
  console.log(`${signal} received, shutting down`);
  server.close(() => {
    optimizeDatabase(db);
    db.close();
    previewsDb.close();
    process.exit(0);
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
