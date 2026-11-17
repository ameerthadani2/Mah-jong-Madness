/**
 * Server-verified puzzle results, ratings and leaderboards over the real API, against memory and
 * (with DATABASE_URL_TEST) Postgres. The clock is the test's: a Rush run's time is the server's,
 * whatever the client claims. Answers are worked out with the engine, as the app would.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  dailyPuzzleDifficulty,
  dailyPuzzleForKey,
  dateOfDailyKey,
  DEFAULT_PUZZLE_RATING,
  puzzleDifficulty,
  movesPuzzleRating,
  randomHex,
  ratePuzzleAnswer,
  rushDifficultyAt,
  rushRunPuzzle,
  rushScore,
  type AnyPuzzle,
  type PuzzleAnswerInput,
} from '@mjm/engine';
import { createApiHandler } from '../src/api';
import { createGuest, deleteAccount, link, purgeDeletedUsers, SessionService } from '../src/auth';
import { ClubRegistry, type Club } from '../src/clubs';
import { createPool, type Pool } from '../src/db';
import { BucketTable } from '../src/limits';
import { migrate } from '../src/migrate';
import { RUSH_RUN_TTL_MS } from '../src/puzzles';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';
import { RoomRegistry } from '../src/rooms';
import { PEPPER, request } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const DAY = 86_400_000;
/** Monday 16 November 2026, 10:00 UTC. */
const T0 = Date.UTC(2026, 10, 16, 10, 0, 0);

type Json = Record<string, unknown>;
type Row = { rank: number; userId: string; displayName: string; value: number; hidden?: boolean; solved?: unknown; rated?: number };

/** A right answer for any theme, worked out with the engine. */
function right(p: AnyPuzzle): PuzzleAnswerInput {
  return p.type === 'waits' ? p.answers : p.answers[0];
}
/** A wrong answer for any theme. */
function wrong(p: AnyPuzzle): PuzzleAnswerInput {
  if (p.type === 'waits') return p.answers.slice(1);
  if (p.type === 'claim') return p.options.find((o) => !p.answers.includes(o.id))!.id;
  return p.hand.find((k) => !p.answers.includes(k))!;
}
const dailyRight = (key: string) => dailyPuzzleForKey(key)!.answers[0];
const dailyWrong = (key: string) => wrong(dailyPuzzleForKey(key)!);

