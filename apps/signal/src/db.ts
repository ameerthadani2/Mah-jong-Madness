/**
 * Postgres connection pool. The app uses the pooled (PgBouncer) connection string with a small
 * pool; migrations use the direct string (see main.ts). TLS is on for every host except a local one.
 */
import pg from 'pg';

export type Pool = pg.Pool;

/** Anything that can run one parameterised statement: a Pool or a checked-out PoolClient. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
}

export interface PoolOptions {
  /** Maximum connections (default 5; Neon's pooler multiplexes beyond that). */
  max?: number;
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

export function createPool(databaseUrl: string, opts: PoolOptions = {}): Pool {
  const ssl = opts.ssl ?? !isLocalDatabase(databaseUrl);
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: opts.max ?? 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: ssl ? { rejectUnauthorized: true } : false,
    ...(opts.options ? { options: opts.options } : {}),
  });
  // An idle client that loses its connection must not crash the process; the pool replaces it.
  pool.on('error', (e) => console.error('[signal] database pool error', e.message));
  return pool;
}

/** One round trip; resolves true when the database answers. */
export async function ping(pool: Queryable): Promise<boolean> {
  try {
    const res = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    return res.rows[0]?.ok === 1;
  } catch {
    return false;
  }
}
