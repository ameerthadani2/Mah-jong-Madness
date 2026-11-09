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
