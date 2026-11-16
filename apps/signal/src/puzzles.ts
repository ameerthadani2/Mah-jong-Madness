/**
 * Server-verified puzzle results, the puzzle rating and the leaderboards (docs/API.md, "Puzzles
 * and leaderboards").
 *
 * The server never takes a client's word for a result. Opening the daily puzzle starts an attempt
 * for the local date key the app plays (one per account and key, so reopening keeps the clock);
 * the answer finishes it, the server regenerates that day's puzzle with the engine, judges the
 * answer against the accepted set and takes the time from its own clock. A Puzzle Rush run is issued here (seed and start time), and finishing
 * it sends the answers in order: each puzzle is regenerated from the seed and judged, the run
 * stops at the third wrong answer as in the app, and the score comes from the server's clock.
 * Every verified answer moves the account's one puzzle rating with the engine's rules
 * (`ratePuzzleAnswer`, the same steps the app applies on the device).
 *
 * Boards list live, visible, unbanned accounts only, with the account's name as the club rules
 * clean it (a name the blocklist refuses shows as "Player XXXX").
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  dailyPuzzleDifficulty,
  dateOfDailyKey,
  DEFAULT_PUZZLE_RATING,
  isPuzzleAnswerInput,
  judgePuzzleAnswer,
  judgeRushAnswer,
  randomHex,
  ratePuzzleAnswer,
  RUSH_SECONDS,
  RUSH_STRIKES,
  rushScore,
  utcDateKey,
  dailyPuzzle,
  type PuzzleAnswerInput,
  type PuzzleDifficulty,
  type PuzzleType,
  type RushVerdict,
} from '@mjm/engine';
import type { ClubRegistry } from './clubs';
import { LIMITS } from './config';
import { BucketTable, cleanField, DAY_MS } from './limits';
import { nameAllowed } from './moderation';
import type { BoardPage, BoardRow, Repos, UserRecord } from './repos/types';

/** How long an issued Rush run may be finished: a run lasts three minutes, so this is generous. */
export const RUSH_RUN_TTL_MS = 30 * 60_000;
/** The rating board lists accounts with at least this many verified answers. */
export const RATING_BOARD_MIN_RATED = 20;
/** Rows a board lists at most. */
export const BOARD_LIMIT = 100;
/** Ranked Puzzle Rush runs a day (UTC) for an account without Coach Gold or The Four Winds Club; a run counts when it is issued. */
export const FREE_RUSH_RUNS_PER_DAY = 1;
/** The longest time a daily answer is ranked with (the server's time from start to answer); longer is stored as this. */
export const DAILY_MAX_SECONDS = 3600;

/** A refusal with an HTTP status and an `error` code (docs/API.md). */
export class PuzzleError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PuzzleError';
  }
}

/** What a handler needs from the API's request context. */
export interface PuzzleCtx {
  params: Record<string, string>;
  body: Record<string, unknown>;
  req: IncomingMessage;
  ip: string;
  caller(): Promise<{ userId: string; user: UserRecord }>;
}

export type PuzzleRouteFactory<R> = (method: string, path: string, handler: (ctx: PuzzleCtx) => unknown) => R;

export interface PuzzleDeps {
  repos: Repos;
  clubs: ClubRegistry;
  now?: () => number;
  /** A non-200 answer (the API's Reply). */
  reply: (status: number, body?: unknown) => unknown;
  /** Yields between regenerated Rush puzzles so a long run does not hold up the tables (default: setImmediate). */
  yieldTurn?: () => Promise<void>;
  /** Per-account bucket for submissions (default `LIMITS.puzzleSubmitsPerMinute` a minute). */
  submitLimiter?: BucketTable<string>;
  /** Per-account bucket for board and rating reads (default `LIMITS.leaderboardReadsPerMinute` a minute). */
  readLimiter?: BucketTable<string>;
  /** Per-address bucket for Rush starts (default `LIMITS.rushStartsPerHourPerIp` an hour). */
  rushIpLimiter?: BucketTable<string>;
  /**
   * Whether the account has unlimited ranked Rush (Coach Gold or The Four Winds Club; the API
   * passes the wallet's check). Without it an account starts `FREE_RUSH_RUNS_PER_DAY` runs a UTC day.
   * Default: nobody has it.
   */
  unlimitedRush?: (userId: string) => Promise<boolean>;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** A board name: the account's name cleaned as everywhere else, or "Player XXXX" when it is empty or the blocklist refuses it. */
export function boardName(userId: string, displayName: string): string {
  const name = cleanField(displayName, 24);
  return name && nameAllowed(name) ? name : `Player ${userId.replace(/-/g, '').slice(0, 4).toUpperCase()}`;
}

/** Midnight UTC of the day `ms` falls in, and of the Monday of its week. */
export function dayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}
export function weekStart(ms: number): number {
  const day = dayStart(ms);
  const weekday = (new Date(day).getUTCDay() + 6) % 7; // Monday 0
  return day - weekday * DAY_MS;
}

