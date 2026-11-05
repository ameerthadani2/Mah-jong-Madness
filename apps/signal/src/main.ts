/**
 * Process entry point (and the esbuild bundle's entry): reads the environment, builds the
 * repositories, the session service and the sign-in providers, and starts the server.
 *
 *   node dist/server.cjs            start the server (MIGRATE_ON_BOOT=1 migrates first)
 *   node dist/server.cjs migrate    apply pending migrations and exit
 *
 * Everything is optional. Without DATABASE_URL the server keeps its state in memory (lost on
 * restart); without AUTH_PEPPER it uses a random pepper for this process (sessions end on
 * restart); without provider ids only guest accounts exist. Each case logs a warning.
 * Migrations prefer DATABASE_URL_DIRECT (Neon's direct, unpooled string) over DATABASE_URL.
 */
import { SessionService } from './auth';
import { loadConfig, pepperFromEnv, providersFromEnv } from './config';
import { createPool } from './db';
import { migrate } from './migrate';
import { createRepos } from './repos';
import { createSignalServer } from './server';

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
  const env = process.env;
  if (flag(env.MIGRATE_ON_BOOT)) await runMigrations();
  const warn = (line: string) => console.warn(line);
  const config = loadConfig(env);
  if (config.dataDir) warn(`[signal] DATA_DIR (${config.dataDir}) is no longer used: clubs and tables are stored through the repositories`);
  const repos = createRepos({ databaseUrl: env.DATABASE_URL });
  if (repos.kind === 'memory') warn('[signal] DATABASE_URL is not set: accounts, clubs and tables are kept in memory and lost on restart');
  const sessions = new SessionService(repos.repos, pepperFromEnv(env, warn));
  const providers = providersFromEnv(env);
  const server = await createSignalServer({ port: config.port, repos, sessions, providers, config });

  const enabled = Object.keys(providers);
  console.log(
    `[signal] listening on :${server.address().port} (storage ${repos.kind}, sign-in ${['guest', ...enabled].join(' ')}, hosted tables ${config.hostTables ? `enabled, up to ${config.maxHostedTables}` : 'disabled'}, relay-only rooms ${config.p2pRooms ? 'enabled' : 'disabled'}, CORS ${config.corsOrigins.length ? config.corsOrigins.join(' ') : 'same origin only'})`,
  );

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[signal] ${signal}: saving tables and shutting down`);
    server
      .close()
      .then(() => repos.close())
      .then(
        () => process.exit(0),
        (e: Error) => {
          console.error('[signal] shutdown error', e.message);
          process.exit(1);
        },
      );
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((e: Error) => {
  console.error('[signal] fatal', e.message);
  process.exit(1);
});
