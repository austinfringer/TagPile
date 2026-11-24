import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';

export const TEST_USER = {
  username: 'e2e-user',
  email: 'e2e-user@example.com',
  password: 'correct-horse-battery-staple',
};

/** Seeds a single test user directly into the SQLite file the e2e server instance uses.
 *  There's no public signup endpoint (accounts are invite-only), so this mirrors what the
 *  server's own `createTestUser` test helper does, just against the running e2e database. */
export default function globalSetup() {
  const databasePath = process.env.E2E_DATABASE_PATH;
  if (!databasePath) {
    throw new Error('E2E_DATABASE_PATH is not set; playwright.config.ts should set it.');
  }

  const db = new Database(databasePath);
  try {
    db.prepare(
      'INSERT INTO users (id, username, email, password_hash, is_admin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      crypto.randomUUID(),
      TEST_USER.username,
      TEST_USER.email,
      bcrypt.hashSync(TEST_USER.password, 10),
      1,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  } finally {
    db.close();
  }
}
