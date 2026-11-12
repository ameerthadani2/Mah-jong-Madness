/**
 * What the Quick match screen shows, kept pure so the rules are unit-tested: the line under the
 * search (players found, the wait, the seconds until bots join), what to do with a refusal
 * (`quickMatchFailure`), and the one search the screen runs from start to finish (`runQuickMatch`):
 * the birth year sent once after `age_missing`, nothing sent or retried after `age_under`.
 */
import { BANNED_CLOSE_CODE, BANNED_MESSAGE, type QueueStatus } from '@mjm/net';
import { tableErrorMessage } from '../components/table/tableErrors';
import type { Message } from '../logic/translate';

/** The fill time the copy promises when the server has not said (QUICK_MATCH_FILL_MS's default). */
export const DEFAULT_FILL_MS = 20_000;

export interface QuickMatchView {
  /** Humans found so far, this player included (1 to 4). */
  humans: number;
  /** Whole seconds waited. */
  waitedSeconds: number;
  /** The seconds after which bots fill the empty seats (from the server, else 20). */
  fillSeconds: number;
  /** Seconds until bots join, while waiting; 0 once due. */
  botsInSeconds: number;
}

export function quickMatchView(status: QueueStatus | null, waitedMs?: number): QuickMatchView {
  const fillMs = status?.fillMs && status.fillMs > 0 ? status.fillMs : DEFAULT_FILL_MS;
  const waited = Math.max(0, waitedMs ?? status?.waitedMs ?? 0);
  return {
    humans: Math.min(4, Math.max(1, status?.humans ?? 1)),
    waitedSeconds: Math.floor(waited / 1000),
    fillSeconds: Math.round(fillMs / 1000),
    botsInSeconds: Math.max(0, Math.ceil((fillMs - waited) / 1000)),
  };
}

/**
 * What a screen reader is told while a search runs: the number of players found, and then that a
 * table was found (or that the player is being taken back to one). It is the whole content of the
 * screen's live region, so it must change only when one of those does: the seconds waited are
 * deliberately not part of it, or the reader would speak every second of the wait.
 */
export function quickMatchAnnouncement(phase: 'searching' | 'matched' | 'returning', humans: number): Message {
  if (phase === 'matched') return { key: 'quickmatch.matched' };
  if (phase === 'returning') return { key: 'quickmatch.returning' };
  return { key: 'quickmatch.humans', params: { count: humans } };
}

/**
 * What a failed quick match leads to.
 *  - `age`: the server has no birth year for this account (`age_missing`): send the device's, queue again.
 *  - `message`: a localised sentence. `final` means trying again cannot help (banned, under the minimum age), so no
 *    retry is offered; `retryAfterMs` asks the player to wait that long before the retry is offered.
 */
export type QuickMatchFailure =
  | { kind: 'age' }
  | { kind: 'message'; message: Message; final: boolean; retryAfterMs?: number }
  | { kind: 'cancelled' }
  | { kind: 'other' };

/** How long the retry stays disabled after `rate_limited` (the server's allowance refills within seconds). */
export const RATE_LIMIT_WAIT_MS = 5_000;

const BANNED: QuickMatchFailure = { kind: 'message', message: { key: 'quickmatch.errors.banned' }, final: true };

const BY_CODE: Readonly<Record<string, QuickMatchFailure>> = {
  banned: BANNED,
  // The year on file is under the server's quick-match age (18; 17 on an older server) and the server takes a year only once: nothing the app sends changes it.
  age_under: { kind: 'message', message: { key: 'quickmatch.errors.ageUnder' }, final: true },
  age_missing: { kind: 'age' },
  rate_limited: { kind: 'message', message: { key: 'quickmatch.errors.rateLimited' }, final: false, retryAfterMs: RATE_LIMIT_WAIT_MS },
  unavailable: { kind: 'message', message: { key: 'quickmatch.errors.unavailable' }, final: false },
  replaced: { kind: 'message', message: { key: 'quickmatch.errors.replaced' }, final: false },
  sign_in: { kind: 'message', message: { key: 'quickmatch.errors.signIn' }, final: false },
  // `seated` normally never gets here (the session goes back to the table); these are the times it could not.
  seated: { kind: 'message', message: { key: 'quickmatch.errors.seatedFailed' }, final: false },
  rejoin_failed: { kind: 'message', message: { key: 'quickmatch.errors.seatedFailed' }, final: false },
  cancelled: { kind: 'cancelled' },
};

