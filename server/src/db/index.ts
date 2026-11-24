import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations, type Migration } from './migrations.ts';

export type Db = Database.Database;

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** Refreshes the query planner statistics (`PRAGMA optimize`). Without statistics SQLite can
 *  pick a slow index for search. `allTables` also checks tables that this connection has not
 *  read yet; use it one time after the database opens. */
export function optimizeDatabase(db: Db, { allTables = false } = {}): void {
  db.pragma(allTables ? 'optimize = 0x10002' : 'optimize');
}

export function runMigrations(db: Db, list: Migration[] = migrations): string[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  const applied = new Set(
    db
      .prepare<[], { name: string }>('SELECT name FROM _migrations')
      .all()
      .map((r) => r.name),
  );
  const insert = db.prepare('INSERT INTO _migrations (name) VALUES (?)');
  const newlyApplied: string[] = [];

  const apply = db.transaction((m: Migration) => {
    db.exec(m.sql);
    insert.run(m.name);
  });

  for (const m of list) {
    if (applied.has(m.name)) continue;
    apply(m);
    newlyApplied.push(m.name);
  }

  return newlyApplied;
}
