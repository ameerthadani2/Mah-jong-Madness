/**
 * Postgres connection pool. The app uses the pooled (PgBouncer) connection string with a small
 * pool; migrations use the direct string (see main.ts). TLS is on for every host except a local one.
 *
 * A database that hangs (a frozen compute, a network black hole) must not hang the server: every
 * query gives up after `DB_QUERY_TIMEOUT_MS` on the client side (the connection is then dropped
 * from the pool), and on a direct connection the server cancels a statement after the same time
 * (`statement_timeout`; PgBouncer-style poolers refuse that startup parameter, so it is left off
 * there). `ping()` answers within `DB_PING_TIMEOUT_MS` whatever the database does.
 */
import pg from 'pg';

export type Pool = pg.Pool;

/** Anything that can run one parameterised statement: a Pool or a checked-out PoolClient. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

/** Client-side limit on every query (default for `PoolOptions.queryTimeoutMs`). */
export const DB_QUERY_TIMEOUT_MS = 5_000;
/** How long `ping()` waits before calling the database down. */
export const DB_PING_TIMEOUT_MS = 2_000;

export interface PoolOptions {
  /** Maximum connections (default 5; Neon's pooler multiplexes beyond that). */
  max?: number;
  /** Client-side query timeout in ms (default `DB_QUERY_TIMEOUT_MS`; 0 turns it off, for migrations). */
  queryTimeoutMs?: number;
  /**
   * Server-side `statement_timeout` in ms. Default: `queryTimeoutMs` on a direct connection, off
   * through a pooler (see `isPooledDatabase`); 0 turns it off.
   */
  statementTimeoutMs?: number;
  /** Extra startup options, e.g. `-c search_path=test_schema` for isolated tests. */
  options?: string;
  /** Force TLS on or off; by default it is on unless the host is local. */
  ssl?: boolean;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

/** True when the URL points at this machine (or a Unix socket), where TLS is neither available nor needed. */
export function isLocalDatabase(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    const host = url.hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.startsWith('/') || (url.searchParams.get('host') ?? '').startsWith('/');
  } catch {
    return false;
  }
}

/**
 * True when the URL goes through a transaction pooler (Neon's `-pooler` host, or PgBouncer's usual
 * port 6432), which neither keeps session state such as advisory locks nor accepts startup
 * parameters such as `statement_timeout`.
 */
export function isPooledDatabase(databaseUrl: string): boolean {
  try {
    const url = new URL(databaseUrl);
    return url.hostname.toLowerCase().includes('-pooler') || url.port === '6432';
  } catch {
    return false;
  }
}

/** The pg settings `createPool` uses (exported for tests). */
export function poolConfig(databaseUrl: string, opts: PoolOptions = {}): pg.PoolConfig {
  const ssl = opts.ssl ?? !isLocalDatabase(databaseUrl);
  const queryTimeout = opts.queryTimeoutMs ?? DB_QUERY_TIMEOUT_MS;
  const statementTimeout = opts.statementTimeoutMs ?? (isPooledDatabase(databaseUrl) ? 0 : queryTimeout);
  return {
    connectionString: databaseUrl,
    max: opts.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...(queryTimeout > 0 ? { query_timeout: queryTimeout } : {}),
    ...(statementTimeout > 0 ? { statement_timeout: statementTimeout } : {}),
    ssl: ssl ? { rejectUnauthorized: true } : false,
    ...(opts.options ? { options: opts.options } : {}),
  };
}

export function createPool(databaseUrl: string, opts: PoolOptions = {}): Pool {
  const pool = new pg.Pool(poolConfig(databaseUrl, opts));
  // An idle client that loses its connection must not crash the process; the pool replaces it.
  pool.on('error', (e) => console.error('[signal] database pool error', e.message));
  return pool;
}

/** One round trip; resolves true when the database answers within `timeoutMs`, false otherwise (never hangs). */
export async function ping(pool: Queryable, timeoutMs = DB_PING_TIMEOUT_MS): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  const answer = pool.query<{ ok: number }>('SELECT 1 AS ok').then(
    (res) => res.rows[0]?.ok === 1,
    () => false,
  );
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Advisory lock key held by the one process allowed to host tables on a database ("MJM" then 1). */
export const HOST_LOCK_KEY = 0x4d4a4d01;