function fixture(repos: Repos, opts: { limits?: boolean } = {}) {
  const clock = { now: T0 };
  const now = () => clock.now;
  const sessions = new SessionService(repos, { pepper: PEPPER, now });
  const clubs = new ClubRegistry({ store: repos.clubs, now, retryDelayMs: 5 });
  const rooms = new RoomRegistry({ allowHosted: true, now });
  const roomy = new BucketTable<string>(10_000, 10_000, { now });
  const handler = createApiHandler({
    clubs,
    rooms,
    repos,
    sessions,
    now,
    puzzles: { yieldTurn: async () => {}, ...(opts.limits ? {} : { submitLimiter: roomy, readLimiter: roomy, rushIpLimiter: roomy }) },
  });
  let n = 0;
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}, ip?: string) =>
    request(handler, method, url, body, headers, ip ?? `10.9.${Math.floor(++n / 250)}.${n % 250}`);
  const guest = async (displayName: string) => {
    const res = await call('POST', '/api/auth/guest', { device: { id: randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' }, displayName });
    expect(res.status).toBe(201);
    return { userId: res.json.userId as string, name: displayName, auth: { authorization: `Bearer ${(res.json.session as { token: string }).token}` } };
  };
  type G = Awaited<ReturnType<typeof guest>>;
  const startDaily = (g: G, date: unknown) => call('POST', '/api/puzzles/daily/start', { date }, g.auth);
  /** Opens the daily puzzle, lets `seconds` pass on the server's clock and answers it (or answers the start's refusal). */
  const daily = async (g: G, date: string, answer: unknown, seconds = 20, extra: Json = {}) => {
    const started = await startDaily(g, date);
    if (started.status !== 200) return started;
    clock.now += seconds * 1000;
    return call('POST', '/api/puzzles/daily', { attemptId: started.json.attemptId, answer, ...extra }, g.auth);
  };
  const startRush = async (g: G) => {
    const res = await call('POST', '/api/puzzles/rush', {}, g.auth);
    expect(res.status).toBe(201);
    return res.json as { runId: string; seed: string };
  };
  /** A run's answers: `pattern` of r (right) and w (wrong). */
  const rushAnswers = (seed: string, pattern: string) => [...pattern].map((c, i) => (c === 'r' ? right(rushRunPuzzle(seed, i)) : wrong(rushRunPuzzle(seed, i))));
  const finish = (g: G, runId: string, answers: unknown[], extra: Json = {}) => call('POST', `/api/puzzles/rush/${runId}/finish`, { answers, ...extra }, g.auth);
  const board = async (g: G, path: string) => {
    const res = await call('GET', `/api/leaderboards/${path}`, undefined, g.auth);
    expect(res.status, res.body).toBe(200);
    return res.json as { rows: Row[]; me: Row | null; scope: string };
  };
  /** Gives the account a live plan (`coach.gold.month`, `fourwinds.year`, ...) until `until` (default: a month on). */
  const plan = (g: G, entitlement = 'coach.gold.month', until = clock.now + 30 * DAY) =>
    repos.wallet.setEntitlement({ userId: g.userId, entitlement, expiresAt: until, source: 'store', updatedAt: clock.now });
  return { clock, now, repos, sessions, clubs, call, guest, plan, startDaily, daily, startRush, rushAnswers, finish, board };
}

const TODAY = '2026-11-16';

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    it('judges a daily answer itself, ignores a forged "correct", and rates it as the app does', async () => {
      const f = fixture(repos());
      const [a, b] = [await f.guest('Ana'), await f.guest('Bo')];
      const ok = await f.daily(a, TODAY, dailyRight(TODAY), 31);
      expect(ok.status, ok.body).toBe(200);
      const difficulty = dailyPuzzleDifficulty(dateOfDailyKey(TODAY)!);
      const up = ratePuzzleAnswer(DEFAULT_PUZZLE_RATING, 'discard', difficulty, true);
      expect(ok.json).toEqual({ date: TODAY, correct: true, seconds: 31, ranked: true, rating: { rating: up.rating, change: up.delta, rated: 1 } });
      // A wrong answer that claims to be right is wrong.
      const forged = await f.daily(b, TODAY, dailyWrong(TODAY), 3, { correct: true });
      const down = ratePuzzleAnswer(DEFAULT_PUZZLE_RATING, 'discard', difficulty, false);
      expect(forged.json).toMatchObject({ correct: false, rating: { rating: down.rating, change: down.delta, rated: 1 } });
      // One ranked attempt per date key: starting again, or finishing again, is refused and moves nothing.
      const again = await f.daily(a, TODAY, dailyRight(TODAY));
      expect([again.status, again.json.error]).toEqual([409, 'already_played']);
      expect((await f.call('GET', '/api/puzzles/rating', undefined, a.auth)).json).toMatchObject({ rating: up.rating, rated: 1 });
      // The day before and the day after are open (time zones); two days off is not, nor a date that is not one.
      expect((await f.daily(a, '2026-11-15', dailyRight('2026-11-15'))).json.correct).toBe(true);
      expect((await f.daily(a, '2026-11-17', dailyRight('2026-11-17'))).json.correct).toBe(true);
      for (const off of ['2026-11-14', '2026-11-18']) expect((await f.startDaily(a, off)).json.error).toBe('date_out_of_range');
      for (const bad of ['2026-11-31', undefined, 20261116]) expect((await f.startDaily(a, bad)).json.error).toBe('invalid');
      const open = await f.startDaily(b, '2026-11-17');
      expect(open.status).toBe(200);
      for (const bad of [{ id: 'pass' }, 'draw', 99, [1, 1], null]) {
        expect((await f.call('POST', '/api/puzzles/daily', { attemptId: open.json.attemptId, answer: bad }, b.auth)).json.error).toBe('invalid_answer');
      }
      // An attempt is the caller's own and must be named.
      const notMine = await f.call('POST', '/api/puzzles/daily', { attemptId: open.json.attemptId, answer: 1 }, a.auth);
      expect([notMine.status, notMine.json.error]).toEqual([404, 'not_found']);
      for (const id of [undefined, '', 'nope', randomUUID()]) expect((await f.call('POST', '/api/puzzles/daily', { attemptId: id, answer: 1 }, b.auth)).status).toBeGreaterThanOrEqual(400);
      expect((await f.call('POST', '/api/puzzles/daily', { date: TODAY, answer: 1, seconds: 1 }, b.auth)).json.error).toBe('invalid');
      // The server's time is capped; the rating has moved three times for Ana.
      const slow = await f.startDaily(b, '2026-11-15');
      f.clock.now += 3_700_000;
      expect((await f.call('POST', '/api/puzzles/daily', { attemptId: slow.json.attemptId, answer: dailyWrong('2026-11-15'), seconds: 2 }, b.auth)).json.seconds).toBe(3600);
      expect((await f.call('GET', '/api/puzzles/rating', undefined, a.auth)).json).toMatchObject({ rated: 3 });
      expect((await f.call('POST', '/api/puzzles/daily/start', { date: TODAY })).status).toBe(401);
      expect((await f.call('POST', '/api/puzzles/daily', { attemptId: open.json.attemptId, answer: 1 })).status).toBe(401);
    });

    it('times the daily puzzle with the server clock: reopening keeps the start, a claimed time is ignored', async () => {
      const f = fixture(repos());
      const a = await f.guest('Ana');
      const first = await f.startDaily(a, TODAY);
      expect(first.status, first.body).toBe(200);
      expect(first.json).toEqual({ attemptId: expect.any(String), date: TODAY, startedAt: new Date(T0).toISOString() });
      // Closing and reopening the puzzle 25 seconds later returns the same attempt and start.
      f.clock.now += 25_000;
      expect((await f.startDaily(a, TODAY)).json).toEqual(first.json);
      f.clock.now += 15_000;
      const done = await f.call('POST', '/api/puzzles/daily', { attemptId: first.json.attemptId, answer: dailyRight(TODAY), seconds: 1 }, a.auth);
      expect(done.json).toMatchObject({ date: TODAY, correct: true, seconds: 40 });
      // The board ranks the server's 40, not the 1 the client claimed.
      expect((await f.board(a, `daily?date=${TODAY}`)).me).toMatchObject({ value: 40, solved: true });
      // A finished attempt cannot be finished again, nor started again.
      const twice = await f.call('POST', '/api/puzzles/daily', { attemptId: first.json.attemptId, answer: dailyRight(TODAY) }, a.auth);
      expect([twice.status, twice.json.error]).toEqual([409, 'already_played']);
      expect([(await f.startDaily(a, TODAY)).status, (await f.startDaily(a, TODAY)).json.error]).toEqual([409, 'already_played']);
      // Another account's attempt for the same date is its own, with its own clock.
      const b = await f.guest('Bo');
      const other = await f.startDaily(b, TODAY);
      expect(other.json.attemptId).not.toBe(first.json.attemptId);
      expect(other.json.startedAt).toBe(new Date(f.now()).toISOString());
    });

    it('times a Rush run with the server clock, judges it to the third strike, and finishes it once', async () => {
      const f = fixture(repos());
      const [a, b] = [await f.guest('Ana'), await f.guest('Bo')];
      // Several runs in a day: Ana has Coach Gold (the free meter is tested below).
      await f.plan(a);
      const run = await f.startRush(a);
      expect(run.seed).toMatch(/^rush-[0-9a-f]{16}$/);
      f.clock.now += 60_000;
      // r w r r w w, then answers after the third strike that are not judged.
      const answers = f.rushAnswers(run.seed, 'rwrrwwrr');
      expect((await f.finish(b, run.runId, answers)).json.error).toBe('run_not_found');
      const res = await f.finish(a, run.runId, answers, { seconds: 5, score: 99_999 });
      expect(res.status, res.body).toBe(200);
      expect(res.json).toMatchObject({ runId: run.runId, solved: 3, wrong: 3, seconds: 60, score: rushScore(3, 60) });
      expect((res.json.answers as Array<{ correct: boolean }>).map((x) => x.correct)).toEqual([true, false, true, true, false, false]);
      // Rush does not move the rating (the engine's rule, as in the app): it is reported unchanged.
      expect(movesPuzzleRating('rush')).toBe(false);
      expect(res.json.rating).toEqual({ rating: DEFAULT_PUZZLE_RATING, change: 0, rated: 0 });
      expect(await f.repos.puzzleRatings.get(a.userId)).toBeNull();
      // The daily puzzle does, by the engine's step.
      const day = await f.daily(a, TODAY, dailyRight(TODAY));
      const stepped = ratePuzzleAnswer(DEFAULT_PUZZLE_RATING, 'discard', dailyPuzzleDifficulty(dateOfDailyKey(TODAY)!), true).rating;
      expect(day.json.rating).toEqual({ rating: stepped, change: stepped - DEFAULT_PUZZLE_RATING, rated: 1 });
      expect((await f.finish(a, run.runId, answers)).json.error).toBe('run_finished');
      expect((await f.repos.puzzleResults.listForUser(a.userId)).filter((p) => p.kind === 'rush')).toHaveLength(6);

      // A run longer than three minutes is scored as three minutes.
      const long = await f.startRush(a);
      f.clock.now += 200_000;
      expect((await f.finish(a, long.runId, f.rushAnswers(long.seed, 'rr'))).json).toMatchObject({ solved: 2, seconds: 180, score: rushScore(2, 180) });
      // An unfinished run expires; more answers than seconds is refused; malformed input is refused.
      const stale = await f.startRush(a);
      f.clock.now += RUSH_RUN_TTL_MS + 1;
      expect((await f.finish(a, stale.runId, [])).json.error).toBe('run_expired');
      const quick = await f.startRush(a);
      f.clock.now += 2_000;
      expect((await f.finish(a, quick.runId, f.rushAnswers(quick.seed, 'rrr'))).json.error).toBe('rush_too_fast');
      expect((await f.finish(a, quick.runId, ['x'])).json.error).toBe('invalid_answer');
      expect((await f.finish(a, quick.runId, 'rr' as unknown as unknown[])).json.error).toBe('invalid');
      expect((await f.finish(a, 'nope', [])).json.error).toBe('run_not_found');
      expect((await f.finish(a, quick.runId, f.rushAnswers(quick.seed, 'rr'))).json).toMatchObject({ solved: 2, seconds: 2 });
    });

    it('meters ranked Rush on the server: one run a UTC day without Coach Gold, unlimited with a plan', async () => {
      const f = fixture(repos());
      const [free, gold, winds, lapsed] = [await f.guest('Free'), await f.guest('Gold'), await f.guest('Winds'), await f.guest('Lapsed')];
      const start = (g: { auth: Record<string, string> }) => f.call('POST', '/api/puzzles/rush', {}, g.auth);
      // A free account: the first run of the day is issued; it is abandoned (never finished) and still counts.
      expect((await start(free)).status).toBe(201);
      f.clock.now += 60_000;
      const refused = await start(free);
      expect([refused.status, refused.json.error]).toEqual([403, 'rush_daily_limit']);
      // The day boundary is midnight UTC: a second before it is still refused, at midnight a run is issued again.
      const midnight = Date.UTC(2026, 10, 17);
      f.clock.now = midnight - 1000;
      expect((await start(free)).json.error).toBe('rush_daily_limit');
      f.clock.now = midnight;
      expect((await start(free)).status).toBe(201);
      expect((await start(free)).json.error).toBe('rush_daily_limit');
      // Coach Gold and The Four Winds Club start as many as they like (the per-address limit still applies).
      await f.plan(gold, 'coach.gold.month');
      await f.plan(winds, 'fourwinds.year');
      for (const g of [gold, winds]) for (let i = 0; i < 4; i++) expect((await start(g)).status).toBe(201);
      // A plan that has lapsed is a free account again.
      await f.plan(lapsed, 'coach.gold.month', f.now() - 1);
      expect((await start(lapsed)).status).toBe(201);
      expect((await start(lapsed)).json.error).toBe('rush_daily_limit');
      expect((await f.repos.rushRuns.countStartedSince(free.userId, 0))).toBe(2);
    });

    it('records but does not rank a daily answer under 3 seconds or a Rush run averaging under 1.5 seconds an answer', async () => {
      const f = fixture(repos());
      const key = '2026-11-17';
      const [bot, human, gold] = [await f.guest('Bot'), await f.guest('Human'), await f.guest('Gold')];
      // The daily puzzle: 2.999 s is under the floor, 3 s is not.
      const started = await f.startDaily(bot, key);
      f.clock.now += 2999;
      const fast = await f.call('POST', '/api/puzzles/daily', { attemptId: started.json.attemptId, answer: dailyRight(key) }, bot.auth);
      expect(fast.json).toMatchObject({ correct: true, ranked: false, rating: { rating: DEFAULT_PUZZLE_RATING, change: 0, rated: 0 } });
      expect((await f.repos.puzzleResults.listForUser(bot.userId)).map((r) => [r.kind, r.correct, r.ranked])).toEqual([['daily', true, false]]);
      expect((await f.daily(bot, key, dailyRight(key))).json.error).toBe('already_played');
      const ok = await f.daily(human, key, dailyRight(key), 3);
      expect(ok.json).toMatchObject({ correct: true, ranked: true, seconds: 3, rating: { rated: 1 } });
      const mine = (rows: Row[]) => rows.filter((r) => [bot, human, gold].some((g) => g.userId === r.userId)).map((r) => r.displayName);
      const daily = await f.board(bot, `daily?date=${key}`);
      expect(mine(daily.rows)).toEqual(['Human']);
      expect(daily.me).toBeNull();

      // Puzzle Rush: twenty answers in 29 s averages 1.45 s (not ranked); in 30 s, 1.5 s (ranked).
      await f.plan(gold);
      const quick = await f.startRush(gold);
      f.clock.now += 29_000;
      const unranked = await f.finish(gold, quick.runId, f.rushAnswers(quick.seed, 'r'.repeat(20)));
      expect(unranked.json).toMatchObject({ solved: 20, seconds: 29, ranked: false });
      expect((await f.repos.rushRuns.get(quick.runId))?.ranked).toBe(false);
      expect((await f.board(gold, 'rush?period=day')).me).toBeNull();
      const paced = await f.startRush(human);
      f.clock.now += 30_000;
      expect((await f.finish(human, paced.runId, f.rushAnswers(paced.seed, 'r'.repeat(20)))).json).toMatchObject({ solved: 20, seconds: 30, ranked: true });
      const rush = await f.board(gold, 'rush?period=day');
      expect(mine(rush.rows)).toEqual(['Human']);
      // A run's third strike ends it: the judged answers set the pace, not the ones sent after it.
      const strikes = await f.startRush(gold);
      f.clock.now += 9_000;
      expect((await f.finish(gold, strikes.runId, f.rushAnswers(strikes.seed, 'rwww' + 'r'.repeat(5)))).json).toMatchObject({ solved: 1, wrong: 3, ranked: true });
    });

    it('verifies a hard daily puzzle and the hard value and defence puzzles of a Rush run by regenerating them', async () => {
      const f = fixture(repos());
      const [a, b] = [await f.guest('Ana'), await f.guest('Bo')];
      // Sunday 15 November is a hard daily puzzle.
      const SUNDAY = '2026-11-15';
      expect(dailyPuzzleDifficulty(dateOfDailyKey(SUNDAY)!)).toBe(3);
      expect((await f.daily(a, SUNDAY, dailyRight(SUNDAY))).json.correct).toBe(true);
      expect((await f.daily(b, SUNDAY, dailyWrong(SUNDAY))).json.correct).toBe(false);
      // A run that reaches the hard puzzles (from the 16th): the tempting wrong answer of a hard value
      // puzzle (the rival) and of a hard defence puzzle (a shape-keeping tile outside the answers) is refused.
      const run = await f.startRush(a);
      f.clock.now += 170_000;
      const pattern = 'rrrrrrrrrrrrrrr' + 'rwrrwrrrrrw';
      const answers = [...pattern].map((c, i) => {
        const p = rushRunPuzzle(run.seed, i);
        if (c === 'r') return right(p);
        if (p.type === 'value') return p.rival;
        if (p.type === 'defence') return p.options.find((o) => o.shanten === p.bestShanten && !o.accepted)!.kind;
        return wrong(p);
      });
      const hard = [...pattern].map((_, i) => rushRunPuzzle(run.seed, i)).slice(15);
      expect(hard.every((p, i) => puzzleDifficulty(p, rushDifficultyAt(15 + i)) === 3)).toBe(true);
      expect(hard.filter((p) => p.type === 'value' || p.type === 'defence').length).toBeGreaterThanOrEqual(4);
      expect([rushRunPuzzle(run.seed, 16).type, rushRunPuzzle(run.seed, 19).type]).toEqual(['defence', 'value']);
      const res = await f.finish(a, run.runId, answers);
      expect(res.status, res.body).toBe(200);
      expect((res.json.answers as Array<{ correct: boolean }>).map((x) => (x.correct ? 'r' : 'w')).join('')).toBe(pattern);
      expect(res.json).toMatchObject({ solved: pattern.length - 3, wrong: 3 });
    });

    it('ranks the daily board solved first, then fewest seconds, with the caller’s own row', async () => {
      const f = fixture(repos());
      const key = '2026-11-17';
      const [fast, slow, tieA, tieB, miss] = [await f.guest('Fast'), await f.guest('Slow'), await f.guest('Tie first'), await f.guest('Tie second'), await f.guest('Miss')];
      await f.daily(slow, key, dailyRight(key), 50);
      await f.daily(miss, key, dailyWrong(key), 4);
      await f.daily(fast, key, dailyRight(key), 9);
      await f.daily(tieA, key, dailyRight(key), 20);
      f.clock.now += 1000;
      await f.daily(tieB, key, dailyRight(key), 20);
      const res = await f.board(miss, `daily?date=${key}`);
      const mine = res.rows.filter((r) => [fast, slow, tieA, tieB, miss].some((g) => g.userId === r.userId));
      expect(mine.map((r) => [r.displayName, r.value, r.solved])).toEqual([
        ['Fast', 9, true],
        ['Tie first', 20, true],
        ['Tie second', 20, true],
        ['Slow', 50, true],
        ['Miss', 4, false],
      ]);
      expect(res.me).toMatchObject({ userId: miss.userId, displayName: 'Miss', hidden: false });
      expect(res.scope).toBe('global');
      expect((await f.call('GET', '/api/leaderboards/daily?date=nope', undefined, miss.auth)).json.error).toBe('invalid');
      expect((await f.call('GET', '/api/leaderboards/rush?period=year', undefined, miss.auth)).json.error).toBe('invalid');
      expect((await f.call('GET', '/api/leaderboards/rating')).status).toBe(401);
    });

    it('scopes boards to a club for its members only, and leaves out hidden, deleted and banned accounts', async () => {
      const f = fixture(repos());
      const [owner, member, hidden, banned, gone, outsider] = [await f.guest('Owner'), await f.guest('Member'), await f.guest('Hidden'), await f.guest('Banned'), await f.guest('Gone'), await f.guest('Outsider')];
      const club = (await f.call('POST', '/api/clubs', { name: 'Board club ' + randomHex(3) }, owner.auth)).json as unknown as Club;
      for (const g of [member, hidden, banned, gone]) expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth)).json.status).toBe('joined');
      const players = [owner, member, hidden, banned, gone, outsider];
      for (const [i, g] of players.entries()) {
        const run = await f.startRush(g);
        f.clock.now += 30_000;
        expect((await f.finish(g, run.runId, f.rushAnswers(run.seed, 'r'.repeat(i + 1) + 'www'))).status).toBe(200);
      }
      expect((await f.call('PATCH', '/api/me', { leaderboardVisible: false }, hidden.auth)).json.leaderboardVisible).toBe(false);
      expect((await f.call('GET', '/api/me', undefined, hidden.auth)).json.leaderboardVisible).toBe(false);
      expect((await f.call('GET', '/api/me', undefined, member.auth)).json.leaderboardVisible).toBe(true);
      expect((await f.call('PATCH', '/api/me', { leaderboardVisible: 'no' }, member.auth)).status).toBe(400);
      await f.repos.moderation.ban(banned.userId, f.now(), 'test');
      expect((await f.call('DELETE', '/api/me', undefined, gone.auth)).status).toBe(204);

      const scoped = await f.board(member, `rush?period=all&club=${club.code}`);
      expect(scoped.scope).toBe('club');
      expect(scoped.rows.map((r) => [r.rank, r.displayName])).toEqual([
        [1, 'Member'],
        [2, 'Owner'],
      ]);
      expect(scoped.me).toMatchObject({ rank: 1, hidden: false });
      // The hidden player sees their own row, marked hidden, ranked among the listed ones.
      expect((await f.board(hidden, `rush?period=day&club=${club.code}`)).me).toMatchObject({ rank: 1, displayName: 'Hidden', hidden: true });
      const global = await f.board(outsider, 'rush?period=week');
      const names = global.rows.map((r) => r.displayName);
      expect(names).toEqual(expect.arrayContaining(['Outsider', 'Member', 'Owner']));
      for (const absent of ['Hidden', 'Banned', 'Gone', 'Deleted player']) expect(names).not.toContain(absent);
      expect(global.me).toMatchObject({ displayName: 'Outsider', value: rushScore(6, 30), solved: 6 });
      const refused = await f.call('GET', `/api/leaderboards/rating?club=${club.code}`, undefined, outsider.auth);
      expect([refused.status, refused.json.error]).toEqual([403, 'forbidden']);
      expect((await f.call('GET', '/api/leaderboards/rating?club=NOPE99', undefined, outsider.auth)).status).toBe(404);
      // Back on the board once visible again.
      await f.call('PATCH', '/api/me', { leaderboardVisible: true }, hidden.auth);
      expect((await f.board(member, `rush?period=all&club=${club.code}`)).rows.map((r) => r.displayName)).toContain('Hidden');
    });

    it('lists ratings of accounts with twenty verified answers, and a refused name shows as Player XXXX', async () => {
      const f = fixture(repos());
      const [steady, brief] = [await f.guest('Steady'), await f.guest('Brief')];
      // Twenty daily puzzles on twenty days (Rush does not move the rating).
      const start = f.now();
      for (let d = 0; d < 20; d++) {
        f.clock.now = start + d * DAY;
        const key = new Date(f.now()).toISOString().slice(0, 10);
        expect((await f.daily(steady, key, d % 4 === 3 ? dailyWrong(key) : dailyRight(key))).json.rating).toMatchObject({ rated: d + 1 });
      }
      const short = await f.startRush(brief);
      f.clock.now += 60_000;
      await f.finish(brief, short.runId, f.rushAnswers(short.seed, 'r'.repeat(17) + 'www'));
      for (const key of ['2026-12-04', '2026-12-05']) await f.daily(brief, key, dailyRight(key));
      const res = await f.board(brief, 'rating');
      const ids = res.rows.map((r) => r.userId);
      expect(ids).toContain(steady.userId);
      expect(ids).not.toContain(brief.userId);
      expect(res.me).toBeNull();
      expect(res.rows.find((r) => r.userId === steady.userId)).toMatchObject({ displayName: 'Steady', rated: 20 });
      // A name stored before the blocklist refused it is not shown.
      await f.repos.users.update(steady.userId, { displayName: 'fuck' });
      const renamed = (await f.board(brief, 'rating')).rows.find((r) => r.userId === steady.userId)!;
      expect(renamed.displayName).toMatch(/^Player [0-9A-F]{4}$/);
    });

    it('moves a guest’s results to the account it merges into, keeps the better-supported rating, and purges a deleted account’s rows', async () => {
      const f = fixture(repos());
      const identity = { provider: 'google' as const, subject: 'g-' + randomHex(8) };
      const account = await createGuest(f.repos, PEPPER, { platform: 'ios' }, { sessions: f.sessions, now: f.now, displayName: 'Mei' });
      await link(f.repos, account.userId, identity, { sessions: f.sessions, now: f.now, currentSessionId: account.sessionId, deviceId: account.deviceId });
      await f.repos.puzzleRatings.set({ userId: account.userId, rating: 1100, rated: 2, updatedAt: f.now() });
      const guest = await f.guest('Mei on the tablet');
      const run = await f.startRush(guest);
      f.clock.now += 60_000;
      const finished = await f.finish(guest, run.runId, f.rushAnswers(run.seed, 'rrrrwww'));
      expect(finished.json.rating).toMatchObject({ rated: 0 });
      // Yesterday's, today's and tomorrow's daily puzzles are all open (time zones), and each is rated.
      for (const key of ['2026-11-15', TODAY, '2026-11-17']) await f.daily(guest, key, dailyRight(key));
      const guestRating = await f.repos.puzzleRatings.get(guest.userId);
      expect(guestRating).toMatchObject({ rated: 3 });
      expect(await link(f.repos, guest.userId, identity, { sessions: f.sessions, now: f.now })).toMatchObject({ userId: account.userId, merged: true });
      // The guest's 3 verified answers beat the account's 2: its rating is the account's now.
      expect(await f.repos.puzzleRatings.get(account.userId)).toEqual({ ...guestRating, userId: account.userId });
      expect(await f.repos.puzzleRatings.get(guest.userId)).toBeNull();
      expect((await f.repos.rushRuns.get(run.runId))?.userId).toBe(account.userId);
      expect((await f.repos.puzzleResults.listForUser(account.userId)).filter((p) => p.kind === 'daily').map((p) => p.puzzleKey)).toEqual(['2026-11-15', TODAY, '2026-11-17']);
      // The guest's finished daily attempt is the account's now: the account cannot start that date again.
      const moved = await f.repos.dailyAttempts.start({ id: randomUUID(), userId: account.userId, dateKey: TODAY, startedAt: f.now() });
      expect(moved.finishedAt).not.toBeNull();
      // The merged-away guest is on no board; the account is, under its own name.
      const viewer = await f.guest('Viewer');
      const rows = (await f.board(viewer, 'rush?period=all')).rows;
      expect(rows.map((r) => r.userId)).not.toContain(guest.userId);
      expect(rows.find((r) => r.userId === account.userId)).toMatchObject({ displayName: 'Mei', value: finished.json.score });

      // Deletion takes the account off every board at once; the purge removes its rows.
      await deleteAccount(f.repos, account.userId, { now: f.now });
      expect((await f.board(viewer, 'rush?period=all')).rows.map((r) => r.userId)).not.toContain(account.userId);
      expect((await f.board(viewer, `daily?date=${TODAY}`)).rows.map((r) => r.userId)).not.toContain(account.userId);
      f.clock.now += 31 * DAY;
      const purged = await purgeDeletedUsers(f.repos, { now: f.now });
      expect(purged.userIds).toEqual(expect.arrayContaining([account.userId, guest.userId]));
      expect(await f.repos.puzzleRatings.get(account.userId)).toBeNull();
      expect(await f.repos.rushRuns.get(run.runId)).toBeNull();
      expect(await f.repos.dailyAttempts.get(moved.id)).toBeNull();
      expect(await f.repos.puzzleResults.listForUser(account.userId)).toEqual([]);
      expect(await f.repos.puzzleResults.listForUser(guest.userId)).toEqual([]);
    });
  });
}

