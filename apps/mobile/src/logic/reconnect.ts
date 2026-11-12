/**
 * Reconnecting to an online table after the game server's socket drops: the backoff schedule
 * and a small state machine. Pure; src/game/session.ts drives it with real timers.
 *
 *   connected ──closed──▶ reconnecting(1) ──failed──▶ reconnecting(2) … ──failed (10th)──▶ lost
 *        ▲                      │ succeeded                                   ▲
 *        └──────────────────────┘          unauthorised (4401), room gone ────┘ (from any attempt)
 *
 * Any other close is a reason to try again: a dropped link (1006), a server that is restarting
 * (1001, 1012) and one that could not finish checking the session in time (1013).
 * Three endings are never retried. Two because trying again would undo what the server just did:
 * the seat was opened on another device ('ended'; the table client is `kicked`), and a watcher made
 * way for a player ('madeWay'). The third because the answer cannot change: the account was banned
 * ('banned'; the socket closed with 4403), which outranks every other ending.
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
  reason: 'exhausted' | 'unauthorised' | 'ended' | 'gone' | 'madeWay' | 'banned' | null;
}

export type ReconnectEvent =
  /** The socket closed unexpectedly. */
  | { type: 'closed' }
  /** The attempt in progress failed; `unauthorised` when the server refused the session (4401), `gone` when it answered the join with 'Room not found or full'. */
  | { type: 'failed'; unauthorised?: boolean; gone?: boolean }
  | { type: 'succeeded' }
  /** The socket closed with 4401: no point retrying with the same session. */
  | { type: 'unauthorised' }
  /** The match is over, the seat was opened on another device or the player left: stop trying. */
  | { type: 'ended' }
  /** The server took this watcher out of the room because a player needed the place: joining again is the player's choice. */
  | { type: 'madeWay' }
  /** The socket closed with 4403, now or on a rejoin: the account is banned, and no retry or new session changes that. */
  | { type: 'banned' }
  /** The player pressed "Reconnect" on a lost link: start trying again (only where trying can help, `canRetry`). */
  | { type: 'retry' };

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
      return s.reason === 'banned' ? s : { status: 'lost', attempt: s.attempt, reason: 'unauthorised' };
    case 'ended':
      return s.status === 'lost' ? s : { status: 'lost', attempt: s.attempt, reason: 'ended' };
    case 'madeWay':
      return s.status === 'lost' ? s : { status: 'lost', attempt: s.attempt, reason: 'madeWay' };
    case 'banned':
      // The server's last word on the account, whatever the link was doing or had already been told.
      return s.reason === 'banned' ? s : { status: 'lost', attempt: s.attempt, reason: 'banned' };
    case 'retry':
      return canRetry(s) ? { status: 'reconnecting', attempt: 1, reason: null } : s;
  }
}

/**
 * Whether the player's "Reconnect" can do what it says: the link was given up after its attempts ran out
 * (the server may be back by now), or the session was refused (a fresh one is fetched for the next try).
 * Every other ending is final or the player's own choice (another device, a watcher who made way, a table
 * that is gone, a ban): there the button leads back to Home.
 */
export function canRetry(s: Pick<ReconnectState, 'status' | 'reason'>): boolean {
  return s.status === 'lost' && (s.reason === 'exhausted' || s.reason === 'unauthorised');
}

/** How long to wait before the attempt `s` is on (null when no attempt is due). */
export function nextDelayMs(s: ReconnectState): number | null {
  return s.status === 'reconnecting' ? backoffMs(s.attempt) : null;
}

/**
 * The game server's sentence to a watcher (a peer at a table without a seat) whose place a player
 * needed: it arrives as the signalling error `closed` (WATCHER_DROPPED in apps/signal/src/rooms.ts).
 */
export const WATCHER_MADE_WAY = /^a player needed your place at this table/i;

export function isWatcherMadeWay(message: unknown): boolean {
  return typeof message === 'string' && WATCHER_MADE_WAY.test(message.trim());
}

