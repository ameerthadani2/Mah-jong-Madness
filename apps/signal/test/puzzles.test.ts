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
  isPuzzleAnswerInput,
  judgeRushAnswer,
  leakedFields,
  puzzleQuestion,
  PUZZLE_TYPES,
  type PuzzleQuestion,
  RUSH_SECONDS,
  RUSH_STRIKES,
  type AnyPuzzle,
  type DiscardPuzzle,
  type PuzzleAnswerInput,
  dailyPuzzle,
} from '@mjm/engine';
import { createApiHandler } from '../src/api';
import { createGuest, deleteAccount, link, purgeDeletedUsers, SessionService } from '../src/auth';
import { ClubRegistry, type Club } from '../src/clubs';
import { createPool, type Pool } from '../src/db';
import { BucketTable } from '../src/limits';
import { migrate } from '../src/migrate';
import { DAILY_CACHE_SIZE, dailyPuzzleCache, RUSH_ACCURATE_PACE_MS, RUSH_ACCURATE_SHARE, RUSH_HOLD_SOLVED, RUSH_RUN_TTL_MS, RUSH_SLOWDOWN_EARLY, RUSH_SLOWDOWN_MIN_HARD, RUSH_SLOWDOWN_MIN_RATIO, RUSH_SLOWDOWN_PACE_MS, RUSH_SNAP_MAX, RUSH_SNAP_MS, RUSH_STEADY_CV, RUSH_TIMING_FLAG_WEIGHT, RUSH_TIMING_MIN_ANSWERS, rushTiming } from '../src/puzzles';
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

function fixture(repos: Repos, opts: { limits?: boolean; dailyPuzzle?: (day: Date) => DiscardPuzzle } = {}) {
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
    adminToken: ADMIN,
    puzzles: { ...(opts.limits ? {} : { submitLimiter: roomy, answerLimiter: roomy, readLimiter: roomy, rushIpLimiter: roomy }), ...(opts.dailyPuzzle ? { dailyPuzzle: opts.dailyPuzzle } : {}) },
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
    // The seed stays on the server (the test reads it from the store to work out answers).
    expect(res.json.seed).toBeUndefined();
    const seed = (await repos.rushRuns.get(res.json.runId as string))!.seed;
    return { ...(res.json as { runId: string; next: { index: number; question: PuzzleQuestion } }), seed };
  };
  /** A run's answers: `pattern` of r (right) and w (wrong). */
  const rushAnswers = (seed: string, pattern: string) => [...pattern].map((c, i) => (c === 'r' ? right(rushRunPuzzle(seed, i)) : wrong(rushRunPuzzle(seed, i))));
  const answer = (g: G, runId: string, index: number, a: unknown) => call('POST', `/api/puzzles/rush/${runId}/answer`, { index, answer: a }, g.auth);
  /**
   * Plays `answers` one at a time as if they had been made over the server-clock time the test let
   * pass since the run started (up to the run's three minutes), with a human's uneven gaps (JITTER),
   * then finishes the run at the test's time. Answers after the third wrong one are not sent (the
   * run ends there). Anything that is not a list of answers goes to the finish route as it is.
   */
  const JITTER = [0.6, 1.4, 1.0, 0.8, 1.2];
  const finish = async (g: G, runId: string, answers: unknown, extra: Json = {}) => {
    const run = await repos.rushRuns.get(runId);
    const plain = () => call('POST', `/api/puzzles/rush/${runId}/finish`, { ...extra, ...(Array.isArray(answers) ? {} : { answers }) }, g.auth);
    if (!run || run.userId !== g.userId || run.finishedAt !== null || !Array.isArray(answers) || answers.length === 0) return plain();
    let sent = answers.length;
    for (let i = 0, w = 0; i < answers.length; i++) {
      if (!isPuzzleAnswerInput(answers[i]) || (!judgeRushAnswer(run.seed, i, answers[i] as PuzzleAnswerInput).correct && ++w >= RUSH_STRIKES)) {
        sent = i + 1;
        break;
      }
    }
    const end = clock.now;
    const span = Math.min(end, run.startedAt + RUSH_SECONDS * 1000) - run.startedAt;
    const weights = Array.from({ length: sent }, (_, i) => JITTER[i % JITTER.length]);
    const total = weights.reduce((a, b) => a + b, 0);
    let last: Awaited<ReturnType<typeof call>> | null = null;
    for (let i = 0, cum = 0; i < sent; i++) {
      cum += weights[i];
      clock.now = run.startedAt + Math.round((span * cum) / total);
      last = await answer(g, runId, i, answers[i]);
      if (last.status !== 200) break;
    }
    clock.now = end;
    if (last && last.status !== 200) return last;
    if (last?.json.done) return { ...last, json: last.json.result as Json };
    return plain();
  };
  const board = async (g: G, path: string) => {
    const res = await call('GET', `/api/leaderboards/${path}`, undefined, g.auth);
    expect(res.status, res.body).toBe(200);
    return res.json as { rows: Row[]; me: Row | null; scope: string };
  };
  /** Gives the account a live plan (`coach.gold.month`, `fourwinds.year`, ...) until `until` (default: a month on). */
  const plan = (g: G, entitlement = 'coach.gold.month', until = clock.now + 30 * DAY) =>
    repos.wallet.setEntitlement({ userId: g.userId, entitlement, expiresAt: until, source: 'store', updatedAt: clock.now });
  return { clock, now, repos, sessions, clubs, call, guest, plan, startDaily, daily, startRush, rushAnswers, answer, finish, board };
}

