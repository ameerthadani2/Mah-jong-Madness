/**
 * The table on one fake clock (adapted from ../wire.ts): the real TableHost deals and plays honestly, the real
 * TableClient is the phone of the player at seat 0, the other seats are the host's bots, and every frame between them
 * passes through the server's hands (`Adversary`, server.ts), which may drop, hold, delay, rewrite or add to them, and
 * through the hands of the host itself (`forge` writes moves into its log). Around the client runs a model of the app
 * (`App`): it saves the table's record 400 ms after a change (at once while the deal is agreed or when the seat is
 * opened on another device), restores it after a restart or a resume from Home, keeps the record of a table that left
 * Home in its archive, and keeps red hands apart, as apps/mobile/src/app-state.tsx and src/game/session.ts do, with the
 * app's own logic (apps/mobile/src/logic) where the code has it. Everything the oracle needs to know is told to the
 * ground-truth recorder (`Truth`, truth.ts) as it happens.
 */
import type { Action, GameState, RuleSet } from '@mjm/engine';
import type { ClientMessage, HostMessage, KeptRecord, Link, LoopbackHub, LoopbackTransport, SerializedClient, SerializedHost, TableClient, TableHost } from '../../src/index';
import { archiveLogic, BY_MATCH, engine, journalLogic, net, ORDERED_WRITES, redLogic, SAVE_FLUSH, slotLogic, slotWriterLogic, type ArchivedTable, type KeptRed, type MoveJournal, type Net, type Slot } from './load';
import { hashOf } from './random';
import { CLOCKS, type MoveKind, type Scenario, type StateKind } from './scenario';
import type { Truth } from './truth';

export const T0 = 2_000_000;
export const STEP_MS = 100;
export const SIGNAL_URL = 'wss://game.example/ws';
export const ACCOUNT = 'u-victim';
export const NAME = 'Victim';
/** The online session reconnects this long after it lost its link. */
export const RECONNECT_MS = 1_000;
/** apps/mobile/src/game/persist.ts SAVE_DELAY_MS. */
export const SAVE_DELAY_MS = 400;
const HOUR = 3_600_000;
/** A copy of what the app writes to or reads from the device (JSON, as storage.ts writes it). */
const clone = <T>(x: T): T => (x === null || x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));
/**
 * The app writes each move to its journal before it goes out and gives what the journal holds for a match back to a client
 * restored from a record of it (`TableClientOptions.writeAhead` and `journal`; apps/mobile/src/logic/moveJournal.ts and
 * game/journalKeeper.ts). On when the code's app has the journal (ADVERSARY_JOURNAL=0 turns it off, to see the app
 * without it); the model follows the app.
 */
export const APP_JOURNAL = journalLogic !== null && process.env.ADVERSARY_JOURNAL !== '0';

/** A moment of the match as the server sees it (what `Anchor`s name). */
export type Moment =
  | { on: 'commit' | 'reveal' | 'deal' | 'result'; hand: number }
  | { on: 'state'; hand: number; kind: StateKind; k: number; tc: number }
  | { on: 'move'; hand: number; kind: MoveKind; k: number; tc: number };

/** What the server does with the frames and moves that pass through it, and when (server.ts). */
export interface Adversary {
  /** The frames that go to the phone in place of `m`, which the host sent it on `line` (none: dropped). */
  down(line: Line, m: HostMessage): HostMessage[];
  /** Whether the server holds `m` back on its line, to let it go later (`Line.release`). */
  hold(line: Line, m: HostMessage): boolean;
  /** The network's extra delay for `m` (ms). */
  delay(line: Line, m: HostMessage): number;
  /** Whether a message from the phone reaches the table (the server may answer it itself). */
  up(line: Line, m: ClientMessage): boolean;
  /** Right after `m` reached the phone. */
  delivered(line: Line, m: HostMessage): void;
  /** A moment of the match: events anchored on it begin (`frame`: the frame or message that marks it, which an event that begins at once acts on). */
  moment(mo: Moment, line: Line | null, frame: HostMessage | ClientMessage | null): void;
  /** Every step, after the table's own timers. */
  tick(): void;
  /** The phone is about to join on a new link: `reconnect` (the same client), or `run` (a new client). */
  newLine(kind: 'reconnect' | 'run'): void;
  /** The welcome the phone is about to be sent on a new link (the server may rewrite it). */
  welcome(line: Line, m: Extract<HostMessage, { t: 'welcome' }>): HostMessage[];
}

/** One connection from a phone to the table. */
export class Line {
  readonly down: Array<{ at: number; m: HostMessage }> = [];
  readonly up: Array<{ at: number; m: ClientMessage }> = [];
  readonly held: HostMessage[] = [];
  readonly closeHandlers = new Set<() => void>();
  cb: ((m: HostMessage) => void) | null = null;
  /** The phone hears and sends nothing more on it. */
  phoneClosed = false;
  /** The server let go of it (the host saw the peer leave). */
  hostClosed = false;
  closedAt: number | null = null;
  readonly link: Link;
  readonly transport: LoopbackTransport;
  constructor(
    readonly sim: Sim,
    readonly id: string,
    readonly n: number,
    readonly owner: 'victim' | 'other',
    /** The client instance bound to it. */
    public run: number,
    readonly openedAt: number,
  ) {
    this.transport = sim.hub.create(id);
    this.transport.onMessage((from, msg) => {
      if (from === 'host') sim.fromHost(this, msg as HostMessage);
    });
    this.link = {
      send: (m) => sim.fromPhone(this, m as ClientMessage),
      onMessage: (cb) => {
        this.cb = cb as (m: HostMessage) => void;
        return () => {
          if (this.cb === cb) this.cb = null;
        };
      },
      close: () => sim.closeLine(this, { phone: true, host: true, tell: false }),
      onClose: (cb) => {
        this.closeHandlers.add(cb);
        return () => this.closeHandlers.delete(cb);
      },
    } as Link;
  }
  get open(): boolean {
    return !this.phoneClosed;
  }
  /** The server sends a frame of its own making, behind what is already on its way. */
  send(m: HostMessage): void {
    if (this.phoneClosed) return;
    this.down.push({ at: Math.max(this.sim.clock.now, this.down.length ? this.down[this.down.length - 1].at : -Infinity), m });
  }
  /** The server sends a frame of its own making at once, past what is on its way. */
  inject(m: HostMessage): void {
    this.sim.deliver(this, m);
  }
  /** The server lets go what it held on this link (`edit` may change each frame first). */
  release(edit?: (m: HostMessage) => HostMessage | null): void {
    for (const m of this.held.splice(0)) {
      const x = edit ? edit(m) : m;
      if (x) this.send(x);
    }
  }
}

