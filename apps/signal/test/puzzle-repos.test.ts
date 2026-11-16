/**
 * The puzzle repositories (migration 0010) against memory and (with DATABASE_URL_TEST) Postgres:
 * one ranked daily result per date key, the rating row and how a merge keeps the better-supported
 * one, Rush runs finished once and pruned when they expire, the leaderboards' order, ties, scope
 * and visibility, and what the 30-day purge takes.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, type BoardQuery, type Repos } from '../src/repos';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const T0 = Date.UTC(2026, 10, 16, 8, 0, 0);
const DAY = 86_400_000;

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    const user = async (displayName = 'Player') => (await repos().users.create({ id: randomUUID(), kind: 'guest', displayName, createdAt: T0 })).id;
    const q = (viewerId: string, extra: Partial<BoardQuery> = {}): BoardQuery => ({ viewerId, userIds: null, limit: 100, ...extra });
    const daily = (userId: string, key: string, correct: boolean, seconds: number, at = T0) =>
      repos().puzzleResults.recordDaily({ userId, puzzleKey: key, correct, seconds, ratingAfter: 1000, createdAt: at });

    it('keeps one daily result per account and date key, and a merge leaves a clashing one behind', async () => {
      const r = repos();
      const [a, b] = [await user(), await user()];
      const key = 'k-' + randomHex(4);
      expect(await daily(a, key, true, 30)).toMatchObject({ kind: 'daily', puzzleKey: key, correct: true, seconds: 30 });
      expect(await daily(a, key, false, 5)).toBeNull();
      expect(await daily(a, key + 'x', false, 5)).not.toBeNull();
      expect(await daily(b, key, false, 9)).not.toBeNull();
      await r.puzzleResults.record({ userId: a, kind: 'rush', puzzleKey: 'run:0', correct: true, seconds: 0, ratingAfter: 1016, createdAt: T0 });
      // b already has `key`: a's result for it stays with a; the others move.
      expect(await r.puzzleResults.moveToUser(a, b)).toBe(2);
      expect((await r.puzzleResults.listForUser(b)).map((p) => [p.kind, p.puzzleKey, p.correct])).toEqual(
        expect.arrayContaining([
          ['daily', key, false],
          ['daily', key + 'x', false],
          ['rush', 'run:0', true],
        ]),
      );
      expect((await r.puzzleResults.listForUser(a)).map((p) => p.puzzleKey)).toEqual([key]);
    });

    it('stores a rating and keeps the better-supported one on a merge', async () => {
      const r = repos();
      const [guest, account, fresh] = [await user(), await user(), await user()];
      expect(await r.puzzleRatings.get(guest)).toBeNull();
      await r.puzzleRatings.set({ userId: guest, rating: 1200, rated: 30, updatedAt: T0 });
      await r.puzzleRatings.set({ userId: account, rating: 1100, rated: 12, updatedAt: T0 + 1000 });
      await r.puzzleRatings.set({ userId: account, rating: 1110, rated: 13, updatedAt: T0 + 2000 });
      expect(await r.transaction((tx) => tx.puzzleRatings.getForUpdate(account))).toEqual({ userId: account, rating: 1110, rated: 13, updatedAt: T0 + 2000 });
      await r.puzzleRatings.mergeInto(guest, account);
      expect(await r.puzzleRatings.get(account)).toEqual({ userId: account, rating: 1200, rated: 30, updatedAt: T0 });
      expect(await r.puzzleRatings.get(guest)).toBeNull();
      // The account's own wins a tie, and a guest with no rating changes nothing.
      const tie = await user();
      await r.puzzleRatings.set({ userId: tie, rating: 900, rated: 30, updatedAt: T0 });
      await r.puzzleRatings.mergeInto(tie, account);
      expect((await r.puzzleRatings.get(account))?.rating).toBe(1200);
      await r.puzzleRatings.mergeInto(fresh, account);
      expect((await r.puzzleRatings.get(account))?.rating).toBe(1200);
      await r.puzzleRatings.set({ userId: fresh, rating: 1300, rated: 1, updatedAt: T0 });
      const empty = await user();
      await r.puzzleRatings.mergeInto(fresh, empty);
      expect(await r.puzzleRatings.get(empty)).toMatchObject({ rating: 1300, rated: 1 });
    });

    it('finishes a Rush run once, moves runs on a merge and prunes expired unfinished ones', async () => {
      const r = repos();
      const [a, b] = [await user(), await user()];
      const id = randomUUID();
      expect(await r.rushRuns.create({ id, userId: a, seed: 'rush-1', startedAt: T0, expiresAt: T0 + 1_800_000 })).toMatchObject({ id, finishedAt: null, score: null });
      const result = { finishedAt: T0 + 60_000, solved: 4, wrong: 3, seconds: 60, score: 520 };
      expect(await r.rushRuns.finish(id, result)).toMatchObject({ ...result, userId: a, seed: 'rush-1' });
      expect(await r.rushRuns.finish(id, { ...result, score: 9999 })).toBeNull();
      expect(await r.rushRuns.finish(randomUUID(), result)).toBeNull();
      expect(await r.rushRuns.get('not-a-uuid')).toBeNull();
      const open = randomUUID();
      await r.rushRuns.create({ id: open, userId: a, seed: 'rush-2', startedAt: T0, expiresAt: T0 + 1000 });
      expect(await r.rushRuns.moveToUser(a, b)).toBe(2);
      expect((await r.rushRuns.get(id))?.userId).toBe(b);
      expect(await r.rushRuns.pruneUnfinished(T0 + 2000)).toBeGreaterThanOrEqual(1);
      expect(await r.rushRuns.get(open)).toBeNull();
      expect(await r.rushRuns.get(id)).not.toBeNull();
    });

    it('orders the daily board solved first, then fewest seconds, then who answered first, and ranks the viewer', async () => {
      const r = repos();
      const key = 'd-' + randomHex(4);
      const [slow, fast, wrong, early, late, hidden, banned, gone] = [
        await user('Slow'),
        await user('Fast'),
        await user('Wrong'),
        await user('Early'),
        await user('Late'),
        await user('Hidden'),
        await user('Banned'),
        await user('Gone'),
      ];
      await daily(slow, key, true, 40);
      await daily(fast, key, true, 10);
      await daily(wrong, key, false, 1);
      await daily(late, key, true, 20, T0 + 5000);
      await daily(early, key, true, 20, T0 + 1000);
      await daily(hidden, key, true, 5);
      await daily(banned, key, true, 5);
      await daily(gone, key, true, 5);
      await r.users.setLeaderboardVisible(hidden, false);
      await r.moderation.ban(banned, T0, 'test');
      await r.users.update(gone, { deletedAt: T0 });
      const page = await r.leaderboards.daily(key, q(wrong));
      expect(page.rows.map((x) => [x.rank, x.displayName, x.score, x.tiebreak])).toEqual([
        [1, 'Fast', 1, 10],
        [2, 'Early', 1, 20],
        [3, 'Late', 1, 20],
        [4, 'Slow', 1, 40],
        [5, 'Wrong', 0, 1],
      ]);
      expect(page.me).toMatchObject({ rank: 5, userId: wrong, hidden: false });
      // A hidden or banned viewer sees their own row, ranked among the listed ones, marked hidden.
      expect((await r.leaderboards.daily(key, q(hidden))).me).toMatchObject({ rank: 1, displayName: 'Hidden', hidden: true });
      expect((await r.leaderboards.daily(key, q(banned))).me).toMatchObject({ rank: 1, hidden: true });
      expect((await r.leaderboards.daily(key, q(gone))).me).toBeNull();
      // The viewer outside a short list still gets their row; a club scope lists only its members.
      expect((await r.leaderboards.daily(key, q(slow, { limit: 2 }))).me).toMatchObject({ rank: 4, displayName: 'Slow' });
      const club = await r.leaderboards.daily(key, q(slow, { userIds: [slow, late, hidden] }));
      expect(club.rows.map((x) => [x.rank, x.displayName])).toEqual([
        [1, 'Late'],
        [2, 'Slow'],
      ]);
      expect(club.me).toMatchObject({ rank: 2 });
      expect((await r.leaderboards.daily(key, q(fast, { userIds: [slow] }))).me).toBeNull();
      expect((await r.leaderboards.daily(key, q(randomUUID()))).me).toBeNull();
    });

    it('lists each account’s best Rush score in a window, ties to the earlier run', async () => {
      const r = repos();
      const [a, b, c] = [await user('A'), await user('B'), await user('C')];
      const run = async (userId: string, score: number, finishedAt: number) => {
        const id = randomUUID();
        await r.rushRuns.create({ id, userId, seed: 's', startedAt: finishedAt - 60_000, expiresAt: finishedAt + 1_800_000 });
        await r.rushRuns.finish(id, { finishedAt, solved: Math.floor(score / 100), wrong: 3, seconds: 60, score });
      };
      const since = T0 + 1000 * DAY;
      await run(a, 900, since - DAY);
      await run(a, 500, since + 1000);
      await run(b, 500, since + 500);
      await run(c, 0, since + 100);
      await run(c, 700, since - 5);
      const today = await r.leaderboards.rush(since, q(c));
      const mine = today.rows.filter((x) => [a, b, c].includes(x.userId));
      expect(mine.map((x) => [x.displayName, x.score, x.count])).toEqual([
        ['B', 500, 5],
        ['A', 500, 5],
      ]);
      expect(today.me).toBeNull();
      const ever = (await r.leaderboards.rush(since - 2 * DAY, q(a, { userIds: [a, b, c] }))).rows;
      expect(ever.map((x) => [x.rank, x.displayName, x.score])).toEqual([
        [1, 'A', 900],
        [2, 'C', 700],
        [3, 'B', 500],
      ]);
    });

    it('lists ratings with enough rated answers, and the purge takes the rating, runs and results', async () => {
      const r = repos();
      const [a, b, c] = [await user('A'), await user('B'), await user('C')];
      await r.puzzleRatings.set({ userId: a, rating: 1500, rated: 20, updatedAt: T0 });
      await r.puzzleRatings.set({ userId: b, rating: 1500, rated: 40, updatedAt: T0 - 1 });
      await r.puzzleRatings.set({ userId: c, rating: 1900, rated: 19, updatedAt: T0 });
      const page = await r.leaderboards.rating(20, q(c, { userIds: [a, b, c] }));
      expect(page.rows.map((x) => [x.rank, x.displayName, x.score, x.count])).toEqual([
        [1, 'B', 1500, 40],
        [2, 'A', 1500, 20],
      ]);
      expect(page.me).toBeNull();
      const run = randomUUID();
      await r.rushRuns.create({ id: run, userId: a, seed: 's', startedAt: T0, expiresAt: T0 + 1000 });
      await daily(a, 'p-' + randomHex(4), true, 3);
      await r.users.setLeaderboardVisible(a, false);
      expect(await r.users.getLeaderboardVisible(a)).toBe(false);
      expect(await r.users.getLeaderboardVisible(b)).toBe(true);
      await r.users.update(a, { deletedAt: T0 });
      expect(await r.users.purgeDeletedIds(T0 + 1)).toContain(a);
      expect(await r.puzzleRatings.get(a)).toBeNull();
      expect(await r.rushRuns.get(run)).toBeNull();
      expect(await r.puzzleResults.listForUser(a)).toEqual([]);
    });
  });
}

let memory: Repos;
beforeAll(() => {
  memory = createMemoryRepos();
});
contract('puzzle repositories (memory)', () => memory);

describe.skipIf(!PG_URL)('puzzle repositories (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_puzzles_' + randomHex(6);

  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => {} });
    pg = createPgRepos(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });

  contract('contract', () => pg);
});
