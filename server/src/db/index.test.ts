import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, optimizeDatabase, runMigrations, type Db } from './index.ts';
import { migrations } from './migrations.ts';

describe('optimizeDatabase', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('writes planner statistics for tables that have none', () => {
    db = openDatabase(':memory:');
    db.exec('CREATE TABLE t (a INTEGER, b INTEGER); CREATE INDEX idx_t_a ON t (a);');
    const insert = db.prepare('INSERT INTO t (a, b) VALUES (?, ?)');
    for (let i = 0; i < 200; i++) insert.run(i % 10, i);
    optimizeDatabase(db, { allTables: true });
    const stats = db.prepare(`SELECT idx FROM sqlite_stat1 WHERE tbl = 't'`).all();
    expect(stats).toEqual([{ idx: 'idx_t_a' }]);
  });

  it('has an index that finds the values of one tag on one file', () => {
    db = openDatabase(':memory:');
    runMigrations(db);
    const plan = db
      .prepare('EXPLAIN QUERY PLAN SELECT 1 FROM file_tag_values WHERE file_id = ? AND tag_id = ?')
      .all(1, 1) as { detail: string }[];
    expect(plan[0]!.detail).toContain('idx_ftv_file_tag (file_id=? AND tag_id=?)');
  });
});

describe('runMigrations', () => {
  let db: Db;
  afterEach(() => db?.close());

  it('applies all migrations on a fresh database', () => {
    db = openDatabase(':memory:');
    expect(runMigrations(db)).toEqual(migrations.map((m) => m.name));
  });

  it('is idempotent', () => {
    db = openDatabase(':memory:');
    runMigrations(db);
    expect(runMigrations(db)).toEqual([]);
  });

  it('only applies migrations that are not yet recorded', () => {
    db = openDatabase(':memory:');
    runMigrations(db, [{ name: 'a', sql: 'CREATE TABLE a (id INTEGER)' }]);
    const applied = runMigrations(db, [
      { name: 'a', sql: 'CREATE TABLE a (id INTEGER)' },
      { name: 'b', sql: 'CREATE TABLE b (id INTEGER)' },
    ]);
    expect(applied).toEqual(['b']);
  });

  it('rolls back a failing migration without recording it', () => {
    db = openDatabase(':memory:');
    expect(() => runMigrations(db, [{ name: 'bad', sql: 'THIS IS NOT SQL' }])).toThrow();
    const rows = db.prepare('SELECT name FROM _migrations').all();
    expect(rows).toEqual([]);
  });
});