/** Applies verified answers to the account's rating, in order, inside the caller's transaction. */
async function applyRatings(tx: Repos, userId: string, answers: Array<{ type: PuzzleType; difficulty: PuzzleDifficulty; correct: boolean }>, at: number) {
  const current = await tx.puzzleRatings.getForUpdate(userId);
  const before = current?.rating ?? DEFAULT_PUZZLE_RATING;
  let rating = before;
  const after: number[] = [];
  for (const a of answers) {
    rating = ratePuzzleAnswer(rating, a.type, a.difficulty, a.correct).rating;
    after.push(rating);
  }
  const rated = (current?.rated ?? 0) + answers.length;
  if (answers.length > 0) await tx.puzzleRatings.set({ userId, rating, rated, updatedAt: at });
  return { rating: { rating, change: rating - before, rated }, after };
}

const ratingJson = (r: { rating: number; change: number; rated: number }) => ({ rating: r.rating, change: r.change, rated: r.rated });

/** A board answer: rows and the caller's own row, with names as boards show them. */
function boardJson(page: BoardPage, value: (row: BoardRow) => Record<string, unknown>) {
  const row = (r: BoardRow) => ({ rank: r.rank, userId: r.userId, displayName: boardName(r.userId, r.displayName), avatar: cleanField(r.avatar ?? '', 16) || null, ...value(r) });
  return { rows: page.rows.map(row), me: page.me ? { ...row(page.me), hidden: page.me.hidden } : null };
}

/**
 * The date a daily key stands for, if that puzzle is open at `at`: time zones run from UTC−12 to
 * UTC+14, so a player's local date is never more than a day from the server's UTC date.
 */
function openDailyKey(key: unknown, at: number): Date {
  const day = dateOfDailyKey(key);
  if (!day) throw new PuzzleError(400, 'invalid', 'date must be a YYYY-MM-DD date key');
  const today = dateOfDailyKey(utcDateKey(at))!;
  if (Math.abs(day.getTime() - today.getTime()) > DAY_MS) throw new PuzzleError(400, 'date_out_of_range', 'That daily puzzle is not open: the date must be within a day of today');
  return day;
}