const TODAY = '2026-11-16';
const ADMIN = 'admin-token-for-puzzle-tests';

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    it('judges a daily answer itself, ignores a forged "correct", and rates it as the app does', async () => {
      const f = fixture(repos());
      const [a, b] = [await f.guest('Ana'), await f.guest('Bo')];
      const ok = await f.daily(a, TODAY, dailyRight(TODAY), 31);
      expect(ok.status, ok.body).toBe(200);
      const difficulty = dailyPuzzleDifficulty(dateOfDailyKey(TODAY)!);
      const up = ratePuzzleAnswer(DEFAULT_PUZZLE_RATING, 'discard', difficulty, true);
      expect(ok.json).toEqual({ date: TODAY, correct: true, seconds: 31, ranked: true, rating: { rating: up.rating, change: up.delta, rated: 1 }, revealed: dailyPuzzleForKey(TODAY) });
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
      expect(first.json).toEqual({ attemptId: expect.any(String), date: TODAY, startedAt: new Date(T0).toISOString(), question: puzzleQuestion(dailyPuzzleForKey(TODAY)!, dailyPuzzleDifficulty(dateOfDailyKey(TODAY)!)) });
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
      expect((await f.finish(a, quick.runId, ['x'])).json.error).toBe('invalid_answer');
      // Answers travel one at a time: a list posted to finish is refused, not scored.
      expect((await f.finish(a, quick.runId, 'rr' as unknown as unknown[])).json.error).toBe('answers_one_at_a_time');
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
      const [bot, human, gold, edge] = [await f.guest('Bot'), await f.guest('Human'), await f.guest('Gold'), await f.guest('Edge')];
      // The daily puzzle: 2.999 s is under the floor, 3 s is not.
      const started = await f.startDaily(bot, key);
      f.clock.now += 2999;
      const fast = await f.call('POST', '/api/puzzles/daily', { attemptId: started.json.attemptId, answer: dailyRight(key) }, bot.auth);
      expect(fast.json).toMatchObject({ correct: true, ranked: false, rating: { rating: DEFAULT_PUZZLE_RATING, change: 0, rated: 0 } });
      expect((await f.repos.puzzleResults.listForUser(bot.userId)).map((r) => [r.kind, r.correct, r.ranked])).toEqual([['daily', true, false]]);
      expect((await f.daily(bot, key, dailyRight(key))).json.error).toBe('already_played');
      const ok = await f.daily(human, key, dailyRight(key), 3);
      expect(ok.json).toMatchObject({ correct: true, ranked: true, seconds: 3, rating: { rated: 1 } });
      const mine = (rows: Row[]) => rows.filter((r) => [bot, human, gold, edge].some((g) => g.userId === r.userId)).map((r) => r.displayName);
      const daily = await f.board(bot, `daily?date=${key}`);
      expect(mine(daily.rows)).toEqual(['Human']);
      expect(daily.me).toBeNull();

      // Puzzle Rush: ten answers in 14 s averages 1.4 s (not ranked); in 15 s, 1.5 s (ranked). (Fewer than
      // fifteen answers, so the answer-time checks below do not apply: this is the floor alone.)
      await f.plan(gold);
      const quick = await f.startRush(gold);
      f.clock.now += 14_000;
      const unranked = await f.finish(gold, quick.runId, f.rushAnswers(quick.seed, 'r'.repeat(10)));
      expect(unranked.json).toMatchObject({ solved: 10, seconds: 14, ranked: false, inhuman: false });
      expect((await f.repos.rushRuns.get(quick.runId))?.ranked).toBe(false);
      expect((await f.board(gold, 'rush?period=day')).me).toBeNull();
      // (Another account: two results this close to the floors would flag one account, see below.)
      const paced = await f.startRush(edge);
      f.clock.now += 15_000;
      expect((await f.finish(edge, paced.runId, f.rushAnswers(paced.seed, 'r'.repeat(10)))).json).toMatchObject({ solved: 10, seconds: 15, ranked: true });
      const rush = await f.board(gold, 'rush?period=day');
      expect(mine(rush.rows)).toEqual(['Edge']);
      // A run's third strike ends it: the judged answers set the pace, not the ones sent after it.
      const strikes = await f.startRush(gold);
      f.clock.now += 9_000;
      expect((await f.finish(gold, strikes.runId, f.rushAnswers(strikes.seed, 'rwww' + 'r'.repeat(5)))).json).toMatchObject({ solved: 1, wrong: 3, ranked: true });
    });

    it('flags an account whose recent results are at a floor or perfect at an inhuman pace, hides it from every board, and lets an admin clear or confirm it', async () => {
      const f = fixture(repos());
      const [bot, human] = [await f.guest('Paced bot'), await f.guest('Human')];
      await f.plan(bot);
      await f.plan(human);
      const admin = { authorization: `Bearer ${ADMIN}` };
      const mine = (rows: Row[]) => rows.filter((r) => [bot, human].some((g) => g.userId === r.userId)).map((r) => r.displayName);
      /** A run of `pattern` answered over `ms` of the server's clock. */
      const run = async (g: typeof bot, pattern: string, ms: number) => {
        const r = await f.startRush(g);
        f.clock.now += ms;
        const res = await f.finish(g, r.runId, f.rushAnswers(r.seed, pattern));
        expect(res.status, res.body).toBe(200);
        return res.json;
      };
      const flagOf = async (g: typeof bot) => (await f.repos.puzzleFlags.get(g.userId))?.status ?? null;
      // Both answer the daily puzzle at a human pace and are on the daily board.
      await f.daily(bot, TODAY, dailyRight(TODAY), 12);
      await f.daily(human, TODAY, dailyRight(TODAY), 25);
      // The bot paces itself just above the Rush floor (14 answers in 21.7 s, 1.55 s each): ranked, but at the floor.
      // (Under fifteen answers, so this is the total-time rule alone; the answer-time checks have their own test.)
      expect(await run(bot, 'r'.repeat(14), 21_700)).toMatchObject({ ranked: true });
      expect(await flagOf(bot)).toBeNull();
      expect(mine((await f.board(human, 'rush?period=all')).rows)).toContain('Paced bot');
      // An honest pace (about 6 s an answer, a mistake or two) never counts, however often.
      for (let i = 0; i < 5; i++) await run(human, 'rrrrwrrrrrrw', 72_000);
      expect(await flagOf(human)).toBeNull();
      // The second result at the floor flags the bot: it is on no board, and sees its own row marked.
      await run(bot, 'r'.repeat(14), 21_700);
      expect(await flagOf(bot)).toBe('flagged');
      for (const path of ['rush?period=all', `daily?date=${TODAY}`]) {
        expect(mine((await f.board(human, path)).rows)).toEqual(['Human']);
        expect((await f.board(bot, path)).me).toMatchObject({ displayName: 'Paced bot', hidden: true, flagged: true });
      }
      expect((await f.board(human, 'rush?period=all')).me).toMatchObject({ hidden: false, flagged: false });

      // The admin queue lists it with what the check saw; the routes need the admin token.
      expect((await f.call('GET', '/api/admin/puzzle-flags', undefined, human.auth)).status).toBe(401);
      const queue = await f.call('GET', '/api/admin/puzzle-flags', undefined, admin);
      expect(queue.status, queue.body).toBe(200);
      const entry = (queue.json.flags as Array<Record<string, unknown>>).find((x) => x.userId === bot.userId)!;
      expect(entry).toMatchObject({ status: 'flagged', account: { id: bot.userId, displayName: 'Paced bot' } });
      expect(entry.reason).toMatch(/^2 of the last 3 puzzle results/);
      expect((entry.recent as unknown[]).length).toBe(3);
      expect((await f.call('GET', '/api/admin/puzzle-flags?status=nope', undefined, admin)).json.error).toBe('invalid');
      expect((await f.call('POST', `/api/admin/puzzle-flags/${human.userId}`, { action: 'clear' }, admin)).status).toBe(404);
      expect((await f.call('POST', `/api/admin/puzzle-flags/${bot.userId}`, { action: 'ban' }, admin)).json.error).toBe('invalid');

      // Cleared: back on the boards, and only results after the clear count towards a new flag.
      const cleared = await f.call('POST', `/api/admin/puzzle-flags/${bot.userId}`, { action: 'clear' }, admin);
      expect(cleared.json).toMatchObject({ ok: true, flag: { status: 'cleared' } });
      expect(mine((await f.board(human, 'rush?period=all')).rows)).toContain('Paced bot');
      f.clock.now += 1000;
      await run(bot, 'r'.repeat(14), 21_700);
      expect(await flagOf(bot)).toBe('cleared');
      // A perfect run at an inhuman pace (12 of 12 in 33.6 s, 2.8 s each) counts too.
      expect(await run(bot, 'r'.repeat(12), 33_600)).toMatchObject({ ranked: true, wrong: 0 });
      expect(await flagOf(bot)).toBe('flagged');
      // Confirmed: off the boards for good; the check never undoes it.
      expect((await f.call('POST', `/api/admin/puzzle-flags/${bot.userId}`, { action: 'confirm' }, admin)).json).toMatchObject({ flag: { status: 'confirmed' } });
      expect((await f.repos.puzzleFlags.flag(bot.userId, 'again', f.now())).status).toBe('confirmed');
      expect(mine((await f.board(human, 'rush?period=all')).rows)).toEqual(['Human']);
      expect((await f.call('GET', '/api/admin/puzzle-flags?status=confirmed', undefined, admin)).json.flags).toEqual(expect.arrayContaining([expect.objectContaining({ userId: bot.userId })]));
    });

    it('serves a ranked Rush run one puzzle at a time and judges and stamps each answer as it arrives', async () => {
      const f = fixture(repos());
      const [a, b] = [await f.guest('Ana'), await f.guest('Bo')];
      await f.plan(a);
      const run = await f.startRush(a);
      // The first puzzle comes with the run: the engine's puzzle as its question, under an id that does not give the seed away.
      expect(run.next.index).toBe(0);
      expect(run.next.question).toEqual({ ...puzzleQuestion(rushRunPuzzle(run.seed, 0), 1), seed: `${run.runId}:0` });
      expect(JSON.stringify({ ...run, seed: undefined })).not.toContain(run.seed.slice(5));
      const p = (i: number) => rushRunPuzzle(run.seed, i);
      // Only the puzzle being served can be answered: not the next one, not someone else's run.
      f.clock.now += 5_000;
      expect((await f.answer(a, run.runId, 1, right(p(1)))).json.error).toBe('not_served');
      expect((await f.answer(b, run.runId, 0, right(p(0)))).json.error).toBe('run_not_found');
      expect((await f.answer(a, run.runId, -1, right(p(0)))).json.error).toBe('invalid');
      expect((await f.answer(a, run.runId, 0, 'x')).json.error).toBe('invalid_answer');
      const first = await f.answer(a, run.runId, 0, right(p(0)));
      expect(first.status, first.body).toBe(200);
      expect(first.json).toMatchObject({ index: 0, counted: true, correct: true, type: p(0).type, solved: 1, wrong: 0, done: false });
      expect(first.json.next).toEqual({ index: 1, type: p(1).type, question: { ...puzzleQuestion(p(1), rushDifficultyAt(1)), seed: `${run.runId}:1` } });
      // The answered puzzle is revealed whole with its verdict, under the same id.
      expect(first.json.revealed).toEqual({ ...p(0), seed: `${run.runId}:0` });
      // A second answer to the same puzzle is refused, and the first verdict stands.
      expect((await f.answer(a, run.runId, 0, wrong(p(0)))).json.error).toBe('already_answered');
      // Each answer is stamped by the server: the next puzzle was served at the first answer's time.
      expect(await f.repos.rushRuns.get(run.runId)).toMatchObject({ servedIndex: 1, servedAt: f.now() });
      f.clock.now += 7_000;
      expect((await f.answer(a, run.runId, 1, wrong(p(1)))).json).toMatchObject({ correct: false, solved: 1, wrong: 1 });
      f.clock.now += 4_000;
      expect((await f.answer(a, run.runId, 2, wrong(p(2)))).json).toMatchObject({ wrong: 2, done: false });
      f.clock.now += 9_000;
      // The third wrong answer ends the run at its stamp (25 s), with the times the server measured.
      const end = await f.answer(a, run.runId, 3, wrong(p(3)));
      expect(end.json).toMatchObject({ done: true, next: null, result: { solved: 1, wrong: 3, seconds: 25, score: rushScore(1, 25), ranked: true, inhuman: false } });
      expect(((end.json.result as Json).answers as Array<{ ms: number }>).map((x) => x.ms)).toEqual([5_000, 7_000, 4_000, 9_000]);
      // A finished run takes no more answers and is not finished again.
      expect((await f.answer(a, run.runId, 4, right(p(4)))).json.error).toBe('run_finished');
      expect((await f.call('POST', `/api/puzzles/rush/${run.runId}/finish`, {}, a.auth)).json.error).toBe('run_finished');
      expect((await f.repos.puzzleResults.listForUser(a.userId)).filter((x) => x.kind === 'rush').map((x) => x.seconds)).toEqual([5, 7, 4, 9]);

      // The clock: an answer made after the three minutes (and the grace for the network) does not count; the run ends at three minutes.
      const late = await f.startRush(a);
      f.clock.now += 10_000;
      await f.answer(a, late.runId, 0, right(rushRunPuzzle(late.seed, 0)));
      f.clock.now += 175_000;
      const over = await f.answer(a, late.runId, 1, right(rushRunPuzzle(late.seed, 1)));
      expect(over.json).toMatchObject({ counted: false, done: true, result: { solved: 1, wrong: 0, seconds: 180 } });
      // Finishing early ends the run at the finish, with the answers so far.
      const early = await f.startRush(a);
      f.clock.now += 8_000;
      await f.answer(a, early.runId, 0, right(rushRunPuzzle(early.seed, 0)));
      f.clock.now += 2_000;
      expect((await f.call('POST', `/api/puzzles/rush/${early.runId}/finish`, {}, a.auth)).json).toMatchObject({ solved: 1, wrong: 0, seconds: 10, ranked: true });
    });

    it('serves every theme as its question, with no answer, analysis or explanation, and reveals the whole puzzle only with the verdict', async () => {
      const f = fixture(repos());
      const a = await f.guest('Ana');
      await f.plan(a);
      const run = await f.startRush(a);
      const seen = new Set<string>();
      let served = run.next as unknown as { index: number; type: string; question: Record<string, unknown> & { type: AnyPuzzle['type'] } };
      // Fifteen answers, all right (a run ends at three wrong ones): every theme three times, at the first two difficulties.
      for (let i = 0; i < 15; i++) {
        const p = rushRunPuzzle(run.seed, i);
        expect(served.index).toBe(i);
        expect(served.type).toBe(p.type);
        // The payload names no withheld field, and holds nothing that says which answer is right.
        expect(leakedFields(served.question), `${p.type} #${i}`).toEqual([]);
        const text = JSON.stringify(served);
        for (const k of ['answers', 'answer', 'best', 'rival', 'explanation', 'accepted', 'danger', 'exact', 'acceptance', 'shantenAfter', 'expectedScore']) expect(text, `${p.type} #${i}`).not.toContain(`"${k}"`);
        if ('explanation' in p) expect(text).not.toContain(p.explanation.slice(0, 20));
        expect(served.question).toEqual({ ...puzzleQuestion(p, rushDifficultyAt(i)), seed: `${run.runId}:${i}` });
        seen.add(p.type);
        f.clock.now += 4_000 + (i % 3) * 2_500;
        const res = await f.answer(a, run.runId, i, right(p));
        expect(res.status, res.body).toBe(200);
        expect(res.json).toMatchObject({ correct: true, revealed: { ...p, seed: `${run.runId}:${i}` } });
        served = res.json.next as typeof served;
      }
      expect([...seen].sort()).toEqual([...PUZZLE_TYPES].sort());
      // A wrong answer reveals the puzzle too, so the player sees why.
      const p15 = rushRunPuzzle(run.seed, 15);
      f.clock.now += 6_000;
      expect((await f.answer(a, run.runId, 15, wrong(p15))).json).toMatchObject({ correct: false, revealed: { ...p15, seed: `${run.runId}:15` } });

      // The daily puzzle: the start serves the question, the answer reveals the whole puzzle.
      const day = dailyPuzzleForKey(TODAY)!;
      const started = await f.startDaily(a, TODAY);
      expect(leakedFields(started.json.question as never)).toEqual([]);
      expect(JSON.stringify(started.json)).not.toMatch(/"(answers|best|options|bestAcceptance|bestShanten)"/);
      expect(started.json.question).toEqual(puzzleQuestion(day, dailyPuzzleDifficulty(dateOfDailyKey(TODAY)!)));
      f.clock.now += 20_000;
      const done = await f.call('POST', '/api/puzzles/daily', { attemptId: started.json.attemptId, answer: wrong(day) }, a.auth);
      expect(done.json).toMatchObject({ correct: false, revealed: day });
      // A refused answer (already played) reveals nothing new, and the start of a played day serves no question.
      const again = await f.startDaily(a, TODAY);
      expect(again.json).toEqual({ error: 'already_played', message: expect.any(String) });
    });

    it("keeps a run whose answer times no person makes off the board and flags it: the fifth assessment's paced script, while an honest pace ranks", async () => {
      const f = fixture(repos());
      const [script, human] = [await f.guest('Paced script'), await f.guest('Honest')];
      const mine = (rows: Row[]) => rows.filter((r) => [script, human].some((g) => g.userId === r.userId)).map((r) => r.displayName);
      /** Plays a run one answer at a time: gaps[i] ms before answer i, wrong where `wrongAt` says; finishes at three minutes unless the strikes end it. */
      const play = async (g: typeof script, gaps: number[], wrongAt: (i: number) => boolean) => {
        const run = await f.startRush(g);
        const t0 = f.now();
        let last: Json = {};
        for (const [i, gap] of gaps.entries()) {
          f.clock.now += gap;
          const p = rushRunPuzzle(run.seed, i);
          const res = await f.answer(g, run.runId, i, wrongAt(i) ? wrong(p) : right(p));
          expect(res.status, res.body).toBe(200);
          last = res.json;
          if (last.done) return last.result as Json;
        }
        f.clock.now = t0 + RUSH_SECONDS * 1000;
        return (await f.call('POST', `/api/puzzles/rush/${run.runId}/finish`, {}, g.auth)).json;
      };
      // The script, as the fifth assessment ran it: the daily after 6 s, then 89 Rush answers every 2.02 s with one deliberate mistake.
      expect((await f.daily(script, TODAY, dailyRight(TODAY), 6)).json).toMatchObject({ ranked: true });
      const scripted = await play(script, Array.from({ length: 89 }, () => 2020), (i) => i === 17);
      expect(scripted).toMatchObject({ solved: 88, wrong: 1, ranked: false, inhuman: true });
      expect((await f.repos.puzzleFlags.get(script.userId))?.status).toBe('flagged');
      expect((await f.repos.puzzleFlags.get(script.userId))?.reason).toMatch(/1 judged by answer times/);
      // An honest pace with natural variation (4 to 12 s an answer from a fixed seed, a few mistakes) ranks, day after day.
      let seed = 0x5eed;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      for (let day = 0; day < 3; day++) {
        f.clock.now = Date.UTC(2026, 10, 16 + day, 12);
        const gaps = Array.from({ length: 21 }, () => 4000 + Math.round(rand() * 8000));
        const honest = await play(human, gaps.filter((_, i) => gaps.slice(0, i + 1).reduce((x, y) => x + y, 0) <= 178_000), (i) => i % 7 === 5);
        expect(honest).toMatchObject({ ranked: true, inhuman: false });
        expect((honest.wrong as number) >= 1 && (honest.solved as number) >= 15).toBe(true);
      }
      expect(await f.repos.puzzleFlags.get(human.userId)).toBeNull();
      // The script is on no board (flagged, and its run unranked); the honest player is.
      for (const path of ['rush?period=all', `daily?date=${TODAY}`]) expect(mine((await f.board(human, path)).rows)).not.toContain('Paced script');
      expect(mine((await f.board(human, 'rush?period=all')).rows)).toEqual(['Honest']);
      expect((await f.board(script, `daily?date=${TODAY}`)).me).toMatchObject({ hidden: true, flagged: true });
    });

    it("holds the sixth assessment's jittered script and a run over the ceiling for an admin, and ranks an honest player who slows down", async () => {
      const f = fixture(repos());
      const admin = { authorization: `Bearer ${ADMIN}` };
      const [script, strong, strong2, human] = [await f.guest('Jittered script'), await f.guest('Strong'), await f.guest('Strong too'), await f.guest('Honest')];
      const mine = (rows: Row[]) => rows.filter((r) => [script, strong, strong2, human].some((g) => g.userId === r.userId)).map((r) => r.displayName).sort();
      let seed = 6604;
      const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
      /** Plays a run one answer at a time with gap(i) ms before answer i (within the three minutes), wrong where `wrongAt` says. */
      const play = async (g: typeof script, gap: (i: number) => number, wrongAt: (i: number) => boolean) => {
        const run = await f.startRush(g);
        const t0 = f.now();
        for (let i = 0; ; i++) {
          const ms = Math.round(gap(i));
          if (f.now() + ms - t0 > 179_000) break;
          f.clock.now += ms;
          const p = rushRunPuzzle(run.seed, i);
          const res = await f.answer(g, run.runId, i, wrongAt(i) ? wrong(p) : right(p));
          expect(res.status, res.body).toBe(200);
          if (res.json.done) return res.json.result as Json;
        }
        f.clock.now = t0 + RUSH_SECONDS * 1000;
        return (await f.call('POST', `/api/puzzles/rush/${run.runId}/finish`, {}, g.auth)).json;
      };
      // The assessor's script: 2.0 to 4.1 s an answer, two deliberate mistakes. It passed every earlier check with 56 solved.
      // It is no slower on the hard puzzles and past the ceiling, so its run waits for an admin; neither sign flags the account
      // on its own (a fast, steady person can show both), so the account is not flagged by this one run.
      const scripted = await play(script, () => 2000 + rand() * 2100, (i) => i === 3 || i === 9);
      expect(scripted).toMatchObject({ wrong: 2, ranked: false, inhuman: false, held: true });
      expect(scripted.solved as number).toBeGreaterThan(50);
      expect(await f.repos.puzzleFlags.get(script.userId)).toBeNull();
      // Under the ceiling, no slower on the hard puzzles: held as well, and that account not flagged either.
      const even = await f.guest('Even script');
      // A fixed pattern (3.5 to 6.5 s, the same on every stretch: coefficient of variation about 0.2) that the machine-steady
      // rule does not take, and under 6 s on the hard puzzles as on the first fifteen: only the slowdown sign is left.
      const pattern = [3500, 6500, 4500, 5500, 4000, 6000];
      const evenScript = await play(even, (i) => (i < 30 ? pattern[i % pattern.length] : 999_999), (i) => i === 4);
      expect(evenScript).toMatchObject({ ranked: false, inhuman: false, held: true });
      expect(evenScript.solved as number).toBeLessThanOrEqual(RUSH_HOLD_SOLVED);
      expect(await f.repos.puzzleFlags.get(even.userId)).toBeNull();
      // A run that slows down as a person does but solves more than the ceiling: recorded, held off the board.
      const fast = (i: number) => (i < 15 ? 2000 + rand() * 2500 : 3500 + rand() * 2500);
      const held = await play(strong, fast, (i) => i === 6 || i === 20);
      expect(held).toMatchObject({ ranked: false, inhuman: false, held: true });
      expect(held.solved as number).toBeGreaterThan(RUSH_HOLD_SOLVED);
      const held2 = await play(strong2, fast, (i) => i === 8);
      expect(held2).toMatchObject({ ranked: false, held: true });
      expect(await f.repos.puzzleFlags.get(strong.userId)).toBeNull();
      // An honest player: times that grow with difficulty (easy 2.5 to 6 s, medium 4 to 9 s, hard 6 to 13 s), a few mistakes.
      const honest = await play(human, (i) => (i < 5 ? 2500 + rand() * 3500 : i < 15 ? 4000 + rand() * 5000 : 6000 + rand() * 7000), (i) => i === 7 || i === 18);
      expect(honest).toMatchObject({ ranked: true, inhuman: false, held: false });
      expect(honest.solved as number).toBeGreaterThanOrEqual(15);
      expect(mine((await f.board(human, 'rush?period=all')).rows)).toEqual(['Honest']);

      // The admin flag view lists the held runs, oldest first; confirming one puts it on the board, rejecting keeps it off.
      expect((await f.call('GET', '/api/admin/puzzle-flags', undefined, human.auth)).status).toBe(401);
      const queue = await f.call('GET', '/api/admin/puzzle-flags', undefined, admin);
      expect(queue.status, queue.body).toBe(200);
      const runs = queue.json.heldRuns as Array<Record<string, unknown>>;
      // The scripts' runs wait there too, oldest first, for the admin to reject.
      expect(runs.map((r) => r.userId)).toEqual([script.userId, even.userId, strong.userId, strong2.userId]);
      expect(runs[2]).toMatchObject({ runId: held.runId, solved: held.solved, held: true, ranked: false, account: { id: strong.userId, displayName: 'Strong' } });
      for (const r of [scripted, evenScript]) expect((await f.call('POST', `/api/admin/puzzle-flags/rush-runs/${r.runId}`, { action: 'reject' }, admin)).json).toMatchObject({ ok: true, run: { held: false, ranked: false } });
      expect((await f.call('POST', `/api/admin/puzzle-flags/rush-runs/${held.runId}`, { action: 'confirm' }, human.auth)).status).toBe(401);
      expect((await f.call('POST', `/api/admin/puzzle-flags/rush-runs/${held.runId}`, { action: 'ban' }, admin)).json.error).toBe('invalid');
      expect((await f.call('POST', `/api/admin/puzzle-flags/rush-runs/${honest.runId}`, { action: 'confirm' }, admin)).status).toBe(404);
      expect((await f.call('POST', `/api/admin/puzzle-flags/rush-runs/${held.runId}`, { action: 'confirm' }, admin)).json).toMatchObject({ ok: true, run: { runId: held.runId, held: false, ranked: true } });
      expect((await f.call('POST', `/api/admin/puzzle-flags/rush-runs/${held2.runId}`, { action: 'reject' }, admin)).json).toMatchObject({ ok: true, run: { held: false, ranked: false } });
      // A decided run is no longer held: deciding it again finds nothing.
      expect((await f.call('POST', `/api/admin/puzzle-flags/rush-runs/${held.runId}`, { action: 'reject' }, admin)).status).toBe(404);
      expect((await f.call('GET', '/api/admin/puzzle-flags', undefined, admin)).json.heldRuns).toEqual([]);
      expect(mine((await f.board(human, 'rush?period=all')).rows)).toEqual(['Honest', 'Strong']);
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

describe('plausible answer times', () => {
  const at = (ms: number[], wrongAt: number[] = []) => {
    let t = 0;
    return ms.map((x, i) => ({ servedAt: t, answeredAt: (t += x), correct: !wrongAt.includes(i) }));
  };
  const uneven = (n: number, mean: number) => Array.from({ length: n }, (_, i) => Math.round(mean * [0.6, 1.4, 1.0, 0.8, 1.2][i % 5]));
  it('needs fifteen answers before it judges', () => {
    expect(rushTiming(at(Array(14).fill(500))).inhuman).toBeNull();
    expect(rushTiming(at(Array(15).fill(500))).inhuman).not.toBeNull();
  });
  it('marks 95% right at under 3 s an answer, and not 94% or 3 s', () => {
    expect(rushTiming(at(uneven(20, 2999), [0])).inhuman).toMatch(/19 of 20 right/);
    // At 3.0 s an answer on average, slowing down on the hard puzzles as people do (an even 3 s pace is the slowdown rule's).
    expect(rushTiming(at([...uneven(15, 2600), ...uneven(5, 4200)], [0])).inhuman).toBeNull();
    expect(rushTiming(at(uneven(17, 2000), [0])).inhuman).toBeNull();
  });
  it('marks machine-steady answer times (coefficient of variation under 0.15)', () => {
    const steady = Array.from({ length: 20 }, (_, i) => 6000 + (i % 2 ? 800 : -800));
    expect(rushTiming(at(steady, [1, 5, 9])).inhuman).toMatch(/machine-steady/);
    const loose = Array.from({ length: 20 }, (_, i) => 6000 + (i % 2 ? 1000 : -1000));
    expect(rushTiming(at(loose, [1, 5, 9])).inhuman).toBeNull();
  });
  it('marks more than three answers under 0.8 s', () => {
    const snaps = (n: number) => uneven(20, 7000).map((x, i) => (i < n ? 799 : x));
    expect(rushTiming(at(snaps(3), [1, 5, 9])).inhuman).toBeNull();
    expect(rushTiming(at(snaps(4), [1, 5, 9])).inhuman).toMatch(/4 answers under 800 ms/);
  });
  it('sends a run no slower on its hard puzzles than on its first fifteen to an admin, from five hard answers on, without calling it inhuman', () => {
    const run = (early: number, late: number, hard: number) => at([...uneven(RUSH_SLOWDOWN_EARLY, early), ...uneven(hard, late)], [1, 9]);
    expect(rushTiming(run(3000, 3000, 5))).toMatchObject({ inhuman: null, review: expect.stringMatching(/no slower on hard puzzles \(3\.00 s an answer against 3\.00 s on the first 15\)/) });
    expect(rushTiming(run(3000, 3000, 4)).review).toBeNull();
    // 1.2 times as long is enough; just under is not.
    expect(rushTiming(run(3000, 3600, 5)).review).toBeNull();
    expect(rushTiming(run(3000, 3590, 5)).review).toMatch(/no slower/);
    // Faster on the hard puzzles counts too, but not at a hard pace of 6 s or more, where a run solves no more than an honest one.
    expect(rushTiming(run(8000, 5990, 5)).review).toMatch(/no slower/);
    expect(rushTiming(run(8000, 6000, 5)).review).toBeNull();
    expect(rushTiming(run(8000, 5990, 5)).inhuman).toBeNull();
  });
  it('has the thresholds the API documents', () => {
    expect([RUSH_TIMING_MIN_ANSWERS, RUSH_ACCURATE_SHARE, RUSH_ACCURATE_PACE_MS, RUSH_STEADY_CV, RUSH_SNAP_MS, RUSH_SNAP_MAX, RUSH_TIMING_FLAG_WEIGHT]).toEqual([15, 0.95, 3000, 0.15, 800, 3, 2]);
    expect([RUSH_SLOWDOWN_EARLY, RUSH_SLOWDOWN_MIN_HARD, RUSH_SLOWDOWN_MIN_RATIO, RUSH_SLOWDOWN_PACE_MS, RUSH_HOLD_SOLVED]).toEqual([15, 5, 1.2, 6000, 35]);
  });
});

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

  it('meters Rush answers in their own bucket, so a quick player is not stopped by the submission limit', async () => {
    const f = fixture(createMemoryRepos(), { limits: true });
    const a = await f.guest('Quick');
    await f.plan(a);
    const run = await f.startRush(a);
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await f.answer(a, run.runId, i, right(rushRunPuzzle(run.seed, i)))).status);
    expect(codes.slice(0, 60).every((c) => c === 200)).toBe(true);
    expect(codes[60]).toBe(429);
    // The 60 answers did not use the account's 20 submissions a minute.
    expect((await f.call('POST', '/api/puzzles/daily/start', { date: TODAY }, a.auth)).status).toBe(200);
  });
});

