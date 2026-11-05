/**
 * Schema migrations: every `migrations/NNNN_name.sql` file is applied once, in filename order,
 * each inside its own transaction, and recorded in `schema_migrations`. Running it again applies
 * nothing. A transaction-scoped advisory lock makes two machines booting at once take turns,
 * and works through a transaction-mode connection pooler too.
 *
 * Run with `npm run migrate -w @mjm/signal` (or `node dist/server.cjs migrate` in the image),
 * or call `migrate(pool)` from code.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from './db';

export interface MigrationFile {
  /** File name without `.sql`, e.g. `0001_init`; stored in `schema_migrations.version`. */
  version: string;
  path: string;
}

export interface MigrateOptions {
  /** Directory holding the `.sql` files (default: `migrations/` next to `src/` or `dist/`). */
  dir?: string;
  log?: (line: string) => void;
}

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
/** Arbitrary constant shared by every process that migrates this database. */
const LOCK_KEY = 727_001;

/**
 * Where the migrations live. `MIGRATIONS_DIR` wins; otherwise `../migrations` relative to this
 * module, which is `apps/signal/migrations` from `src/` under tsx and from `dist/` in the bundle
 * (the build defines `import.meta.url` for the CommonJS output).
 */
export function defaultMigrationsDir(): string {
  const fromEnv = process.env.MIGRATIONS_DIR?.trim();
  if (fromEnv) return fromEnv;
  const candidates = [fileURLToPath(new URL('../migrations', import.meta.url)), join(process.cwd(), 'migrations'), join(process.cwd(), 'apps/signal/migrations')];
  return candidates.find((dir) => existsSync(dir)) ?? candidates[0];
}

/** The migration files in the order they must be applied. Other files in the directory are ignored. */
export function listMigrations(dir: string = defaultMigrationsDir()): MigrationFile[] {
  return readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((name) => ({ version: name.slice(0, -'.sql'.length), path: join(dir, name) }));
}

/** Applies every pending migration and returns the versions applied by this call. */
export async function migrate(pool: Pool, opts: MigrateOptions = {}): Promise<string[]> {
  const log = opts.log ?? (() => {});
  const files = listMigrations(opts.dir);
  const applied: string[] = [];
  for (const file of files) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      // Under the lock, because two concurrent CREATE ... IF NOT EXISTS can still collide.
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file.version]);
      if (done.rowCount) {
        await client.query('COMMIT');
        continue;
      }
      log(`[migrate] applying ${file.version}`);
      // No parameters, so pg uses the simple protocol and the file may hold many statements.
      await client.query(readFileSync(file.path, 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file.version]);
      await client.query('COMMIT');
      applied.push(file.version);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${file.version} failed: ${(e as Error).message}`);
    } finally {
      client.release();
    }
  }
  log(applied.length ? `[migrate] applied ${applied.length} migration(s)` : '[migrate] database is up to date');
  return applied;
}

/** Versions already recorded, oldest first. */
export async function appliedMigrations(pool: Pool): Promise<string[]> {
  const res = await pool.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
  return res.rows.map((r) => r.version);
}