/** The player at seat 0: what it is doing about the decision on its screen. */
interface Decision {
  key: string;
  hand: number;
  tc: number;
  since: number;
  think: number;
  acted: Action | null;
  actedAt: number;
  errored: boolean;
  retried: boolean;
}

/** A move of another kind of the same seat (`retry: other`). */
function otherThan(s: GameState, seat: number, a: Action, acts: Action[]): Action | null {
  const sameKind = (b: Action) => engine.sameAction(a, b, s, seat);
  const rest = acts.filter((b) => !sameKind(b));
  return rest.find((b) => b.type === 'pass') ?? rest.find((b) => b.type === 'discard') ?? rest[0] ?? null;
}

export const moveKind = (a: Action | undefined): MoveKind => (!a ? 'any' : a.type === 'hu' ? 'hu' : a.type === 'pass' ? 'pass' : a.type === 'discard' ? 'discard' : 'claim');

/** The decision `g` asks of seat 0 (`other`: none). */
export function stateKind(g: GameState): StateKind {
  let acts: Action[] = [];
  try {
    acts = engine.legalActions(g, 0);
  } catch {
    acts = [];
  }
  if (acts.length === 0) return 'other';
  if (acts.some((a) => a.type === 'hu')) return 'win';
  return g.phase === 'claim' ? 'claim' : 'own';
}

/**
 * The app on the player's phone, as far as the table's record goes: the saved-table slot, the archive of tables that
 * left Home, the red hands kept apart, and the save schedule (apps/mobile/src/game/persist.ts).
 */