describe('the daily puzzle is made once per date', () => {
  it('keeps the puzzle of the dates used last and makes a dropped date again', () => {
    const made: number[] = [];
    const daily = dailyPuzzleCache((day) => {
      made.push(day.getTime());
      return dailyPuzzle(day);
    });
    const day = (n: number) => new Date(Date.UTC(2026, 10, 16 + n));
    const first = daily(day(0));
    expect(first).toEqual(dailyPuzzleForKey(TODAY));
    expect(daily(day(0))).toBe(first);
    expect(made).toHaveLength(1);
    // Dates 1 to 4 fill the cache past its size: date 0, used longest ago, is dropped.
    for (let n = 1; n <= DAILY_CACHE_SIZE; n++) daily(day(n));
    expect(made).toHaveLength(1 + DAILY_CACHE_SIZE);
    daily(day(DAILY_CACHE_SIZE));
    expect(made).toHaveLength(1 + DAILY_CACHE_SIZE);
    expect(daily(day(0))).toEqual(first);
    expect(made).toHaveLength(2 + DAILY_CACHE_SIZE);
    // Kept now: dates 2, 3, 4 and 0. Using date 2 again moves it to the back, so a new date
    // drops date 3 (used longest ago), not date 2.
    daily(day(2));
    daily(day(-1));
    const before = made.length;
    daily(day(2));
    expect(made).toHaveLength(before);
    daily(day(3));
    expect(made).toHaveLength(before + 1);
  });

  it('makes a date\'s puzzle once for every start and answer on the server', async () => {
    const made: string[] = [];
    const f = fixture(createMemoryRepos(), {
      dailyPuzzle: (day) => {
        made.push(day.toISOString().slice(0, 10));
        return dailyPuzzle(day);
      },
    });
    const players = [await f.guest('Ana'), await f.guest('Bo'), await f.guest('Cy')];
    for (const [i, g] of players.entries()) {
      const res = await f.daily(g, TODAY, i === 1 ? dailyWrong(TODAY) : dailyRight(TODAY), 20);
      expect(res.status, res.body).toBe(200);
      expect(res.json).toMatchObject({ correct: i !== 1, revealed: dailyPuzzleForKey(TODAY) });
    }
    expect(made).toEqual([TODAY]);
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
