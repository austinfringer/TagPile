import type { Express } from 'express';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { createApp } from '../app.ts';
import { loadConfig } from '../config.ts';
import { openDatabase, runMigrations, type Db } from '../db/index.ts';
import { createUser, getUserByUsername } from '../db/auth_operations.ts';
import { createServices, type AppServices } from '../services/index.ts';

export function createTestDb(): Db {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

export function createTestApp(
  db: Db = createTestDb(),
  services: AppServices = createServices(db, openDatabase(':memory:')),
) {
  const config = loadConfig({ JWT_SECRET: 'test-secret' });
  return { db, services, app: createApp({ db, version: 'test', config, services }) };
}

export interface TestUser {
  id: string;
  username: string;
  email: string;
  password: string;
  isAdmin: boolean;
}

const DEFAULT_TEST_USER = {
  username: 'alice',
  email: 'alice@example.com',
  password: 'correct-horse',
  isAdmin: true,
};

/** Inserts a user directly into the db and returns it along with its plaintext password. */
export function createTestUser(db: Db, overrides: Partial<TestUser> = {}): TestUser {
  const { username, email, password, isAdmin } = { ...DEFAULT_TEST_USER, ...overrides };
  createUser(db, username, email, bcrypt.hashSync(password, 10), isAdmin);
  const user = getUserByUsername(db, username);
  if (!user) {
    throw new Error(`Failed to create test user ${username}`);
  }
  return { id: user.id, username, email, password, isAdmin };
}

/** Creates a test user and logs them in, returning the user and a `Cookie` header carrying
 *  the resulting session cookies (`jwt` and `refreshToken`) for use on subsequent requests. */
export async function loginTestUser(
  app: Express,
  db: Db,
  overrides: Partial<TestUser> = {},
): Promise<{ user: TestUser; cookie: string }> {
  const user = createTestUser(db, overrides);

  const res = await request(app)
    .post('/api/auth/login')
    .send({ username: user.username, password: user.password });

  const setCookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  return { user, cookie };
}