export class App {
  /**
   * The saved-table slot and the archive as this run of the app holds them (app-state.tsx keeps both in memory and writes
   * them to the device as they change): a resume from Home and a reseat in the same run read these.
   */
  slot: (Exclude<Slot, null> & { savedAt: number }) | null = null;
  archive: ArchivedTable[] = [];
  /** What is on the device (src/storage.ts), which a cold start reads back: written as they change, unless writes fail. */
  slotStored: (Exclude<Slot, null> & { savedAt: number }) | null = null;
  archiveStored: ArchivedTable[] = [];
  /** When (the table's clock) the record in the slot was put there, and when the one on the device was written. */
  slotAt: number | null = null;
  private slotStoredAt: number | null = null;
  red: readonly KeptRed[] = [];
  /**
   * The journal of moves (`APP_JOURNAL`): what this run of the app holds (`journal`, which a resume in the same run is
   * given) and what is on the device (`journalStored`, which a cold start reads back; null once a write failed and the app
   * took it off the device).
   */
  journal: MoveJournal = [];
  journalStored: MoveJournal | null = [];
  pendingAt: number | null = null;
  /**
   * Writes to the device fail from now on (a full storage): the record, the archive and the journal stay in the app's
   * memory but are not written (a journal whose write fails is taken off the device); the red hands still are.
   */
  failing = false;
  /**
   * Only the archive's writes fail from now on (a nearly full storage: the archive is the app's largest write, up to a
   * million characters); the saved table, the journal and the red hands are still written.
   */
  archiveFails = false;
  /** The device's archive is older than the one in memory (a write of it failed since the last one that went through). */
  private archiveBehind = false;
  /** Each write of the journal of moves takes `ms` until `until` (a slow storage): the move goes out once it is done. */
  journalDelay: { ms: number; until: number } | null = null;
  /** Journal writes under way (`journalDelay`): each completes at its time, and its move then goes out. */
  private writes: Array<{ at: number; done: () => void }> = [];
  saves = 0;
  private unsub: (() => void) | null = null;
  private kicked = false;
  private held = false;
  constructor(private readonly phone: Phone) {}
  /** The app's wall clock for the age of what it keeps (a long wait moves it on without simulating the wait). */
  now(): number {
    return this.phone.sim.clock.now + this.phone.sim.appClockSkew;
  }
  attach(c: TableClient): void {
    this.unsub?.();
    this.kicked = c.state.kicked;
    this.held = (c.state as { heldElsewhere?: boolean }).heldElsewhere === true;
    this.unsub = c.onChange((s) => {
      if (this.phone.client !== c) return;
      // persist.ts clientSaves: at once when the seat is opened on another device, or (since unit 20g) when the first
      // welcome says another device held it.
      const held = (s as { heldElsewhere?: boolean }).heldElsewhere === true;
      const now = (s.kicked && !this.kicked) || (held && !this.held);
      this.kicked = s.kicked;
      this.held = held;
      this.changed(s.ceremony, now);
      this.keepRed();
    });
    this.changed();
    this.keepRed();
  }
  detach(): void {
    this.unsub?.();
    this.unsub = null;
    this.pendingAt = null;
  }
  changed(ceremony?: string, now = false): void {
    if (now || ceremony === 'committed' || ceremony === 'revealed') {
      this.pendingAt = null;
      this.save();
      return;
    }
    if (this.pendingAt !== null) return;
    this.pendingAt = this.phone.sim.clock.now + SAVE_DELAY_MS;
  }
  tick(): void {
    const now = this.phone.sim.clock.now;
    // (In order: a phone's writes go one after another.)
    while (this.writes.length > 0 && this.writes[0].at <= now) this.writes.shift()!.done();
    if (this.pendingAt !== null && now >= this.pendingAt) {
      this.pendingAt = null;
      this.save();
    }
  }
  /**
   * A save still waiting is written now: the table screen goes, or the app goes to the background (persist.ts `flush`,
   * since unit 20h, `SAVE_FLUSH`; before, a save still waiting went with the screen).
   */
  flush(): void {
    if (this.pendingAt === null || !SAVE_FLUSH) return;
    this.pendingAt = null;
    this.save();
  }
  save(): void {
    const c = this.phone.client;
    if (!c) return;
    if (c.state.matchOver) return this.put(null);
    // As app-state.tsx saves it (the name and avatar a launch checks for, logic/activeSession.ts).
    const rec = { kind: 'online' as const, signalUrl: SIGNAL_URL, roomCode: this.phone.sim.room, token: c.state.token ?? '', name: NAME, avatar: 'auntie', client: JSON.parse(JSON.stringify(c.serialize())) as SerializedClient, savedAt: this.now() };
    this.put(rec);
  }
  /**
   * app-state.tsx `putActive`: the slot changes; a table that leaves it goes to the archive. Both change in memory at
   * once and are then written to the device, unless writes fail (`failing`).
   */
  put(next: App['slot']): void {
    const prev = this.slot;
    let changed = false;
    if (archiveLogic) {
      const c = this.phone.client;
      const live = () => (prev && c && c.state.matchId === prev.client?.state?.matchId ? (JSON.parse(JSON.stringify(c.serialize())) as SerializedClient) : undefined);
      const kept = archiveLogic.archiveOnSlotChange(this.archive, prev, next, live, this.now());
      // (The archive's bounds pushed the record of the table's match out: it left the archive, and not for the slot.)
      const ours = this.phone.sim.matchId;
      if (ours && this.archive.some((e) => e.matchId === ours) && !kept.some((e) => e.matchId === ours) && next?.client?.state?.matchId !== ours) this.phone.sim.truth.archivePushedOut = true;
      changed = kept !== this.archive;
      this.archive = [...kept];
    }
    // The slot is given anything but the open table (app-state.tsx `putActive`): a save still waiting for that table is
    // dropped, not written back when the screen goes (the archive took the record its client holds now).
    if (!next || next.roomCode !== this.phone.sim.room) this.pendingAt = null;
    this.slot = next;
    this.slotAt = next?.client ? this.phone.sim.clock.now : null;
    // The journal (app-state.tsx): kept for the matches the app keeps a record of.
    if (APP_JOURNAL && journalLogic) {
      const open = this.phone.client && !this.phone.client.state.matchOver ? this.phone.client.state.matchId : null;
      this.setJournal(journalLogic.keptFor(this.journal, (_u, m) => m === open || m === next?.client?.state?.matchId || this.archive.some((e) => e.matchId === m)));
    }
    if (this.failing) return;
    // The archive, then the slot. Since unit 20h (game/slotWriter.ts, `ORDERED_WRITES`) the slot gives a record up on the
    // device only once the archive holds it: while the archive cannot be written, the slot keeps the record when no table
    // takes its place, and otherwise the journal's list of the match that leaves goes first. Before, the slot was emptied
    // or replaced whatever became of the archive's write.
    if (changed || (ORDERED_WRITES && this.archiveBehind)) {
      if (this.archiveFails) this.archiveBehind = true;
      else {
        this.archiveStored = clone(this.archive);
        this.archiveBehind = false;
      }
    }
    const leaving = ORDERED_WRITES && slotWriterLogic ? slotWriterLogic.leavingMatch(this.slotStored, next) : null;
    // (The device's slot gives a match's record up for another one's while the device's archive does not hold it.)
    const storedMatch = this.slotStored?.client?.state?.matchId;
    if (this.archiveBehind && next && typeof storedMatch === 'string' && storedMatch !== '' && next.client?.state?.matchId !== storedMatch) this.phone.sim.truth.recordGivenUpAt ??= this.phone.sim.clock.now;
    if (leaving && this.archiveBehind) {
      if (!next) return;
      if (APP_JOURNAL && journalLogic?.withoutMatch) this.setJournal(journalLogic.withoutMatch(this.journal, leaving.signalUrl, leaving.matchId));
    }
    this.saves++;
    this.slotStored = clone(next);
    this.slotStoredAt = this.slotAt;
    this.phone.sim.truth.saved(this.phone, next?.client ?? null);
    // Once the record is written, the moves it holds leave the journal.
    const m = next?.client?.state?.matchId;
    if (APP_JOURNAL && journalLogic && typeof m === 'string' && m !== '') this.setJournal(journalLogic.afterSave(this.journal, SIGNAL_URL, m, next?.client?.sentSeq ?? 0));
  }
  /** The journal's write (storage.ts writeJournal): one that fails takes it off the device. */
  private setJournal(j: MoveJournal): void {
    if (j === this.journal) return;
    this.journal = j;
    this.journalStored = this.failing ? null : j;
  }
  /**
   * The table client's hook (game/journalKeeper.ts `writeAhead`): written before the move goes out; it goes out either way.
   * A slow storage (`journalDelay`) finishes the write later: the hook then gives the client a promise of it, which the app
   * keeps (a thenable that completes at the fake clock's time, as the phone's queue of writes would).
   */
  journalWrite(entry: unknown): void | PromiseLike<void> {
    if (!journalLogic) return;
    this.journal = journalLogic.withEntry(this.journal, SIGNAL_URL, entry);
    const stored = this.failing ? null : this.journal;
    const now = this.phone.sim.clock.now;
    const d = this.journalDelay;
    const slow = !!d && now < d.until;
    // (A write waits behind those still under way: the phone's storage runs them one after another.)
    if (!slow && this.writes.length === 0) {
      this.journalStored = stored;
      return;
    }
    const at = Math.max(now, this.writes.length > 0 ? this.writes[this.writes.length - 1].at : now) + (slow ? d!.ms : 0);
    return {
      then: (ok?: (() => unknown) | null) => {
        this.writes.push({
          at,
          done: () => {
            this.journalStored = stored;
            ok?.();
          },
        });
        return Promise.resolve();
      },
    } as PromiseLike<void>;
  }
  /** What the journal holds for a match, for a client restored from a record of it. */
  journalFor(matchId: unknown): unknown[] | undefined {
    return APP_JOURNAL && journalLogic && typeof matchId === 'string' && matchId !== '' ? journalLogic.journalOf(this.journal, SIGNAL_URL, matchId) : undefined;
  }
  /** app-state.tsx `keepRed`: the hands the client found red, written down apart from the record. */
  keepRed(): void {
    const c = this.phone.client as TableClient & { redHands?: () => unknown[] };
    if (!redLogic || !c || typeof c.redHands !== 'function') return;
    this.red = redLogic.withRed(this.red, SIGNAL_URL, this.phone.sim.room, c.redHands(), this.now());
  }
  /** The red hands kept for the table (by game server and match since unit 20g: the client keeps its own match's). */
  redFor(room: string): unknown[] {
    if (!redLogic) return [];
    return BY_MATCH ? redLogic.redFor(this.red, SIGNAL_URL, this.now()) : redLogic.redFor(this.red, SIGNAL_URL, room);
  }
  /**
   * app-state.tsx `setKeptMatchSource` (since unit 20g): what the app keeps of a match a client joining `room` was welcomed
   * into holding no record of it: the saved table's record of it, else the archive's, with the journal of the match and
   * the red hands.
   */
  keptMatch(matchId: string, room: string): KeptRecord | undefined {
    if (!BY_MATCH || !archiveLogic?.archivedMatch) return undefined;
    const red = this.redFor(room);
    const slot = this.slot?.kind === 'online' && this.slot.client?.state?.matchId === matchId ? { roomCode: this.slot.roomCode, client: this.slot.client } : undefined;
    const e = slot ?? archiveLogic.archivedMatch(this.archive, SIGNAL_URL, matchId, this.now());
    if (!e) return { red };
    this.phone.sim.truth.tookUpAtWelcome(this.phone.run, e.roomCode !== room, e.client as SerializedClient);
    return { client: e.client, journal: this.journalFor(matchId), moved: e.roomCode !== room, red };
  }
  /**
   * The saved slot as a launch reads it (logic/activeSession.ts: a record older than 12 h is not offered; before unit 20g it
   * was deleted, since then an online one that holds a match goes to the archive first). The journal is what the device holds.
   */
  launch(): void {
    this.slot = clone(this.slotStored);
    this.slotAt = this.slotStoredAt;
    this.archive = clone(this.archiveStored);
    const max = slotLogic?.SAVED_TABLE_MAX_AGE_MS ?? 12 * HOUR;
    if (this.slot && this.now() - this.slot.savedAt > max) {
      const stale = BY_MATCH && slotLogic?.staleOnlineSession ? slotLogic.staleOnlineSession(clone(this.slot), this.now()) : null;
      let wrote = true;
      if (stale && archiveLogic) {
        this.archive = [...archiveLogic.archiveOnSlotChange(this.archive, stale, null, () => undefined, this.now())];
        wrote = !this.failing && !this.archiveFails;
        if (wrote) this.archiveStored = clone(this.archive);
        else this.archiveBehind = true;
      }
      // storage.ts loadActiveSession removes the key (a removal goes through on a full storage); since unit 20h only once
      // the archive holding it was written (`ORDERED_WRITES`): until then the device's slot keeps it, not offered on Home.
      this.slot = null;
      this.slotAt = null;
      if (!ORDERED_WRITES || wrote) {
        this.slotStored = null;
        this.slotStoredAt = null;
      }
    }
    this.journal = this.journalStored ?? [];
  }
}

