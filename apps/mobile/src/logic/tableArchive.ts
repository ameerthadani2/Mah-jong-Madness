/**
 * The records of online tables this device no longer has in its saved-table slot (src/app-state.tsx): one the server
 * said was gone, one the player gave up, and one another table took the slot from. Each is kept for a day under the game
 * server, the room and the match, so that when the account sits at that room again by any path (Quick Match's answer
 * that it holds a seat there, a club's table, a notification, Join by code), the table client takes the record up
 * (`TableClient.fromArchive`: only for the match it holds) instead of starting with nothing. A server cannot make the
 * phone forget what it checked by saying the table is gone and then seating the account there again. Home never offers
 * one of these for Resume. Pure: src/storage.ts reads and writes the list.
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

/** How long a record is kept: a day. */
export const ARCHIVE_TTL_MS = 24 * 60 * 60 * 1000;
/** How many are kept at most (the newest). */
export const ARCHIVE_MAX = 3;

/**
 * The online table record leaving the saved-table slot, as an entry, when it holds a match that is not over. The token is
 * the one its client holds (the table's latest), else the slot's.
 */
export function archiveEntry(rec: { signalUrl: string; roomCode: string; token: string; client?: SerializedClient }, now: number): ArchivedTable | null {
  const c = rec.client;
  const matchId = c?.state?.matchId;
  if (!c || typeof matchId !== 'string' || matchId === '' || c.state.matchOver === true) return null;
  const token = typeof c.state.token === 'string' && c.state.token !== '' ? c.state.token : rec.token;
  return { signalUrl: rec.signalUrl, roomCode: rec.roomCode, matchId, token, client: c, archivedAt: now };
}

/** What the saved-table slot holds, as far as the archive is concerned (src/storage.ts ActiveSession). */
export type Slot = { kind: 'online'; signalUrl: string; roomCode: string; token: string; client?: SerializedClient } | { kind: 'local' } | null;

/**
 * The archive after the saved-table slot goes from `prev` to `next`. An online table that leaves the slot (it is gone,
 * given up, or another table takes the slot) is kept while its match is not over, with the record its client holds now
 * when it is the table open on this device (`live`); a table whose record is the slot's again leaves the archive. The same
 * list comes back when nothing changed (so nothing is written).
 */
export function archiveOnSlotChange(list: readonly ArchivedTable[], prev: Slot, next: Slot, live: () => SerializedClient | undefined, now: number): readonly ArchivedTable[] {
  let kept = list;
  if (prev?.kind === 'online' && !(next?.kind === 'online' && next.signalUrl === prev.signalUrl && next.roomCode === prev.roomCode)) {
    const entry = archiveEntry({ ...prev, client: live() ?? prev.client }, now);
    if (entry) kept = withArchived(kept, entry, now);
  }
  const matchId = next?.kind === 'online' ? next.client?.state?.matchId : null;
  if (next?.kind === 'online' && typeof matchId === 'string' && matchId !== '') {
    const rest = withoutArchived(kept, { signalUrl: next.signalUrl, roomCode: next.roomCode, matchId });
    if (rest.length !== kept.length) kept = rest;
  }
  return kept;
}

const live = (e: ArchivedTable, now: number) => e.archivedAt > now - ARCHIVE_TTL_MS && e.archivedAt < now + ARCHIVE_TTL_MS;
const sameMatch = (a: Pick<ArchivedTable, 'signalUrl' | 'roomCode' | 'matchId'>, b: Pick<ArchivedTable, 'signalUrl' | 'roomCode' | 'matchId'>) =>
  a.signalUrl === b.signalUrl && a.roomCode === b.roomCode && a.matchId === b.matchId;

/** The entries still kept at `now`. */
export function liveArchive(list: readonly ArchivedTable[], now: number): ArchivedTable[] {
  return list.filter((e) => live(e, now));
}

/** The list with `e` in it (in place of an entry for the same table and match), the expired ones gone, the newest ARCHIVE_MAX last. */
export function withArchived(list: readonly ArchivedTable[], e: ArchivedTable, now: number): ArchivedTable[] {
  return [...liveArchive(list, now).filter((x) => !sameMatch(x, e)), e].slice(-ARCHIVE_MAX);
}

/** The list without the entry for this table and match (its record is in the saved-table slot again). */
export function withoutArchived(list: readonly ArchivedTable[], key: Pick<ArchivedTable, 'signalUrl' | 'roomCode' | 'matchId'>): ArchivedTable[] {
  return list.filter((x) => !sameMatch(x, key));
}

/** The newest entry kept for this game server and room. */
export function archivedFor(list: readonly ArchivedTable[], signalUrl: string, roomCode: string, now: number): ArchivedTable | undefined {
  return liveArchive(list, now)
    .filter((e) => e.signalUrl === signalUrl && e.roomCode === roomCode)
    .sort((a, b) => a.archivedAt - b.archivedAt)
    .pop();
}

const str = (x: unknown): x is string => typeof x === 'string';

/** The entries read back from storage: well-formed and still kept ones only, at most ARCHIVE_MAX. */
export function validArchive(raw: unknown, now: number): ArchivedTable[] {
  if (!Array.isArray(raw)) return [];
  const ok = raw.filter((e): e is ArchivedTable => {
    if (!e || typeof e !== 'object') return false;
    const x = e as Record<string, unknown>;
    const c = x.client as { state?: { matchId?: unknown } } | null | undefined;
    return str(x.signalUrl) && str(x.roomCode) && str(x.matchId) && x.matchId !== '' && str(x.token) && typeof x.archivedAt === 'number' && Number.isFinite(x.archivedAt) && !!c && typeof c === 'object' && c.state?.matchId === x.matchId;
  });
  return liveArchive(ok, now).slice(-ARCHIVE_MAX);
}
