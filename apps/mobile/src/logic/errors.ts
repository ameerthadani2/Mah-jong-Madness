/**
 * Turns an error from the network, the game server or the clubs API into a sentence
 * a player can act on. Known failure shapes map to a key in the `errors` namespace,
 * so the copy is translated; short, human-readable server messages we do not know
 * pass through as they are; anything technical is replaced with a generic line.
 *
 * `friendlyErrorMessage` returns the key and parameters (pure, testable);
 * `friendlyError(e, t)` renders it with the caller's `t`.
 */
import type { Message, Translate } from './translate';

const TIMEOUT: Message = { key: 'errors.timeout' };
const GENERIC: Message = { key: 'errors.generic' };

/** Checked in order: the first match wins. */
const RULES: ReadonlyArray<{ test: RegExp; key: string }> = [
  { test: /timed? ?out|timeout|aborted/i, key: 'errors.timeout' },
  { test: /too many|rate.?limit|slow down|\b429\b/i, key: 'errors.rateLimited' },
  { test: /room (?:is )?(?:not found|full)|not found or full/i, key: 'errors.roomUnavailable' },
  {
    test: /network request failed|failed to fetch|load failed|signaling connection failed|connection (?:closed|refused|failed|lost)|not connected|websocket|econnrefused|enotfound|socket hang up/i,
    key: 'errors.unreachable',
  },
  { test: /capacity|server is full|no tables available/i, key: 'errors.busy' },
  { test: /request failed \(\d{3}\)|internal (?:server )?error/i, key: 'errors.serverProblem' },
];

/**
 * Readable messages the game server, the table host and the clubs API send, mapped
 * to translated copy. The English copy is the server's own sentence; numbers in it
 * (limits) become parameters.
 */
const KNOWN: ReadonlyArray<{ test: RegExp; key: string; params?: (m: RegExpMatchArray) => Record<string, string> }> = [
  // Game server (apps/signal/src/rooms.ts) and the signalling client.
  { test: /^only server-hosted tables can be created/i, key: 'errors.hostedOnly' },
  { test: /^hosted tables are disabled/i, key: 'errors.hostedDisabled' },
  { test: /^please wait a few seconds before creating another room/i, key: 'errors.createCooldown' },
  { test: /^the game server did not answer in time/i, key: 'errors.noAnswer' },
  { test: /^unauthori[sz]ed/i, key: 'errors.unauthorised' },
  // Table host (packages/net/src/host.ts) and table client.
  { test: /^table is full/i, key: 'errors.tableFull' },
  { test: /^match already in progress/i, key: 'errors.matchInProgress' },
  { test: /^join the table first/i, key: 'errors.notSeated' },
  { test: /^no hand in progress/i, key: 'errors.notPlaying' },
  { test: /^you can only act for your own seat/i, key: 'errors.wrongSeat' },
  { test: /^connection to the table was lost/i, key: 'errors.tableLost' },
  { test: /^this seat was opened on another device/i, key: 'errors.seatTaken' },
  // Clubs API (apps/signal/src/clubs.ts).
  { test: /^club not found/i, key: 'errors.clubNotFound' },
  { test: /^you do not have permission to do that in this club/i, key: 'errors.clubForbidden' },
  { test: /^you can belong to at most (\d+) clubs/i, key: 'errors.clubsPerUser', params: (m) => ({ max: m[1] }) },
  { test: /^this club is full \((\d+) members\)/i, key: 'errors.clubFull', params: (m) => ({ max: m[1] }) },
  { test: /^club name is required/i, key: 'errors.clubNameRequired' },
  { test: /^this club has too many pending requests/i, key: 'errors.clubPendingFull' },
  { test: /^no pending request for that user/i, key: 'errors.noPendingRequest' },
  { test: /^the owner cannot leave/i, key: 'errors.ownerCannotLeave' },
  { test: /^the owner cannot change their own role/i, key: 'errors.ownerOwnRole' },
  { test: /^member not found/i, key: 'errors.memberNotFound' },
  { test: /^join the club first/i, key: 'errors.joinClubFirst' },
  { test: /^only admins can open tables in this club/i, key: 'errors.adminsOnlyTables' },
  { test: /^this club already has (\d+) open tables/i, key: 'errors.clubTablesFull', params: (m) => ({ max: m[1] }) },
  { test: /^credentials required/i, key: 'errors.credentialsRequired' },
  { test: /^identity check failed/i, key: 'errors.identityFailed' },
];

