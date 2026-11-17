/**
 * Client for the server's puzzle routes (docs/API.md, "Puzzles and leaderboards"): the daily
 * puzzle timed by the server (start, then finish with the answer), Puzzle Rush runs the server
 * serves one puzzle at a time, judging and stamping each answer as it is made, the server's puzzle rating, the leaderboards and the "Show me on
 * leaderboards" choice. Pure TypeScript: `fetch` is injected, so tests drive it with a fake.
 *
 * Failures are `ApiError`s (src/api/http.ts); `puzzleErrorMessage` turns each code into
 * translated copy (`puzzles.server.errors.*`), and `isPuzzleServerDown` says when the app should
 * carry on locally, unranked, instead of showing an error.
 */
import type { AnyPuzzle, DiscardPuzzle, PuzzleAnswerInput, PuzzleQuestion, PuzzleType } from '@mjm/engine';
import { authorisedJson, globalFetch, type Authoriser, type FetchLike } from './http';
import { friendlyErrorMessage } from '../logic/errors';
import type { Message, Translate } from '../logic/translate';

/** What every puzzle call needs: the server's HTTP base and the signed-in session. */
export interface PuzzleContext {
  base: string;
  auth: Authoriser;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
}

/** How long a puzzle request may take before the app gives up and plays on locally. */
export const PUZZLE_REQUEST_TIMEOUT_MS = 10_000;

/** The server's rating after a submission: the rating, its change over the submission, and how many verified answers moved it. */
export interface ServerRating {
  rating: number;
  change: number;
  rated: number;
}

export interface DailyStart {
  attemptId: string;
  date: string;
  /** ISO time the server started the clock (the same on every start for this date). */
  startedAt: string;
  /** The day's puzzle as its question (docs/API.md, "Questions and reveals"): nothing that gives the answer away. */
  question: PuzzleQuestion;
}

export interface DailyFinish {
  date: string;
  correct: boolean;
  /** The server's time from the start to the answer. */
  seconds: number;
  /** False when the server timed it under the human-time floor (3 s): recorded, not ranked. Absent from older servers. */
  ranked?: boolean;
  rating: ServerRating;
  /** The whole puzzle, revealed with the verdict, for the feedback. */
  revealed: DiscardPuzzle;
}

/** A Rush puzzle as the server serves it: its place in the run and its question (the answer comes only with the verdict). */
export interface RushServed {
  index: number;
  type: PuzzleType;
  question: PuzzleQuestion;
}

export interface RushStart {
  runId: string;
  startedAt: string;
  expiresAt: string;
  seconds: number;
  strikes: number;
  /** The first puzzle (the server keeps the run's seed and serves each puzzle once the previous answer has arrived). */
  next: RushServed;
}

export interface RushFinish {
  runId: string;
  solved: number;
  wrong: number;
  /** The server's time from the run's start to its end (the third strike, the finish or the three minutes), at most the run's length. */
  seconds: number;
  score: number;
  /** False under the human-time floor (1.5 s an answer) or with inhuman answer times: recorded, not ranked. */
  ranked?: boolean;
  /** True when the answer times were judged inhuman (docs/API.md, "Plausible answer times"). */
  inhuman?: boolean;
  answers: Array<{ index: number; type: PuzzleType; correct: boolean; ms?: number }>;
  rating: ServerRating;
}

/** The server's reply to one Rush answer: its verdict, and the next puzzle or the finished run. */
export interface RushAnswerReply {
  index: number;
  /** False when the answer came after the run's three minutes: it does not count and the run is over. */
  counted: boolean;
  correct?: boolean;
  type?: PuzzleType;
  solved?: number;
  wrong?: number;
  /** The whole puzzle just answered, revealed with the verdict (for the feedback). */
  revealed?: AnyPuzzle;
  done: boolean;
  next: RushServed | null;
  /** The finished run, when `done`. */
  result?: RushFinish;
}

