/**
 * The puzzle repositories (migrations 0010 and 0011) against memory and (with DATABASE_URL_TEST) Postgres:
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

    it('stores each Rush answer once, only for the puzzle being served, serves the next at its time and keeps an inhuman verdict', async () => {
      const r = repos();
      const a = await user();
      const id = randomUUID();
      expect(await r.rushRuns.create({ id, userId: a, seed: 'rush-3', startedAt: T0, expiresAt: T0 + 1_800_000 })).toMatchObject({ servedIndex: 0, servedAt: T0, inhuman: false });
      const ans = (index: number, at: number, correct = true) => ({ index, type: 'discard' as const, correct, servedAt: at - 5000, answeredAt: at });
      // Not yet served, then once, then not again.
      expect(await r.rushRuns.answer(id, ans(1, T0 + 5000))).toBe(false);
      expect(await r.rushRuns.answer(id, ans(0, T0 + 5000))).toBe(true);
      expect(await r.rushRuns.answer(id, ans(0, T0 + 6000))).toBe(false);
      expect(await r.rushRuns.getForUpdate(id)).toMatchObject({ servedIndex: 1, servedAt: T0 + 5000 });
      expect(await r.rushRuns.answer(id, ans(1, T0 + 9000, false))).toBe(true);
      expect(await r.rushRuns.answers(id)).toEqual([ans(0, T0 + 5000), ans(1, T0 + 9000, false)]);
      expect(await r.rushRuns.finish(id, { finishedAt: T0 + 9000, solved: 1, wrong: 1, seconds: 9, score: 100, ranked: false, inhuman: true })).toMatchObject({ ranked: false, inhuman: true });
      // A finished run takes no answer.
      expect(await r.rushRuns.answer(id, ans(2, T0 + 10_000))).toBe(false);
      expect(await r.puzzleFlags.recentResults(a, -1, 10)).toEqual([{ kind: 'rush', at: T0 + 9000, seconds: 9, answers: 2, solved: 1, wrong: 1, inhuman: true }]);
      expect(await r.rushRuns.answer(randomUUID(), ans(0, T0))).toBe(false);
      expect(await r.rushRuns.answers(randomUUID())).toEqual([]);
      expect(await r.rushRuns.getForUpdate('not-a-uuid')).toBeNull();
    });

    it('keeps one daily attempt per account and key, finishes it once, moves it on a merge and prunes old ones', async () => {
      const r = repos();
      const [a, b] = [await user(), await user()];
      const id = randomUUID();
      const started = await r.dailyAttempts.start({ id, userId: a, dateKey: '2026-11-16', startedAt: T0 });
      expect(started).toEqual({ id, userId: a, dateKey: '2026-11-16', startedAt: T0, finishedAt: null });
      // A second start returns the first attempt and its start time.
      expect(await r.dailyAttempts.start({ id: randomUUID(), userId: a, dateKey: '2026-11-16', startedAt: T0 + 40_000 })).toEqual(started);
      expect(await r.dailyAttempts.finish(id, T0 + 40_000)).toMatchObject({ id, finishedAt: T0 + 40_000 });
      expect(await r.dailyAttempts.finish(id, T0 + 50_000)).toBeNull();
      expect(await r.dailyAttempts.finish(randomUUID(), T0)).toBeNull();
      expect(await r.dailyAttempts.get('not-a-uuid')).toBeNull();
      expect(await r.dailyAttempts.start({ id: randomUUID(), userId: a, dateKey: '2026-11-16', startedAt: T0 + 60_000 })).toMatchObject({ id, finishedAt: T0 + 40_000 });
      // b already has an attempt for the 16th: a's stays behind; the 17th moves.
      const bOwn = await r.dailyAttempts.start({ id: randomUUID(), userId: b, dateKey: '2026-11-16', startedAt: T0 });
      const later = await r.dailyAttempts.start({ id: randomUUID(), userId: a, dateKey: '2026-11-17', startedAt: T0 + DAY });
      expect(await r.dailyAttempts.moveToUser(a, b)).toBe(1);
      expect((await r.dailyAttempts.get(later.id))?.userId).toBe(b);
      expect((await r.dailyAttempts.get(id))?.userId).toBe(a);
      expect(await r.dailyAttempts.prune(T0 + 1)).toBeGreaterThanOrEqual(2);
      expect(await r.dailyAttempts.get(bOwn.id)).toBeNull();
      expect(await r.dailyAttempts.get(later.id)).not.toBeNull();
      // The purge takes an account's attempts.
      await r.users.update(b, { deletedAt: T0 });
      expect(await r.users.purgeDeletedIds(T0 + 1)).toContain(b);
      expect(await r.dailyAttempts.get(later.id)).toBeNull();
    });

    it('keeps automation flags (a confirmed one stays), reads recent results newest first, moves a flag on a merge, and keeps flagged and unranked entries off the boards', async () => {
      const r = repos();
      const [a, b, c] = [await user('Flag A'), await user('Flag B'), await user('Flag C')];
      const key = 'f-' + randomHex(4);
      await daily(a, key, true, 4, T0 + 1000);
      const run = randomUUID();
      await r.rushRuns.create({ id: run, userId: a, seed: 's', startedAt: T0, expiresAt: T0 + 1_800_000 });
      await r.rushRuns.finish(run, { finishedAt: T0 + 2000, solved: 20, wrong: 1, seconds: 31, score: 3000, ranked: true });
      const unranked = randomUUID();
      await r.rushRuns.create({ id: unranked, userId: b, seed: 's', startedAt: T0, expiresAt: T0 + 1_800_000 });
      expect(await r.rushRuns.finish(unranked, { finishedAt: T0 + 3000, solved: 20, wrong: 0, seconds: 20, score: 3000, ranked: false })).toMatchObject({ ranked: false });
      await r.puzzleResults.recordDaily({ userId: b, puzzleKey: key, correct: true, seconds: 1, ratingAfter: null, createdAt: T0, ranked: false });
      expect(await r.puzzleFlags.recentResults(a, -1, 10)).toEqual([
        { kind: 'rush', at: T0 + 2000, seconds: 31, answers: 21, solved: 20, wrong: 1, inhuman: false },
        { kind: 'daily', at: T0 + 1000, seconds: 4, answers: 1, solved: 1, wrong: 0 },
      ]);
      expect(await r.puzzleFlags.recentResults(a, T0 + 1000, 10)).toHaveLength(1);
      const ids = async (page: Promise<{ rows: Array<{ userId: string }> }>) => (await page).rows.map((x) => x.userId).filter((id) => [a, b, c].includes(id));
      expect(await ids(r.leaderboards.daily(key, q(c)))).toEqual([a]);
      expect(await ids(r.leaderboards.rush(T0, q(c)))).toEqual([a]);
      // Flagged: off every board, and the viewer's own row says so.
      expect(await r.puzzleFlags.get(a)).toBeNull();
      expect(await r.puzzleFlags.flag(a, 'test', T0)).toEqual({ userId: a, status: 'flagged', reason: 'test', flaggedAt: T0, reviewedAt: null });
      expect(await ids(r.leaderboards.daily(key, q(c)))).toEqual([]);
      expect((await r.leaderboards.rush(T0, q(a))).me).toMatchObject({ userId: a, hidden: true, flagged: true });
      expect(await r.puzzleFlags.review(c, 'cleared', T0)).toBeNull();
      expect(await r.puzzleFlags.review(a, 'cleared', T0 + 5)).toMatchObject({ status: 'cleared', reviewedAt: T0 + 5 });
      expect(await ids(r.leaderboards.rush(T0, q(c)))).toEqual([a]);
      expect((await r.leaderboards.rush(T0, q(a))).me).toMatchObject({ hidden: false, flagged: false });
      await r.puzzleFlags.flag(a, 'again', T0 + 6);
      await r.puzzleFlags.review(a, 'confirmed', T0 + 7);
      expect(await r.puzzleFlags.flag(a, 'once more', T0 + 8)).toMatchObject({ status: 'confirmed', reason: 'again' });
      expect((await r.puzzleFlags.list('confirmed', 500)).map((f) => f.userId)).toContain(a);
      // A merge moves the flag to an account that has none.
      await r.puzzleFlags.moveToUser(a, c);
      expect(await r.puzzleFlags.get(a)).toBeNull();
      expect(await r.puzzleFlags.get(c)).toMatchObject({ userId: c, status: 'confirmed' });
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