/** The player's phone: its table client (one per run of the client), its links, its app, and the player. */
export class Phone {
  client: TableClient | null = null;
  line: Line | null = null;
  /** Client instances made so far (the run of the current one). */
  run = 0;
  /** Runs of the app's process. */
  appRun = 0;
  running = true;
  asleep = false;
  monoOffset = 500_000 - T0;
  reconnectAt: number | null = null;
  /** Home's Resume, `ms` after a seat-taken notice or a planned one. */
  resumeAt: number | null = null;
  /** The account is seated at the room again (after `gone` or `fresh`). */
  reseatAt: number | null = null;
  reseatRoom: string | null = null;
  /** The app comes back up (after `restart` or `update`). */
  startAt: number | null = null;
  /** The table answers the session's reconnects with room_unavailable. */
  gone = false;
  /** The build the client runs (another one before an app update). */
  build: Net;
  app: App;
  private decision: Decision | null = null;
  /** A move that failed: avoided at the player's next move of the hand while it is still legal. */
  private avoid: { hand: number; action: Action } | null = null;
  private readied = new Set<number>();
  private nextCheck = 0;
  constructor(
    readonly sim: Sim,
    readonly kind: 'victim' | 'other',
  ) {
    this.app = new App(this);
    this.build = net;
  }
  /**
   * The options every client of this phone is built with (game/session.ts `clientOptions`): its clocks, and on the player's
   * phone the journal's hook (a write that fails takes the journal off the device and lets the move go) and the lookup by
   * match at the first welcome (joining `room`).
   */
  opts(room: string = this.sim.room): { now: () => number; monotonic: () => number; writeAhead?: (entry: unknown) => void | Promise<void>; keptRecord?: (matchId: string) => KeptRecord | undefined } {
    const clock = { now: () => this.sim.clock.now, monotonic: () => this.sim.clock.now + this.monoOffset };
    if (this.kind !== 'victim') return clock;
    const app = this.app;
    return {
      ...clock,
      ...(APP_JOURNAL ? { writeAhead: (entry: unknown) => app.journalWrite(entry) as void | Promise<void> } : {}),
      ...(BY_MATCH ? { keptRecord: (matchId: string) => app.keptMatch(matchId, room) } : {}),
    };
  }
  /** The options a client restored from a record of `matchId` is built with: the journal of the match goes back to it. */
  restoreOpts(matchId: unknown, room: string = this.sim.room) {
    const journal = this.kind === 'victim' ? this.app.journalFor(matchId) : undefined;
    this.sim.truth.journalGiven(journal !== undefined);
    return { ...this.opts(room), ...(journal !== undefined ? { journal } : {}) };
  }
  /** A client on a new link: `make` builds it on the link. */
  start(make: (link: Link) => TableClient, how: string): void {
    const line = this.sim.openLine(this.kind, this.run + 1);
    this.run++;
    this.line = line;
    const c = make(line.link);
    this.client = c;
    this.decision = null;
    this.readied.clear();
    if (this.kind === 'victim') {
      this.app.attach(c);
      this.sim.truth.runStarted(this, how);
      this.sim.adversary?.newLine('run');
    }
    c.join();
    // The app pings right behind each join (the client queues one too, which a synchronous run never gets to).
    (c as TableClient & { ping?: () => void }).ping?.();
  }
  /** The online session's reconnect on a new link, with the same client. */
  reconnect(): void {
    const c = this.client;
    if (!c) return;
    this.reconnectAt = null;
    if (this.gone) return this.sim.goneAnswered(this);
    const line = this.sim.openLine(this.kind, this.run);
    this.line = line;
    c.rebind(line.link);
    if (this.kind === 'victim') this.sim.adversary?.newLine('reconnect');
    c.join();
    (c as TableClient & { ping?: () => void }).ping?.();
  }
  /** The link breaks: the phone learns it (its socket closes) and reconnects `ms` later. */
  lose(ms: number, opts: { host: boolean } = { host: true }): void {
    if (!this.line) return;
    this.sim.closeLine(this.line, { phone: true, host: opts.host, tell: true });
    this.reconnectAt = this.sim.clock.now + ms;
  }
  /** Leave the table screen: the client and its link go (a save still waiting is written first since unit 20h, `App.flush`; before, it went with them). */
  leave(): void {
    if (this.kind === 'victim' && this.client) this.app.flush();
    if (this.line) this.sim.closeLine(this.line, { phone: true, host: true, tell: false });
    if (this.client && this.kind === 'victim') this.sim.truth.runEnded(this, this.client);
    this.app.detach();
    this.client = null;
    this.line = null;
    this.reconnectAt = null;
  }
  /** Home's Resume (session.ts `savedClientFor`): a client restored from the saved slot when it holds this table's record, else one from its token. */
  resume(): void {
    this.leave();
    const rec = this.app.slot;
    const room = this.sim.room;
    const saved = rec && rec.roomCode === room && rec.client && (rec.client.state?.token ?? '') === rec.token && typeof rec.client.state?.matchId === 'string' && rec.client.state.matchId !== '' ? rec.client : null;
    const token = rec?.token || undefined;
    const TC = this.build.TableClient;
    if (saved) {
      this.start((link) => {
        const c = TC.restore(saved, link, NAME, 'auntie', { token, userId: ACCOUNT }, this.restoreOpts(saved.state?.matchId, room));
        (c as TableClient & { keepRed?: (l: unknown) => void }).keepRed?.(this.app.redFor(room));
        return c;
      }, 'restore');
    } else this.start((link) => new TC(link, NAME, 'auntie', { token, userId: ACCOUNT }, this.opts(room)), token ? 'token' : 'fresh');
  }
  /** The app's process stops: nothing of it runs, its socket goes, a save still waiting is lost. */
  stop(): void {
    if (this.line) this.sim.closeLine(this.line, { phone: true, host: true, tell: false });
    if (this.client) this.sim.truth.runEnded(this, this.client);
    this.app.detach();
    this.client = null;
    this.line = null;
    this.reconnectAt = null;
    this.running = false;
    this.sim.truth.appStopped(this);
  }
  /** The app's process starts (another build after an update): its monotonic clock starts afresh, and it reads its saved slot. */
  boot(build: Net = this.build): void {
    this.running = true;
    this.appRun++;
    this.build = build;
    this.monoOffset = 500_000 + this.appRun * 1_000_000 - this.sim.clock.now;
    this.app.launch();
    this.sim.truth.appStarted(this);
  }
  /** The app's process starts again and the player resumes the table from Home. */
  startApp(build: Net = this.build): void {
    this.boot(build);
    this.resume();
  }
  /**
   * The account is seated at `room` again by any path (session.ts `createOnlineSession`): the saved table's record when the
   * slot holds one of that room (`savedClientFor`, with the slot's token), else a record kept of the table there
   * (`keptOrFresh`), or nothing.
   */
  reseat(room: string): void {
    this.leave();
    if (!this.running) this.boot();
    this.gone = false;
    const rec = this.app.slot;
    if (rec && rec.roomCode === room && rec.client && (rec.client.state?.token ?? '') === rec.token && typeof rec.client.state?.matchId === 'string' && rec.client.state.matchId !== '') {
      const saved = rec.client;
      const TC0 = this.build.TableClient;
      this.start((link) => {
        const c = TC0.restore(saved, link, NAME, 'auntie', { token: rec.token || undefined, userId: ACCOUNT }, this.restoreOpts(saved.state?.matchId, room));
        (c as TableClient & { keepRed?: (l: unknown) => void }).keepRed?.(this.app.redFor(room));
        return c;
      }, 'restore');
      return;
    }
    const kept = archiveLogic ? archiveLogic.archivedFor(this.app.archive, SIGNAL_URL, room, this.app.now()) : undefined;
    const TC = this.build.TableClient as Net['TableClient'] & { fromArchive?: Net['TableClient']['restore'] };
    if (kept && typeof TC.fromArchive === 'function') {
      this.start((link) => {
        const c = TC.fromArchive!(kept.client, link, NAME, 'auntie', { token: kept.token || undefined, userId: ACCOUNT }, this.restoreOpts(kept.client.state?.matchId, room));
        (c as TableClient & { keepRed?: (l: unknown) => void }).keepRed?.(this.app.redFor(room));
        return c;
      }, 'archive');
      this.sim.truth.tookUpFromArchive(this.run, kept.client);
    } else this.start((link) => new TC(link, NAME, 'auntie', { userId: ACCOUNT }, this.opts(room)), 'fresh');
  }
  tick(): void {
    const now = this.sim.clock.now;
    if (this.startAt !== null && now >= this.startAt) {
      this.startAt = null;
      this.startApp(this.sim.pendingBuild ?? this.build);
      this.sim.pendingBuild = null;
    }
    if (this.reseatAt !== null && now >= this.reseatAt) {
      this.reseatAt = null;
      this.reseat(this.reseatRoom ?? this.sim.room);
    }
    if (!this.running) return;
    if (this.resumeAt !== null && now >= this.resumeAt) {
      this.resumeAt = null;
      this.resume();
    }
    if (this.reconnectAt !== null && now >= this.reconnectAt && !this.asleep) this.reconnect();
    if (this.asleep || !this.client) return;
    if (this.line) this.sim.pump(this.line);
    // A frame may have taken the client away (the app cleared a table that is over, a reseat).
    if (!this.client) return;
    // The online session checks the link once a second.
    if (now >= this.nextCheck) {
      this.nextCheck = (Math.floor(now / 1_000) + 1) * 1_000;
      if (this.line && this.line.open && this.reconnectAt === null && this.client.checkLink() === 'silent') this.lose(RECONNECT_MS);
    }
    this.play();
    if (this.kind === 'victim') this.app.tick();
  }
  /** A frame reached the client (what the player sees of errors). */
  onFrame(m: HostMessage): void {
    const d = this.decision;
    if (m.t !== 'error' || !d?.acted) return;
    d.errored = true;
    // A player whose move came back with an error tries something else next (`retry: other`), at this turn or the next.
    if (this.sim.scenario.player.retry.kind === 'other') this.avoid = { hand: d.hand, action: d.acted };
  }
  /** The player plays the move its phone shows, after thinking; presses Next after a result. */
  private play(): void {
    const c = this.client;
    // A frame or a check of the link may have taken the client away this step.
    if (!c) return;
    const st = c.state;
    const p = this.sim.scenario.player;
    if (st.lastResult !== null && st.lastAudit && !st.matchOver) {
      const h = st.lastAudit.handNumber;
      if (p.readyMs !== null && !this.readied.has(h)) {
        const since = this.sim.resultSeen.get(`${this.run}:${h}`) ?? this.sim.clock.now;
        if (this.sim.clock.now - since >= p.readyMs) {
          this.readied.add(h);
          c.ready();
        }
      }
      return;
    }
    if (st.kicked) return;
    let s: GameState | null = null;
    try {
      s = c.localState();
    } catch {
      s = null;
    }
    if (!s || s.phase === 'ended') return;
    let acts: Action[] = [];
    try {
      acts = engine.legalActions(s, 0);
    } catch {
      acts = [];
    }
    if (acts.length === 0) return;
    const now = this.sim.clock.now;
    const key = `${s.handNumber}:${s.turnCounter}`;
    if (this.decision?.key !== key) {
      const [lo, hi] = this.kind === 'victim' ? p.thinkMs : [800, 800];
      const think = lo + (hashOf(this.sim.scenario.seed, 'think', this.kind, this.run, key) % (hi - lo + 1));
      this.decision = { key, hand: s.handNumber, tc: s.turnCounter, since: now, think, acted: null, actedAt: 0, errored: false, retried: false };
    }
    const d = this.decision;
    if (!d.acted) {
      if (now - d.since < d.think) return;
      let a = engine.chooseAction(s, 0, { seed: this.kind === 'victim' ? 'p' : 'o' });
      if (!a) return;
      const avoid = this.avoid;
      if (avoid && avoid.hand === s.handNumber && engine.sameAction(avoid.action, a, s, 0) && acts.some((b) => engine.sameAction(b, avoid.action, s!, 0))) a = otherThan(s, 0, a, acts) ?? a;
      d.acted = a;
      d.actedAt = now;
      this.act(a, s);
      return;
    }
    // A move that seems to have gone nowhere: an error came back, or nothing happened for a while.
    if (d.retried || p.retry.kind === 'none' || this.kind !== 'victim') return;
    if (!d.errored && now - d.actedAt < Math.max(p.retry.afterMs, 1_500)) return;
    if (d.errored && now - d.actedAt < p.retry.afterMs) return;
    d.retried = true;
    const first = d.acted;
    const again = p.retry.kind === 'same' ? first : otherThan(s, 0, first, acts);
    if (p.retry.kind === 'other') this.avoid = { hand: s.handNumber, action: first };
    if (again) this.act(again, s);
  }
  private act(a: Action, s: GameState): void {
    const c = this.client!;
    const before = this.sim.truth.sentCount();
    c.act(a);
    if (this.kind === 'victim') this.sim.truth.intent(this, s, a, this.sim.truth.sentCount() > before);
  }
}