export interface RatingReply {
  rating: number;
  rated: number;
  updatedAt: string | null;
}

export type BoardKind = 'daily' | 'rush' | 'rating';
export type RushPeriod = 'day' | 'week' | 'all';

export interface BoardRow {
  rank: number;
  userId: string;
  displayName: string;
  avatar: string | null;
  /** Daily: seconds. Rush: the best score. Rating: the rating. */
  value: number;
  /** Daily: solved or not. Rush: puzzles solved in the best run. */
  solved?: boolean | number;
  /** Rating: verified answers. */
  rated?: number;
  /** On `me` only: the caller hid themselves (ranked, but shown to nobody else). */
  hidden?: boolean;
  /** On `me` only: the server's automation check keeps the caller off the boards until a moderator has looked (docs/API.md). */
  flagged?: boolean;
}

export interface Board {
  board: BoardKind;
  scope: 'global' | 'club';
  club: string | null;
  rows: BoardRow[];
  me: BoardRow | null;
  date?: string;
  period?: RushPeriod;
  since?: string;
  minRated?: number;
}

export interface BoardOptions {
  /** Daily board: the date key (default: the server's UTC date). */
  date?: string;
  /** Rush board: today, this week or all time (default: today). */
  period?: RushPeriod;
  /** One club the player belongs to; omitted for the global board. */
  club?: string;
}

function call<T>(ctx: PuzzleContext, method: string, path: string, body?: unknown): Promise<T> {
  return authorisedJson<T>(ctx.auth, { fetch: ctx.fetch ?? globalFetch, base: ctx.base, method, path, body, timeoutMs: PUZZLE_REQUEST_TIMEOUT_MS, scope: 'puzzle', label: 'game server' });
}

/** The query string of a board request (only the options that apply to that board). */
export function boardPath(kind: BoardKind, opts: BoardOptions = {}): string {
  const q: string[] = [];
  if (kind === 'daily' && opts.date) q.push(`date=${encodeURIComponent(opts.date)}`);
  if (kind === 'rush' && opts.period) q.push(`period=${encodeURIComponent(opts.period)}`);
  if (opts.club) q.push(`club=${encodeURIComponent(opts.club)}`);
  return `/api/leaderboards/${kind}${q.length ? `?${q.join('&')}` : ''}`;
}

export const puzzlesApi = {
  /** Opens the daily puzzle for the local date key: the server starts (or resumes) the clock. */
  startDaily: (ctx: PuzzleContext, date: string) => call<DailyStart>(ctx, 'POST', '/api/puzzles/daily/start', { date }),
  /** Answers the daily puzzle: the server judges it and times it from the start. */
  finishDaily: (ctx: PuzzleContext, attemptId: string, answer: PuzzleAnswerInput) => call<DailyFinish>(ctx, 'POST', '/api/puzzles/daily', { attemptId, answer }),
  /** Starts a ranked Puzzle Rush run: the server keeps the seed and the start time, and sends the first puzzle. */
  startRush: (ctx: PuzzleContext) => call<RushStart>(ctx, 'POST', '/api/puzzles/rush', {}),
  /** Answers the puzzle the run is waiting on, as it is made: the server judges and stamps it and sends the next. */
  answerRush: (ctx: PuzzleContext, runId: string, index: number, answer: PuzzleAnswerInput) => call<RushAnswerReply>(ctx, 'POST', `/api/puzzles/rush/${encodeURIComponent(runId)}/answer`, { index, answer }),
  /** Ends a run (the clock ran out or the player left): the server scores it from the answers it stamped. */
  finishRush: (ctx: PuzzleContext, runId: string) => call<RushFinish>(ctx, 'POST', `/api/puzzles/rush/${encodeURIComponent(runId)}/finish`, {}),
  getPuzzleRating: (ctx: PuzzleContext) => call<RatingReply>(ctx, 'GET', '/api/puzzles/rating'),
  getLeaderboard: (ctx: PuzzleContext, kind: BoardKind, opts: BoardOptions = {}) => call<Board>(ctx, 'GET', boardPath(kind, opts)),
  /** Whether the player appears on public leaderboards (on unless they turned it off). */
  getLeaderboardVisible: async (ctx: PuzzleContext) => (await call<{ leaderboardVisible?: unknown }>(ctx, 'GET', '/api/me')).leaderboardVisible !== false,
  setLeaderboardVisible: async (ctx: PuzzleContext, visible: boolean) => (await call<{ leaderboardVisible?: unknown }>(ctx, 'PATCH', '/api/me', { leaderboardVisible: visible })).leaderboardVisible !== false,
};

