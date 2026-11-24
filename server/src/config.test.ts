import { delimiter, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('falls back to defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 3000,
      host: '0.0.0.0',
      databasePath: './data/tagpile.sqlite',
      isProduction: false,
      jwtSecret: '',
      libraryRoots: [],
      tls: null,
      cookieSecure: false,
      trustProxy: false,
    });
  });

  it('enables secure cookies in HTTPS mode', () => {
    const cfg = loadConfig({
      TLS_CERT_FILE: '/etc/tls/cert.pem',
      TLS_KEY_FILE: '/etc/tls/key.pem',
    });
    expect(cfg.tls).toEqual({ certFile: '/etc/tls/cert.pem', keyFile: '/etc/tls/key.pem' });
    expect(cfg.cookieSecure).toBe(true);
  });

  it('lets COOKIE_SECURE override the default', () => {
    expect(loadConfig({ COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(
      loadConfig({ TLS_CERT_FILE: 'c', TLS_KEY_FILE: 'k', COOKIE_SECURE: '0' }).cookieSecure,
    ).toBe(false);
    expect(() => loadConfig({ COOKIE_SECURE: 'yes' })).toThrow(/Invalid COOKIE_SECURE/);
  });

  it('rejects only one of the two TLS files', () => {
    expect(() => loadConfig({ TLS_CERT_FILE: '/etc/tls/cert.pem' })).toThrow(/TLS_KEY_FILE/);
    expect(() => loadConfig({ TLS_KEY_FILE: '/etc/tls/key.pem' })).toThrow(/TLS_CERT_FILE/);
  });

  it('parses TRUST_PROXY', () => {
    expect(loadConfig({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ TRUST_PROXY: 'loopback, 10.0.0.0/8' }).trustProxy).toBe(
      'loopback, 10.0.0.0/8',
    );
  });

  it('reads values from the environment', () => {
    const cfg = loadConfig({
      PORT: '8080',
      HOST: '127.0.0.1',
      DATABASE_PATH: ':memory:',
      NODE_ENV: 'production',
      JWT_SECRET: 'super-secret',
      LIBRARY_ROOTS: [resolve('/srv/media'), ` ${resolve('/mnt/photos')}${sep} `, ''].join(
        delimiter,
      ),
    });
    expect(cfg).toEqual({
      port: 8080,
      host: '127.0.0.1',
      databasePath: ':memory:',
      isProduction: true,
      jwtSecret: 'super-secret',
      libraryRoots: [resolve('/srv/media'), resolve('/mnt/photos')],
      tls: null,
      cookieSecure: false,
      trustProxy: false,
    });
  });

  it('rejects a relative library root', () => {
    expect(() => loadConfig({ LIBRARY_ROOTS: 'media' })).toThrow(/Invalid LIBRARY_ROOTS/);
  });

  it('rejects an invalid port', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(/Invalid PORT/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/Invalid PORT/);
  });
});
