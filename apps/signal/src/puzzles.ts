/**
 * Server-verified puzzle results, the puzzle rating and the leaderboards (docs/API.md, "Puzzles
 * and leaderboards").
 *
 * The server never takes a client's word for a result. Opening the daily puzzle starts an attempt
 * for the local date key the app plays (one per account and key, so reopening keeps the clock)
 * and serves the puzzle as its question; the answer finishes it and reveals the whole puzzle, the server regenerates that day's puzzle with the engine, judges the
 * answer against the accepted set and takes the time from its own clock. A ranked Puzzle Rush run
 * is played one puzzle at a time: the server keeps the run's seed, serves a puzzle (as its
 * question, `puzzleQuestion`: no answer, no analysis, no explanation) only once the previous answer
 * has arrived, reveals the whole puzzle with the verdict on its answer, and judges and stamps each answer as it comes; the run stops at the
 * third wrong answer as in the app, and its time, score and plausibility come from those stamps
 * (`rushTiming`). A verified daily answer moves the account's one puzzle rating with the engine's
 * rules (`ratePuzzleAnswer`, the same steps the app applies on the device); Puzzle Rush does not
 * move it (`movesPuzzleRating`, the engine's one rule for the app and the server).
 *
 * Boards list live, visible, unbanned accounts only, with the account's name as the club rules
 * clean it (a name the blocklist refuses shows as "Player XXXX").
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  dailyPuzzleDifficulty,
  dateOfDailyKey,
  DEFAULT_PUZZLE_RATING,
  isPuzzleAnswerInput,
  judgePuzzleAnswer,
  movesPuzzleRating,
  randomHex,
  ratePuzzleAnswer,
  RUSH_SECONDS,
  RUSH_STRIKES,
  puzzleDifficulty,
  rushDifficultyAt,
  rushRunPuzzle,
  rushScore,
  utcDateKey,
  dailyPuzzle,
  puzzleQuestion,
  type DiscardPuzzle,
  type PuzzleAnswerInput,
  type PuzzleQuestion,
  type PuzzleDifficulty,
  type PuzzleType,
  type AnyPuzzle,
} from "@mjm/engine";
import type { ClubRegistry } from "./clubs";
import { LIMITS } from "./config";
import { BucketTable, cleanField, DAY_MS } from "./limits";
import { nameAllowed } from "./moderation";
import type {
  BoardPage,
  BoardRow,
  RecentPuzzleResult,
  Repos,
  RushAnswerRecord,
  RushRunRecord,
  UserRecord,
} from "./repos/types";

/** How long an issued Rush run may be finished: a run lasts three minutes, so this is generous. */
export const RUSH_RUN_TTL_MS = 30 * 60_000;
/** The rating board lists accounts with at least this many verified answers. */
export const RATING_BOARD_MIN_RATED = 20;
/** Rows a board lists at most. */
export const BOARD_LIMIT = 100;
/** Ranked Puzzle Rush runs a day (UTC) for an account without Coach Gold or The Four Winds Club; a run counts when it is issued. */
export const FREE_RUSH_RUNS_PER_DAY = 1;
/**
 * Human-time floors (docs/API.md, "Human-time floors"). A daily answer the server timed under
 * `DAILY_RANK_FLOOR_MS` is recorded as solved (or not) but not ranked or rated: nobody reads a
 * sixteen-tile hand and answers in that time, only a script that computed the answer from the
 * date. A Rush run whose judged answers average under `RUSH_RANK_FLOOR_MS` each is recorded but
 * not ranked.
 */
export const DAILY_RANK_FLOOR_MS = 3000;
export const RUSH_RANK_FLOOR_MS = 1500;
/**
 * Automation flags (docs/API.md, "Automation flags"). After every daily answer and Rush run the
 * server reads the account's last `FLAG_WINDOW` results (ranked or not; only those after an admin
 * last cleared a flag) and flags the account when at least `FLAG_MIN_INHUMAN` of them are at a
 * floor or perfect at a pace no person reaches (`inhumanResult`). A flagged account is on no board.
 *
 * The thresholds come from the fourth assessment's script (daily in 0 s, Rush 40 of 40 at 1 s an
 * answer) and an honest-paced probe (daily in 6 s or more, Rush at about 6 s an answer with
 * mistakes): a daily answer within 2 s of its floor, a Rush run of 5 answers or more within 0.5 s
 * of its floor, or a perfect run of 10 or more at under 3 s an answer.
 */
