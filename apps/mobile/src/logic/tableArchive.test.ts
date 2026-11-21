import { describe, expect, it } from 'vitest';
import type { SerializedClient } from '@mjm/net';
import { ARCHIVE_MAX, ARCHIVE_TTL_MS, archivedFor, archiveEntry, archiveOnSlotChange, validArchive, withArchived, type ArchivedTable, type Slot } from './tableArchive';

const URL = 'wss://game.example/ws';
/** A client record as the table client saves it, for a match `matchId` (`over`: the match ended). */
const record = (matchId: string | null, over = false, token = 'tok-client'): SerializedClient => ({ version: 2, state: { matchId, matchOver: over, token } }) as unknown as SerializedClient;
const slot = (room: string, matchId: string | null, over = false): Slot => ({ kind: 'online', signalUrl: URL, roomCode: room, token: 'tok-slot', client: record(matchId, over) });
const none = () => undefined;

describe('the records of tables that left the saved-table slot', () => {
  it('a table the server said was gone, or the player gave up, is kept under its room and match, with its token', () => {
    const kept = archiveOnSlotChange([], slot('ABC123', 'm-1'), null, none, 1_000);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ signalUrl: URL, roomCode: 'ABC123', matchId: 'm-1', token: 'tok-client', archivedAt: 1_000 });
    expect(archivedFor(kept, URL, 'ABC123', 2_000)?.matchId).toBe('m-1');
    expect(archivedFor(kept, URL, 'OTHER1', 2_000)).toBeUndefined();
    expect(archivedFor(kept, 'wss://other.example/ws', 'ABC123', 2_000)).toBeUndefined();
  });

  it('so is one another table takes the slot from (an online table, or a match against the bots)', () => {
    expect(archiveOnSlotChange([], slot('ABC123', 'm-1'), slot('XYZ789', 'm-2'), none, 1_000).map((e) => e.roomCode)).toEqual(['ABC123']);
    expect(archiveOnSlotChange([], slot('ABC123', 'm-1'), { kind: 'local' }, none, 1_000).map((e) => e.roomCode)).toEqual(['ABC123']);
  });

  it('with the record the open table holds now, when it is that table (the slot is saved a moment after a change)', () => {
    const live = record('m-1', false, 'tok-new');
    const kept = archiveOnSlotChange([], slot('ABC123', 'm-1'), null, () => live, 1_000);
    expect(kept[0].client).toBe(live);
    expect(kept[0].token).toBe('tok-new');
  });

  it('nothing is kept of a match that is over, of a table whose welcome never came, or of a table saved again', () => {
    expect(archiveOnSlotChange([], slot('ABC123', 'm-1', true), null, none, 1_000)).toEqual([]);
    expect(archiveOnSlotChange([], slot('ABC123', 'm-1'), null, () => record('m-1', true), 1_000)).toEqual([]);
    expect(archiveOnSlotChange([], slot('ABC123', null), null, none, 1_000)).toEqual([]);
    const list: ArchivedTable[] = [];
    // The same table saved again (each change of its client): the same list comes back, so nothing is written.
    expect(archiveOnSlotChange(list, slot('ABC123', 'm-1'), slot('ABC123', 'm-1'), none, 1_000)).toBe(list);
    expect(archiveOnSlotChange(list, null, slot('ABC123', 'm-1'), none, 1_000)).toBe(list);
  });

  it('a table whose record is the slot\'s again leaves the archive', () => {
    const kept = archiveOnSlotChange([], slot('ABC123', 'm-1'), null, none, 1_000);
    expect(archiveOnSlotChange(kept, null, slot('ABC123', 'm-1'), none, 2_000)).toEqual([]);
    // Another match at that room code is another table: the kept one stays.
    expect(archiveOnSlotChange(kept, null, slot('ABC123', 'm-9'), none, 2_000)).toBe(kept);
  });

  it('keeps one entry per table and match (the latest), the newest few, for a day', () => {
    let list: ArchivedTable[] = [];
    list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: 'A', token: 't', client: record('m-a') }, 0)!, 0);
    list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: 'A', token: 't', client: record('m-a') }, 10)!, 10);
    expect(list.map((e) => e.archivedAt)).toEqual([10]);
    for (let i = 0; i < ARCHIVE_MAX + 2; i++) list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: `R${i}`, token: 't', client: record(`m-${i}`) }, 20 + i)!, 20 + i);
    expect(list).toHaveLength(ARCHIVE_MAX);
    expect(list[list.length - 1].roomCode).toBe(`R${ARCHIVE_MAX + 1}`);
    expect(archivedFor(list, URL, `R${ARCHIVE_MAX + 1}`, 30 + ARCHIVE_TTL_MS - 20)).toBeDefined();
    expect(archivedFor(list, URL, `R${ARCHIVE_MAX + 1}`, 30 + ARCHIVE_TTL_MS)).toBeUndefined();
  });

  it('of several matches at one room code, the newest is the one a join takes up', () => {
    let list: ArchivedTable[] = [];
    list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: 'A', token: 't', client: record('m-old') }, 0)!, 0);
    list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: 'A', token: 't', client: record('m-new') }, 5)!, 5);
    expect(archivedFor(list, URL, 'A', 10)?.matchId).toBe('m-new');
  });

  it('reads back only well-formed entries still kept', () => {
    const good = archiveEntry({ signalUrl: URL, roomCode: 'A', token: 't', client: record('m-a') }, 1_000)!;
    expect(validArchive([good], 2_000)).toEqual([good]);
    expect(validArchive([good], 1_000 + ARCHIVE_TTL_MS + 1)).toEqual([]);
    expect(validArchive('nope', 2_000)).toEqual([]);
    expect(validArchive([null, 3, { ...good, matchId: 7 }, { ...good, client: record('m-other') }, { ...good, archivedAt: 'x' }, { ...good, roomCode: undefined }], 2_000)).toEqual([]);
  });
});