describe('puzzle limits', () => {
  it('meters submissions and board reads per account, and Rush starts per address', async () => {
    const f = fixture(createMemoryRepos(), { limits: true });
    // Accounts with Coach Gold, so the free Rush meter (one run a day) does not stop them first.
    const a = await f.guest('Ana');
    await f.plan(a);
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await f.call('POST', '/api/puzzles/rush', {}, a.auth)).status);
    expect(codes.slice(0, 20).every((c) => c === 201)).toBe(true);
    const limited = await f.call('POST', '/api/puzzles/daily/start', { date: TODAY }, a.auth);
    expect([limited.status, limited.json.error, limited.headers['retry-after']]).toEqual([429, 'rate_limited', '12']);
    const reads: number[] = [];
    for (let i = 0; i < 31; i++) reads.push((await f.call('GET', '/api/leaderboards/rating', undefined, a.auth)).status);
    expect(reads.filter((c) => c === 429)).toHaveLength(1);
    // A minute later the account may submit again.
    f.clock.now += 60_000;
    expect((await f.call('POST', '/api/puzzles/daily/start', { date: TODAY }, a.auth)).status).toBe(200);
    // One address starting runs for many fresh guests runs out after 60 an hour.
    const ip = '203.0.113.9';
    let refused = 0;
    for (let i = 0; i < 4; i++) {
      const g = await f.guest(`G${i}`);
      await f.plan(g);
      for (let j = 0; j < 20; j++) if ((await f.call('POST', '/api/puzzles/rush', {}, g.auth, ip)).status === 429) refused++;
    }
    expect(refused).toBe(20);
  });
});

let memory: Repos;
beforeAll(() => {
  memory = createMemoryRepos();
});
contract('puzzles and leaderboards (memory)', () => memory);

describe.skipIf(!PG_URL)('puzzles and leaderboards (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_puzzle_api_' + randomHex(6);

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
