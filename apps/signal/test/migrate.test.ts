/**
 * Migration runner. File ordering and the schema's coverage are checked everywhere; applying
 * to a real database runs only with DATABASE_URL_TEST (see repos.test.ts).
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createPool, type Pool } from '../src/db';
import { appliedMigrations, defaultMigrationsDir, listMigrations, migrate } from '../src/migrate';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();

/**
 * The shipped migrations and the tables they create, read from the migrations folder itself, so
 * adding a migration never needs a list edited here (several branches adding one at the same time
 * used to collide on these lists).
 */
const SHIPPED_DIR = defaultMigrationsDir();
const SHIPPED_VERSIONS = readdirSync(SHIPPED_DIR)
  .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
  .sort()
  .map((name) => name.replace(/\.sql$/, ''));
const SHIPPED_TABLES = [
  ...new Set(
    SHIPPED_VERSIONS.flatMap((v) => [...readFileSync(join(SHIPPED_DIR, v + '.sql'), 'utf8').matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+) \(/gm)].map((m) => m[1])),
  ),
].sort();

/** Tables the server cannot run without: a migration that lost one of them is a mistake. */
const CORE_TABLES = ['users', 'auth_identities', 'sessions', 'devices', 'wallets', 'wallet_ledger', 'purchases', 'entitlements', 'clubs', 'club_members', 'club_tables', 'match_results', 'table_snapshots', 'schema_migrations', 'store_events', 'reports'];

describe('migration files', () => {
  it('lists NNNN_name.sql files in filename order and ignores anything else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mjm-migrations-'));
    try {
      for (const name of ['0002_second.sql', '0010_tenth.sql', '0001_first.sql', 'README.md', '0003-bad-name.sql', 'notes.sql']) writeFileSync(join(dir, name), '-- x');
      expect(listMigrations(dir).map((m) => m.version)).toEqual(['0001_first', '0002_second', '0010_tenth']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('finds every shipped migration by default: numbered from 0001 with no gap and no number used twice', () => {
    const files = listMigrations(SHIPPED_DIR);
    expect(files.map((f) => f.version)).toEqual(SHIPPED_VERSIONS);
    expect(SHIPPED_VERSIONS[0]).toBe('0001_init');
    // Two migrations with the same number would run in an order nobody chose; a gap means a file is missing.
    expect(SHIPPED_VERSIONS.map((v) => Number(v.slice(0, 4)))).toEqual(SHIPPED_VERSIONS.map((_, i) => i + 1));
  });

  it('together the shipped migrations create every table the server needs', () => {
    expect(SHIPPED_TABLES).toEqual(expect.arrayContaining(CORE_TABLES));
  });

  it('0002 adds the season columns and copies lifetime points into the current season', () => {
    const sql = readFileSync(listMigrations(defaultMigrationsDir())[1].path, 'utf8');
    expect(sql).toMatch(/ALTER TABLE clubs ADD COLUMN season_history jsonb/);
    expect(sql).toMatch(/ALTER TABLE clubs ADD COLUMN season_started_at timestamptz/);
    expect(sql).toMatch(/UPDATE club_members SET season_points = lifetime_points/);
  });

  it('0003 exposes the creator written inside each table snapshot as a generated column', () => {
    const sql = readFileSync(listMigrations(defaultMigrationsDir())[2].path, 'utf8');
    expect(sql).toMatch(/ADD COLUMN created_by text GENERATED ALWAYS AS \(snapshot ->> 'createdBy'\) STORED/);
  });
});

describe.skipIf(!PG_URL)('migrate() against Postgres', () => {
  let admin: Pool;
  const schemas: string[] = [];

  beforeAll(() => {
    admin = createPool(PG_URL!, { max: 1 });
  });
  afterAll(async () => {
    for (const s of schemas) await admin.query('DROP SCHEMA IF EXISTS ' + s + ' CASCADE');
    await admin.end();
  });

  async function freshPool(): Promise<Pool> {
    const schema = 'mjm_migrate_' + randomHex(6);
    schemas.push(schema);
    await admin.query('CREATE SCHEMA ' + schema);
    return createPool(PG_URL!, { options: '-c search_path=' + schema });
  }

  it('applies the shipped migrations to a fresh database once, then nothing', async () => {
    const pool = await freshPool();
    try {
      const lines: string[] = [];
      expect(await migrate(pool, { log: (l) => lines.push(l) })).toEqual(SHIPPED_VERSIONS);
      expect(await appliedMigrations(pool)).toEqual(SHIPPED_VERSIONS);
      const tables = await pool.query<{ table_name: string }>('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()');
      expect(tables.rows.map((r) => r.table_name).sort()).toEqual(SHIPPED_TABLES);
      expect(await migrate(pool)).toEqual([]);
      expect(lines.some((l) => l.includes('applying 0001_init'))).toBe(true);
    } finally {
      await pool.end();
    }
  });

  it('rolls a failing migration back completely and does not record it', async () => {
    const pool = await freshPool();
    const dir = mkdtempSync(join(tmpdir(), 'mjm-migrations-'));
    try {
      writeFileSync(join(dir, '0001_ok.sql'), 'CREATE TABLE a (id int);');
      writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int); SELECT * FROM no_such_table;');
      await expect(migrate(pool, { dir })).rejects.toThrow(/0002_bad/);
      expect(await appliedMigrations(pool)).toEqual(['0001_ok']);
      const b = await pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'b'");
      expect(b.rowCount).toBe(0);
      // Fixing the file lets the next run continue where it stopped.
      writeFileSync(join(dir, '0002_bad.sql'), 'CREATE TABLE b (id int);');
      expect(await migrate(pool, { dir })).toEqual(['0002_bad']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await pool.end();
    }
  });

  it('lets two runners race safely', async () => {
    const pool = await freshPool();
    try {
      const [a, b] = await Promise.all([migrate(pool), migrate(pool)]);
      expect([...a, ...b].sort()).toEqual(SHIPPED_VERSIONS);
    } finally {
      await pool.end();
    }
  });
});
