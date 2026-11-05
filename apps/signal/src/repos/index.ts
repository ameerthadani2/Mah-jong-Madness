/**
 * Picks the repository implementation: Postgres when a database URL is configured, memory
 * otherwise (development, tests, or a server that has not been given a database yet).
 */
import { createPool, ping, type Pool } from '../db';
import { createMemoryRepos } from './memory';
import { createPgRepos } from './pg';
import type { Repos } from './types';

export * from './types';
export { createMemoryRepos } from './memory';
export { createPgRepos, isUuid } from './pg';

export interface RepoConfig {
  /** Pooled connection string (`DATABASE_URL`). Absent or blank selects the memory repositories. */
  databaseUrl?: string | null;
  /** Use this pool instead of creating one (tests). */
  pool?: Pool;
}

export interface RepoHandle {
  repos: Repos;
  kind: Repos['kind'];
  /** The Postgres pool, or null for memory. */
  pool: Pool | null;
  /** True when the store answers (always true for memory). */
  healthy(): Promise<boolean>;
  close(): Promise<void>;
}

export function createRepos(config: RepoConfig = {}): RepoHandle {
  const url = config.databaseUrl?.trim();
  const pool = config.pool ?? (url ? createPool(url) : null);
  if (!pool) {
    return { repos: createMemoryRepos(), kind: 'memory', pool: null, healthy: async () => true, close: async () => {} };
  }
  const ownsPool = !config.pool;
  return {
    repos: createPgRepos(pool),
    kind: 'pg',
    pool,
    healthy: () => ping(pool),
    close: async () => {
      if (ownsPool) await pool.end();
    },
  };
}
