/**
 * Client for the server's puzzle routes (docs/API.md, "Puzzles and leaderboards"): the daily
 * puzzle timed by the server (start, then finish with the answer), Puzzle Rush runs the server
 * issues and scores, the server's puzzle rating, the leaderboards and the "Show me on
 * leaderboards" choice. Pure TypeScript: `fetch` is injected, so tests drive it with a fake.
 *
 * Failures are `ApiError`s (src/api/http.ts); `puzzleErrorMessage` turns each code into
 * translated copy (`puzzles.server.errors.*`), and `isPuzzleServerDown` says when the app should
 * carry on locally, unranked, instead of showing an error.
 */
import type { PuzzleAnswerInput, PuzzleType } from '@mjm/engine';
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
}

export interface DailyFinish {
  date: string;
  correct: boolean;
  /** The server's time from the start to the answer. */
  seconds: number;
  rating: ServerRating;
}

export interface RushStart {
  runId: string;
  seed: string;
  startedAt: string;
  expiresAt: string;
  seconds: number;
  strikes: number;
}

export interface RushFinish {
  runId: string;
  solved: number;
  wrong: number;
  /** The server's time from the run's start to the finish, at most the run's length. */
  seconds: number;
  score: number;
  answers: Array<{ index: number; type: PuzzleType; correct: boolean }>;
  rating: ServerRating;
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
  /** Starts a Puzzle Rush run: the server issues the seed and keeps the start time. */
  startRush: (ctx: PuzzleContext) => call<RushStart>(ctx, 'POST', '/api/puzzles/rush', {}),
  /** Finishes a run once, with every answer in order from the first puzzle. */
  finishRush: (ctx: PuzzleContext, runId: string, answers: readonly PuzzleAnswerInput[]) => call<RushFinish>(ctx, 'POST', `/api/puzzles/rush/${encodeURIComponent(runId)}/finish`, { answers }),
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
  run_not_found: 'puzzles.server.errors.runNotFound',
  run_finished: 'puzzles.server.errors.runFinished',
  run_expired: 'puzzles.server.errors.runExpired',
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