export const {
  startDaily,
  finishDaily,
  startRush,
  answerRush,
  finishRush,
  getPuzzleRating,
  getLeaderboard,
  getLeaderboardVisible,
  setLeaderboardVisible,
} = puzzlesApi;

const codeOf = (e: unknown): string => (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '');
const statusOf = (e: unknown): number | undefined => (e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : undefined);

/** The puzzle routes' error codes and this client's own, each with its line in `puzzles.server.errors`. */
const PUZZLE_ERRORS: Readonly<Record<string, string>> = {
  invalid: 'puzzles.server.errors.invalid',
  invalid_answer: 'puzzles.server.errors.invalidAnswer',
  date_out_of_range: 'puzzles.server.errors.dateOutOfRange',
  already_played: 'puzzles.server.errors.alreadyPlayed',
  rush_too_fast: 'puzzles.server.errors.rushTooFast',
  // This client's own: the server recorded a result under a human-time floor without ranking it.
  too_fast_to_rank: 'puzzles.server.errors.tooFastToRank',
  // The server's free Rush meter: the Shop's own Coach Gold message, as the Rush screen's lock shows it.
  rush_daily_limit: 'shop.rushUsed',
  run_not_found: 'puzzles.server.errors.runNotFound',
  run_finished: 'puzzles.server.errors.runFinished',
  run_expired: 'puzzles.server.errors.runExpired',
  not_served: 'puzzles.server.errors.runOutOfStep',
  already_answered: 'puzzles.server.errors.runOutOfStep',
  answers_one_at_a_time: 'puzzles.server.errors.runOutOfStep',
  forbidden: 'puzzles.server.errors.forbidden',
  not_found: 'puzzles.server.errors.notFound',
  rate_limited: 'puzzles.server.errors.rateLimited',
  puzzle_timeout: 'puzzles.server.errors.unreachable',
  puzzle_unreachable: 'puzzles.server.errors.unreachable',
  puzzle_bad_reply: 'puzzles.server.errors.badReply',
};

/** A puzzle call's failure as translated copy; anything the puzzle routes do not name goes to the generic mapping. */
export function puzzleErrorMessage(e: unknown): Message {
  const key = PUZZLE_ERRORS[codeOf(e)];
  return key ? { key } : friendlyErrorMessage(e);
}

export function puzzleErrorText(e: unknown, t: Translate): string {
  const m = puzzleErrorMessage(e);
  // The plan is named as the Shop names it, in either language.
  if (m.key === 'shop.rushUsed') return t(m.key, { plan: t('shop.tiers.gold') });
  return t(m.key, m.params);
}

/**
 * True when the server could not be used at all (no answer, a timeout, an unreadable reply or a
 * server fault): the app then plays on locally and says the result is not ranked. A refusal the
 * server gave on purpose (already played, rate limited, a run expired) is not "down".
 */
export function isPuzzleServerDown(e: unknown): boolean {
  const code = codeOf(e);
  if (code === 'puzzle_timeout' || code === 'puzzle_unreachable' || code === 'puzzle_bad_reply' || code === 'signed_out') return true;
  const status = statusOf(e);
  return status !== undefined && status >= 500;
}
