/**
 * The order the app writes the saved-table slot and the archive in (game/slotWriter.ts): the slot gives a record up on
 * the device only once the archive holds it, or once the journal's list of its match is gone, so a cold start never takes
 * an older record up with a list that says nothing was sent after it.
 */
import { describe, expect, it } from 'vitest';
import type { SerializedClient } from '@mjm/net';
import { journalKeeper } from './journalKeeper';
import { slotWriter, type SlotStorage } from './slotWriter';
import { journalOf, withEntry, type MoveJournal } from '../logic/moveJournal';
import { archiveOnSlotChange, type ArchivedTable } from '../logic/tableArchive';
import type { ActiveSession } from '../storage';

const URL = 'wss://game.example/ws';
/** A journal entry as the table client hands it over (only what the journal reads). */
const entry = (seq: number, matchId: string) => ({ seq, matchId, hand: 0, tc: seq, action: { type: 'pass' }, epoch: 1, at: 1000 + seq, run: 'r1', seg: 0, from: 0, sum: `s${seq}` });
/** The saved table of room `room` holding match `matchId`, with every move up to place `sentSeq` in its record. */
const slot = (room: string, matchId: string, sentSeq: number): Extract<ActiveSession, { kind: 'online' }> => ({ kind: 'online', signalUrl: URL, roomCode: room, token: 'tok', name: 'A', avatar: 'auntie', savedAt: 1, client: { version: 1, sentSeq, state: { matchId, matchOver: false } } as unknown as SerializedClient });

/** What the device holds, and what was written in what order; `fail` says which writes fail. */
function device(fail: { archive?: boolean; slot?: boolean; journal?: 'write' | 'both' } = {}) {
  const d = {
    slot: null as ActiveSession | null,
    archive: [] as readonly ArchivedTable[],
    journal: null as MoveJournal | null,
    order: [] as string[],
    fail,
  };
  const store: SlotStorage = {
    saveArchive: async (list) => {
      d.order.push('archive');
      if (d.fail.archive) return false;
      d.archive = JSON.parse(JSON.stringify(list)) as ArchivedTable[];
      return true;
    },
    saveActiveSession: async (s) => {
      d.order.push(`slot ${s.kind === 'online' ? s.roomCode : 'local'}`);
      if (d.fail.slot) return false;
      d.slot = JSON.parse(JSON.stringify(s)) as ActiveSession;
      return true;
    },
    clearActiveSession: async () => {
      d.order.push('clear');
      d.slot = null;
      return true;
    },
  };
  const keeper = journalKeeper({
    write: (j) => {
      d.order.push('journal');
      if (d.fail.journal === 'both') throw new Error('storage broken');
      // A write that fails takes the journal off the device (src/storage.ts).
      d.journal = d.fail.journal === 'write' ? null : (JSON.parse(JSON.stringify(j)) as MoveJournal);
    },
  });
  return { d, store, keeper };
}

/** The app puts `next` in the slot as src/app-state.tsx `putActive` does, with the archive as it changes. */
function app(dev: ReturnType<typeof device>) {
  const writer = slotWriter(dev.store, dev.keeper);
  let active: ActiveSession | null = null;
  let archive: readonly ArchivedTable[] = [];
  return {
    writer,
    async put(next: ActiveSession | null) {
      const kept = archiveOnSlotChange(archive, active as never, next as never, () => undefined, 1_000);
      const changed = kept !== archive;
      archive = kept;
      active = next;
      await writer.put(next, changed ? kept : undefined);
    },
    get archive() {
      return archive;
    },
  };
}

