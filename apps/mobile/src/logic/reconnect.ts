/**
 * Reconnecting to an online table after the game server's socket drops: the backoff schedule
 * and a small state machine. Pure; src/game/session.ts drives it with real timers.
 *
 *   connected ──closed──▶ reconnecting(1) ──failed──▶ reconnecting(2) … ──failed (10th)──▶ lost
 *        ▲                      │ succeeded                                   ▲
 *        └──────────────────────┘          unauthorised (4401), room gone ────┘ (from any attempt)
 */

/** Waits before attempt 1, 2, 3 …: 1, 2, 4, 8, 16, 32, then 60 s each. */
export function backoffSeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(60, 2 ** (n - 1));
}

export const backoffMs = (attempt: number): number => backoffSeconds(attempt) * 1000;

/** After this many failed attempts the table is shown as lost (the manual Reconnect remains). */
export const MAX_RECONNECT_ATTEMPTS = 10;

export type ConnectionStatus = 'connected' | 'reconnecting' | 'lost';

export interface ReconnectState {
  status: ConnectionStatus;
  /** The attempt being waited for or made (1-based) while reconnecting; how many were made once lost. */
  attempt: number;
  /** Why the table was lost ('gone': the server says the room no longer exists or has no seat for us). */
  reason: 'exhausted' | 'unauthorised' | 'ended' | 'gone' | null;
}

export type ReconnectEvent =
  /** The socket closed unexpectedly. */
  | { type: 'closed' }
  /** The attempt in progress failed; `unauthorised` when the server refused the session (4401), `gone` when it answered the join with 'Room not found or full'. */
  | { type: 'failed'; unauthorised?: boolean; gone?: boolean }
  | { type: 'succeeded' }
  /** The socket closed with 4401: no point retrying with the same session. */
  | { type: 'unauthorised' }
  /** The match is over or the player left: stop trying. */
  | { type: 'ended' };

export const CONNECTED: ReconnectState = { status: 'connected', attempt: 0, reason: null };

export function reconnectStep(s: ReconnectState, e: ReconnectEvent, maxAttempts = MAX_RECONNECT_ATTEMPTS): ReconnectState {
  switch (e.type) {
    case 'closed':
      return s.status === 'connected' ? { status: 'reconnecting', attempt: 1, reason: null } : s;
    case 'failed':
      if (s.status !== 'reconnecting') return s;
      if (e.unauthorised) return { status: 'lost', attempt: s.attempt, reason: 'unauthorised' };
      // The server's definitive answer: the table ended or was reaped while we were away. No backoff can bring it back.
      if (e.gone) return { status: 'lost', attempt: s.attempt, reason: 'gone' };
      return s.attempt >= maxAttempts ? { status: 'lost', attempt: s.attempt, reason: 'exhausted' } : { status: 'reconnecting', attempt: s.attempt + 1, reason: null };
    case 'succeeded':
      return s.status === 'reconnecting' ? CONNECTED : s;
    case 'unauthorised':
      return { status: 'lost', attempt: s.attempt, reason: 'unauthorised' };
    case 'ended':
      return s.status === 'lost' ? s : { status: 'lost', attempt: s.attempt, reason: 'ended' };
  }
}

/** How long to wait before the attempt `s` is on (null when no attempt is due). */
export function nextDelayMs(s: ReconnectState): number | null {
  return s.status === 'reconnecting' ? backoffMs(s.attempt) : null;
}