/** Messages that read like code, stack traces or error codes rather than copy. */
const TECHNICAL = /[{}<>[\]]|\bat \S+:\d+|\bundefined\b|\bnull\b|\bNaN\b|is not a function|cannot read|unexpected (?:token|end)|\bjson\b|^[a-z]+(?:_[a-z]+)+$|^[a-z]+$/i;

function field(e: unknown, key: 'message' | 'name' | 'code'): string {
  if (typeof e === 'string') return key === 'message' ? e : '';
  if (e && typeof e === 'object' && key in e) {
    const v = (e as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  }
  return '';
}

function numberField(e: unknown, key: string): number | undefined {
  if (e && typeof e === 'object' && key in e) {
    const v = (e as Record<string, unknown>)[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  }
  return undefined;
}

/**
 * Failures the HTTP clients (src/api/http.ts) mark with their own `code`, and the account
 * API's error codes (docs/API.md) that always mean the same thing whatever the message says.
 */
function fromCode(e: unknown): Message | null {
  if (numberField(e, 'code') === 4401) return { key: 'errors.unauthorised' };
  switch (field(e, 'code')) {
    case 'club_timeout':
      return { key: 'errors.clubTimeout', params: { seconds: numberField(e, 'seconds') ?? 15 } };
    case 'auth_timeout':
      return { key: 'errors.authTimeout', params: { seconds: numberField(e, 'seconds') ?? 15 } };
    case 'club_unreachable':
    case 'auth_unreachable':
      return { key: 'errors.unreachable' };
    case 'club_bad_reply':
      return { key: 'errors.clubBadReply', params: { status: numberField(e, 'status') ?? 0 } };
    case 'auth_bad_reply':
      return { key: 'errors.authBadReply', params: { status: numberField(e, 'status') ?? 0 } };
    case 'invalid_credentials':
      return { key: 'errors.invalidCredentials' };
    case 'invalid_session':
    case 'session_expired':
    case 'session_revoked':
    case 'session_rotated':
      return { key: 'errors.sessionExpired' };
    case 'signed_out':
      return { key: 'errors.signedOut' };
    case 'banned':
      return { key: 'errors.banned' };
    case 'room_unavailable':
      return { key: 'errors.roomUnavailable' };
    case 'invalid_token':
      return { key: 'errors.invalidToken' };
    case 'provider_disabled':
      return { key: 'errors.providerDisabled' };
    case 'not_linked':
      return { key: 'errors.notLinked' };
    case 'identity_in_use':
      return { key: 'errors.identityInUse' };
    case 'last_identity':
      return { key: 'errors.lastIdentity' };
    case 'rate_limited':
      return { key: 'errors.rateLimited' };
    case 'unavailable':
      return { key: 'errors.unavailable' };
    default:
      return null;
  }
}

/** Codes whose server message is usually more specific (a club cap names its number): used only when no message matched. */
function fallbackFromCode(e: unknown): Message | null {
  switch (field(e, 'code')) {
    case 'limit':
      return { key: 'errors.limit' };
    case 'not_found':
      return { key: 'errors.notFound' };
    case 'invalid':
      return { key: 'errors.invalidRequest' };
    default:
      return null;
  }
}

export function friendlyErrorMessage(e: unknown): Message {
  const name = field(e, 'name');
  if (name === 'AbortError' || name === 'TimeoutError') return TIMEOUT;
  const coded = fromCode(e);
  if (coded) return coded;
  const msg = field(e, 'message').trim();
  if (!msg) return fallbackFromCode(e) ?? GENERIC;
  // A sentence we know from the server wins over the generic patterns: "too many pending requests" is a club
  // limit, not throttling.
  for (const k of KNOWN) {
    const m = msg.match(k.test);
    if (m) return k.params ? { key: k.key, params: k.params(m) } : { key: k.key };
  }
  for (const r of RULES) if (r.test.test(msg)) return { key: r.key };
  const fallback = fallbackFromCode(e);
  if (fallback) return fallback;
  if (name === 'SyntaxError' || name === 'TypeError' || name === 'ReferenceError') return GENERIC;
  if (msg.length > 120 || TECHNICAL.test(msg)) return GENERIC;
  return { key: 'errors.passthrough', params: { message: /[.!?]$/.test(msg) ? msg : `${msg}.` } };
}

/** The player-facing sentence for `e` in the current language. */
export function friendlyError(e: unknown, t: Translate): string {
  const m = friendlyErrorMessage(e);
  return t(m.key, m.params);
}