export const FLAG_WINDOW = 10;
export const FLAG_MIN_INHUMAN = 2;
export const DAILY_INHUMAN_SECONDS = 5;
export const RUSH_INHUMAN_PACE_SECONDS = 2;
export const RUSH_PERFECT_PACE_SECONDS = 3;
export const RUSH_PERFECT_MIN_SOLVED = 10;

/**
 * Plausible answer times (docs/API.md, "Plausible answer times"). With each Rush answer stamped by
 * the server, a run of at least `RUSH_TIMING_MIN_ANSWERS` answers is inhuman when it is right on
 * `RUSH_ACCURATE_SHARE` or more of them at under `RUSH_ACCURATE_PACE_MS` an answer, when its answer
 * times are machine-steady (coefficient of variation under `RUSH_STEADY_CV`), or when more than
 * `RUSH_SNAP_MAX` answers came under `RUSH_SNAP_MS`. An inhuman run is recorded, kept off the Rush
 * board and counted toward the automation flag (`inhumanResult`).
 *
 * Provisional until there are real players: set from the fifth assessment's paced script (89
 * answers every 2.02 s with one deliberate mistake) and a simulated honest player (4 to 12 s an
 * answer, a few mistakes), not from measured play.
 */
export const RUSH_TIMING_MIN_ANSWERS = 15;
export const RUSH_ACCURATE_SHARE = 0.95;
export const RUSH_ACCURATE_PACE_MS = 3000;
export const RUSH_STEADY_CV = 0.15;
export const RUSH_SNAP_MS = 800;
export const RUSH_SNAP_MAX = 3;
/**
 * A Rush run judged inhuman by its answer times counts as this many results toward the flag: the
 * stamps of fifteen answers or more are stronger evidence than one total time, so one such run is
 * enough to flag the account (an admin clears a flag that was wrong).
 */
export const RUSH_TIMING_FLAG_WEIGHT = 2;
/** An answer stamped this long after the run's three minutes is not counted (it was made after the clock ran out on the phone). */
export const RUSH_ANSWER_GRACE_MS = 2000;

/** What the per-answer stamps say about a run: the answer times (ms), and why it is inhuman (null when it is not). */
export function rushTiming(
  answers: ReadonlyArray<
    Pick<RushAnswerRecord, "servedAt" | "answeredAt" | "correct">
  >,
): { ms: number[]; inhuman: string | null } {
  const ms = answers.map((a) => Math.max(0, a.answeredAt - a.servedAt));
  const n = ms.length;
  if (n < RUSH_TIMING_MIN_ANSWERS) return { ms, inhuman: null };
  const mean = ms.reduce((a, b) => a + b, 0) / n;
  const right = answers.filter((a) => a.correct).length;
  if (right / n >= RUSH_ACCURATE_SHARE && mean < RUSH_ACCURATE_PACE_MS)
    return {
      ms,
      inhuman: `${right} of ${n} right at ${(mean / 1000).toFixed(2)} s an answer`,
    };
  const sd = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  const cv = mean > 0 ? sd / mean : 0;
  if (cv < RUSH_STEADY_CV)
    return {
      ms,
      inhuman: `answer times machine-steady (coefficient of variation ${cv.toFixed(3)})`,
    };
  const snaps = ms.filter((x) => x < RUSH_SNAP_MS).length;
  if (snaps > RUSH_SNAP_MAX)
    return { ms, inhuman: `${snaps} answers under ${RUSH_SNAP_MS} ms` };
  return { ms, inhuman: null };
}

