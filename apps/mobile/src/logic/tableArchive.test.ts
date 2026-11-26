import { describe, expect, it } from 'vitest';
import type { SerializedClient } from '@mjm/net';
import { ARCHIVE_MAX, ARCHIVE_MAX_CHARS, ARCHIVE_TTL_MS, archivedFor, archivedMatch, archiveEntry, archiveOnSlotChange, holdsRed, validArchive, withArchived, type ArchivedTable, type Slot } from './tableArchive';

const URL = 'wss://game.example/ws';
/** A client record as the table client saves it, for a match `matchId` (`over`: the match ended, and the phone verified the end). */
const record = (matchId: string | null, over = false, token = 'tok-client'): SerializedClient => ({ version: 2, state: { matchId, matchOver: over, matchEndVerified: over, token } }) as unknown as SerializedClient;
/** The same, for a match whose end the phone took without verifying it (a hand failed, or it could not check the chain). */
const unverifiedEnd = (matchId: string, failed = false): SerializedClient => ({ version: 2, state: { matchId, matchOver: true, matchEndVerified: false, matchFailed: failed, token: 'tok-client' } }) as unknown as SerializedClient;
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

  it('nothing is kept of a match whose end the phone verified, of a table whose welcome never came, or of a table saved again', () => {
    expect(archiveOnSlotChange([], slot('ABC123', 'm-1', true), null, none, 1_000)).toEqual([]);
    expect(archiveOnSlotChange([], slot('ABC123', 'm-1'), null, () => record('m-1', true), 1_000)).toEqual([]);
    expect(archiveOnSlotChange([], slot('ABC123', null), null, none, 1_000)).toEqual([]);
    const list: ArchivedTable[] = [];
    // The same table saved again (each change of its client): the same list comes back, so nothing is written.
    expect(archiveOnSlotChange(list, slot('ABC123', 'm-1'), slot('ABC123', 'm-1'), none, 1_000)).toBe(list);
    expect(archiveOnSlotChange(list, null, slot('ABC123', 'm-1'), none, 1_000)).toBe(list);
  });

  it('a match whose end the phone took without verifying it is kept: a server could say a match was over and seat the account there again', () => {
    expect(archiveOnSlotChange([], slot('ABC123', 'm-1'), null, () => unverifiedEnd('m-1'), 1_000).map((e) => e.matchId)).toEqual(['m-1']);
    expect(archiveEntry({ signalUrl: URL, roomCode: 'ABC123', token: 't', client: unverifiedEnd('m-1', true) }, 0)?.matchId).toBe('m-1');
  });

  it('a match whose record is the slot\'s again leaves the archive, wherever it is played', () => {
    const kept = archiveOnSlotChange([], slot('ABC123', 'm-1'), null, none, 1_000);
    expect(archiveOnSlotChange(kept, null, slot('ABC123', 'm-1'), none, 2_000)).toEqual([]);
    expect(archiveOnSlotChange(kept, null, slot('MOVED9', 'm-1'), none, 2_000)).toEqual([]);
    // Another match at that room code is another table: the kept one stays.
    expect(archiveOnSlotChange(kept, null, slot('ABC123', 'm-9'), none, 2_000)).toBe(kept);
  });

  it('a record of another match taking the slot at the same room code (the code went to another table) keeps the first', () => {
    expect(archiveOnSlotChange([], slot('ABC123', 'm-1'), slot('ABC123', 'm-2'), none, 1_000).map((e) => e.matchId)).toEqual(['m-1']);
  });

  it('a client of the same table that holds no match yet (saved before its first welcome) takes the slot: the match it held is kept, to be taken up by its match at that welcome', () => {
    const kept = archiveOnSlotChange([], slot('ABC123', 'm-1'), slot('ABC123', null), none, 1_000);
    expect(kept.map((e) => e.matchId)).toEqual(['m-1']);
    expect(archivedMatch(kept, URL, 'm-1', 2_000)?.roomCode).toBe('ABC123');
    // Its welcome names the match and its record holds it: the match leaves the archive again.
    expect(archiveOnSlotChange(kept, slot('ABC123', null), slot('ABC123', 'm-1'), none, 2_000)).toEqual([]);
    // Its welcome names another match (the code went to another table): the first stays kept.
    expect(archiveOnSlotChange(kept, slot('ABC123', null), slot('ABC123', 'm-2'), none, 2_000)).toBe(kept);
  });

  it('is found by its match wherever the table runs it, and by the room it was played at', () => {
    const kept = archiveOnSlotChange([], slot('ABC123', 'm-1'), null, none, 1_000);
    expect(archivedMatch(kept, URL, 'm-1', 2_000)?.roomCode).toBe('ABC123');
    expect(archivedMatch(kept, URL, 'm-2', 2_000)).toBeUndefined();
    expect(archivedMatch(kept, 'wss://other.example/ws', 'm-1', 2_000)).toBeUndefined();
    // One entry per match: the same match kept again from another room replaces it.
    const again = withArchived(kept, archiveEntry({ signalUrl: URL, roomCode: 'MOVED9', token: 't', client: record('m-1') }, 3_000)!, 3_000);
    expect(again.map((e) => e.roomCode)).toEqual(['MOVED9']);
  });

  it('keeps one entry per match (the latest), for thirty days; three other tables, or many, push nothing out while there is room', () => {
    let list: ArchivedTable[] = [];
    list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: 'A', token: 't', client: record('m-a') }, 0)!, 0);
    list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: 'A', token: 't', client: record('m-a') }, 10)!, 10);
    expect(list.map((e) => e.archivedAt)).toEqual([10]);
    for (let i = 0; i < 3; i++) list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: `R${i}`, token: 't', client: record(`m-${i}`) }, 20 + i)!, 20 + i);
    expect(archivedMatch(list, URL, 'm-a', 100)).toBeDefined();
    for (let i = 3; i < ARCHIVE_MAX + 2; i++) list = withArchived(list, archiveEntry({ signalUrl: URL, roomCode: `R${i}`, token: 't', client: record(`m-${i}`) }, 20 + i)!, 20 + i);
    expect(list).toHaveLength(ARCHIVE_MAX);
    expect(list[list.length - 1].roomCode).toBe(`R${ARCHIVE_MAX + 1}`);
    const lastAt = 20 + ARCHIVE_MAX + 1;
    expect(archivedFor(list, URL, `R${ARCHIVE_MAX + 1}`, lastAt + ARCHIVE_TTL_MS - 1)).toBeDefined();
    expect(archivedFor(list, URL, `R${ARCHIVE_MAX + 1}`, lastAt + ARCHIVE_TTL_MS)).toBeUndefined();
    expect(ARCHIVE_TTL_MS).toBe(30 * 24 * 3600_000);
  });

  it('keeps them together within a bound: room is made from the oldest records without a red hand first, never the newest', () => {
    const large = (room: string, at: number, red = false) =>
      archiveEntry({ signalUrl: URL, roomCode: room, token: 't', client: { ...(red ? unverifiedEnd(`m-${room}`, true) : record(`m-${room}`)), pad: 'x'.repeat(400_000) } as unknown as SerializedClient }, at)!;
    let list: ArchivedTable[] = [];
    for (const [i, room] of ['A', 'B', 'C'].entries()) list = withArchived(list, large(room, i), i);
    expect(list.map((e) => e.roomCode)).toEqual(['B', 'C']);
    expect(JSON.stringify(list).length).toBeLessThanOrEqual(ARCHIVE_MAX_CHARS);
    expect(validArchive([large('A', 0), large('B', 1), large('C', 2)], 10).map((e) => e.roomCode)).toEqual(['B', 'C']);
    // The oldest holds a red hand: the next oldest goes in its place.
    list = [];
    for (const [i, room] of ['A', 'B', 'C'].entries()) list = withArchived(list, large(room, i, room === 'A'), i);
    expect(holdsRed(list[0])).toBe(true);
    expect(list.map((e) => e.roomCode)).toEqual(['A', 'C']);
    // Only red ones left to give up: the oldest of them goes.
    list = [];
    for (const [i, room] of ['A', 'B', 'C'].entries()) list = withArchived(list, large(room, i, true), i);
    expect(list.map((e) => e.roomCode)).toEqual(['B', 'C']);
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
