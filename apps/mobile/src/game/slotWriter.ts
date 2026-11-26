/**
 * How the app writes a change of the saved-table slot and of the archive of tables that left it (src/app-state.tsx
 * `putActive`), so that a cold start never takes a record up with a journal list that says less was sent than was.
 *
 * The journal of moves (logic/moveJournal.ts) drops the moves a written record of the slot holds, so after a slot write
 * a match's list holds only what was sent after that record. That is right for the record a cold start reads, as long as
 * the slot holds it. When the slot stops holding the match on the device (its table left Home, another table took the
 * slot), a cold start reads the match's record from the archive instead, which must then hold the record that left the
 * slot. So the writes go one after another, in the order they were asked for: the archive first, and the slot only once
 * the archive is known to hold what the slot gives up. When the archive cannot be written (a nearly full storage):
 * - with no table taking the slot, the device's slot keeps the record (the next change, and the next launch, try the
 *   archive again). A cold start then offers it on Home, and a join takes it up with its journal list, as it should;
 * - with another table taking the slot, the journal's list of the match leaving goes first (`forget`): the record the
 *   device's archive holds of it, if any, is older, and a client restored from that without a list vouches for nothing
 *   past it (packages/net `TableClient.load`). Only when the list cannot be taken off the device either does the slot
 *   keep its record.
 * Once a record is in the slot on the device, the moves it holds leave the journal (`JournalKeeper.saved`).
 */
import type { ArchivedTable } from '../logic/tableArchive';
import type { ActiveSession } from '../storage';
import type { JournalKeeper } from './journalKeeper';

export interface SlotStorage {
  /** Write the archive: true once the device holds it. */
  saveArchive(list: readonly ArchivedTable[]): Promise<boolean>;
  /** Write the saved-table slot: true once the device holds it. */
  saveActiveSession(s: ActiveSession): Promise<boolean>;
  /** Empty the slot: true once the device holds no saved table. */
  clearActiveSession(): Promise<boolean>;
}

/** What the device holds as the app starts. */
export interface StoredAtLaunch {
  /** What the device's slot holds: the saved table read, or a stale one kept there because the archive could not be written. */
  stored: ActiveSession | null;
  /** The archive as it is in memory. */
  archive?: readonly ArchivedTable[];
  /** The device's archive is older than `archive` (its write at launch failed). */
  archiveBehind?: boolean;
}

export interface SlotWriter {
  /** What the device held as the app started (before the first change is written). */
  begin(start: StoredAtLaunch): void;
  /**
   * The slot goes to `next` (null: emptied); `archive`: the archive as it is now, when the change changed it. Written to
   * the device in the order asked, after every change asked before it.
   */
  put(next: ActiveSession | null, archive?: readonly ArchivedTable[]): Promise<void>;
  /** The writes asked so far are done. */
  idle(): Promise<void>;
}

type Match = { signalUrl: string; matchId: string };

/** The match an online record holds (null: a local table, or a record saved before the table's first welcome). */
export function slotMatch(s: ActiveSession | null): Match | null {
  const m = s?.kind === 'online' ? s.client?.state?.matchId : null;
  return s?.kind === 'online' && typeof m === 'string' && m !== '' ? { signalUrl: s.signalUrl, matchId: m } : null;
}

/** The match whose record the slot gives up on the device when it goes from `stored` to `next` (null: none). */
export function leavingMatch(stored: ActiveSession | null, next: ActiveSession | null): Match | null {
  const m = slotMatch(stored);
  if (!m) return null;
  const n = slotMatch(next);
  return n && n.signalUrl === m.signalUrl && n.matchId === m.matchId ? null : m;
}

/** The writer: the device's slot is taken to be empty until `begin` says what it holds. */
export function slotWriter(store: SlotStorage, journal: Pick<JournalKeeper, 'saved' | 'forget'>): SlotWriter {
  let stored: ActiveSession | null = null;
  let archive: readonly ArchivedTable[] | undefined;
  let behind = false;
  let queue: Promise<void> = Promise.resolve();
  const write = async (next: ActiveSession | null, changed: readonly ArchivedTable[] | undefined) => {
    if (changed !== undefined) {
      archive = changed;
      behind = true;
    }
    const leaving = leavingMatch(stored, next);
    // The archive first: on every change of it, and again before the slot gives a record up while it is behind.
    if (behind && archive !== undefined && (changed !== undefined || leaving)) behind = !(await store.saveArchive(archive).catch(() => false));
    if (leaving && behind) {
      // The device's archive does not hold the record the slot would give up: with no table to take the slot, the slot
      // keeps it; with one, the journal's list of the match goes first (and if it cannot, the slot keeps the record).
      if (next === null) return;
      if (!(await journal.forget(leaving.signalUrl, leaving.matchId).catch(() => false))) return;
    }
    if (next === null) {
      if (await store.clearActiveSession().catch(() => false)) stored = null;
      return;
    }
    if (!(await store.saveActiveSession(next).catch(() => false))) return;
    stored = next;
    // Once the record is written, the moves it holds leave the journal: what stays is what was sent after it.
    const m = slotMatch(next);
    if (m && next.kind === 'online') {
      const seq = next.client?.sentSeq;
      journal.saved(m.signalUrl, m.matchId, typeof seq === 'number' && Number.isInteger(seq) ? seq : 0);
    }
  };
  return {
    begin(start) {
      stored = start.stored;
      archive = start.archive;
      behind = start.archiveBehind === true && archive !== undefined;
    },
    put(next, changed) {
      queue = queue.then(() => write(next, changed)).catch(() => undefined);
      return queue;
    },
    idle: () => queue,
  };
}