/** A Rush puzzle as the server serves it before the answer: its question (`puzzleQuestion`), under an id that does not reveal the run's seed. */
export function servedRushQuestion(
  run: Pick<RushRunRecord, "id" | "seed">,
  index: number,
): { index: number; type: PuzzleType; question: PuzzleQuestion } {
  return rushQuestionOf(run, index, rushRunPuzzle(run.seed, index));
}
function rushQuestionOf(
  run: Pick<RushRunRecord, "id">,
  index: number,
  p: AnyPuzzle,
): { index: number; type: PuzzleType; question: PuzzleQuestion } {
  return {
    index,
    type: p.type,
    question: {
      ...puzzleQuestion(p, rushDifficultyAt(index)),
      seed: `${run.id}:${index}`,
    },
  };
}
/** A Rush puzzle as the server reveals it with the verdict on its answer: the whole puzzle, under the same id. */
export function revealedRushPuzzle(
  run: Pick<RushRunRecord, "id">,
  index: number,
  p: AnyPuzzle,
): AnyPuzzle {
  return { ...p, seed: `${run.id}:${index}` };
}

/** Whether one result is at a floor, perfect at a pace no person reaches, or a Rush run whose answer times were judged inhuman. */
export function inhumanResult(r: RecentPuzzleResult): boolean {
  if (r.kind === "daily") return r.seconds < DAILY_INHUMAN_SECONDS;
  if (r.inhuman) return true;
  if (r.answers < 5) return false;
  const pace = r.seconds / r.answers;
  return (
    pace < RUSH_INHUMAN_PACE_SECONDS ||
    (r.wrong === 0 &&
      r.solved >= RUSH_PERFECT_MIN_SOLVED &&
      pace < RUSH_PERFECT_PACE_SECONDS)
  );
}

/**
 * Flags the account when its recent results look automated, inside the caller's transaction. A
 * flagged or confirmed account is left as it is; after an admin's clear only later results count.
 */
export async function checkAutomation(
  tx: Repos,
  userId: string,
  at: number,
): Promise<boolean> {
  const flag = await tx.puzzleFlags.get(userId);
  if (flag && flag.status !== "cleared") return true;
  const recent = await tx.puzzleFlags.recentResults(
    userId,
    flag?.reviewedAt ?? -1,
    FLAG_WINDOW,
  );
  const inhuman = recent.filter(inhumanResult);
  const timed = inhuman.filter((r) => r.kind === "rush" && r.inhuman).length;
  if (inhuman.length + timed * (RUSH_TIMING_FLAG_WEIGHT - 1) < FLAG_MIN_INHUMAN)
    return false;
  const daily = inhuman.filter((r) => r.kind === "daily").length;
  await tx.puzzleFlags.flag(
    userId,
    `${inhuman.length} of the last ${recent.length} puzzle results at a human-time floor, perfect at an inhuman pace or with inhuman answer times (${daily} daily, ${inhuman.length - daily} Rush, ${timed} judged by answer times)`,
    at,
  );
  return true;
}

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
    this.name = "PuzzleError";
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

export type PuzzleRouteFactory<R> = (
  method: string,
  path: string,
  handler: (ctx: PuzzleCtx) => unknown,
) => R;

