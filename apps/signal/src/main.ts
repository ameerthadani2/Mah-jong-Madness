/**
 * Process entry point (and the esbuild bundle's entry). For now it runs migrations when asked
 * and then starts the existing server module; it will later read the environment and call
 * createSignalServer with the repositories and auth services.
 *
 *   node dist/server.cjs            start the server (MIGRATE_ON_BOOT=1 migrates first)
 *   node dist/server.cjs migrate    apply pending migrations and exit
 *
 * Migrations prefer DATABASE_URL_DIRECT (Neon's direct, unpooled string) over DATABASE_URL.
 */
import { createPool } from './db';
import { migrate } from './migrate';

const flag = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((v ?? '').trim().toLowerCase());

async function runMigrations(): Promise<boolean> {
  const url = (process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.log('[migrate] DATABASE_URL is not set; nothing to migrate (the server uses in-memory storage)');
    return false;
  }
  const pool = createPool(url, { max: 1 });
  try {
    await migrate(pool, { log: (line) => console.log(line) });
    return true;
  } finally {
    await pool.end();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'migrate') {
    await runMigrations();
    return;
  }
  if (flag(process.env.MIGRATE_ON_BOOT)) await runMigrations();
  await import('./server');
}

main().catch((e: Error) => {
  console.error('[signal] fatal', e.message);
  process.exit(1);
});