export interface SimOptions {
  scenario: Scenario;
  truth: Truth;
  /** Before an app update: the build the phone starts on. */
  startBuild?: Net;
}

/** The whole table: host, network, phones. */
export class Sim {
  readonly clock = { now: T0 };
  /** Added to the app's clock for the age of its records (`gone` routes that wait a day). */
  appClockSkew = 0;
  hub: LoopbackHub;
  host: TableHost;
  /** Runs of the server's process. */
  era = 0;
  readonly room: string;
  readonly matchId: string;
  readonly rules: RuleSet;
  readonly lines: Line[] = [];
  readonly phone: Phone;
  other: Phone | null = null;
  adversary: Adversary | null = null;
  readonly truth: Truth;
  readonly scenario: Scenario;
  /** When each client run first held each hand's result: the player presses Next `readyMs` after it. */
  readonly resultSeen = new Map<string, number>();
  /** The build an app update brings, until the app starts again. */
  pendingBuild: Net | null = null;
  /** Moves forged into the log are being applied (origin of `apply`). */
  forging: 'player' | 'auto' | null = null;
  /** Frames the server changed (a doctored view). */
  readonly doctoredFrames = new WeakSet<object>();
  /** Frames the server made malformed: the charter says each fails the hand on show (the mark names what was done). */
  readonly mustFail = new WeakMap<object, string>();
  /** When the host sent each frame it sent the phone (the server's own frames are not in it). */
  private readonly sentAt = new WeakMap<object, number>();
  private timers: Array<{ at: number; fn: () => void }> = [];
  private lineCount = 0;
  private decisionKey = '';
  private readonly counts = new Map<string, number>();
  private readonly seen = new Set<string>();
  constructor(opts: SimOptions) {
    const s = opts.scenario;
    this.scenario = s;
    this.truth = opts.truth;
    this.room = `ADV${s.seed}`;
    this.matchId = `m-${this.room}`;
    const c = CLOCKS[s.speed];
    this.rules = engine.withRules({ handsPerMatch: s.hands, turnSeconds: c.turn, timeBankSeconds: c.bank });
    this.hub = new net.LoopbackHub();
    this.host = this.makeHost();
    this.phone = new Phone(this, 'victim');
    if (opts.startBuild) this.phone.build = opts.startBuild;
    this.truth.attach(this);
  }

