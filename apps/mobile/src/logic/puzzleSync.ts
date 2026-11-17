/**
 * The daily puzzle and Puzzle Rush through the game server, with the device as the fallback
 * (docs/API.md, "Puzzles and leaderboards"). Pure TypeScript: the server calls are injected, so
 * tests drive every path without React or the network.
 *
 * With a session and a server that answers, the daily puzzle's attempt is started when it opens
 * and finished by the answer, and a ranked Rush run is played from the server one puzzle at a time:
 * each answer is posted as it is made, and the server judges and stamps it and sends the next
 * puzzle; the verdict, time, score and rating shown are the server's. A Rush answer that cannot
 * reach the server ends the run there, unranked, and the screen says so. When the
 * server cannot be used, the puzzle plays on the device as it always has and says it is not ranked.
 * Streaks, the local rating and the free Rush allowance are kept on the device in both cases.
 */
import type { PuzzleAnswerInput } from '@mjm/engine';
import { ApiError } from '../api/http';
import { isPuzzleServerDown, type DailyFinish, type DailyStart, type RatingReply, type RushAnswerReply, type RushFinish, type RushServed, type RushStart, type ServerRating } from '../api/puzzles';

/** The server calls this module makes (the `puzzlesApi` functions with their context bound). */
export interface PuzzleServer {
  startDaily(date: string): Promise<DailyStart>;
  finishDaily(attemptId: string, answer: PuzzleAnswerInput): Promise<DailyFinish>;
  startRush(): Promise<RushStart>;
  answerRush(runId: string, index: number, answer: PuzzleAnswerInput): Promise<RushAnswerReply>;
  finishRush(runId: string): Promise<RushFinish>;
  getPuzzleRating(): Promise<RatingReply>;
}

/** Where a puzzle stands with the server: ranked (and how to finish it), or played on the device only. */
export type DailyLink =
  | { ranked: true; attemptId: string; startedAt: string }
  /** `error`: why not (absent when there is no session); `down` when the server could not be used at all. */
  | { ranked: false; error?: unknown; down: boolean };

/** Opens today's puzzle on the server: the attempt (the same one on every reopening), or why it is unranked. */
export async function openDaily(server: PuzzleServer | null, date: string): Promise<DailyLink> {
  if (!server) return { ranked: false, down: true };
  try {
    const s = await server.startDaily(date);
    return { ranked: true, attemptId: s.attemptId, startedAt: s.startedAt };
  } catch (error) {
    return { ranked: false, error, down: isPuzzleServerDown(error) };
  }
}

export type DailyOutcome =
  | {
      ranked: true;
      /** The server's verdict, time and rating. */
      correct: boolean;
      seconds: number;
      rating: ServerRating;
      /** True when the server's verdict differs from the device's (logged; the server's is shown). */
      mismatch: boolean;
    }
  | { ranked: false; error?: unknown; down: boolean };

/** A result the server recorded under a human-time floor (docs/API.md): shown as not ranked, with its own line. */
const tooFastToRank = () => new ApiError('The game server recorded this result but did not rank it: it was faster than the human-time floor', 'too_fast_to_rank');

/** Finishes a ranked daily attempt with the answer; an unranked link stays unranked. */
export async function submitDaily(server: PuzzleServer | null, link: DailyLink, answer: PuzzleAnswerInput, localCorrect: boolean, log: (msg: string) => void = console.warn): Promise<DailyOutcome> {
  if (!server || !link.ranked) return link.ranked ? { ranked: false, down: true } : link;
  try {
    const r = await server.finishDaily(link.attemptId, answer);
    if (r.ranked === false) return { ranked: false, error: tooFastToRank(), down: false };
    const mismatch = r.correct !== localCorrect;
    if (mismatch) log(`[puzzles] the server judged the daily answer ${r.correct ? 'right' : 'wrong'}; the device judged it ${localCorrect ? 'right' : 'wrong'}`);
    return { ranked: true, correct: r.correct, seconds: r.seconds, rating: r.rating, mismatch };
  } catch (error) {
    return { ranked: false, error, down: isPuzzleServerDown(error) };
  }
}

/**
 * A Puzzle Rush run: issued by the server (its id and the first puzzle; the server keeps the seed
 * and sends each later puzzle with the verdict on the one before), or seeded on the device and unranked.
 */
export type RushLink = { ranked: true; runId: string; first: RushServed } | { ranked: false; seed: string; error?: unknown; down: boolean };

/** Starts a run on the server before its first puzzle; without one the run uses `localSeed`. */
export async function openRush(server: PuzzleServer | null, localSeed: string): Promise<RushLink> {
  if (!server) return { ranked: false, seed: localSeed, down: true };
  try {
    const r = await server.startRush();
    return { ranked: true, runId: r.runId, first: r.next };
  } catch (error) {
    return { ranked: false, seed: localSeed, error, down: isPuzzleServerDown(error) };
  }
}

export type RushOutcome =
  | {
      ranked: true;
      solved: number;
      seconds: number;
      score: number;
      rating: ServerRating;
      /** True when the server counted a different number solved than the device (logged; the server's is shown). */
      mismatch: boolean;
    }
  /** `lost`: an answer could not reach the server, so the run ended there (the screen says so). */
  | { ranked: false; error?: unknown; down: boolean; lost?: boolean };

