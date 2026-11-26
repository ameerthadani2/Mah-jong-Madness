/**
 * The code the fuzzer runs. In the repository it is the package it lives in (`../../src`) and the engine that package
 * imports. Two switches point it elsewhere, for runs outside the repository's tests:
 * - `ADVERSARY_TREE`: a folder holding another copy of the code (packages/net, packages/engine and apps/mobile/src/logic,
 *   as `git archive` gives them), run instead of this one;
 * - `ADVERSARY_OLD_TREE`: a second copy, the build an app update replaces: the victim's phone runs its table client until
 *   the update, which then restores the record that client saved (`update` in scenario.ts).
 * The app's own logic for the records it keeps of a table (apps/mobile/src/logic: the archive of tables that left Home,
 * the red hands kept apart, the age of the saved table, the journal of moves) is loaded when the copy has it; without it
 * the phone keeps none of them, as the app did before it had them.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { SerializedClient } from '../../src/index';

export type Net = typeof import('../../src/index');
export type Engine = typeof import('@mjm/engine');

const tree = process.env.ADVERSARY_TREE || null;
const oldTree = process.env.ADVERSARY_OLD_TREE || null;
/** The checkout this folder sits in (packages/net/test/adversary). */
const checkout = fileURLToPath(new URL('../../../../', import.meta.url));

const load = (root: string, rel: string): Promise<unknown> => import(/* @vite-ignore */ pathToFileURL(join(root, rel)).href);

export const net: Net = tree ? ((await load(tree, 'packages/net/src/index.ts')) as Net) : await import('../../src/index');
export const engine: Engine = tree ? ((await load(tree, 'packages/engine/src/index.ts')) as Engine) : await import('@mjm/engine');
/** The table client of the build an app update replaces, when one is named. */
export const oldNet: Net | null = oldTree ? ((await load(oldTree, 'packages/net/src/index.ts')) as Net) : null;
/** Which code runs: the tree's folder, or `repository` for the package itself. */
export const codeName = tree ?? 'repository';
export const oldCodeName = oldTree;

/** An entry of the app's archive of tables that left Home (apps/mobile/src/logic/tableArchive.ts). */
export interface ArchivedTable {
  signalUrl: string;
  roomCode: string;
  matchId: string;
  token: string;
  client: SerializedClient;
  archivedAt: number;
}
/** The saved-table slot as the archive sees it. */
export type Slot = { kind: 'online'; signalUrl: string; roomCode: string; token: string; client?: SerializedClient; savedAt?: number } | null;
export interface ArchiveLogic {
  ARCHIVE_TTL_MS: number;
  archiveOnSlotChange(list: readonly ArchivedTable[], prev: Slot, next: Slot, live: () => SerializedClient | undefined, now: number): readonly ArchivedTable[];
  archivedFor(list: readonly ArchivedTable[], signalUrl: string, roomCode: string, now: number): ArchivedTable | undefined;
  /** The app of unit 20g: records kept by match, found by the match a welcome names (absent before). */
  archivedMatch?(list: readonly ArchivedTable[], signalUrl: string, matchId: string, now: number): ArchivedTable | undefined;
}
export interface KeptRed {
  signalUrl: string;
  roomCode: string;
  matchId: string;
  hand: number;
  failures: string[];
}
export interface RedLogic {
  withRed(list: readonly KeptRed[], signalUrl: string, roomCode: string, red: readonly unknown[], now?: number): readonly KeptRed[];
  /** By room before unit 20g (`redFor(list, url, room)`); by game server since, every match (`redFor(list, url, now)`). */
  redFor(list: readonly KeptRed[], signalUrl: string, roomOrNow?: string | number): unknown[];
}
export interface SlotLogic {
  SAVED_TABLE_MAX_AGE_MS: number;
  /** Since unit 20g: a stale online saved table that holds a match, which the app keeps in its archive (absent before). */
  staleOnlineSession?(raw: unknown, now: number): (Exclude<Slot, null> & { savedAt: number }) | null;
}
/** The app's journal of moves (apps/mobile/src/logic/moveJournal.ts, since unit 20g). */
export type MoveJournal = ReadonlyArray<{ signalUrl: string; matchId: string; entries: unknown[] }>;
export interface JournalLogic {
  withEntry(j: MoveJournal, signalUrl: string, entry: unknown): MoveJournal;
  afterSave(j: MoveJournal, signalUrl: string, matchId: string, sentSeq: number): MoveJournal;
  journalOf(j: MoveJournal, signalUrl: string, matchId: string): unknown[] | undefined;
  keptFor(j: MoveJournal, held: (signalUrl: string, matchId: string) => boolean): MoveJournal;
  /** Since unit 20h: the journal without one match's list (game/slotWriter.ts drops it before the slot gives the match's record up while the archive is behind). */
  withoutMatch?(j: MoveJournal, signalUrl: string, matchId: string): MoveJournal;
}

async function appLogic<T>(file: string, dir = 'logic'): Promise<T | null> {
  const root = tree ?? checkout;
  const rel = join('apps/mobile/src', dir, file);
  return existsSync(join(root, rel)) ? ((await load(root, rel)) as T) : null;
}

export const archiveLogic = await appLogic<ArchiveLogic>('tableArchive.ts');
export const redLogic = await appLogic<RedLogic>('redHands.ts');
export const slotLogic = await appLogic<SlotLogic>('activeSession.ts');
export const journalLogic = await appLogic<JournalLogic>('moveJournal.ts');
/**
 * The app keeps its records by match (unit 20g): the red hands of a game server go to every client of the match, a client
 * welcomed into a match it holds no record of asks for one by match, a stale saved table is archived at launch.
 */
export const BY_MATCH = typeof archiveLogic?.archivedMatch === 'function';

/** The app's save schedule (apps/mobile/src/game/persist.ts; a copy of the code holding only `logic` has none). */
export interface PersistLogic {
  saveScheduler(save: () => void): { flush?: () => void };
}
/** The app's order of writes for the saved table and the archive (apps/mobile/src/game/slotWriter.ts, since unit 20h). */
export interface SlotWriterLogic {
  leavingMatch(stored: unknown, next: unknown): { signalUrl: string; matchId: string } | null;
}
const persistLogic = await appLogic<PersistLogic>('persist.ts', 'game');
export const slotWriterLogic = await appLogic<SlotWriterLogic>('slotWriter.ts', 'game');
/**
 * Since unit 20h the app writes a save still waiting when the table screen goes or the app goes to the background
 * (`flush`), instead of dropping it; before, a save still waiting went with the screen.
 */
export const SAVE_FLUSH = typeof persistLogic?.saveScheduler(() => undefined).flush === 'function';
/**
 * Since unit 20h the saved table gives a record up on the device only once the archive holds it (game/slotWriter.ts): while
 * the archive cannot be written, the slot keeps the record, or the journal's list of the match goes first.
 */
export const ORDERED_WRITES = typeof slotWriterLogic?.leavingMatch === 'function';

/** docs/FAIRNESS.md of the checkout this folder sits in: the stated limits the oracle names are quoted from it. */
export const fairnessDocPath = join(checkout, 'docs', 'FAIRNESS.md');