  private makeHost(restore?: SerializedHost): TableHost {
    const clock = net.clientClock({ now: () => this.clock.now, monotonic: () => this.clock.now });
    const host = new net.TableHost(this.hub.create('host'), {
      roomCode: this.room,
      rules: this.rules,
      now: clock,
      matchId: this.matchId,
      intermissionSeconds: 8,
      botDelayMs: this.scenario.botDelayMs,
      schedule: (fn, ms) => void this.timers.push({ at: this.clock.now + ms, fn }),
      verifiedUserIds: true,
      ...(restore ? { restore } : {}),
    });
    const h = host as unknown as { apply: (seat: number, a: Action, source: string) => void; anyHumanConnected: () => boolean };
    const apply = h.apply;
    h.apply = (seat: number, a: Action, source: string) => {
      const before = host.game;
      const origin = this.truth.origin;
      this.truth.beforeApply(seat, a, before);
      apply.call(host, seat, a, source);
      this.truth.applied(seat, a, source, origin, this.forging, before, host.game);
      this.noteHost();
    };
    if (this.scenario.othersPresent) h.anyHumanConnected = () => true;
    return host;
  }

  adversaryDoctored(m: HostMessage): boolean {
    return this.doctoredFrames.has(m);
  }

  hostSentAt(m: HostMessage): number | undefined {
    return this.sentAt.get(m);
  }