/**
 * The single-host lease: only one server process at a time may restore and host the tables of a
 * database, because each process keeps its tables in memory and two copies of a table would deal
 * two different games under one code and overwrite each other's snapshots.
 */
export interface HostLock {
  /** Take the lock, retrying until it is free or the wait runs out (then it rejects). */
  acquire(): Promise<void>;
  /**
   * Called once if the lock is lost after it was taken (its connection failed or stopped
   * answering). The loss is remembered: a handler registered after it happened is called too
   * (on the next microtask), so a loss during boot is never missed.
   */
  onLost(cb: (e: Error) => void): void;
  /** Give the lock up (ends its connection). */
  release(): Promise<void>;
}

export interface HostLockOptions {
  /** Advisory lock key (default `HOST_LOCK_KEY`; tests use their own). */
  key?: number;
  /** Pause between attempts while another process holds the lock (default 1 s). */
  retryMs?: number;
  /** Give up after this long (default 30 s). */
  waitMs?: number;
  /** How often the held lock's connection is checked (default 15 s); a check that fails or takes over 10 s loses the lock. */
  checkEveryMs?: number;
  log?: (line: string) => void;
}

/**
 * A session-level `pg_try_advisory_lock` on a dedicated connection. The URL must be a direct
 * connection: a transaction pooler hands each statement to any server connection, so a session
 * lock taken through it is neither kept nor released reliably (`main.ts` prefers
 * `DATABASE_URL_DIRECT` for this reason).
 */
export function createHostLock(databaseUrl: string, opts: HostLockOptions = {}): HostLock {
  const key = opts.key ?? HOST_LOCK_KEY;
  const retryMs = opts.retryMs ?? 1_000;
  const waitMs = opts.waitMs ?? 30_000;
  const checkEveryMs = opts.checkEveryMs ?? 15_000;
  const log = opts.log ?? ((line: string) => console.log(line));
  const base = poolConfig(databaseUrl, { queryTimeoutMs: 10_000, statementTimeoutMs: 0 });
  const lostHandlers: Array<(e: Error) => void> = [];
  let client: pg.Client | null = null;
  let check: ReturnType<typeof setInterval> | null = null;
  let held = false;
  let released = false;
  /** Why the lock was lost, from the moment it happens: handlers registered later are told as well. */
  let lostWith: Error | null = null;

  const lose = (e: Error) => {
    if (!held || released || lostWith) return;
    lostWith = e;
    held = false;
    if (check) clearInterval(check);
    for (const h of lostHandlers) h(e);
  };
  const drop = async (c: pg.Client | null) => {
    if (!c) return;
    c.removeAllListeners('error');
    c.removeAllListeners('end');
    c.on('error', () => undefined);
    await c.end().catch(() => undefined);
  };

  return {
    async acquire() {
      const until = Date.now() + waitMs;
      let said = false;
      for (;;) {
        try {
          if (!client) {
            const c = new pg.Client({ connectionString: base.connectionString, ssl: base.ssl, query_timeout: base.query_timeout, connectionTimeoutMillis: 5_000, keepAlive: true });
            c.on('error', (e: Error) => lose(e));
            await c.connect();
            client = c;
            c.on('end', () => lose(new Error('The host lock connection ended')));
          }
          const res = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [key]);
          if (res.rows[0]?.ok === true) {
            held = true;
            check = setInterval(() => {
              client?.query('SELECT 1').catch((e: Error) => lose(e));
            }, checkEveryMs);
            check.unref?.();
            return;
          }
          if (!said) log('[signal] another server holds the host lock on this database; waiting for it to stop');
          said = true;
        } catch (e) {
          const c = client;
          client = null;
          await drop(c);
          if (Date.now() >= until) throw new Error(`Could not reach the database for the host lock: ${(e as Error).message}`);
        }
        if (Date.now() >= until) {
          const c = client;
          client = null;
          await drop(c);
          throw new Error(`Another server still holds the host lock after ${Math.round(waitMs / 1000)} s: only one server may host tables on a database`);
        }
        await new Promise((r) => setTimeout(r, retryMs));
      }
    },
    onLost(cb) {
      lostHandlers.push(cb);
      const e = lostWith;
      if (e) queueMicrotask(() => cb(e));
    },
    async release() {
      released = true;
      held = false;
      if (check) clearInterval(check);
      const c = client;
      client = null;
      await drop(c);
    },
  };
}
