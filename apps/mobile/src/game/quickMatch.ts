/**
 * What the Quick match screen shows, kept pure so the rules are unit-tested: the line under the
 * search (players found, the wait, the seconds until bots join) and what to do with a refusal
 * (a localised message, or the age gate for `age_required`).
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

/** What a failed quick match leads to: the age gate, or a message. */
export type QuickMatchFailure = { kind: 'age' } | { kind: 'message'; message: Message } | { kind: 'cancelled' } | { kind: 'other' };

const BY_CODE: Readonly<Record<string, string>> = {
  banned: 'quickmatch.errors.banned',
  rate_limited: 'quickmatch.errors.rateLimited',
  unavailable: 'quickmatch.errors.unavailable',
  replaced: 'quickmatch.errors.replaced',
  sign_in: 'quickmatch.errors.signIn',
};

export function quickMatchFailure(e: unknown): QuickMatchFailure {
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined;
  const message = e && typeof e === 'object' ? (e as { message?: unknown }).message : undefined;
  if (code === 'cancelled') return { kind: 'cancelled' };
  if (code === 'age_required') return { kind: 'age' };
  if (code === BANNED_CLOSE_CODE || message === BANNED_MESSAGE) return { kind: 'message', message: { key: BY_CODE.banned } };
  if (typeof code === 'string' && BY_CODE[code]) return { kind: 'message', message: { key: BY_CODE[code] } };
  const table = tableErrorMessage(e);
  return table ? { kind: 'message', message: table } : { kind: 'other' };
}