  /** The host's own state, privately: its clock for seat 0 and its timeout rule. */
  hostInside() {
    return this.host as unknown as {
      clocks: Map<number, { base: number; inBank: boolean }>;
      banks: number[];
      now: () => number;
      timeoutAction(g: GameState, seat: number): Action;
      stateMsg(seat: number): HostMessage;
      seatInfo(): unknown;
      seats: Array<{ token?: string; peerId: string | null; connected: boolean; userId?: string }>;
      snapshot: { handNumber: number; scores: number[] };
      hostSecret: string;
      hostCommit: string;
      ceremonyAttempts: number;
      phase: string;
      game: GameState | null;
      botSkill: string;
      rules: RuleSet;
      matchId: string;
      roomCode: string;
    };
  }

  /** The move the table's published rule makes for seat 0 in `g`. */
  timeoutMove(g: GameState): Action | null {
    try {
      return this.hostInside().timeoutAction(g, 0);
    } catch {
      return null;
    }
  }

  openLine(owner: 'victim' | 'other', run: number): Line {
    const n = this.lineCount++;
    const line = new Line(this, owner === 'victim' ? `p${n}` : `o${n}`, n, owner, run, this.clock.now);
    this.lines.push(line);
    if (owner === 'victim') this.truth.lineOpened(line);
    return line;
  }

  closeLine(line: Line, how: { phone: boolean; host: boolean; tell: boolean }): void {
    if (how.phone && !line.phoneClosed) {
      line.phoneClosed = true;
      line.closedAt = this.clock.now;
      line.down.length = 0;
      line.up.length = 0;
      line.held.length = 0;
      if (line.owner === 'victim') this.truth.lineClosed(line);
    }
    if (how.host && !line.hostClosed) {
      line.hostClosed = true;
      line.transport.close();
    }
    if (how.tell) for (const f of [...line.closeHandlers]) f();
  }

  /** A frame the host sent on `line`. */
  fromHost(line: Line, m0: HostMessage): void {
    if (line.owner === 'other' || !this.adversary) {
      if (!line.phoneClosed) line.send(m0);
      return;
    }
    this.sentAt.set(m0, this.clock.now);
    this.truth.hostSent(line, m0);
    this.moments(line, m0);
    if (line.phoneClosed) return;
    const out = m0.t === 'welcome' ? this.adversary.welcome(line, m0).flatMap((x) => this.adversary!.down(line, x)) : this.adversary.down(line, m0);
    for (const m of out) {
      if (line.phoneClosed) return;
      if (this.adversary.hold(line, m)) {
        line.held.push(m);
        continue;
      }
      const at = Math.max(this.clock.now + this.adversary.delay(line, m), line.down.length ? line.down[line.down.length - 1].at : -Infinity);
      line.down.push({ at, m });
    }
  }

  /** A message the phone sent on `line`. */
  fromPhone(line: Line, m: ClientMessage): void {
    if (line.phoneClosed) return;
    if (line.owner === 'victim' && this.adversary) {
      this.truth.clientSent(line, m);
      this.upMoments(line, m);
      if (line.phoneClosed) return;
      if (!this.adversary.up(line, m)) return;
    }
    line.up.push({ at: this.clock.now, m });
    this.uppump(line);
  }

  uppump(line: Line): void {
    while (line.up.length && line.up[0].at <= this.clock.now) {
      const m = line.up.shift()!.m;
      if (line.phoneClosed || line.hostClosed) continue;
      this.truth.origin = { kind: line.owner, line, m };
      try {
        line.transport.send('host', m);
      } finally {
        this.truth.origin = null;
      }
      this.noteHost();
    }
  }

  pump(line: Line): void {
    while (!line.phoneClosed && line.down.length && line.down[0].at <= this.clock.now) this.deliver(line, line.down.shift()!.m);
  }

  /** A frame reaches the phone on `line`. */
  deliver(line: Line, m: HostMessage): void {
    if (line.phoneClosed) return;
    const phone = line.owner === 'victim' ? this.phone : this.other;
    if (!phone || !phone.client || phone.line !== line) return;
    if (line.owner === 'victim') this.truth.delivered(line, m);
    try {
      line.cb?.(m);
    } catch (e) {
      this.truth.crash(`client: ${(e as Error).message}`);
    }
    if (line.owner !== 'victim') return;
    if ((m.t === 'hand_over' || m.t === 'hand_missed') && phone.client) {
      const h = m.t === 'hand_over' ? m.audit?.handNumber : m.audit?.handNumber;
      const key = `${phone.run}:${h}`;
      if (!this.resultSeen.has(key)) this.resultSeen.set(key, this.clock.now);
    }
    phone.onFrame(m);
    this.adversary?.delivered(line, m);
    if (phone.client) this.truth.afterDelivered(line, m, phone.client);
  }

  /** The moments of the match a frame the host sends the phone marks. */
  private moments(line: Line, m: HostMessage): void {
    const adv = this.adversary!;
    if (m.t === 'commit_request') return adv.moment({ on: 'commit', hand: m.handNumber }, line, m);
    if (m.t === 'hand_over') return adv.moment({ on: 'result', hand: m.audit.handNumber }, line, m);
    if (m.t !== 'state') return;
    const hand = m.view.handNumber;
    const tc = m.view.turnCounter;
    if (!this.seen.has(`deal:${hand}`)) {
      this.seen.add(`deal:${hand}`);
      adv.moment({ on: 'deal', hand }, line, m);
    }
    const g = this.host.game;
    if (!g || g.handNumber !== hand || g.turnCounter !== tc || this.seen.has(`s:${hand}:${tc}`)) return;
    this.seen.add(`s:${hand}:${tc}`);
    const kind = stateKind(g);
    const count = (k: StateKind) => {
      const key = `s:${hand}:${k}`;
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      return n;
    };
    adv.moment({ on: 'state', hand, kind, k: count(kind), tc }, line, m);
    if (kind !== 'other') adv.moment({ on: 'state', hand, kind: 'any', k: count('any'), tc }, line, m);
  }

