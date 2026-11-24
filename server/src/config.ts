import { delimiter, isAbsolute, resolve } from 'node:path';

export interface TlsFiles {
  certFile: string;
  keyFile: string;
}

export interface Config {
  port: number;
  host: string;
  databasePath: string;
  isProduction: boolean;
  /** Empty when `JWT_SECRET` is not set. The caller must set a secret before `createApp`. */
  jwtSecret: string;
  /** Directories that may hold library roots. When empty, no library can be created or relinked. */
  libraryRoots: string[];
  /** Certificate and key files for built-in HTTPS. Null means plain HTTP. */
  tls: TlsFiles | null;
  /** Adds the `Secure` attribute to session cookies. Defaults to true in HTTPS mode. */
  cookieSecure: boolean;
  /** Value for Express `trust proxy`. False means the server ignores `X-Forwarded-*` headers. */
  trustProxy: boolean | number | string;
}

function parseLibraryRoots(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (!isAbsolute(entry)) {
        throw new Error(`Invalid LIBRARY_ROOTS: "${entry}" is not an absolute path`);
      }
      return resolve(entry);
    });
}

function parseBoolean(name: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new Error(`Invalid ${name}: ${raw} (use true or false)`);
}

function parseTls(env: NodeJS.ProcessEnv): TlsFiles | null {
  const certFile = env.TLS_CERT_FILE || undefined;
  const keyFile = env.TLS_KEY_FILE || undefined;
  if (!certFile && !keyFile) return null;
  if (!certFile || !keyFile) {
    throw new Error('Set both TLS_CERT_FILE and TLS_KEY_FILE, or neither');
  }
  return { certFile, keyFile };
}

/** `TRUST_PROXY` accepts true/false, a hop count, or a list of addresses and subnets in the
 *  format that Express `trust proxy` accepts (for example `loopback` or `10.0.0.0/8`). */
function parseTrustProxy(raw: string | undefined): boolean | number | string {
  if (raw === undefined || raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${env.PORT}`);
  }
  const tls = parseTls(env);

  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    databasePath: env.DATABASE_PATH ?? './data/tagpile.sqlite',
    isProduction: env.NODE_ENV === 'production',
    jwtSecret: env.JWT_SECRET ?? '',
    libraryRoots: parseLibraryRoots(env.LIBRARY_ROOTS),
    tls,
    cookieSecure: parseBoolean('COOKIE_SECURE', env.COOKIE_SECURE) ?? tls !== null,
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
  };
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** True when `host` accepts connections only from this machine. */
export const isLoopbackHost = (host: string) => LOOPBACK_HOSTS.has(host) || /^127\./.test(host);