export function quickMatchFailure(e: unknown): QuickMatchFailure {
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  const message = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined;
  if (code === BANNED_CLOSE_CODE || message === BANNED_MESSAGE) return BANNED;
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(BY_CODE, code)) return BY_CODE[code];
  const table = tableErrorMessage(e);
  return table ? { kind: 'message', message: table, final: false } : { kind: 'other' };
}

/** What the screen needs from the device and the server to run one search (injected, so the flow is tested). */
export interface QuickMatchSteps<S> {
  /** One search: resolves with the table session, rejects with the refusal. */
  search(): Promise<S>;
  /** The birth year the age gate holds on this device, if any. */
  birthYear(): number | undefined;
  /**
   * Sends that year with PATCH /api/me, after `age_missing` only. 'on_file' is the server's
   * `birth_year_locked`: it already has a year, so the device stops sending its own.
   */
  sendBirthYear(year: number): Promise<'sent' | 'on_file' | 'failed'>;
}

export type QuickMatchOutcome<S> =
  | { kind: 'session'; session: S }
  | { kind: 'cancelled' }
  /** The server has no birth year and neither has this device: the age gate comes first. */
  | { kind: 'ask_age' }
  /** `error` is set when no localised message fits (the caller shows its generic one). */
  | { kind: 'failed'; message: Message | null; final: boolean; retryAfterMs?: number; error?: unknown };

/**
 * One quick match from the player's tap to a seat or a message. The birth year goes to the server
 * at most once per run and only in answer to `age_missing`; `age_under` and `banned` end the run
 * without another request.
 */
export async function runQuickMatch<S>(steps: QuickMatchSteps<S>): Promise<QuickMatchOutcome<S>> {
  let yearSent = false;
  for (;;) {
    let error: unknown;
    try {
      return { kind: 'session', session: await steps.search() };
    } catch (e) {
      error = e;
    }
    const failure = quickMatchFailure(error);
    if (failure.kind === 'cancelled') return failure;
    if (failure.kind === 'message') return { kind: 'failed', message: failure.message, final: failure.final, retryAfterMs: failure.retryAfterMs };
    if (failure.kind === 'other') return { kind: 'failed', message: null, final: false, error };
    // age_missing. A second one after the year went through means the server did not keep it.
    if (yearSent) return { kind: 'failed', message: { key: 'quickmatch.errors.ageSync' }, final: false };
    const year = steps.birthYear();
    if (!year) return { kind: 'ask_age' };
    yearSent = true;
    if ((await steps.sendBirthYear(year)) === 'failed') return { kind: 'failed', message: { key: 'quickmatch.errors.ageSync' }, final: false };
  }
}

/** The rejoin token this device saved for `room` on this game server, when its saved table is that one. */
export function savedRejoinToken(saved: { kind: string; signalUrl?: string; roomCode?: string; token?: string } | null, signalUrl: string, room: string): string | undefined {
  if (!saved || saved.kind !== 'online' || saved.signalUrl !== signalUrl) return undefined;
  return saved.roomCode?.toUpperCase() === room.toUpperCase() && saved.token ? saved.token : undefined;
}

/** Whole seconds until the retry is offered again (0 when it already is). */
export function retryWaitSeconds(retryAt: number, now: number): number {
  return Math.max(0, Math.ceil((retryAt - now) / 1000));
}

/**
 * How to close a table that arrived after the Quick match screen had gone (Back was pressed meanwhile).
 * A freshly matched table is given up with the table's `leave`. A table the player was only being taken
 * back to (`seated`) keeps its seat: they never asked to leave it, and with no other human there the
 * server would close it at once.
 */
export function unseenTableClose(returningToSeat: boolean): { keepSeat: boolean } {
  return { keepSeat: returningToSeat };
}
