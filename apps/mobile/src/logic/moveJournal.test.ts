import { describe, expect, it } from 'vitest';
import { afterSave, journalOf, JOURNAL_ENTRIES_MAX, JOURNAL_MATCHES_MAX, keptFor, validJournal, withEntry, withoutEntry, type MoveJournal } from './moveJournal';
import { ARCHIVE_MAX, archiveEntry, archivedMatch, withArchived, type ArchivedTable } from './tableArchive';

const URL = 'wss://game.example/ws';
/** A journal entry as the table client hands it over (only the fields the journal reads matter here). */
const entry = (seq: number, matchId = 'm-1') => ({ seq, matchId, hand: 0, tc: seq, action: { type: 'pass' }, epoch: 1, at: 1000 + seq, run: 'r1', seg: 0, from: 0, sum: `s${seq}` });

describe('the journal of moves', () => {
  it('keeps each move under its game server and match, in the order it was filed', () => {
    let j: MoveJournal = [];
    j = withEntry(j, URL, entry(1));
    j = withEntry(j, URL, entry(2));
    j = withEntry(j, URL, entry(1, 'm-2'));
    j = withEntry(j, 'wss://other.example/ws', entry(7));
    expect(journalOf(j, URL, 'm-1')).toEqual([entry(1), entry(2)]);
    expect(journalOf(j, URL, 'm-2')).toEqual([entry(1, 'm-2')]);
    expect(journalOf(j, 'wss://other.example/ws', 'm-1')).toEqual([entry(7)]);
    // A match it holds no list for: nothing it can vouch for.
    expect(journalOf(j, URL, 'm-3')).toBeUndefined();
  });

  it('an entry at a place the list already holds starts the list again from there: those were filed by a client that did not take it up', () => {
    let j: MoveJournal = [];
    for (const n of [1, 2, 3]) j = withEntry(j, URL, entry(n));
    j = withEntry(j, URL, entry(2));
    expect(journalOf(j, URL, 'm-1')).toEqual([entry(1), entry(2)]);
  });

  it('ignores what is not an entry of a match', () => {
    const j = withEntry([], URL, { seq: 1 });
    expect(j).toEqual([]);
    expect(withEntry(j, URL, { matchId: 'm-1', seq: 'x' })).toEqual([]);
  });

  it('a move that did not go out leaves it again', () => {
    let j: MoveJournal = [];
    for (const n of [1, 2]) j = withEntry(j, URL, entry(n));
    expect(journalOf(withoutEntry(j, URL, entry(2)), URL, 'm-1')).toEqual([entry(1)]);
    expect(withoutEntry(j, URL, entry(1, 'm-9'))).toBe(j);
  });

  it('once a record holding the moves up to a place is written, those leave it; the list stays, empty when all of it was in the record', () => {
    let j: MoveJournal = [];
    for (const n of [4, 5, 6]) j = withEntry(j, URL, entry(n));
    j = afterSave(j, URL, 'm-1', 5);
    expect(journalOf(j, URL, 'm-1')).toEqual([entry(6)]);
    j = afterSave(j, URL, 'm-1', 6);
    expect(journalOf(j, URL, 'm-1')).toEqual([]);
    // The same journal when nothing changed (so nothing is written).
    expect(afterSave(j, URL, 'm-1', 6)).toBe(j);
    // A match whose record was written before any move: its list starts, empty.
    expect(journalOf(afterSave([], URL, 'm-2', 0), URL, 'm-2')).toEqual([]);
  });

  it('keeps the lists of the matches the app still keeps a record of, and only so many matches and entries', () => {
    let j: MoveJournal = [];
    for (let m = 0; m < JOURNAL_MATCHES_MAX + 3; m++) j = withEntry(j, URL, entry(1, `m-${m}`));
    expect(j).toHaveLength(JOURNAL_MATCHES_MAX);
    expect(journalOf(j, URL, 'm-0')).toBeUndefined();
    const kept = keptFor(j, (_url, m) => m === 'm-5');
    expect(kept.map((x) => x.matchId)).toEqual(['m-5']);
    expect(keptFor(kept, () => true)).toBe(kept);
    let long: MoveJournal = [];
    for (let n = 1; n <= JOURNAL_ENTRIES_MAX + 5; n++) long = withEntry(long, URL, entry(n));
    const list = journalOf(long, URL, 'm-1')!;
    expect(list).toHaveLength(JOURNAL_ENTRIES_MAX);
    expect(list[0]).toEqual(entry(6));
  });

  it('keeps the list of every match whose record the app keeps: 31 other tables that leave Home unfinished push out neither the record nor the list', () => {
    // A record of each table as the archive keeps it (only what the archive reads).
    const record = (matchId: string) => ({ version: 1, state: { matchId, matchOver: false } }) as unknown as ArchivedTable['client'];
    const held = (archive: readonly ArchivedTable[]) => (url: string, m: string) => archive.some((e) => e.signalUrl === url && e.matchId === m);
    // The table the server cut the player off from: its record was written (its list stays, empty) and it left Home.
    let j = afterSave(withEntry([], URL, entry(1)), URL, 'm-victim', 1);
    let archive = withArchived([], archiveEntry({ signalUrl: URL, roomCode: 'VICTIM', token: 't', client: record('m-victim') }, 1_000)!, 1_000);
    // Then the account sits at 31 other tables, each saved once (its list made) and each leaving Home unfinished.
    for (let k = 1; k <= ARCHIVE_MAX - 1; k++) {
      j = afterSave(j, URL, `m-other-${k}`, 0);
      archive = withArchived(archive, archiveEntry({ signalUrl: URL, roomCode: `OTHER${k}`, token: 't', client: record(`m-other-${k}`) }, 1_000 + k)!, 1_000 + k);
      j = keptFor(j, held(archive));
    }
    // The record is still kept, and so is its list: empty, which says nothing was sent after the record.
    expect(archivedMatch(archive, URL, 'm-victim', 2_000)).toBeDefined();
    expect(journalOf(j, URL, 'm-victim')).toEqual([]);
    // And as read back from storage after a cold start.
    expect(journalOf(validJournal(JSON.parse(JSON.stringify(j))), URL, 'm-victim')).toEqual([]);
    // One more pushes the record out (the stated limit), and its list goes with it.
    j = afterSave(j, URL, 'm-other-x', 0);
    archive = withArchived(archive, archiveEntry({ signalUrl: URL, roomCode: 'OTHERX', token: 't', client: record('m-other-x') }, 1_100)!, 1_100);
    j = keptFor(j, held(archive));
    expect(archivedMatch(archive, URL, 'm-victim', 2_000)).toBeUndefined();
    expect(journalOf(j, URL, 'm-victim')).toBeUndefined();
    // The cap leaves room for the archive's records, the saved table's and the table open on this device.
    expect(JOURNAL_MATCHES_MAX).toBeGreaterThanOrEqual(ARCHIVE_MAX + 2);
  });

  it('reads back only well-formed lists from storage', () => {
    expect(validJournal('nope')).toEqual([]);
    expect(validJournal([{ signalUrl: URL, matchId: 'm-1', entries: [entry(1)] }, { signalUrl: URL, matchId: '', entries: [] }, { signalUrl: URL, matchId: 'm-2' }, null])).toEqual([{ signalUrl: URL, matchId: 'm-1', entries: [entry(1)] }]);
  });
});