  private upMoments(line: Line, m: ClientMessage): void {
    const adv = this.adversary!;
    if (m.t === 'reveal') return adv.moment({ on: 'reveal', hand: this.hostInside().snapshot.handNumber }, line, m);
    if (m.t !== 'action') return;
    const g = this.host.game;
    const hand = g?.handNumber ?? this.hostInside().snapshot.handNumber;
    const kind = moveKind(m.action);
    const count = (k: MoveKind) => {
      const key = `m:${hand}:${k}`;
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      return n;
    };
    const tc = typeof m.turnCounter === 'number' ? m.turnCounter : -1;
    adv.moment({ on: 'move', hand, kind, k: count(kind), tc }, line, m);
    adv.moment({ on: 'move', hand, kind: 'any', k: count('any'), tc }, line, m);
  }

  /** After anything that may change the hand: a new decision of seat 0 on the host. */
  noteHost(): void {
    const g = this.host.game;
    if (!g || this.hostInside().phase !== 'playing') return;
    const key = `${g.handNumber}:${g.turnCounter}`;
    if (key === this.decisionKey) return;
    this.decisionKey = key;
    const kind = stateKind(g);
    if (kind === 'other') return;
    const clock = this.hostInside().clocks.get(0);
    const deadline = clock ? clock.base + this.hostInside().banks[0] : this.clock.now;
    this.truth.decision(g, kind, deadline);
  }

  /** The server applies a move to seat 0 in its own log (`label`: as the player's own, or as the table's). */
  forge(a: Action, label: 'player' | 'auto'): boolean {
    this.forging = label;
    try {
      (this.host as unknown as { apply: (seat: number, a: Action, source: string) => void }).apply(0, a, label === 'player' ? 'player' : 'timeout');
      return true;
    } catch {
      return false;
    } finally {
      this.forging = null;
    }
  }

  /** The session's reconnect is answered room_unavailable: the app takes the table off Home, into its archive. */
  goneAnswered(phone: Phone): void {
    phone.app.put(null);
    phone.leave();
  }

  /** The server restarts and restores the table from its save; every link goes, the phones reconnect `ms` later. */
  restartServer(ms: number): void {
    const saved = JSON.parse(JSON.stringify(this.host.serialize())) as SerializedHost;
    this.host.close();
    this.timers = [];
    this.hub = new net.LoopbackHub();
    this.era++;
    this.host = this.makeHost(saved);
    this.decisionKey = '';
    this.truth.serverRestarted();
    for (const p of [this.phone, this.other]) {
      if (!p || !p.line) continue;
      this.closeLine(p.line, { phone: true, host: false, tell: true });
      if (p.client && p.running) p.reconnectAt = this.clock.now + ms;
    }
  }

  /** The player opens the seat on another phone (with the table's token), plays there `ms`, and resumes on this one. */
  otherDevice(ms: number): void {
    const token = this.phone.client?.state.token;
    if (!token || this.other) return;
    const o = new Phone(this, 'other');
    this.other = o;
    o.start((link) => new net.TableClient(link, NAME, 'auntie', { token, userId: ACCOUNT }, o.opts()), 'other');
    this.phone.resumeAt = this.clock.now + ms;
    this.truth.otherDevice(true);
  }

  step(): void {
    this.clock.now += STEP_MS;
    for (const l of this.lines) if (!l.phoneClosed && !l.hostClosed) this.uppump(l);
    const due = this.timers.filter((t) => t.at <= this.clock.now);
    this.timers = this.timers.filter((t) => t.at > this.clock.now);
    for (const t of due) t.fn();
    this.noteHost();
    try {
      this.host.tick();
    } catch (e) {
      this.truth.crash(`host: ${(e as Error).message}`);
    }
    this.noteHost();
    this.adversary?.tick();
    this.noteHost();
    this.phone.tick();
    if (this.other) {
      this.other.tick();
      if (this.other.client?.state.kicked) {
        this.other.leave();
        this.other = null;
        this.truth.otherDevice(false);
      }
    }
    this.truth.step();
  }

  /** Play the match out: until the host's match is over and the phone shows its end, or the time runs out. */
  run(): void {
    const limit = T0 + this.scenario.hands * 900_000 + 600_000;
    let overAt: number | null = null;
    while (this.clock.now < limit) {
      this.step();
      if (this.hostInside().phase === 'match_over') {
        overAt ??= this.clock.now;
        this.truth.matchOverAt ??= this.clock.now;
        const p = this.phone;
        const settled = p.client?.state.matchOver && p.resumeAt === null && p.reseatAt === null && p.startAt === null;
        if (settled || this.clock.now - overAt > 120_000) break;
      }
    }
    this.truth.finish(this);
  }
}

/** The kinds of move the forger and the player avoid making for the player: the table's timeout rule, and the player's own choice. */
export function forgedMove(sim: Sim, g: GameState, policy: 'other' | 'timeout'): Action | null {
  const t = sim.timeoutMove(g);
  if (policy === 'timeout') return t;
  let acts: Action[] = [];
  try {
    acts = engine.legalActions(g, 0);
  } catch {
    return null;
  }
  const mine = (() => {
    try {
      return engine.chooseAction(g, 0, { seed: 'p' });
    } catch {
      return null;
    }
  })();
  const notRule = (a: Action) => !t || !engine.sameAction(a, t, g, 0);
  const differs = (a: Action) => notRule(a) && (!mine || !engine.sameAction(a, mine, g, 0));
  // Neither the table's rule nor the player's own choice where there is one; else not the rule's.
  if (g.phase === 'claim') return acts.find((a) => a.type === 'pass' && differs(a)) ?? acts.find(differs) ?? acts.find(notRule) ?? null;
  return acts.find((a) => a.type === 'discard' && differs(a)) ?? acts.find(differs) ?? acts.find(notRule) ?? null;
}
