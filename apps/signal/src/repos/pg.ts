/**
 * Postgres repositories over the schema in migrations/. Every statement is a constant string
 * with $n placeholders; values only ever travel as parameters (test/repos.test.ts fails if
 * these files gain string interpolation). jsonb values are sent as JSON text and cast, because
 * pg would otherwise turn a JavaScript array into a Postgres array literal.
 *
 * Ids that are uuid columns are checked before they reach SQL, so a malformed id from a client
 * reads as "not found" rather than a database error.
 *
 * This file assembles the repositories and runs transactions; each area's repositories live in a
 * module beside it (docs/ARCHITECTURE.md): pgUsers.ts, pgWallet.ts, pgModeration.ts, pgClubs.ts,
 * pgTables.ts and pgPuzzles.ts, with what they share in pgShared.ts.
 */
import type { Pool, Queryable } from '../db';
import type { Repos } from './types';
import type { Tx } from './pgShared';
import { pgDevices, pgIdentities, pgSessions, pgUsers } from './pgUsers';
import { pgStoreEvents, pgWallet } from './pgWallet';
import { pgBlocks, pgModeration, pgReports } from './pgModeration';
import { pgClubs, pgJoinAllowances } from './pgClubs';
import { pgMatchResults, pgQuickMatchPairs, pgTableRatings, pgTableSnapshots } from './pgTables';
import { pgDailyAttempts, pgLeaderboards, pgPuzzleFlags, pgPuzzleRatings, pgPuzzleResults, pgRushRuns } from './pgPuzzles';

export { isUuid } from './pgShared';

function build(q: Queryable, tx: Tx, transaction: Repos['transaction']): Repos {
  return {
    kind: 'pg',
    users: pgUsers(q),
    identities: pgIdentities(q),
    sessions: pgSessions(q),
    devices: pgDevices(q),
    wallet: pgWallet(q, tx),
    storeEvents: pgStoreEvents(q),
    reports: pgReports(q, tx),
    clubs: pgClubs(q, tx),
    tableSnapshots: pgTableSnapshots(q),
    matchResults: pgMatchResults(q),
    puzzleResults: pgPuzzleResults(q),
    puzzleRatings: pgPuzzleRatings(q),
    tableRatings: pgTableRatings(q),
    quickMatchPairs: pgQuickMatchPairs(q),
    joinAllowances: pgJoinAllowances(q),
    rushRuns: pgRushRuns(q),
    dailyAttempts: pgDailyAttempts(q),
    puzzleFlags: pgPuzzleFlags(q),
    leaderboards: pgLeaderboards(q),
    blocks: pgBlocks(q, tx),
    moderation: pgModeration(q),
    transaction,
  };
}

/** Repositories bound to one checked-out client that is already inside BEGIN; nested work joins it. */
function bound(client: Queryable): Repos {
  const repos: Repos = build(client, (fn) => fn(client), (fn) => fn(repos));
  return repos;
}

async function inTransaction<T>(pool: Pool, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  // A client whose ROLLBACK failed (for example after a query timeout left it busy) must not go
  // back into the pool: release(err) destroys it.
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client as unknown as Queryable);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch((r: Error) => (broken = r));
    throw e;
  } finally {
    client.release(broken);
  }
}

export function createPgRepos(pool: Pool): Repos {
  const tx: Tx = (fn) => inTransaction(pool, fn);
  return build(pool as unknown as Queryable, tx, (fn) => inTransaction(pool, (client) => fn(bound(client))));
}
