import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkIfFirstTimeSetup, ensureJwtSecret } from './firstTimeSetup.ts';
import { simpleTokenHash } from './helpers.ts';
import { createTestDb, createTestUser } from './test/helpers.ts';

describe('checkIfFirstTimeSetup', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const pendingSetupCodes = (db: ReturnType<typeof createTestDb>) =>
    db
      .prepare(
        'SELECT code_hash FROM invitations WHERE issuer_id IS NULL AND used = 0 AND revoked = 0',
      )
      .all() as { code_hash: string }[];

  it('creates one admin invitation and returns its code when there are no users', () => {
    const db = createTestDb();
    const code = checkIfFirstTimeSetup(db);
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(pendingSetupCodes(db)).toEqual([{ code_hash: simpleTokenHash(code!) }]);
  });

  it('revokes the code from an earlier start, so only the newest code is valid', () => {
    const db = createTestDb();
    const first = checkIfFirstTimeSetup(db);
    const second = checkIfFirstTimeSetup(db);
    expect(second).not.toBe(first);
    expect(pendingSetupCodes(db)).toEqual([{ code_hash: simpleTokenHash(second!) }]);
  });

  it('does nothing when a user exists', () => {
    const db = createTestDb();
    createTestUser(db);
    expect(checkIfFirstTimeSetup(db)).toBeNull();
    expect(pendingSetupCodes(db)).toEqual([]);
  });
});

describe('ensureJwtSecret', () => {
  it('generates and persists a secret on first call', () => {
    const db = createTestDb();
    const secret = ensureJwtSecret(db);
    expect(secret).toMatch(/^[0-9a-f]{96}$/);
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('jwt_secret') as {
      value: string;
    };
    expect(row.value).toBe(secret);
  });

  it('returns the stored secret on subsequent calls', () => {
    const db = createTestDb();
    const first = ensureJwtSecret(db);
    expect(ensureJwtSecret(db)).toBe(first);
  });

  it('generates a different secret for a fresh database', () => {
    const first = ensureJwtSecret(createTestDb());
    const second = ensureJwtSecret(createTestDb());
    expect(second).not.toBe(first);
  });
});