/** The server's finished run as the screen shows it. */
function rushOutcomeOf(r: RushFinish, localSolved: number, log: (msg: string) => void): RushOutcome {
  if (r.ranked === false) return { ranked: false, error: tooFastToRank(), down: false };
  const mismatch = r.solved !== localSolved;
  if (mismatch) log(`[puzzles] the server counted ${r.solved} solved in the Rush run; the device counted ${localSolved}`);
  return { ranked: true, solved: r.solved, seconds: r.seconds, score: r.score, rating: r.rating, mismatch };
}

/** What one ranked answer led to: the next puzzle, the end of the run (the server's result), or a lost run. */
export type RushStep = { kind: 'next'; next: RushServed; correct: boolean } | { kind: 'done'; outcome: RushOutcome };

/**
 * Posts one answer of a ranked run as it is made. The server's reply carries the next puzzle, or
 * the finished run when this was the third wrong answer or came after the three minutes. If the
 * answer cannot be sent, or the server refuses it, the run ends here and is not ranked.
 */
export async function sendRushAnswer(server: PuzzleServer | null, link: RushLink, index: number, answer: PuzzleAnswerInput, localSolved: number, log: (msg: string) => void = console.warn): Promise<RushStep> {
  if (!server || !link.ranked) return { kind: 'done', outcome: { ranked: false, down: true, lost: true } };
  try {
    const r = await server.answerRush(link.runId, index, answer);
    if (r.done && r.result) return { kind: 'done', outcome: rushOutcomeOf(r.result, localSolved, log) };
    if (r.next) return { kind: 'next', next: r.next, correct: r.correct === true };
    return { kind: 'done', outcome: { ranked: false, down: false, lost: true } };
  } catch (error) {
    return { kind: 'done', outcome: { ranked: false, error, down: isPuzzleServerDown(error), lost: true } };
  }
}

/** Ends a ranked run (the clock ran out or the player left): the server scores the answers it stamped. */
export async function submitRush(server: PuzzleServer | null, link: RushLink, localSolved: number, log: (msg: string) => void = console.warn): Promise<RushOutcome> {
  if (!server || !link.ranked) return link.ranked ? { ranked: false, down: true } : { ranked: false, error: link.error, down: link.down };
  try {
    return rushOutcomeOf(await server.finishRush(link.runId), localSolved, log);
  } catch (error) {
    return { ranked: false, error, down: isPuzzleServerDown(error) };
  }
}

// ---------------------------------------------------------------------------------------------
// The server's rating, as the screens show it

/** The server's rating for the signed-in account, and its last change when a submission just moved it. */
export interface ServerRatingView {
  userId: string;
  rating: number;
  rated: number;
  /** The change over the last submission this device made, or null (read with GET, or cleared for a new run). */
  change: number | null;
  /** When it was read (epoch ms). */
  at: number;
}

type Listener = () => void;

/** One shared copy of the server's rating, so Learn, the pills and the result screens agree. */
export function createServerRatingStore() {
  let value: ServerRatingView | null = null;
  const listeners = new Set<Listener>();
  const emit = () => listeners.forEach((l) => l());
  return {
    get: () => value,
    /** The rating for `userId`, or null when none was read for that account. */
    forUser: (userId: string | null): ServerRatingView | null => (value && userId && value.userId === userId ? value : null),
    /** After a submission: the rating it left and its change. */
    submitted(userId: string, r: ServerRating, at: number) {
      value = { userId, rating: r.rating, rated: r.rated, change: r.change, at };
      emit();
    },
    /** After a read: the rating, with no change to show. */
    read(userId: string, r: RatingReply, at: number) {
      value = { userId, rating: r.rating, rated: r.rated, change: null, at };
      emit();
    },
    /** A new run starts: the last change is no longer this run's. */
    clearChange() {
      if (value && value.change !== null) {
        value = { ...value, change: null };
        emit();
      }
    },
    clear() {
      value = null;
      emit();
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

export type ServerRatingStore = ReturnType<typeof createServerRatingStore>;

/** The app's one store. */
export const serverRating = createServerRatingStore();

/** How long a read rating is fresh enough not to read again when a screen opens. */
export const SERVER_RATING_FRESH_MS = 60_000;

/** True when the screen should read the server's rating now (none for this account yet, or it is stale). */
export function shouldReadRating(view: ServerRatingView | null, now: number): boolean {
  return !view || now - view.at >= SERVER_RATING_FRESH_MS;
}

/**
 * The rating a screen shows: the server's when it could be read for this account, else the one
 * kept on the device. `change` is the movement to show beside it (null for none): the server's
 * last change when the server's rating is shown, else the device's.
 */
export function shownRating(local: number, localChange: number | null, server: ServerRatingView | null): { rating: number; change: number | null; source: 'server' | 'device' } {
  if (server) return { rating: server.rating, change: server.change, source: 'server' };
  return { rating: local, change: localChange, source: 'device' };
}
