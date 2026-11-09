/**
 * Migration runner. File ordering and the schema's coverage are checked everywhere; applying
 * to a real database runs only with DATABASE_URL_TEST (see repos.test.ts).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createPool, type Pool } from '../src/db';
import { appliedMigrations, defaultMigrationsDir, listMigrations, migrate } from '../src/migrate';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();

const PLANNED_TABLES = [
  'users',
  'auth_identities',
  'sessions',
  'devices',
  'wallets',
  'wallet_ledger',
  'purchases',
  'entitlements',
  'clubs',
  'club_members',
  'club_tables',
  'match_results',
  'table_snapshots',
  'puzzle_results',
  'schema_migrations',
  'store_events',
  'reports',
];

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

  it('finds the shipped migrations by default, and together they create every planned table', () => {
    const files = listMigrations(defaultMigrationsDir());
    expect(files.map((f) => f.version)).toEqual(['0001_init', '0002_store_reports_seasons', '0003_server_hardening', '0004_store_plans_consent']);
    const sql = files.map((f) => readFileSync(f.path, 'utf8')).join('\n');
    for (const table of PLANNED_TABLES) expect(sql).toMatch(new RegExp('CREATE TABLE (IF NOT EXISTS )?' + table + ' \\('));
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
      expect(await migrate(pool, { log: (l) => lines.push(l) })).toEqual(['0001_init', '0002_store_reports_seasons', '0003_server_hardening', '0004_store_plans_consent']);
      expect(await appliedMigrations(pool)).toEqual(['0001_init', '0002_store_reports_seasons', '0003_server_hardening', '0004_store_plans_consent']);
      const tables = await pool.query<{ table_name: string }>('SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()');
      expect(tables.rows.map((r) => r.table_name).sort()).toEqual([...PLANNED_TABLES].sort());
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
      expect([...a, ...b].sort()).toEqual(['0001_init', '0002_store_reports_seasons', '0003_server_hardening', '0004_store_plans_consent']);
    } finally {
      await pool.end();
    }
  });
});