export interface PuzzleDeps {
  repos: Repos;
  clubs: ClubRegistry;
  now?: () => number;
  /** A non-200 answer (the API's Reply). */
  reply: (status: number, body?: unknown) => unknown;
  /** Per-account bucket for submissions (default `LIMITS.puzzleSubmitsPerMinute` a minute). */
  submitLimiter?: BucketTable<string>;
  /** Per-account bucket for Rush answers (default `LIMITS.rushAnswersPerMinute` a minute). */
  answerLimiter?: BucketTable<string>;
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
  return name && nameAllowed(name)
    ? name
    : `Player ${userId.replace(/-/g, "").slice(0, 4).toUpperCase()}`;
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

/**
 * Applies verified answers to the account's rating, in order, inside the caller's transaction.
 * With no answers (a mode that is not rated) it only reads the rating: change 0.
 */
async function applyRatings(
  tx: Repos,
  userId: string,
  answers: Array<{
    type: PuzzleType;
    difficulty: PuzzleDifficulty;
    correct: boolean;
  }>,
  at: number,
) {
  const current = await tx.puzzleRatings.getForUpdate(userId);
  const before = current?.rating ?? DEFAULT_PUZZLE_RATING;
  let rating = before;
  const after: number[] = [];
  for (const a of answers) {
    rating = ratePuzzleAnswer(rating, a.type, a.difficulty, a.correct).rating;
    after.push(rating);
  }
  const rated = (current?.rated ?? 0) + answers.length;
  if (answers.length > 0)
    await tx.puzzleRatings.set({ userId, rating, rated, updatedAt: at });
  return { rating: { rating, change: rating - before, rated }, after };
}

const ratingJson = (r: { rating: number; change: number; rated: number }) => ({
  rating: r.rating,
  change: r.change,
  rated: r.rated,
});

/** A board answer: rows and the caller's own row, with names as boards show them. */
function boardJson(
  page: BoardPage,
  value: (row: BoardRow) => Record<string, unknown>,
) {
  const row = (r: BoardRow) => ({
    rank: r.rank,
    userId: r.userId,
    displayName: boardName(r.userId, r.displayName),
    avatar: cleanField(r.avatar ?? "", 16) || null,
    ...value(r),
  });
  return {
    rows: page.rows.map(row),
    me: page.me
      ? { ...row(page.me), hidden: page.me.hidden, flagged: page.me.flagged }
      : null,
  };
}

/**
 * The date a daily key stands for, if that puzzle is open at `at`: time zones run from UTC−12 to
 * UTC+14, so a player's local date is never more than a day from the server's UTC date.
 */
function openDailyKey(key: unknown, at: number): Date {
  const day = dateOfDailyKey(key);
  if (!day)
    throw new PuzzleError(400, "invalid", "date must be a YYYY-MM-DD date key");
  const today = dateOfDailyKey(utcDateKey(at))!;
  if (Math.abs(day.getTime() - today.getTime()) > DAY_MS)
    throw new PuzzleError(
      400,
      "date_out_of_range",
      "That daily puzzle is not open: the date must be within a day of today",
    );
  return day;
}

export function puzzleRoutes<R>(
  r: PuzzleRouteFactory<R>,
  deps: PuzzleDeps,
): R[] {
  const { repos, clubs } = deps;
  const now = deps.now ?? Date.now;
  const submits =
    deps.submitLimiter ??
    new BucketTable<string>(
      LIMITS.puzzleSubmitsPerMinute,
      LIMITS.puzzleSubmitsPerMinute / 60,
      { now },
    );
  const answersBucket =
    deps.answerLimiter ??
    new BucketTable<string>(
      LIMITS.rushAnswersPerMinute,
      LIMITS.rushAnswersPerMinute / 60,
      { now },
    );
  const reads =
    deps.readLimiter ??
    new BucketTable<string>(
      LIMITS.leaderboardReadsPerMinute,
      LIMITS.leaderboardReadsPerMinute / 60,
      { now },
    );
  const rushByIp =
    deps.rushIpLimiter ??
    new BucketTable<string>(
      LIMITS.rushStartsPerHourPerIp,
      LIMITS.rushStartsPerHourPerIp / 3600,
      { now },
    );

  const submitter = async (ctx: PuzzleCtx) => {
    const me = await ctx.caller();
    if (!submits.take(me.userId))
      throw new PuzzleError(
        429,
        "rate_limited",
        "Too many puzzle submissions; please slow down",
      );
    return me;
  };
  const reader = async (ctx: PuzzleCtx) => {
    const me = await ctx.caller();
    if (!reads.take(me.userId))
      throw new PuzzleError(
        429,
        "rate_limited",
        "Too many leaderboard reads; please slow down",
      );
    return me;
  };
  const query = (ctx: PuzzleCtx) =>
    new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
  /** The board's scope: everyone, or one club the caller belongs to (`?club=CODE`). */
  const scope = (
    ctx: PuzzleCtx,
    userId: string,
  ): { userIds: string[] | null; club: string | null } => {
    const code = query(ctx).get("club");
    if (code === null || code === "") return { userIds: null, club: null };
    const club = clubs.club(code);
    if (!clubs.isMember(club.code, userId))
      throw new PuzzleError(403, "forbidden", "Join the club first");
    return { userIds: club.members.map((m) => m.userId), club: club.code };
  };

  /** The caller's run, still open at `at`. */
  const openRun = async (
    runId: string | undefined,
    userId: string,
    at: number,
  ): Promise<RushRunRecord> => {
    const run = await repos.rushRuns.get(runId ?? "");
    if (!run || run.userId !== userId)
      throw new PuzzleError(404, "run_not_found", "No such Puzzle Rush run");
    if (run.finishedAt !== null)
      throw new PuzzleError(
        409,
        "run_finished",
        "This run has already been finished",
      );
    if (at > run.expiresAt)
      throw new PuzzleError(
        410,
        "run_expired",
        "This run has expired; start a new one",
      );
    return run;
  };
  /** An answer is to the puzzle the run is waiting on: not one already answered, not one not yet served. */
  const checkServed = (run: RushRunRecord, index: number) => {
    if (index < run.servedIndex)
      throw new PuzzleError(
        409,
        "already_answered",
        "That puzzle has already been answered",
      );
    if (index > run.servedIndex)
      throw new PuzzleError(
        409,
        "not_served",
        "That puzzle has not been served yet: answer the one before it first",
      );
  };
  /**
   * Finishes a run from its stamped answers, inside the caller's transaction: the run's time is from
   * its start to `endAt` (the third wrong answer, the finish, or the end of the three minutes), at
   * most the run's length; the score comes from that time; the floor and the answer times decide
   * whether it is ranked.
   */
  const finishRun = async (
    tx: Repos,
    run: RushRunRecord,
    answers: RushAnswerRecord[],
    endAt: number,
  ) => {
    const wrong = answers.filter((x) => !x.correct).length;
    const solved = answers.length - wrong;
    const elapsedMs = Math.min(
      Math.max(0, endAt - run.startedAt),
      RUSH_SECONDS * 1000,
    );
    const seconds = Math.round(elapsedMs / 1000);
    const score = rushScore(solved, seconds);
    const timing = rushTiming(answers);
    // Under the floor (the answers average under 1.5 s each over the run's time) or inhuman answer times: recorded, not ranked.
    const underFloor =
      answers.length > 0 && elapsedMs / answers.length < RUSH_RANK_FLOOR_MS;
    const inhuman = timing.inhuman !== null;
    const ranked = !underFloor && !inhuman;
    const finished = await tx.rushRuns.finish(run.id, {
      finishedAt: endAt,
      solved,
      wrong,
      seconds,
      score,
      ranked,
      inhuman,
    });
    if (!finished)
      throw new PuzzleError(
        409,
        "run_finished",
        "This run has already been finished",
      );
    // Rush answers do not move the rating (the engine's `movesPuzzleRating('rush')`): `rating` reports it unchanged.
    const rated = movesPuzzleRating("rush")
      ? answers.map((x) => ({
          type: x.type,
          difficulty: puzzleDifficulty(
            rushRunPuzzle(run.seed, x.index),
            rushDifficultyAt(x.index),
          ),
          correct: x.correct,
        }))
      : [];
    const { rating, after } = await applyRatings(tx, run.userId, rated, endAt);
    for (const [i, x] of answers.entries()) {
      await tx.puzzleResults.record({
        userId: run.userId,
        kind: "rush",
        puzzleKey: `${run.id}:${x.index}`,
        correct: x.correct,
        seconds: Math.round(timing.ms[i] / 1000),
        ratingAfter: after[i] ?? null,
        createdAt: endAt,
      });
    }
    await checkAutomation(tx, run.userId, endAt);
    return {
      runId: run.id,
      solved,
      wrong,
      seconds,
      score,
      ranked,
      inhuman,
      answers: answers.map((x, i) => ({
        index: x.index,
        type: x.type,
        correct: x.correct,
        ms: timing.ms[i],
      })),
      rating: ratingJson(rating),
    };
  };

  return [
    // ------------------------------------------------------------------ the daily puzzle
    r("POST", "/api/puzzles/daily/start", async (ctx) => {
      const me = await submitter(ctx);
      const date = ctx.body.date;
      const at = now();
      const day = openDailyKey(date, at);
      const attempt = await repos.dailyAttempts.start({
        id: randomUUID(),
        userId: me.userId,
        dateKey: date as string,
        startedAt: at,
      });
      if (attempt.finishedAt !== null)
        throw new PuzzleError(
          409,
          "already_played",
          "You have already played this daily puzzle",
        );
      // The puzzle is served as its question; the whole puzzle comes back with the verdict.
      return {
        attemptId: attempt.id,
        date: attempt.dateKey,
        startedAt: iso(attempt.startedAt),
        question: puzzleQuestion(dailyPuzzle(day), dailyPuzzleDifficulty(day)),
      };
    }),
    r("POST", "/api/puzzles/daily", async (ctx) => {
      const me = await submitter(ctx);
      // A `seconds` (or `correct`) in the body is ignored: the time is the server's, from the attempt's start.
      const { attemptId, answer } = ctx.body;
      if (typeof attemptId !== "string" || attemptId === "")
        throw new PuzzleError(
          400,
          "invalid",
          "attemptId must name a started daily attempt",
        );
      const attempt = await repos.dailyAttempts.get(attemptId);
      if (!attempt || attempt.userId !== me.userId)
        throw new PuzzleError(404, "not_found", "No such daily puzzle attempt");
      if (attempt.finishedAt !== null)
        throw new PuzzleError(
          409,
          "already_played",
          "You have already played this daily puzzle",
        );
      if (!isPuzzleAnswerInput(answer))
        throw new PuzzleError(
          400,
          "invalid_answer",
          "answer must be a tile, a list of tiles or a claim option id",
        );
      const at = now();
      const day = openDailyKey(attempt.dateKey, at);
      const puzzle: DiscardPuzzle = dailyPuzzle(day);
      const correct = judgePuzzleAnswer(puzzle, answer);
      const difficulty = dailyPuzzleDifficulty(day);
      const elapsedMs = Math.max(0, at - attempt.startedAt);
      const seconds = Math.min(DAILY_MAX_SECONDS, Math.round(elapsedMs / 1000));
      // Under the floor: recorded, but off the daily board and the rating.
      const ranked = elapsedMs >= DAILY_RANK_FLOOR_MS;
      const key = attempt.dateKey;
      const result = await repos.transaction(async (tx) => {
        // An attempt is finished once; throwing below undoes this and the rating step together.
        if (!(await tx.dailyAttempts.finish(attempt.id, at)))
          throw new PuzzleError(
            409,
            "already_played",
            "You have already played this daily puzzle",
          );
        const { rating, after } = await applyRatings(
          tx,
          me.userId,
          ranked && movesPuzzleRating("daily")
            ? [{ type: "discard", difficulty, correct }]
            : [],
          at,
        );
        const row = await tx.puzzleResults.recordDaily({
          userId: me.userId,
          puzzleKey: key,
          correct,
          seconds,
          ratingAfter: after[0] ?? null,
          createdAt: at,
          ranked,
        });
        // Only the first attempt per date key is ranked and rated.
        if (!row)
          throw new PuzzleError(
            409,
            "already_played",
            "You have already played this daily puzzle",
          );
        await checkAutomation(tx, me.userId, at);
        return { rating, row };
      });
      return {
        date: key,
        correct,
        seconds: result.row.seconds,
        ranked,
        rating: ratingJson(result.rating),
        revealed: puzzle,
      };
    }),

    // ------------------------------------------------------------------ Puzzle Rush
    r("POST", "/api/puzzles/rush", async (ctx) => {
      const me = await submitter(ctx);
      if (!rushByIp.take(ctx.ip))
        throw new PuzzleError(
          429,
          "rate_limited",
          "Too many Puzzle Rush runs from this address; try again later",
        );
      const unlimited = deps.unlimitedRush
        ? await deps.unlimitedRush(me.userId)
        : false;
      const id = randomUUID();
      const seed = `rush-${randomHex(8)}`;
      // The first puzzle is made before the clock starts, so its making is not counted against the player.
      const first = servedRushQuestion({ id, seed }, 0);
      const at = now();
      const run = await repos.transaction(async (tx) => {
        if (!unlimited) {
          // The account's row is locked first, so two starts at once cannot both take the last free run.
          await tx.puzzleRatings.getForUpdate(me.userId);
          // A run counts when it is issued, finished or not: abandoning a run does not give it back.
          if (
            (await tx.rushRuns.countStartedSince(me.userId, dayStart(at))) >=
            FREE_RUSH_RUNS_PER_DAY
          ) {
            throw new PuzzleError(
              403,
              "rush_daily_limit",
              "Free accounts get one ranked Puzzle Rush a day; Coach Gold makes it unlimited",
            );
          }
        }
        return tx.rushRuns.create({
          id,
          userId: me.userId,
          seed,
          startedAt: at,
          expiresAt: at + RUSH_RUN_TTL_MS,
        });
      });
      // The seed stays on the server: each puzzle is sent when the previous answer has arrived.
      return deps.reply(201, {
        runId: run.id,
        startedAt: iso(run.startedAt),
        expiresAt: iso(run.expiresAt),
        seconds: RUSH_SECONDS,
        strikes: RUSH_STRIKES,
        next: first,
      });
    }),
    r("POST", "/api/puzzles/rush/:runId/answer", async (ctx) => {
      const me = await ctx.caller();
      if (!answersBucket.take(me.userId))
        throw new PuzzleError(
          429,
          "rate_limited",
          "Too many Puzzle Rush answers; please slow down",
        );
      const { index, answer } = ctx.body;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0)
        throw new PuzzleError(
          400,
          "invalid",
          "index must be the number of the puzzle being answered",
        );
      if (!isPuzzleAnswerInput(answer))
        throw new PuzzleError(
          400,
          "invalid_answer",
          "answer must be a tile, a list of tiles or a claim option id",
        );
      const run = await openRun(ctx.params.runId, me.userId, now());
      checkServed(run, index);
      // Judged, and the next puzzle made, before the stamp: the server's own work is not counted against the player.
      const puzzle = rushRunPuzzle(run.seed, index);
      const verdict = {
        type: puzzle.type,
        correct: judgePuzzleAnswer(puzzle, answer as PuzzleAnswerInput),
      };
      // The answered puzzle is revealed whole with its verdict; the next one is served as its question.
      const revealed = revealedRushPuzzle(run, index, puzzle);
      const next = servedRushQuestion(run, index + 1);
      const at = now();
      return repos.transaction(async (tx) => {
        const live = await tx.rushRuns.getForUpdate(run.id);
        if (!live || live.finishedAt !== null)
          throw new PuzzleError(
            409,
            "run_finished",
            "This run has already been finished",
          );
        checkServed(live, index);
        if (at > live.startedAt + RUSH_SECONDS * 1000 + RUSH_ANSWER_GRACE_MS) {
          // Past the run's three minutes: the answer does not count, and the run ends as it stood when the time ran out.
          const result = await finishRun(
            tx,
            live,
            await tx.rushRuns.answers(live.id),
            live.startedAt + RUSH_SECONDS * 1000,
          );
          return {
            index,
            counted: false,
            done: true,
            next: null,
            revealed,
            result,
          };
        }
        if (
          !(await tx.rushRuns.answer(live.id, {
            index,
            type: verdict.type,
            correct: verdict.correct,
            servedAt: live.servedAt,
            answeredAt: at,
          }))
        ) {
          throw new PuzzleError(
            409,
            "already_answered",
            "That puzzle has already been answered",
          );
        }
        const answers = await tx.rushRuns.answers(live.id);
        const wrong = answers.filter((x) => !x.correct).length;
        const solved = answers.length - wrong;
        const base = {
          index,
          counted: true,
          correct: verdict.correct,
          type: verdict.type,
          solved,
          wrong,
          revealed,
        };
        // The third wrong answer ends the run at its stamp.
        if (wrong >= RUSH_STRIKES)
          return {
            ...base,
            done: true,
            next: null,
            result: await finishRun(tx, live, answers, at),
          };
        return { ...base, done: false, next };
      });
    }),
    r("POST", "/api/puzzles/rush/:runId/finish", async (ctx) => {
      const me = await submitter(ctx);
      if (ctx.body.answers !== undefined)
        throw new PuzzleError(
          400,
          "answers_one_at_a_time",
          "Rush answers are posted one at a time as they are made (POST /api/puzzles/rush/:runId/answer); finish takes none",
        );
      const run = await openRun(ctx.params.runId, me.userId, now());
      const at = now();
      return repos.transaction(async (tx) => {
        const live = await tx.rushRuns.getForUpdate(run.id);
        if (!live || live.finishedAt !== null)
          throw new PuzzleError(
            409,
            "run_finished",
            "This run has already been finished",
          );
        return finishRun(tx, live, await tx.rushRuns.answers(live.id), at);
      });
    }),

    // ------------------------------------------------------------------ rating and boards
    r("GET", "/api/puzzles/rating", async (ctx) => {
      const me = await reader(ctx);
      const row = await repos.puzzleRatings.get(me.userId);
      return {
        rating: row?.rating ?? DEFAULT_PUZZLE_RATING,
        rated: row?.rated ?? 0,
        updatedAt: row ? iso(row.updatedAt) : null,
      };
    }),
    r("GET", "/api/leaderboards/daily", async (ctx) => {
      const me = await reader(ctx);
      const date = query(ctx).get("date") ?? utcDateKey(now());
      if (!dateOfDailyKey(date))
        throw new PuzzleError(
          400,
          "invalid",
          "date must be a YYYY-MM-DD date key",
        );
      const s = scope(ctx, me.userId);
      const page = await repos.leaderboards.daily(date, {
        viewerId: me.userId,
        userIds: s.userIds,
        limit: BOARD_LIMIT,
      });
      return {
        board: "daily",
        date,
        scope: s.club ? "club" : "global",
        club: s.club,
        ...boardJson(page, (row) => ({
          value: row.tiebreak,
          solved: row.score === 1,
        })),
      };
    }),
    r("GET", "/api/leaderboards/rush", async (ctx) => {
      const me = await reader(ctx);
      const period = query(ctx).get("period") ?? "day";
      const at = now();
      const since =
        period === "day"
          ? dayStart(at)
          : period === "week"
            ? weekStart(at)
            : period === "all"
              ? 0
              : null;
      if (since === null)
        throw new PuzzleError(
          400,
          "invalid",
          "period must be day, week or all",
        );
      const s = scope(ctx, me.userId);
      const page = await repos.leaderboards.rush(since, {
        viewerId: me.userId,
        userIds: s.userIds,
        limit: BOARD_LIMIT,
      });
      return {
        board: "rush",
        period,
        since: iso(since),
        scope: s.club ? "club" : "global",
        club: s.club,
        ...boardJson(page, (row) => ({ value: row.score, solved: row.count })),
      };
    }),
    r("GET", "/api/leaderboards/rating", async (ctx) => {
      const me = await reader(ctx);
      const s = scope(ctx, me.userId);
      const page = await repos.leaderboards.rating(RATING_BOARD_MIN_RATED, {
        viewerId: me.userId,
        userIds: s.userIds,
        limit: BOARD_LIMIT,
      });
      return {
        board: "rating",
        minRated: RATING_BOARD_MIN_RATED,
        scope: s.club ? "club" : "global",
        club: s.club,
        ...boardJson(page, (row) => ({ value: row.score, rated: row.count })),
      };
    }),
  ];
}