/**
 * What the lobby and the table say about the link, most specific first:
 *  - 'banned': the account was banned while at the table, so nothing here can bring the seat back;
 *  - 'seatTaken': this seat was opened on another device, and this one has stopped for good;
 *  - 'madeWay': this watcher made way for a player;
 *  - 'reconnecting': the session is rejoining by itself;
 *  - 'gone': the server no longer has the table;
 *  - 'lost': the link is down and the session has given up, or the player must come back by hand;
 *  - null: nothing to say.
 */
export type LinkNotice = 'banned' | 'seatTaken' | 'madeWay' | 'reconnecting' | 'gone' | 'lost' | null;

export function linkNotice(conn: Pick<ReconnectState, 'status' | 'reason'>, table: { kicked?: boolean; disconnected?: boolean } | null | undefined): LinkNotice {
  // A ban ends everything else: "resume from Home" or "reconnect" would both be refused.
  if (conn.status === 'lost' && conn.reason === 'banned') return 'banned';
  // Then the table client's own word: whatever the link does next, this device was replaced.
  if (table?.kicked) return 'seatTaken';
  if (conn.status === 'lost' && conn.reason === 'madeWay') return 'madeWay';
  if (conn.status === 'reconnecting') return 'reconnecting';
  if (conn.status === 'lost' && conn.reason === 'gone') return 'gone';
  if (conn.status === 'lost' || table?.disconnected) return 'lost';
  return null;
}

/** True when the session will not come back by itself and the screen must offer the way out. */
export function linkEnded(notice: LinkNotice): boolean {
  return notice !== null && notice !== 'reconnecting';
}

/**
 * True when the saved record of the table is of no use any more and goes with the session: the
 * server no longer has the table, or it will not let this account back to it (a ban). After
 * 'seatTaken' the record stays, so the player can take the seat back from Home on purpose; a
 * watcher has no record to keep.
 */
export function forgetsTable(notice: LinkNotice): boolean {
  return notice === 'gone' || notice === 'banned';
}

/** Translation keys for an ended link: what happened, what it means, and the button that leads out. */
export interface LinkCopy {
  /** The table's banner only; the lobby shows `text` alone. */
  title: string;
  text: string;
  leave: string;
}

const TABLE_COPY: Readonly<Record<Exclude<LinkNotice, null | 'reconnecting'>, LinkCopy>> = {
  // The sentence is the one Settings shows for a banned account: it also says a new guest would be refused.
  banned: { title: 'table.connection.bannedTitle', text: 'settings.account.banned', leave: 'table.connection.goneLeave' },
  seatTaken: { title: 'table.connection.seatTakenTitle', text: 'table.connection.seatTakenText', leave: 'table.connection.goneLeave' },
  madeWay: { title: 'table.connection.madeWayTitle', text: 'online.errors.watcherDropped', leave: 'table.connection.goneLeave' },
  gone: { title: 'table.connection.goneTitle', text: 'table.connection.goneText', leave: 'table.connection.goneLeave' },
  lost: { title: 'table.connection.lostTitle', text: 'table.connection.lostText', leave: 'table.connection.reconnect' },
};

/**
 * The copy for an ended link at the table or in the lobby. Only a plain lost link offers
 * "Reconnect", which starts the session trying again (`canRetry`; where it cannot, the button closes the
 * table and Home's Resume card brings the seat back); every other ending leads back to Home.
 */
export function linkCopy(notice: Exclude<LinkNotice, null | 'reconnecting'>, where: 'table' | 'lobby'): LinkCopy {
  const copy = TABLE_COPY[notice];
  if (where === 'table') return copy;
  if (notice === 'gone') return { ...copy, text: 'lobby.tableGone', leave: 'common.back' };
  if (notice === 'lost') return { ...copy, text: 'lobby.connectionLost', leave: 'lobby.reconnect' };
  return copy;
}
