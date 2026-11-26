/**
 * The records of online tables this device no longer has in its saved-table slot (src/app-state.tsx): one the server
 * said was gone, one the player gave up, one another table took the slot from, one whose saved table went stale before
 * the app was opened again, and one whose match ended without the phone verifying the end. Each is kept under the game
 * server and the match (and the room it was played at), so that when the account sits at that match again by any path
 * (Quick Match's answer that it holds a seat there, a club's table, a notification, Join by code), the table client
 * takes the record up instead of starting with nothing: by the room it joins (`TableClient.fromArchive`, only for the
 * match it holds), or by the match the table's welcome names (`TableClientOptions.keptRecord`), wherever the table runs
 * it. A server cannot make the phone forget what it checked by saying the table is gone and then seating the account
 * there again, or at another room code. Home never offers one of these for Resume. Pure: src/storage.ts reads and writes
 * the list.
 */
import type { SerializedClient } from '@mjm/net';

export interface ArchivedTable {
  signalUrl: string;
  roomCode: string;
  matchId: string;
  /** The seat's rejoin token at that table ('' when the table gave none). */
  token: string;
  client: SerializedClient;
  /** When it left the saved-table slot (this device's clock). */
  archivedAt: number;
}

/** How long a record is kept: thirty days (a match does not go on that long; the red hands are kept for a year apart). */
export const ARCHIVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How many are kept at most (the room the newest need is made, as below). */
export const ARCHIVE_MAX = 32;
/**
 * The most characters of JSON they may take together: each record is at most 512,000 (`RECORD_MAX_CHARS`) and an honest
 * one under 200,000, so with the saved table's record and every other saved value the app stays well within what the
 * platforms let it store. Room is made from the records without a red hand first, oldest first, and only then from those
 * with one; the record just kept is never given up for the others.
 */
export const ARCHIVE_MAX_CHARS = 1_000_000;

/** The record holds a hand the phone found red (or the match failed): what it shows must not be given up while others can be. */
export function holdsRed(e: ArchivedTable): boolean {
  const st = e.client?.state;
  return st?.matchFailed === true || (Array.isArray(st?.audits) && st.audits.some((a) => a?.status === 'failed'));
}

/** The entries of `list` (oldest first) within ARCHIVE_MAX and ARCHIVE_MAX_CHARS, room made as described above. */
function within(list: readonly ArchivedTable[]): ArchivedTable[] {
  const out = list.slice();
  const size = (x: ArchivedTable) => JSON.stringify(x).length;
  let total = out.reduce((n, x) => n + size(x) + 1, 1);
  while (out.length > 1 && (out.length > ARCHIVE_MAX || total > ARCHIVE_MAX_CHARS)) {
    // The newest (last) is the one just kept: never given up here.
    const rest = out.slice(0, -1);
    const i = rest.findIndex((x) => !holdsRed(x));
    const drop = i >= 0 ? i : 0;
    total -= size(out[drop]) + 1;
    out.splice(drop, 1);
  }
  return out;
}

/**
 * The online table record leaving the saved-table slot, as an entry, when it holds a match that can still go on as far
 * as this phone knows: one that is not over, or whose end the phone did not verify. The token is the one its client
 * holds (the table's latest), else the slot's.
 */
export function archiveEntry(rec: { signalUrl: string; roomCode: string; token: string; client?: SerializedClient }, now: number): ArchivedTable | null {
  const c = rec.client;
  const matchId = c?.state?.matchId;
  if (!c || typeof matchId !== 'string' || matchId === '' || (c.state.matchOver === true && c.state.matchEndVerified === true)) return null;
  const token = typeof c.state.token === 'string' && c.state.token !== '' ? c.state.token : rec.token;
  return { signalUrl: rec.signalUrl, roomCode: rec.roomCode, matchId, token, client: c, archivedAt: now };
}

/** What the saved-table slot holds, as far as the archive is concerned (src/storage.ts ActiveSession). */
export type Slot = { kind: 'online'; signalUrl: string; roomCode: string; token: string; client?: SerializedClient } | { kind: 'local' } | null;

const matchOf = (s: Slot): string | null => (s?.kind === 'online' && typeof s.client?.state?.matchId === 'string' && s.client.state.matchId !== '' ? s.client.state.matchId : null);