export function puzzleRoutes<R>(r: PuzzleRouteFactory<R>, deps: PuzzleDeps): R[] {
  const { repos, clubs } = deps;
  const now = deps.now ?? Date.now;
  const yieldTurn = deps.yieldTurn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const submits = deps.submitLimiter ?? new BucketTable<string>(LIMITS.puzzleSubmitsPerMinute, LIMITS.puzzleSubmitsPerMinute / 60, { now });
  const reads = deps.readLimiter ?? new BucketTable<string>(LIMITS.leaderboardReadsPerMinute, LIMITS.leaderboardReadsPerMinute / 60, { now });
  const rushByIp = deps.rushIpLimiter ?? new BucketTable<string>(LIMITS.rushStartsPerHourPerIp, LIMITS.rushStartsPerHourPerIp / 3600, { now });

  const submitter = async (ctx: PuzzleCtx) => {
    const me = await ctx.caller();
    if (!submits.take(me.userId)) throw new PuzzleError(429, 'rate_limited', 'Too many puzzle submissions; please slow down');
    return me;
  };
  const reader = async (ctx: PuzzleCtx) => {
    const me = await ctx.caller();
    if (!reads.take(me.userId)) throw new PuzzleError(429, 'rate_limited', 'Too many leaderboard reads; please slow down');
    return me;
  };
  const query = (ctx: PuzzleCtx) => new URL(ctx.req.url ?? '/', 'http://localhost').searchParams;
  /** The board's scope: everyone, or one club the caller belongs to (`?club=CODE`). */
  const scope = (ctx: PuzzleCtx, userId: string): { userIds: string[] | null; club: string | null } => {
    const code = query(ctx).get('club');
    if (code === null || code === '') return { userIds: null, club: null };
    const club = clubs.club(code);
    if (!clubs.isMember(club.code, userId)) throw new PuzzleError(403, 'forbidden', 'Join the club first');
    return { userIds: club.members.map((m) => m.userId), club: club.code };
  };

  return [
    // ------------------------------------------------------------------ the daily puzzle
    r('POST', '/api/puzzles/daily/start', async (ctx) => {
      const me = await submitter(ctx);
      const date = ctx.body.date;
      const at = now();
      openDailyKey(date, at);
      const attempt = await repos.dailyAttempts.start({ id: randomUUID(), userId: me.userId, dateKey: date as string, startedAt: at });
      if (attempt.finishedAt !== null) throw new PuzzleError(409, 'already_played', 'You have already played this daily puzzle');
      return { attemptId: attempt.id, date: attempt.dateKey, startedAt: iso(attempt.startedAt) };
    }),
    r('POST', '/api/puzzles/daily', async (ctx) => {
      const me = await submitter(ctx);
      // A `seconds` (or `correct`) in the body is ignored: the time is the server's, from the attempt's start.
      const { attemptId, answer } = ctx.body;
      if (typeof attemptId !== 'string' || attemptId === '') throw new PuzzleError(400, 'invalid', 'attemptId must name a started daily attempt');
      const attempt = await repos.dailyAttempts.get(attemptId);
      if (!attempt || attempt.userId !== me.userId) throw new PuzzleError(404, 'not_found', 'No such daily puzzle attempt');
      if (attempt.finishedAt !== null) throw new PuzzleError(409, 'already_played', 'You have already played this daily puzzle');
      if (!isPuzzleAnswerInput(answer)) throw new PuzzleError(400, 'invalid_answer', 'answer must be a tile, a list of tiles or a claim option id');
      const at = now();
      const day = openDailyKey(attempt.dateKey, at);
      const correct = judgePuzzleAnswer(dailyPuzzle(day), answer);
      const difficulty = dailyPuzzleDifficulty(day);
      const seconds = Math.min(DAILY_MAX_SECONDS, Math.round(Math.max(0, at - attempt.startedAt) / 1000));
      const key = attempt.dateKey;
      const result = await repos.transaction(async (tx) => {
        // An attempt is finished once; throwing below undoes this and the rating step together.
        if (!(await tx.dailyAttempts.finish(attempt.id, at))) throw new PuzzleError(409, 'already_played', 'You have already played this daily puzzle');
        const { rating, after } = await applyRatings(tx, me.userId, [{ type: 'discard', difficulty, correct }], at);
        const row = await tx.puzzleResults.recordDaily({ userId: me.userId, puzzleKey: key, correct, seconds, ratingAfter: after[0], createdAt: at });
        // Only the first attempt per date key is ranked and rated.
        if (!row) throw new PuzzleError(409, 'already_played', 'You have already played this daily puzzle');
        return { rating, row };
      });
      return { date: key, correct, seconds: result.row.seconds, rating: ratingJson(result.rating) };
    }),

    // ------------------------------------------------------------------ Puzzle Rush
    r('POST', '/api/puzzles/rush', async (ctx) => {
      const me = await submitter(ctx);
      if (!rushByIp.take(ctx.ip)) throw new PuzzleError(429, 'rate_limited', 'Too many Puzzle Rush runs from this address; try again later');
      const at = now();
      const unlimited = deps.unlimitedRush ? await deps.unlimitedRush(me.userId) : false;
      const run = await repos.transaction(async (tx) => {
        if (!unlimited) {
          // The account's row is locked first, so two starts at once cannot both take the last free run.
          await tx.puzzleRatings.getForUpdate(me.userId);
          // A run counts when it is issued, finished or not: abandoning a run does not give it back.
          if ((await tx.rushRuns.countStartedSince(me.userId, dayStart(at))) >= FREE_RUSH_RUNS_PER_DAY) {
            throw new PuzzleError(403, 'rush_daily_limit', 'Free accounts get one ranked Puzzle Rush a day; Coach Gold makes it unlimited');
          }
        }
        return tx.rushRuns.create({ id: randomUUID(), userId: me.userId, seed: `rush-${randomHex(8)}`, startedAt: at, expiresAt: at + RUSH_RUN_TTL_MS });
      });
      return deps.reply(201, { runId: run.id, seed: run.seed, startedAt: iso(run.startedAt), expiresAt: iso(run.expiresAt), seconds: RUSH_SECONDS, strikes: RUSH_STRIKES });
    }),
    r('POST', '/api/puzzles/rush/:runId/finish', async (ctx) => {
      const me = await submitter(ctx);
      const run = await repos.rushRuns.get(ctx.params.runId);
      if (!run || run.userId !== me.userId) throw new PuzzleError(404, 'run_not_found', 'No such Puzzle Rush run');
      if (run.finishedAt !== null) throw new PuzzleError(409, 'run_finished', 'This run has already been finished');
      const at = now();
      if (at > run.expiresAt) throw new PuzzleError(410, 'run_expired', 'This run has expired; start a new one');
      const answers = ctx.body.answers;
      if (!Array.isArray(answers)) throw new PuzzleError(400, 'invalid', 'answers must be a list');
      if (!answers.every(isPuzzleAnswerInput)) throw new PuzzleError(400, 'invalid_answer', 'Each answer must be a tile, a list of tiles or a claim option id');
      // The server's clock, never the client's: the run's time is from issue to finish, at most the run's length.
      const elapsedMs = Math.max(0, at - run.startedAt);
      const seconds = Math.min(RUSH_SECONDS, Math.round(elapsedMs / 1000));
      // Nobody answers more than one puzzle a second (and no run can hold more than its length in seconds).
      if (answers.length > Math.min(RUSH_SECONDS, Math.max(1, Math.ceil(elapsedMs / 1000)))) throw new PuzzleError(400, 'rush_too_fast', 'More answers than the run had time for');
      const verdicts: RushVerdict[] = [];
      let wrong = 0;
      for (let i = 0; i < answers.length && wrong < RUSH_STRIKES; i++) {
        if (i > 0) await yieldTurn();
        const v = judgeRushAnswer(run.seed, i, answers[i] as PuzzleAnswerInput);
        verdicts.push(v);
        if (!v.correct) wrong++;
      }
      const solved = verdicts.length - wrong;
      const score = rushScore(solved, seconds);
      const outcome = await repos.transaction(async (tx) => {
        const finished = await tx.rushRuns.finish(run.id, { finishedAt: at, solved, wrong, seconds, score });
        if (!finished) throw new PuzzleError(409, 'run_finished', 'This run has already been finished');
        const { rating, after } = await applyRatings(tx, me.userId, verdicts, at);
        for (const [i, v] of verdicts.entries()) {
          await tx.puzzleResults.record({ userId: me.userId, kind: 'rush', puzzleKey: `${run.id}:${v.index}`, correct: v.correct, seconds: 0, ratingAfter: after[i], createdAt: at });
        }
        return rating;
      });
      return {
        runId: run.id,
        solved,
        wrong,
        seconds,
        score,
        answers: verdicts.map((v) => ({ index: v.index, type: v.type, correct: v.correct })),
        rating: ratingJson(outcome),
      };
    }),

    // ------------------------------------------------------------------ rating and boards
    r('GET', '/api/puzzles/rating', async (ctx) => {
      const me = await reader(ctx);
      const row = await repos.puzzleRatings.get(me.userId);
      return { rating: row?.rating ?? DEFAULT_PUZZLE_RATING, rated: row?.rated ?? 0, updatedAt: row ? iso(row.updatedAt) : null };
    }),
    r('GET', '/api/leaderboards/daily', async (ctx) => {
      const me = await reader(ctx);
      const date = query(ctx).get('date') ?? utcDateKey(now());
      if (!dateOfDailyKey(date)) throw new PuzzleError(400, 'invalid', 'date must be a YYYY-MM-DD date key');
      const s = scope(ctx, me.userId);
      const page = await repos.leaderboards.daily(date, { viewerId: me.userId, userIds: s.userIds, limit: BOARD_LIMIT });
      return { board: 'daily', date, scope: s.club ? 'club' : 'global', club: s.club, ...boardJson(page, (row) => ({ value: row.tiebreak, solved: row.score === 1 })) };
    }),
    r('GET', '/api/leaderboards/rush', async (ctx) => {
      const me = await reader(ctx);
      const period = query(ctx).get('period') ?? 'day';
      const at = now();
      const since = period === 'day' ? dayStart(at) : period === 'week' ? weekStart(at) : period === 'all' ? 0 : null;
      if (since === null) throw new PuzzleError(400, 'invalid', 'period must be day, week or all');
      const s = scope(ctx, me.userId);
      const page = await repos.leaderboards.rush(since, { viewerId: me.userId, userIds: s.userIds, limit: BOARD_LIMIT });
      return { board: 'rush', period, since: iso(since), scope: s.club ? 'club' : 'global', club: s.club, ...boardJson(page, (row) => ({ value: row.score, solved: row.count })) };
    }),
    r('GET', '/api/leaderboards/rating', async (ctx) => {
      const me = await reader(ctx);
      const s = scope(ctx, me.userId);
      const page = await repos.leaderboards.rating(RATING_BOARD_MIN_RATED, { viewerId: me.userId, userIds: s.userIds, limit: BOARD_LIMIT });
      return { board: 'rating', minRated: RATING_BOARD_MIN_RATED, scope: s.club ? 'club' : 'global', club: s.club, ...boardJson(page, (row) => ({ value: row.score, rated: row.count })) };
    }),
  ];
}
