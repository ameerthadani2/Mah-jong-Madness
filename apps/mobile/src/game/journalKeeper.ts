/**
 * The journal of moves as the app keeps it (logic/moveJournal.ts): in memory, which is what this run of the app wrote and
 * what a resume in the same run is given, and on the device (`store`, src/storage.ts `writeJournal`), which is what a
 * cold start reads back. src/app-state.tsx makes one and hands its `writeAhead` and `journalFor` to the online table
 * clients (src/game/session.ts `setMoveJournalSource`).
 */
import type { TableClientOptions } from '@mjm/net';
import { afterSave, journalOf, keptFor, withEntry, withoutEntry, withoutMatch, type MoveJournal } from '../logic/moveJournal';

export interface JournalStore {
  /**
   * Write the journal. Returns once it is written (or a promise of that); throws, or rejects, only when the move it was
   * written for must not go out (src/storage.ts: neither written nor taken off the device).
   */
  write(j: MoveJournal): void | Promise<void>;
}

export interface JournalKeeper {
  /** What it holds now. */
  readonly journal: MoveJournal;
  /** Start from what a cold start read back. */
  load(j: MoveJournal): void;
  /** The table client's hook at game server `signalUrl`: each move is written before it goes out. */
  writeAhead(signalUrl: string): NonNullable<TableClientOptions['writeAhead']>;
  /** What it holds for a match, for a client restored from a record of it (undefined: nothing it can vouch for). */
  journalFor(signalUrl: string, matchId: string): unknown[] | undefined;
  /** A record of the match holding every move up to place `sentSeq` was written: those moves leave the journal. */
  saved(signalUrl: string, matchId: string, sentSeq: number): void;
  /** Keep the lists of the matches the app still keeps a record of (`held`), no others. */
  keep(held: (signalUrl: string, matchId: string) => boolean): void;
  /**
   * Drop the list of a match whose record a cold start would no longer read (game/slotWriter.ts). Resolves true once the
   * device no longer holds it (the journal was written, or taken off the device), false when neither could be done.
   */
  forget(signalUrl: string, matchId: string): Promise<boolean>;
}

export function journalKeeper(store: JournalStore): JournalKeeper {
  let j: MoveJournal = [];
  // A write that is not a move's own (after a record was written, or a record dropped): one that fails costs nothing
  // more than the journal (src/storage.ts takes it off the device), so it is not waited for.
  const rewrite = (next: MoveJournal) => {
    if (next === j) return;
    j = next;
    try {
      void Promise.resolve(store.write(next)).catch(() => undefined);
    } catch {
      /* neither written nor taken off: the next move's write tries again, and keeps its move back if it fails too */
    }
  };
  return {
    get journal() {
      return j;
    },
    load(loaded) {
      j = loaded;
    },
    writeAhead: (signalUrl) => (entry) => {
      // In memory first: a resume in this run is given it even if the device's copy could not be written.
      j = withEntry(j, signalUrl, entry);
      // The move does not go out: the entry leaves the journal again (by its place, whatever was written meanwhile).
      const undo = (e: unknown) => {
        j = withoutEntry(j, signalUrl, entry);
        throw e;
      };
      let wrote: void | Promise<void>;
      try {
        wrote = store.write(j);
      } catch (e) {
        return undo(e);
      }
      return wrote ? wrote.catch(undo) : undefined;
    },
    journalFor: (signalUrl, matchId) => journalOf(j, signalUrl, matchId),
    saved: (signalUrl, matchId, sentSeq) => rewrite(afterSave(j, signalUrl, matchId, sentSeq)),
    keep: (held) => rewrite(keptFor(j, held)),
    forget: async (signalUrl, matchId) => {
      const next = withoutMatch(j, signalUrl, matchId);
      j = next;
      try {
        // (A write that fails takes the journal off the device: the list is gone either way. Only one that can do neither throws.)
        await store.write(next);
        return true;
      } catch {
        return false;
      }
    },
  };
}