/**
 * The archive after the saved-table slot goes from `prev` to `next`. An online table that leaves the slot (it is gone,
 * given up, or another table, or a record of another match, takes the slot) is kept while its match can still go on,
 * with the record its client holds now when it is the table open on this device (`live`); a match whose record is the
 * slot's again leaves the archive. So is the record of a match that a client holding no match yet takes the slot from,
 * at the same table (it joined holding nothing: a token the record was not saved under, say): that client takes the
 * record up by its match at its first welcome, and if the welcome names another match, the record stays kept. The same
 * list comes back when nothing changed (so nothing is written).
 */
export function archiveOnSlotChange(list: readonly ArchivedTable[], prev: Slot, next: Slot, live: () => SerializedClient | undefined, now: number): readonly ArchivedTable[] {
  let kept = list;
  const prevMatch = matchOf(prev);
  const nextMatch = matchOf(next);
  // The same match: it stays. (A record of the same table saved before its first welcome holds no match: it does not.)
  const stays = prev?.kind === 'online' && next?.kind === 'online' && next.signalUrl === prev.signalUrl && nextMatch !== null && nextMatch === prevMatch;
  if (prev?.kind === 'online' && !stays) {
    const entry = archiveEntry({ ...prev, client: live() ?? prev.client }, now);
    if (entry) kept = withArchived(kept, entry, now);
  }
  if (next?.kind === 'online' && nextMatch !== null) {
    const rest = withoutArchived(kept, { signalUrl: next.signalUrl, matchId: nextMatch });
    if (rest.length !== kept.length) kept = rest;
  }
  return kept;
}

const live = (e: ArchivedTable, now: number) => e.archivedAt > now - ARCHIVE_TTL_MS && e.archivedAt < now + ARCHIVE_TTL_MS;
const sameMatch = (a: Pick<ArchivedTable, 'signalUrl' | 'matchId'>, b: Pick<ArchivedTable, 'signalUrl' | 'matchId'>) => a.signalUrl === b.signalUrl && a.matchId === b.matchId;

/** The entries still kept at `now`. */
export function liveArchive(list: readonly ArchivedTable[], now: number): ArchivedTable[] {
  return list.filter((e) => live(e, now));
}

/** The list with `e` in it (in place of an entry for the same match), the expired ones gone, room made as `within` makes it. */
export function withArchived(list: readonly ArchivedTable[], e: ArchivedTable, now: number): ArchivedTable[] {
  return within([...liveArchive(list, now).filter((x) => !sameMatch(x, e)), e]);
}

/** The list without the entry for this match (its record is in the saved-table slot again). */
export function withoutArchived(list: readonly ArchivedTable[], key: Pick<ArchivedTable, 'signalUrl' | 'matchId'>): ArchivedTable[] {
  return list.filter((x) => !sameMatch(x, key));
}

/** The newest entry kept for this game server and room. */
export function archivedFor(list: readonly ArchivedTable[], signalUrl: string, roomCode: string, now: number): ArchivedTable | undefined {
  return liveArchive(list, now)
    .filter((e) => e.signalUrl === signalUrl && e.roomCode === roomCode)
    .sort((a, b) => a.archivedAt - b.archivedAt)
    .pop();
}

/** The entry kept for this game server and match, wherever it was played. */
export function archivedMatch(list: readonly ArchivedTable[], signalUrl: string, matchId: string, now: number): ArchivedTable | undefined {
  return liveArchive(list, now).find((e) => e.signalUrl === signalUrl && e.matchId === matchId);
}

const str = (x: unknown): x is string => typeof x === 'string';

/** The entries read back from storage: well-formed and still kept ones only, within the bounds. */
export function validArchive(raw: unknown, now: number): ArchivedTable[] {
  if (!Array.isArray(raw)) return [];
  const ok = raw.filter((e): e is ArchivedTable => {
    if (!e || typeof e !== 'object') return false;
    const x = e as Record<string, unknown>;
    const c = x.client as { state?: { matchId?: unknown } } | null | undefined;
    return str(x.signalUrl) && str(x.roomCode) && str(x.matchId) && x.matchId !== '' && str(x.token) && typeof x.archivedAt === 'number' && Number.isFinite(x.archivedAt) && !!c && typeof c === 'object' && c.state?.matchId === x.matchId;
  });
  return within(liveArchive(ok, now).sort((a, b) => a.archivedAt - b.archivedAt));
}