describe('the saved table and the archive are written in order', () => {
  it('a table that leaves Home: the archive is written first, and the slot emptied only then', async () => {
    const dev = device();
    const a = app(dev);
    await a.put(slot('R1', 'm-1', 3));
    dev.d.order.length = 0;
    await a.put(null);
    expect(dev.d.order).toEqual(['archive', 'clear']);
    expect(dev.d.archive.map((e) => e.matchId)).toEqual(['m-1']);
  });

  it('the moves a record holds leave the journal only once the slot holding it is written', async () => {
    const dev = device({ slot: true });
    const a = app(dev);
    dev.keeper.load(withEntry(withEntry([], URL, entry(1, 'm-1')), URL, entry(2, 'm-1')));
    await a.put(slot('R1', 'm-1', 2));
    expect(journalOf(dev.keeper.journal, URL, 'm-1')).toHaveLength(2);
    dev.d.fail.slot = false;
    await a.put(slot('R1', 'm-1', 2));
    expect(journalOf(dev.keeper.journal, URL, 'm-1')).toEqual([]);
  });

  it('the archive cannot be written and no table takes the slot: the slot keeps the record, and the journal its list, so a cold start takes them up together', async () => {
    const dev = device();
    const a = app(dev);
    // R1 was archived once; the table came back to the slot (the archive write that took it out failed: the device still holds R1).
    dev.keeper.load(withEntry(withEntry([], URL, entry(1, 'm-1')), URL, entry(2, 'm-1')));
    await a.put(slot('R1', 'm-1', 1));
    await a.put(null);
    dev.d.fail.archive = true;
    await a.put(slot('R1', 'm-1', 1));
    // The player plays on: two more moves, written to the slot's record; they leave the journal.
    dev.keeper.load(withEntry(withEntry(dev.keeper.journal, URL, entry(2, 'm-1')), URL, entry(3, 'm-1')));
    await a.put(slot('R1', 'm-1', 3));
    expect(journalOf(dev.keeper.journal, URL, 'm-1')).toEqual([]);
    expect(dev.d.archive.map((e) => e.client.sentSeq)).toEqual([1]);
    // The table leaves Home again and the archive write fails: the device's slot keeps the newer record.
    dev.d.order.length = 0;
    await a.put(null);
    expect(dev.d.order).toEqual(['archive']);
    expect(dev.d.slot).toMatchObject({ roomCode: 'R1', client: { sentSeq: 3 } });
    expect(journalOf(dev.d.journal!, URL, 'm-1')).toEqual([]);
    // The next change tries the archive again before it gives the record up: once written, the slot goes.
    dev.d.fail.archive = false;
    dev.d.order.length = 0;
    await a.put(null);
    expect(dev.d.order).toEqual(['archive', 'clear']);
    expect(dev.d.archive.map((e) => e.client.sentSeq)).toEqual([3]);
  });

  it('another table takes the slot while the archive cannot be written: the list of the match that leaves goes first', async () => {
    const dev = device();
    const a = app(dev);
    dev.keeper.load(withEntry([], URL, entry(1, 'm-1')));
    await a.put(slot('R1', 'm-1', 1));
    expect(journalOf(dev.d.journal ?? [], URL, 'm-1')).toEqual([]);
    dev.d.fail.archive = true;
    dev.d.order.length = 0;
    await a.put(slot('R2', 'm-2', 0));
    expect(dev.d.order).toEqual(['archive', 'journal', 'slot R2', 'journal']);
    // The device holds no list of m-1 any more: a record of it taken up later vouches for nothing past itself.
    expect(journalOf(dev.d.journal!, URL, 'm-1')).toBeUndefined();
    expect(dev.d.slot).toMatchObject({ roomCode: 'R2' });
  });

  it('…and when the list cannot be taken off the device either, the slot keeps the record that would leave it', async () => {
    const dev = device();
    const a = app(dev);
    dev.keeper.load(withEntry([], URL, entry(1, 'm-1')));
    await a.put(slot('R1', 'm-1', 1));
    dev.d.fail.archive = true;
    dev.d.fail.journal = 'both';
    await a.put(slot('R2', 'm-2', 0));
    expect(dev.d.slot).toMatchObject({ roomCode: 'R1' });
    expect(journalOf(dev.d.journal!, URL, 'm-1')).toEqual([]);
  });

  it('a stale saved table kept in the slot at launch (its archive write failed) is given up only as above', async () => {
    const dev = device({ archive: true });
    const stale = slot('R1', 'm-1', 4);
    dev.d.slot = stale;
    const archive = archiveOnSlotChange([], stale as never, null, () => undefined, 1_000);
    dev.keeper.load(afterSaveList('m-1'));
    const writer = slotWriter(dev.store, dev.keeper);
    writer.begin({ stored: stale, archive, archiveBehind: true });
    await writer.put(slot('R2', 'm-2', 0));
    expect(dev.d.order).toEqual(['archive', 'journal', 'slot R2', 'journal']);
    expect(journalOf(dev.d.journal!, URL, 'm-1')).toBeUndefined();
  });
});

/** A journal whose only list, of `matchId`, is empty (a record holding every move was written). */
function afterSaveList(matchId: string): MoveJournal {
  return [{ signalUrl: URL, matchId, entries: [] }];
}
