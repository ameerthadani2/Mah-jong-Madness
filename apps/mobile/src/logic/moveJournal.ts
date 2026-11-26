/**
 * The journal of moves (packages/net `TableClientOptions.writeAhead`): the table client hands every move it files to the
 * app, which writes it here before the move goes out. A client restored from the record of a table (an app restart,
 * Home's Resume, a record taken up from the archive) is given back what the journal holds for its match
 * (`TableClientOptions.journal`), so it knows every move this device sent, also those sent after the record was last
 * written, and holds the hand under way to them from the deal on.
 *
 * The journal is kept by game server and match, for as long as the app keeps a record of that match (the saved-table
 * slot or the archive, src/app-state.tsx): a list leaves the journal with its match's record (`keptFor`), never before
 * it. Once a record that holds a match's moves has been written, the entries it holds leave the journal (`afterSave`),
 * so the journal stays a few entries long. After a record is written the match's list stays, empty, which says there is
 * nothing beyond the record. A match the journal holds no list for is one it cannot vouch for (`journalOf` gives
 * nothing): a restored client then holds the hand under way as one without a journal does, except that a record this
 * build wrote says every move of the hand went to the journal, so a move after the record that the client cannot check
 * keeps the hand amber and the end of the match unverified (packages/net `TableClient.load`). Pure: src/storage.ts
 * reads and writes it.
 */
import { ARCHIVE_MAX } from './tableArchive';

export interface MatchJournal {
  signalUrl: string;
  matchId: string;
  /** The entries the table client handed over (`JournalEntry`), oldest first; the client checks each when it reads them. */
  entries: unknown[];
}

export type MoveJournal = readonly MatchJournal[];

/**
 * The most matches it keeps a list for (the newest written last): room for every match the app can keep a record of at
 * once, with some to spare. That is the archive's records (ARCHIVE_MAX), the saved table's, the table open on this
 * device, and the one open before it while the first record of the new one is not yet written. Lists go with their
 * records (`keptFor`, src/app-state.tsx), so this cap never drops the list of a match whose record is kept; it bounds a
 * journal read back from storage.
 */
export const JOURNAL_MATCHES_MAX = ARCHIVE_MAX + 8;
/**
 * The most entries one match's list keeps (the newest): far more than an honest table makes between two writes of the
 * record. Dropping the oldest leaves a gap after the record's last move, so the client then vouches as one without a
 * journal does: never more than it knows.
 */
export const JOURNAL_ENTRIES_MAX = 200;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const seqOf = (x: unknown): number | null => (isObject(x) && typeof x.seq === 'number' && Number.isInteger(x.seq) ? x.seq : null);
const matchOf = (x: unknown): string | null => (isObject(x) && typeof x.matchId === 'string' && x.matchId !== '' ? x.matchId : null);
const same = (j: MatchJournal, signalUrl: string, matchId: string) => j.signalUrl === signalUrl && j.matchId === matchId;

/** What the journal holds for this match at this game server: undefined when it holds no list for it. */
export function journalOf(j: MoveJournal, signalUrl: string, matchId: string): unknown[] | undefined {
  const m = j.find((x) => same(x, signalUrl, matchId));
  return m ? m.entries.slice() : undefined;
}

/** The journal with match `m` (its list replaced) written last, at most JOURNAL_MATCHES_MAX matches. */
function put(j: MoveJournal, m: MatchJournal): MoveJournal {
  return [...j.filter((x) => !same(x, m.signalUrl, m.matchId)), m].slice(-JOURNAL_MATCHES_MAX);
}

/**
 * The journal with `entry`, a move the table client filed at the game server `signalUrl`, written in its match's list.
 * Entries the list holds at the entry's place or after it go: a client files its moves at places that only grow, so
 * they were filed by a client that did not take this list up (one that joined with nothing), and are no part of it.
 */
export function withEntry(j: MoveJournal, signalUrl: string, entry: unknown): MoveJournal {
  const matchId = matchOf(entry);
  const seq = seqOf(entry);
  if (matchId === null || seq === null) return j;
  const prev = j.find((x) => same(x, signalUrl, matchId))?.entries ?? [];
  const kept = prev.filter((x) => (seqOf(x) ?? Number.POSITIVE_INFINITY) < seq);
  return put(j, { signalUrl, matchId, entries: [...kept, entry].slice(-JOURNAL_ENTRIES_MAX) });
}

/** The journal without `entry` (it was not written, so the move did not go out). */
export function withoutEntry(j: MoveJournal, signalUrl: string, entry: unknown): MoveJournal {
  const matchId = matchOf(entry);
  const seq = seqOf(entry);
  const m = matchId === null ? undefined : j.find((x) => same(x, signalUrl, matchId));
  if (!m || seq === null) return j;
  return j.map((x) => (x === m ? { ...m, entries: m.entries.filter((e) => seqOf(e) !== seq) } : x));
}

/**
 * The journal once a record of match `matchId` holding every move up to place `sentSeq` (`SerializedClient.sentSeq`) has
 * been written: the entries it holds leave the match's list, and the list stays (empty, if it was all in the record), so
 * a client restored from that record is told nothing was sent after it. The same journal comes back when nothing changed.
 */
export function afterSave(j: MoveJournal, signalUrl: string, matchId: string, sentSeq: number): MoveJournal {
  const m = j.find((x) => same(x, signalUrl, matchId));
  if (!m) return put(j, { signalUrl, matchId, entries: [] });
  const entries = m.entries.filter((x) => (seqOf(x) ?? 0) > sentSeq);
  return entries.length === m.entries.length ? j : j.map((x) => (x === m ? { ...m, entries } : x));
}

/** The journal with the lists of the matches `held` says the app still keeps a record of, and no others. */
export function keptFor(j: MoveJournal, held: (signalUrl: string, matchId: string) => boolean): MoveJournal {
  const out = j.filter((x) => held(x.signalUrl, x.matchId));
  return out.length === j.length ? j : out;
}

/** The journal read back from storage: well-formed lists only (the client checks each entry when it takes them up). */
export function validJournal(raw: unknown): MoveJournal {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is MatchJournal => isObject(x) && typeof x.signalUrl === 'string' && typeof x.matchId === 'string' && x.matchId !== '' && Array.isArray(x.entries))
    .map((x) => ({ signalUrl: x.signalUrl, matchId: x.matchId, entries: x.entries.slice(-JOURNAL_ENTRIES_MAX) }))
    .slice(-JOURNAL_MATCHES_MAX);
}
