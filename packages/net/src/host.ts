/**
 * Authoritative table host. Online tables run it on the game server; offline
 * play against bots runs the same code on the player's own device.
 *
 * Responsibilities: seating, commit–reveal seed ceremony, validating actions,
 * broadcasting per-seat views, auto-playing bots / disconnected / timed-out
 * seats, and publishing an audit after every hand.
 */
import {
  advanceMatch,
  applyAction,
  chooseAction,
  dealFromSnapshot,
  DEFAULT_RULES,
  hashState,
  legalActions,
  matchSnapshot,
  sanitizeRules,
  viewFor,
  type Action,
  type GameState,
  type HandResult,
  type MatchSnapshot,
  type RuleSet,
  type BotSkill,
} from '@mjm/engine';
import { commitFor, deriveSeed, isSecret, makeSecret, verifyReveals, type Commitment, type Reveal } from './fairness';
import type { Audit, CeremonyRestart, ClientMessage, HostMessage, RestartCause, SeatInfo } from './messages';
import type { Transport, Unsubscribe } from './transport';
import { randomHex } from './sha256';
import { cleanText } from './text';
import { isQuickChatId, isTableEmoteId } from './tabletext';

export type HostPhase = 'lobby' | 'commit' | 'reveal' | 'playing' | 'hand_over' | 'match_over';

/**
 * Most ceremonies one hand may take. Every restart names at least one human seat that had not been
 * blamed yet, and a blamed seat gets a host-supplied share for every later attempt at that hand
 * (it can never be blamed again), so an honest table needs at most 1 + the number of humans ≤ 5
 * attempts and 6 is never reached honestly.
 */
export const MAX_CEREMONY_ATTEMPTS = 6;

/** After a failed ceremony, how long the table waits before trying the hand again (ms). */
const CEREMONY_RETRY_MS = 5_000;

/** Chat: one line a second with a burst of five. Emotes: one every two seconds. */
const CHAT_BUCKET = { capacity: 5, perSecond: 1 };
const EMOTE_BUCKET = { capacity: 1, perSecond: 0.5 };

export interface HostOptions {
  roomCode: string;
  rules?: RuleSet;
  matchId?: string;
  /** Fill empty seats with bots when the match starts (default true). */
  fillWithBots?: boolean;
  /** Clock source (ms). Defaults to Date.now. */
  now?: () => number;
  /** Delay before a bot acts, for a natural rhythm. 0 in tests. */
  botDelayMs?: number;
  /** Scheduler used for bot delays; defaults to setTimeout. */
  schedule?: (fn: () => void, ms: number) => void;
  /** Seconds players get to confirm the next hand on the result screen. */
  intermissionSeconds?: number;
  /** Names used for bots. */
  botNames?: string[];
  /** Strength of bots at this table (default 'club'). */
  botSkill?: BotSkill;
  /** Restore a previously serialised host (crash recovery). */
  restore?: SerializedHost;
  /**
   * Who may add bots and start the match, by the account bound to their seat: at a club table its
   * opener and the club's owner and admins, at a private table its creator. Asked at the moment of
   * the request, so a change of club roles applies at once. While nobody it accepts holds a
   * connected seat, any seated player may (a table is never stuck because its opener walked away).
   * Absent: every seated player may (local play, and tables opened without an account).
   */
  isController?: (userId: string | undefined) => boolean;
  /**
   * The `userId` on every `join` this host receives was verified by whoever feeds it its messages
   * (the game server writes the account its session token proved into the frame and drops any id
   * the client wrote). With it, an account that holds a seat gets that seat back by joining again,
   * without the rejoin token: a player who reinstalled the app or moved to another device is not
   * locked out of their own match. Never set it at a table a device hosts, where the id in a join
   * is whatever the client claims; there the rejoin token stays the only way back.
   */
  verifiedUserIds?: boolean;
}

export interface HostEvent {
  type: 'hand_over' | 'match_over' | 'lobby' | 'state';
  roomCode: string;
  matchId: string;
  seats: SeatInfo[];
  scores: number[];
  handNumber: number;
  /** Hands won per seat this match (a shared win counts for every winner). */
  handsWon: number[];
  /** The hand's result, on `hand_over` events. */
  result?: HandResult;
}

export interface SerializedHost {
  version: 1;
  roomCode: string;
  matchId: string;
  rules: RuleSet;
  phase: HostPhase;
  game: GameState | null;
  snapshot: MatchSnapshot;
  seats: Array<Omit<SeatState, 'peerId' | 'connected'> & { peerId: null; connected: boolean }>;
  banks: number[];
  audits: Audit[];
  botSkill: BotSkill;
  hostSecret?: string;
  hostCommit?: string;
  ceremonyAttempts?: number;
  restartReasons?: string[];
  restarts?: CeremonyRestart[];
  /** Hand number the ceremony counters belong to. */
  ceremonyHand?: number;
  /** Seats blamed for a restart of `ceremonyHand`; the host supplies their shares until the hand changes. */
  standIns?: number[];
  handsWon?: number[];
  /** The table is in the lobby only because a ceremony was interrupted: only token holders may sit until it is dealt again. */
  pendingRestart?: boolean;
}

interface SeatState extends SeatInfo {
  secret?: string;
  commit?: string;
  /** The host made this human seat's share for the current attempt (it was away or late); told again on a rejoin. */
  supplied?: boolean;
  ready: boolean;
  /** Rejoin token issued in `welcome`; lets a crashed client reclaim its seat. */
  token?: string;
}

interface SeatClock {
  /** When the base turn clock expires. */
  base: number;
  /** Clock has moved into the player's time bank. */
  inBank: boolean;
}

/** A direct link for a client living in the same process as the host (the host's own player). */
export interface Link {
  send(msg: ClientMessage): void;
  onMessage(cb: (msg: HostMessage) => void): Unsubscribe;
  close(): void;
  /** Optional: fires when the transport under the link is lost. */
  onClose?(cb: () => void): Unsubscribe;
}

const DEFAULT_BOT_NAMES = ['阿明 (Bot)', '小美 (Bot)', '老王 (Bot)', '阿花 (Bot)'];
/** Avatar ids handed to bots; the app draws these portraits. A bot never takes an avatar already at the table. */
const DEFAULT_BOT_AVATARS = ['shades', 'lady', 'uncle', 'auntie', 'boss', 'hoops', 'gent', 'grandma', 'cowboy', 'sporty', 'chef', 'student'];
/** Preferred portraits per default bot name (阿明, 小美, 老王, 阿花), tried before the general list. */
const BOT_AVATAR_PREFS = [
  ['shades', 'boss', 'student'],
  ['lady', 'hoops', 'sporty'],
  ['uncle', 'gent', 'cowboy'],
  ['auntie', 'grandma', 'chef'],
];

export class TableHost {
  readonly roomCode: string;
  readonly rules: RuleSet;
  readonly matchId: string;
  phase: HostPhase = 'lobby';
  game: GameState | null = null;
  private snapshot: MatchSnapshot = { handNumber: 0, dealerRotations: 0, dealerSeat: 0, dealerStreak: 0, prevailingWind: 0, scores: [0, 0, 0, 0], matchOver: false };
  private seats: SeatState[] = [0, 1, 2, 3].map((seat) => ({ seat, name: '', peerId: null, isBot: false, connected: false, ready: false }));
  /** Deadline for non-playing phases (ceremony, intermission). */
  private deadline: number | null = null;
  /** Per-seat action clocks while playing. */
  private clocks = new Map<number, SeatClock>();
  /** Remaining time bank per seat (ms) for the current hand. */
  private banks: number[] = [0, 0, 0, 0];
  private readonly botSkill: BotSkill;
  private readonly eventListeners = new Set<(ev: HostEvent) => void>();
  private readonly now: () => number;
  private readonly botDelayMs: number;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly fillWithBots: boolean;
  private readonly intermissionMs: number;
  private readonly botNames: string[];
  private readonly localLinks = new Map<string, (msg: HostMessage) => void>();
  private readonly unsubs: Unsubscribe[] = [];
  private botTimerArmed = false;
  private readonly listeners = new Set<() => void>();
  /** All audits published this match (for the host UI / export). */
  readonly audits: Audit[] = [];
  /** The host's own share in the ceremony: a colluding table cannot bias the seed without it. */
  private hostSecret = '';
  private hostCommit = '';
  private ceremonyAttempts = 0;
  private restarts: CeremonyRestart[] = [];
  /** Hand number the attempt counter and restarts belong to; they reset only when it changes. */
  private ceremonyHand = -1;
  private wins: number[] = [0, 0, 0, 0];
  /** Per-seat chat and emote allowances. */
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private readonly isController?: (userId: string | undefined) => boolean;
  private readonly verifiedUserIds: boolean;

  constructor(
    private readonly transport: Transport,
    opts: HostOptions,
  ) {
    this.roomCode = opts.restore?.roomCode ?? opts.roomCode;
    // Clients sanitise the rules they are sent and replay with them, so the host must deal with the same set.
    this.rules = sanitizeRules(opts.restore?.rules ?? opts.rules ?? DEFAULT_RULES);
    this.matchId = opts.restore?.matchId ?? opts.matchId ?? randomHex(8);
    this.now = opts.now ?? (() => Date.now());
    this.botDelayMs = opts.botDelayMs ?? 0;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.fillWithBots = opts.fillWithBots ?? true;
    this.intermissionMs = (opts.intermissionSeconds ?? 12) * 1000;
    this.botNames = opts.botNames ?? DEFAULT_BOT_NAMES;
    this.botSkill = opts.botSkill ?? opts.restore?.botSkill ?? 'club';
    this.isController = opts.isController;
    this.verifiedUserIds = opts.verifiedUserIds === true;
    if (opts.restore) this.restore(opts.restore);
    this.unsubs.push(transport.onMessage((from, msg) => this.handle(from, msg as ClientMessage)));
    this.unsubs.push(
      transport.onPeer((peerId, ev) => {
        if (ev === 'leave') this.onDisconnect(peerId);
      }),
    );
  }

  // ------------------------------------------------------------------ public

  onChange(cb: () => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Match-level events (for club standings, analytics, persistence). */
  onEvent(cb: (ev: HostEvent) => void): Unsubscribe {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  private emit(type: HostEvent['type']): void {
    if (this.eventListeners.size === 0) return;
    const ev: HostEvent = {
      type,
      roomCode: this.roomCode,
      matchId: this.matchId,
      seats: this.seatInfo(),
      scores: this.match().scores,
      handNumber: this.match().handNumber,
      handsWon: this.wins.slice(),
      result: type === 'hand_over' ? this.game?.result : undefined,
    };
    for (const l of this.eventListeners) l(ev);
  }

  seatInfo(): SeatInfo[] {
    return this.seats.map(({ seat, name, peerId, isBot, connected, avatar, userId, left }, i) => ({
      seat,
      name,
      peerId: peerId && peerId.startsWith('gone-') ? null : peerId,
      isBot,
      connected,
      avatar,
      userId,
      timeBank: Math.round(this.banks[i] / 1000),
      ...(left ? { left: true } : {}),
    }));
  }

  /**
   * Snapshot everything needed to resume this table after the hosting app
   * restarts. Peers are marked disconnected; they reclaim seats with their
   * rejoin tokens. Call after every `onChange`.
   */
  serialize(): SerializedHost {
    return {
      version: 1,
      roomCode: this.roomCode,
      matchId: this.matchId,
      rules: this.rules,
      phase: this.phase,
      game: this.game,
      snapshot: this.snapshot,
      seats: this.seats.map((s) => ({ ...s, peerId: null, connected: s.isBot })),
      banks: this.banks.slice(),
      audits: this.audits.slice(),
      botSkill: this.botSkill,
      hostSecret: this.hostSecret,
      hostCommit: this.hostCommit,
      ceremonyAttempts: this.ceremonyAttempts,
      restartReasons: this.restarts.map(describeRestart),
      restarts: this.restarts.map((r) => ({ ...r, seats: r.seats.slice() })),
      ceremonyHand: this.ceremonyHand,
      standIns: [...this.standInSeats],
      handsWon: this.wins.slice(),
      pendingRestart: this.pendingRestart,
    };
  }

  private restore(data: SerializedHost): void {
    if (data.version !== 1) throw new Error(`Unknown table snapshot version ${String(data.version)}`);
    this.phase = data.phase;
    this.game = data.game;
    this.snapshot = data.snapshot;
    this.seats = data.seats.map((s) => ({ ...s, peerId: null, connected: s.isBot }));
    this.banks = data.banks.slice();
    this.audits.push(...data.audits);
    this.hostSecret = data.hostSecret ?? '';
    this.hostCommit = data.hostCommit ?? '';
    this.ceremonyAttempts = data.ceremonyAttempts ?? 1;
    this.restarts = data.restarts?.map((r) => ({ ...r, seats: r.seats.slice() })) ?? [];
    this.ceremonyHand = data.ceremonyHand ?? (this.phase === 'lobby' ? -1 : this.snapshot.handNumber);
    this.standInSeats = new Set((data.standIns ?? []).filter((s) => Number.isInteger(s) && s >= 0 && s <= 3));
    this.wins = data.handsWon?.slice() ?? [0, 0, 0, 0];
    // A table written while it waited to deal again (a restart during a restart) is still waiting.
    this.pendingRestart = data.pendingRestart === true;
    // Any ceremony in flight cannot continue without the peers' secrets; restart it when they return.
    if (this.phase === 'commit' || this.phase === 'reveal') {
      for (const s of this.seats) {
        s.commit = undefined;
        s.secret = undefined;
        s.supplied = undefined;
      }
      this.phase = 'lobby';
      this.pendingRestart = true;
    }
    if (this.phase === 'playing') this.clocks.clear();
    // Players may have been shown more than the snapshot holds (it is written a moment after the
    // fact): say where this table resumed, so their clients can tell a restart from a rewind.
    if (this.phase === 'playing' && this.game) this.restoredAt = { handNumber: this.game.handNumber, turnCounter: this.game.turnCounter };
    else if (this.pendingRestart) this.restoredAt = { handNumber: this.snapshot.handNumber, turnCounter: -1 };
    else if (this.phase === 'hand_over' && this.game) {
      const next = advanceMatch(this.game);
      if (!next.matchOver) this.restoredAt = { handNumber: next.handNumber, turnCounter: -1 };
    }
  }

  /**
   * Set when this table was restored from a snapshot: the hand it resumed and the turn it resumed
   * at (-1: before that hand was dealt). Every returning seat is told until that hand ends.
   */
  private restoredAt: { handNumber: number; turnCounter: number } | null = null;
  private pendingRestart = false;
  /** True while a round of ceremony messages is going out (see `announcing`). */
  private ceremonyBusy = false;
  /**
   * Seats blamed for a restart of the current hand's ceremony. The host supplies their shares in
   * every later attempt at this hand (they stay human), so no seat is blamed twice. Cleared only
   * when the hand changes.
   */
  private standInSeats = new Set<number>();

  /** Create an in-process link so the hosting device can also play. */
  localLink(peerId = `local-${randomHex(4)}`): Link {
    const handlers = new Set<(msg: HostMessage) => void>();
    this.localLinks.set(peerId, (msg) => {
      for (const h of handlers) h(msg);
    });
    return {
      send: (msg) => this.handle(peerId, msg),
      onMessage: (cb) => {
        handlers.add(cb);
        return () => handlers.delete(cb);
      },
      close: () => {
        this.localLinks.delete(peerId);
        this.onDisconnect(peerId);
      },
    };
  }

  /** Add a bot to the first free seat. */
  addBot(): number | null {
    const free = this.seats.find((s) => !s.peerId && !s.isBot);
    if (!free) return null;
    free.isBot = true;
    free.connected = true;
    free.name = this.botNames[free.seat % this.botNames.length];
    const taken = new Set(this.seats.map((s) => s.avatar).filter((a): a is string => !!a));
    const prefs = BOT_AVATAR_PREFS[free.seat % BOT_AVATAR_PREFS.length];
    free.avatar = [...prefs, ...DEFAULT_BOT_AVATARS].find((a) => !taken.has(a)) ?? DEFAULT_BOT_AVATARS[free.seat];
    this.broadcastLobby();
    return free.seat;
  }

  /**
   * Take a player off the table for good (a club owner's eviction): every seat bound to `userId`.
   * Its connection is told (`{t:'error', code:'evicted'}`) and dropped from the seat, and the seat
   * forgets the account and its rejoin token, so nobody can reclaim it. In the lobby the seat is
   * simply freed. During a match the table's bot plays the seat to the end: the seat keeps its
   * place in the deal and its human flag, because every client freezes the set of bot seats when
   * the match starts and would rightly flag a host that changed it. Returns the seats affected.
   */
  evictUser(userId: string, message = 'You were removed from this table.'): number[] {
    const seats = this.seats.filter((s) => !s.isBot && s.userId === userId);
    for (const seat of seats) {
      if (seat.peerId && seat.connected && !seat.peerId.startsWith('gone-')) this.sendTo(seat.peerId, { t: 'error', code: 'evicted', message });
      if (this.phase === 'lobby' && !this.pendingRestart) {
        Object.assign(seat, { peerId: null, name: '', connected: false, token: undefined, ready: false, userId: undefined, avatar: undefined, commit: undefined, secret: undefined, supplied: undefined, left: undefined });
        continue;
      }
      const wasHere = seat.connected;
      const gone = seat.peerId ?? 'evicted';
      seat.token = undefined;
      seat.userId = undefined;
      seat.name = this.botNames[seat.seat % this.botNames.length];
      seat.left = true;
      if (wasHere) this.onDisconnect(gone);
      else seat.peerId = seat.peerId ?? `gone-evicted-${seat.seat}`;
    }
    if (seats.length) this.broadcastLobby();
    return seats.map((s) => s.seat);
  }

  /** Send one message to every connected human at the table (a notice from the server, such as the club closing it). */
  notifySeated(msg: HostMessage): void {
    this.broadcast(() => msg);
  }

  removeBot(seat: number): void {
    const s = this.seats[seat];
    if (!s.isBot || this.phase !== 'lobby') return;
    s.isBot = false;
    s.connected = false;
    s.name = '';
    s.avatar = undefined;
    this.broadcastLobby();
  }

  /** Begin the match: fill with bots if configured and run the first seed ceremony. */
  start(): void {
    if (this.phase !== 'lobby') return;
    if (this.fillWithBots) while (this.seats.some((s) => !s.peerId && !s.isBot)) this.addBot();
    if (this.seats.some((s) => !s.peerId && !s.isBot)) {
      throw new Error('Table is not full');
    }
    this.beginHand();
  }

  /** Call periodically (e.g. every 500 ms) to enforce timers. */
  tick(): void {
    if (this.phase === 'playing' && this.game) {
      this.tickClocks();
      return;
    }
    if (this.deadline === null || this.now() < this.deadline) return;
    if (this.phase === 'lobby') {
      // A failed ceremony: try the hand again while a player is still here (otherwise a returning one restarts it).
      if (this.pendingRestart && this.anyHumanConnected()) this.retryCeremony();
      return;
    }
    if (this.phase === 'hand_over') {
      this.deadline = null;
      this.afterHand();
    } else if (this.phase === 'commit' || this.phase === 'reveal') {
      // Some peers missed the ceremony window. Decide for all of them at once so a restart
      // never gives later seats a zero-length commit window.
      this.deadline = null;
      const phase = this.phase;
      const late = this.seats.filter((s) => !s.isBot && (phase === 'commit' ? !s.commit : !s.secret));
      if (phase === 'commit') {
        for (const s of late) this.supplyShare(s);
      } else if (late.length > 0) {
        this.restartCeremony(late, 'no_reveal');
        return;
      }
      this.checkCeremony();
    }
  }

  nextDeadline(): number | null {
    return this.deadline;
  }

  /** Expire base clocks into time banks, and auto-play seats whose bank is gone. */
  private tickClocks(): void {
    const now = this.now();
    let changed = false;
    for (const [seat, clock] of [...this.clocks.entries()]) {
      if (now < clock.base) continue;
      if (!clock.inBank && this.banks[seat] > 0) {
        clock.inBank = true;
        changed = true;
        continue;
      }
      if (clock.inBank && now < clock.base + this.banks[seat]) continue;
      // Out of time: the bot moves for them.
      this.banks[seat] = 0;
      this.clocks.delete(seat);
      if (!this.game || legalActions(this.game, seat).length === 0) continue;
      // A timed-out human is auto-played at Club strength at least, so a Beginner table never punishes a lost connection with 1%-win play.
      const a = chooseAction(this.game, seat, { seed: `timeout:${seat}`, skill: this.botSkill === 'beginner' ? 'club' : this.botSkill }) ?? { type: 'pass' };
      this.apply(seat, a, 'timeout');
      return; // apply() re-arms clocks and may change phase
    }
    if (changed) this.broadcastState();
  }

  /** Deadline (ms) shown to a seat: base clock, or base + remaining bank once in the bank. */
  private deadlineFor(seat: number): number | null {
    const c = this.clocks.get(seat);
    if (!c) return null;
    return c.inBank ? c.base + this.banks[seat] : c.base;
  }

  /** Charge the bank for time spent past the base clock when a seat acts. */
  private settleClock(seat: number): void {
    const c = this.clocks.get(seat);
    if (!c) return;
    if (c.inBank) this.banks[seat] = Math.max(0, this.banks[seat] - (this.now() - c.base));
    this.clocks.delete(seat);
  }

  close(): void {
    for (const u of this.unsubs) u();
    this.transport.close();
  }

  // ----------------------------------------------------------------- routing

  private sendTo(peerId: string, msg: HostMessage): void {
    const local = this.localLinks.get(peerId);
    if (local) local(msg);
    else this.transport.send(peerId, msg);
  }

  private broadcast(build: (seat: SeatState) => HostMessage | null): void {
    for (const s of this.seats) {
      if (!s.peerId || s.isBot || !s.connected || s.peerId.startsWith('gone-')) continue;
      const msg = build(s);
      if (msg) this.sendTo(s.peerId, msg);
    }
  }

  private broadcastLobby(): void {
    this.broadcast(() => ({ t: 'lobby', seats: this.seatInfo() }));
    this.notify();
    this.emit('lobby');
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private handle(from: string, msg: ClientMessage): void {
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    switch (msg.t) {
      case 'join': {
        // Seat names reach every player at the table: cleaned like any other free text (see text.ts).
        const name = cleanText(msg.name, 24);
        const avatar = typeof msg.avatar === 'string' ? msg.avatar.slice(0, 8) : undefined;
        const wantSeat = Number.isInteger(msg.wantSeat) && (msg.wantSeat as number) >= 0 && (msg.wantSeat as number) <= 3 ? (msg.wantSeat as number) : undefined;
        const token = typeof msg.token === 'string' && /^[0-9a-f]{32}$/.test(msg.token) ? msg.token : undefined;
        const userId = typeof msg.userId === 'string' && /^[\w-]{6,64}$/.test(msg.userId) ? msg.userId : undefined;
        const have = Number.isInteger(msg.have) && (msg.have as number) >= -1 ? (msg.have as number) : undefined;
        return this.onJoin(from, name, avatar, wantSeat, token, userId, have);
      }
      case 'leave':
        return this.onLeave(from);
      case 'ping':
        return this.sendTo(from, { t: 'pong', at: msg.at, now: this.now() });
      default:
        break;
    }
    const seat = this.seats.find((s) => s.peerId === from);
    if (!seat) return this.sendTo(from, { t: 'error', code: 'not_seated', message: 'Join the table first.' });
    switch (msg.t) {
      case 'commit':
        if (this.phase !== 'commit' || seat.commit) return;
        if (typeof msg.hash !== 'string' || !/^[0-9a-f]{64}$/.test(msg.hash)) return this.sendTo(from, { t: 'error', code: 'bad_commit', message: 'Commitment must be a SHA-256 hex digest.' });
        seat.commit = msg.hash;
        return this.checkCeremony();
      case 'reveal':
        if (this.phase !== 'reveal' || seat.secret) return;
        // Only hex secrets go into a seed (see deriveSeed); anything else is refused here, never at the deal.
        if (!isSecret(msg.secret)) return this.sendTo(from, { t: 'error', code: 'bad_reveal', message: 'A secret must be lowercase hex.' });
        if (commitFor(msg.secret) !== seat.commit) return this.sendTo(from, { t: 'error', code: 'bad_reveal', message: 'Secret does not match your commitment.' });
        seat.secret = msg.secret;
        return this.checkCeremony();
      case 'start':
        if (this.phase !== 'lobby') return;
        if (this.pendingRestart) {
          // The table is waiting to deal its current hand again (a failed ceremony): a seated player may restart it.
          if (seat.connected && !seat.isBot) this.retryCeremony();
          return;
        }
        if (!this.mayControl(seat)) return this.refuseControl(from);
        try {
          this.start();
        } catch (e) {
          this.sendTo(from, { t: 'error', code: 'cannot_start', message: (e as Error).message });
        }
        return;
      case 'add_bot':
        if (this.phase !== 'lobby' || this.pendingRestart) return;
        if (!this.mayControl(seat)) return this.refuseControl(from);
        this.addBot();
        return;
      case 'action': {
        if (seat.isBot) return;
        // Every refusal echoes the turn the player acted on, so its client can tell which of its moves was refused.
        const turnCounter = Number.isInteger(msg.turnCounter) ? msg.turnCounter : undefined;
        if (this.phase !== 'playing' || !this.game) return this.sendTo(from, { t: 'error', code: 'not_playing', message: 'No hand in progress.', turnCounter });
        if (msg.seat !== seat.seat) return this.sendTo(from, { t: 'error', code: 'wrong_seat', message: 'You can only act for your own seat.', turnCounter });
        try {
          this.apply(seat.seat, msg.action, 'player');
        } catch (e) {
          this.sendTo(from, { t: 'error', code: 'illegal', message: (e as Error).message, turnCounter });
          this.sendTo(from, this.stateMsg(seat.seat));
        }
        return;
      }
      case 'ready':
        if (seat.isBot || this.phase !== 'hand_over') return;
        seat.ready = true;
        if (this.seats.every((s) => s.isBot || !s.connected || s.ready)) this.afterHand();
        return;
      case 'chat': {
        // No free text at the table: a chat frame carries a quick-phrase id and anything else is dropped.
        const text = msg.text;
        if (!isQuickChatId(text)) return;
        if (!this.takeToken(`chat:${seat.seat}`, CHAT_BUCKET)) return;
        return this.broadcast(() => ({ t: 'chat', seat: seat.seat, name: seat.name, text }));
      }
      case 'emote': {
        // Only a known emote id is relayed (whether the sender owns a paid pack is the server's check: apps/signal rooms.ts).
        const emote = msg.emote;
        if (!isTableEmoteId(emote)) return;
        if (!this.takeToken(`emote:${seat.seat}`, EMOTE_BUCKET)) return;
        return this.broadcast(() => ({ t: 'emote', seat: seat.seat, emote }));
      }
      default:
        return;
    }
  }

  /** Token bucket on the injected clock: false when the seat has used up its allowance. */
  private takeToken(key: string, rate: { capacity: number; perSecond: number }): boolean {
    const now = this.now();
    const b = this.buckets.get(key) ?? { tokens: rate.capacity, at: now };
    b.tokens = Math.min(rate.capacity, b.tokens + (Math.max(0, now - b.at) / 1000) * rate.perSecond);
    b.at = now;
    this.buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  private onJoin(from: string, name: string, avatar: string | undefined, wantSeat?: number, token?: string, userId?: string, have?: number): void {
    let seat = this.seats.find((s) => s.peerId === from && s.connected);
    let newOccupant = false;
    if (!seat && token) {
      // Reconnect with the rejoin token: at a table a device hosts, the only way to reclaim a seat. Names are public, and so are user ids there: neither is trusted.
      seat = this.seats.find((s) => s.token === token);
      if (seat && this.seatedElsewhere(userId, seat)) return this.refuseSecondSeat(from);
      if (seat) {
        if (seat.connected && seat.peerId && seat.peerId !== from) {
          // The token is live on another connection: kick the old one (the newest device wins, like PokerBros).
          this.sendTo(seat.peerId, { t: 'disconnected' });
        }
        seat.peerId = from;
      }
    }
    if (!seat && this.verifiedUserIds && userId) {
      // Where the user id is the account the server verified, the account itself reclaims its seat:
      // no token (a reinstall, another device) or one that no longer matches. Only ever the seat
      // bound to this very account; the connection that held it is told and dropped, as with a token.
      seat = this.seats.find((s) => !s.isBot && s.userId === userId);
      if (seat) {
        if (seat.connected && seat.peerId && seat.peerId !== from) this.sendTo(seat.peerId, { t: 'disconnected' });
        seat.peerId = from;
        // The old token is not what proved this join: it stops working and the welcome carries a new one.
        seat.token = undefined;
      }
    }
    if (!seat) {
      // Mid-match (or a restored table waiting for its players) only token holders may sit.
      if (this.phase !== 'lobby' || this.pendingRestart) return this.sendTo(from, { t: 'error', code: 'full', message: 'Match already in progress.' });
      if (this.seatedElsewhere(userId)) return this.refuseSecondSeat(from);
      seat = (wantSeat !== undefined && this.seats[wantSeat] && !this.seats[wantSeat].peerId && !this.seats[wantSeat].isBot ? this.seats[wantSeat] : undefined) ?? this.seats.find((s) => !s.peerId && !s.isBot);
      if (!seat) return this.sendTo(from, { t: 'error', code: 'full', message: 'Table is full.' });
      seat.peerId = from;
      newOccupant = true;
    }
    // Hosts serialised by older builds marked departed humans as bots named '… (away)'. A human binding to the seat takes it back.
    if (seat.isBot && seat.name.endsWith('(away)')) seat.isBot = false;
    seat.name = name || `Player ${seat.seat + 1}`;
    seat.avatar = avatar;
    seat.userId = userId ?? seat.userId;
    seat.connected = true;
    seat.left = undefined;
    // A new occupant never inherits a previous player's token (that would let the old player kick them).
    if (newOccupant || !seat.token) seat.token = randomHex(16);
    this.sendTo(from, { t: 'welcome', seat: seat.seat, roomCode: this.roomCode, rules: this.rules, seats: this.seatInfo(), matchId: this.matchId, token: seat.token });
    // A returning seat first gets the audits of the hands that ended without it, so its client can
    // check them and carry its record of the match forward to the hand now on the table.
    if (!newOccupant && have !== undefined) this.sendMissed(from, have);
    if (!newOccupant && this.restoredAt && this.phase !== 'match_over') this.sendTo(from, { t: 'restored', ...this.restoredAt });
    this.broadcastLobby();
    if (this.pendingRestart && this.anyHumanConnected()) {
      this.retryCeremony();
      return;
    }
    // The host made this seat's share while it was away: say so before anything else about the hand,
    // or the returning client would expect its own share in the audit.
    if (seat.supplied && this.phase !== 'lobby' && this.phase !== 'match_over') this.sendTo(from, { t: 'stand_in', handNumber: this.snapshot.handNumber, attempt: this.ceremonyAttempts });
    if (this.phase === 'playing' && this.game) {
      this.armClocks();
      this.sendTo(from, this.stateMsg(seat.seat));
      this.runBots();
    } else if (this.phase === 'hand_over' && this.game) {
      const last = this.audits[this.audits.length - 1];
      if (last) this.sendTo(from, { t: 'hand_over', result: this.game.result!, audit: last, view: viewFor(this.game, seat.seat), now: this.now() });
      if (this.deadline === null) this.deadline = this.now() + this.intermissionMs;
    }
    else if (this.phase === 'match_over' && this.game) {
      const finalView = { ...this.game, scores: this.snapshot.scores };
      this.sendTo(from, { t: 'match_over', scores: this.snapshot.scores, view: viewFor(finalView, seat.seat) });
    }
    else if (this.phase === 'commit' && !seat.commit) this.sendTo(from, { t: 'commit_request', handNumber: this.snapshot.handNumber, attempt: this.ceremonyAttempts });
    else if (this.phase === 'reveal' && !seat.secret) {
      // Clients refuse to reveal before they hold every commitment, so a returning seat gets them first.
      this.sendTo(from, { t: 'commits', handNumber: this.snapshot.handNumber, commits: this.commits() });
      this.sendTo(from, { t: 'reveal_request', handNumber: this.snapshot.handNumber });
    }
  }

  /** The audits of the hands after `have`, oldest first. The hand whose result is on show goes out as `hand_over` itself. */
  private sendMissed(peerId: string, have: number): void {
    const ended = this.phase === 'hand_over' ? this.audits.slice(0, -1) : this.audits;
    for (const audit of ended) if (audit.handNumber > have) this.sendTo(peerId, { t: 'hand_missed', audit });
  }

  /**
   * Whether this seated player may add bots or start the match (see `HostOptions.isController`).
   * A bot never asks; a human seat with no controller connected at the table may.
   */
  private mayControl(seat: SeatState): boolean {
    const accepts = this.isController;
    if (!accepts) return true;
    if (accepts(seat.userId)) return true;
    return !this.seats.some((s) => !s.isBot && s.connected && s.userId !== undefined && accepts(s.userId));
  }

  private refuseControl(from: string): void {
    this.sendTo(from, { t: 'error', code: 'not_controller', message: "Only the table's host or a club admin can add bots or start the match." });
  }

  /**
   * One seat per account: true when `userId` already holds a human seat other than `except`. Two
   * seats would show one player two concealed hands. Tables without accounts (local play) send no id.
   */
  private seatedElsewhere(userId: string | undefined, except?: SeatState): boolean {
    if (!userId) return false;
    return this.seats.some((s) => s !== except && !s.isBot && s.userId === userId && (s.peerId !== null || this.phase !== 'lobby'));
  }

  private refuseSecondSeat(from: string): void {
    this.sendTo(from, { t: 'error', code: 'already_seated', message: 'This account already has a seat at this table.' });
  }

  /**
   * A deliberate `leave`: the same as a lost connection, except the seat is marked as left on
   * purpose, so nobody tells the player their table is waiting for them.
   */
  private onLeave(peerId: string): void {
    const seat = this.seats.find((s) => s.peerId === peerId);
    if (!seat) return;
    if (this.phase !== 'lobby' || this.pendingRestart) seat.left = true;
    this.onDisconnect(peerId);
  }

  private onDisconnect(peerId: string): void {
    const seat = this.seats.find((s) => s.peerId === peerId);
    if (!seat) return;
    seat.connected = false;
    seat.peerId = this.phase === 'lobby' ? null : `gone-${peerId}`;
    if (this.phase === 'lobby' && !this.pendingRestart) {
      // Vacated lobby seat: forget everything about the previous occupant, including the rejoin token.
      Object.assign(seat, { peerId: null, name: '', token: undefined, ready: false, userId: undefined, avatar: undefined, commit: undefined, secret: undefined });
    } else if (this.phase === 'commit') {
      if (!seat.commit) this.supplyShare(seat);
      this.checkCeremony();
    } else if (this.phase === 'reveal') {
      if (!seat.secret) {
        this.restartCeremony([seat], 'disconnect');
        return;
      }
      this.checkCeremony();
    } else if (this.phase === 'playing') {
      // A bot plays for them until they come back.
      this.settleClock(seat.seat);
      this.runBots();
    } else if (this.phase === 'hand_over') {
      if (!this.anyHumanConnected()) this.deadline = null;
      else if (this.seats.every((s) => s.isBot || !s.connected || s.ready)) this.afterHand();
    }
    this.broadcastLobby();
  }

  /**
   * The host supplies this seat's random share because it missed the commit window. The seat stays
   * human and keeps playing; the audit still verifies (its own share simply was not used this hand).
   */
  private supplyShare(seat: SeatState, notify = true): void {
    seat.secret = makeSecret();
    seat.commit = commitFor(seat.secret);
    seat.supplied = true;
    if (notify) this.notifyStandIn(seat);
  }

  /** Tell a connected player their share was supplied. Must follow any commit_request so the client drops its own secret. */
  private notifyStandIn(seat: SeatState): void {
    if (seat.connected && seat.peerId && !seat.isBot && !seat.peerId.startsWith('gone-')) this.sendTo(seat.peerId, { t: 'stand_in', handNumber: this.snapshot.handNumber, attempt: this.ceremonyAttempts });
  }

  /**
   * Seats committed but never revealed, so no fair seed exists. Restart the ceremony; the
   * delinquent seats get host-supplied shares for the rest of this hand so they cannot stall the
   * table again, but they stay human and connected players keep receiving every message.
   */
  private restartCeremony(late: SeatState[], cause: RestartCause): void {
    // Seats register before beginHand so the next attempt already supplies their shares.
    this.prepareHandRecord();
    for (const s of late) this.standInSeats.add(s.seat);
    this.beginHand(cause, late.map((s) => s.seat));
  }

  /** Reset the per-hand ceremony record when the hand to deal is not the one it belongs to. */
  private prepareHandRecord(): boolean {
    const hand = this.snapshot.handNumber;
    if (hand === this.ceremonyHand) return false;
    this.ceremonyHand = hand;
    this.ceremonyAttempts = 0;
    this.restarts = [];
    this.standInSeats = new Set();
    return true;
  }

  /**
   * The ceremony cannot produce a seed this host is willing to deal from. Nobody is blamed: tell
   * the table and return to the lobby. The hand is tried again on a 'start' from a seated player,
   * on the next tick after a short pause while a player is connected, or when a player rejoins.
   */
  private failCeremony(message: string): void {
    this.broadcast(() => ({ t: 'error', code: 'ceremony_failed', message }));
    for (const s of this.seats) {
      s.commit = undefined;
      s.secret = undefined;
      s.supplied = undefined;
    }
    this.phase = 'lobby';
    this.pendingRestart = true;
    this.deadline = this.now() + CEREMONY_RETRY_MS;
    // The next attempt starts a fresh record; clients that saw these attempts will not pass its audit.
    this.ceremonyHand = -1;
    this.broadcastLobby();
  }

  /** Deal the waiting hand again after a failed or interrupted ceremony. */
  private retryCeremony(): void {
    this.pendingRestart = false;
    this.deadline = null;
    this.beginHand();
  }

  // ---------------------------------------------------------------- ceremony

  /**
   * Run the seed ceremony for the current hand. A repeat for the same hand number (a restart, or a
   * table restored mid-ceremony) is recorded in `restarts`; the counters reset only for a new hand.
   * Never runs while a hand is being played or after the match.
   */
  private beginHand(cause?: RestartCause, seats: number[] = []): void {
    if (this.phase !== 'lobby' && this.phase !== 'hand_over' && this.phase !== 'commit' && this.phase !== 'reveal') return;
    if (!this.prepareHandRecord() && this.ceremonyAttempts > 0) {
      this.restarts.push({ attempt: this.ceremonyAttempts, seats, cause: cause ?? 'host_restarted' });
    }
    this.ceremonyAttempts++;
    if (this.ceremonyAttempts > MAX_CEREMONY_ATTEMPTS) {
      this.failCeremony(`The deal could not be agreed after ${MAX_CEREMONY_ATTEMPTS} attempts.`);
      return;
    }
    this.phase = 'commit';
    this.clocks.clear();
    this.banks = [0, 1, 2, 3].map(() => this.rules.timeBankSeconds * 1000);
    this.hostSecret = makeSecret();
    this.hostCommit = commitFor(this.hostSecret);
    const supplied = this.standInSeats;
    for (const s of this.seats) {
      s.commit = undefined;
      s.secret = undefined;
      s.supplied = undefined;
      s.ready = false;
      if (s.isBot || !s.connected) {
        s.secret = makeSecret();
        s.commit = commitFor(s.secret);
        // A human who is away now gets the same notice on return as one stood in on purpose.
        if (!s.isBot) s.supplied = true;
      } else if (supplied.has(s.seat)) {
        this.supplyShare(s, false);
      }
    }
    this.deadline = this.now() + 10_000;
    const attempt = this.ceremonyAttempts;
    this.announcing(() => {
      this.broadcast(() => ({ t: 'commit_request', handNumber: this.snapshot.handNumber, attempt }));
      for (const n of supplied) this.notifyStandIn(this.seats[n]);
    });
    this.notify();
    this.checkCeremony();
  }

  /**
   * Send a round of ceremony messages without reacting to answers that arrive during it (an
   * in-process peer answers synchronously). Every seat then sees the same order: commit_request,
   * stand_in, commits, reveal_request.
   */
  private announcing(send: () => void): void {
    this.ceremonyBusy = true;
    try {
      send();
    } finally {
      this.ceremonyBusy = false;
    }
  }

  private checkCeremony(): void {
    if (this.ceremonyBusy) return;
    if (this.phase === 'commit') {
      if (this.seats.some((s) => !s.commit)) return;
      this.phase = 'reveal';
      this.deadline = this.now() + 10_000;
      const commits = this.commits();
      this.announcing(() => {
        this.broadcast(() => ({ t: 'commits', handNumber: this.snapshot.handNumber, commits }));
        this.broadcast(() => ({ t: 'reveal_request', handNumber: this.snapshot.handNumber }));
      });
      this.notify();
    }
    if (this.phase === 'reveal') {
      if (this.seats.some((s) => !s.secret)) return;
      const check = verifyReveals(this.commits(), this.reveals());
      if (!check.ok) {
        // Human reveals are checked on receipt and the rest are the host's own, so this is a host
        // fault: never pin it on a seat (that would let a host abort deals it dislikes).
        console.error(`ceremony: shares for seats ${check.badSeats.join(', ')} do not match their commitments`);
        this.failCeremony('The host could not verify its own shares for this deal.');
        return;
      }
      const seed = deriveSeed(`${this.matchId}:${this.snapshot.handNumber}`, this.reveals());
      this.game = dealFromSnapshot(this.snapshot, seed, this.rules);
      this.phase = 'playing';
      this.deadline = null;
      // A hand can be over at the deal (a flower win): publish it straight away.
      if (this.game.phase === 'ended') {
        this.clocks.clear();
        this.onHandOver();
        return;
      }
      this.armClocks();
      this.broadcastState();
      this.runBots();
    }
  }

  private commits(): Commitment[] {
    return [...this.seats.map((s) => ({ seat: s.seat, hash: s.commit! })), { seat: 4, hash: this.hostCommit }];
  }

  private reveals(): Reveal[] {
    return [...this.seats.map((s) => ({ seat: s.seat, secret: s.secret! })), { seat: 4, secret: this.hostSecret }];
  }

  // ----------------------------------------------------------------- playing

  private stateMsg(seat: number): HostMessage {
    const clock = this.clocks.get(seat);
    return {
      t: 'state',
      view: viewFor(this.game!, seat),
      hash: hashState(this.game!),
      deadline: this.deadlineFor(seat),
      timeBank: Math.round(this.banks[seat] / 1000),
      inTimeBank: clock?.inBank ?? false,
      now: this.now(),
    };
  }

  private broadcastState(): void {
    this.broadcast((s) => this.stateMsg(s.seat));
    this.notify();
    this.emit('state');
  }

  /** Start a clock for every connected human who owes an action and has none; drop clocks for seats that no longer act. */
  private armClocks(): void {
    if (!this.game || this.game.phase === 'ended') {
      this.clocks.clear();
      return;
    }
    for (const s of this.seats) {
      const owes = !s.isBot && s.connected && legalActions(this.game, s.seat).length > 0;
      if (owes && !this.clocks.has(s.seat)) this.clocks.set(s.seat, { base: this.now() + this.rules.turnSeconds * 1000, inBank: false });
      else if (!owes && this.clocks.has(s.seat)) this.settleClock(s.seat);
    }
  }

  private apply(seat: number, action: Action, source: 'player' | 'bot' | 'timeout'): void {
    if (!this.game) return;
    // The log says whether the seat's own player chose the move; its client checks that against what it sent.
    this.game = applyAction(this.game, seat, action, source === 'player' ? 'player' : 'auto');
    if (source === 'player') this.settleClock(seat);
    if (this.game.phase === 'ended') {
      this.clocks.clear();
      this.onHandOver();
      return;
    }
    this.armClocks();
    this.broadcastState();
    this.runBots();
  }

  /** Let bots (and stand-ins for disconnected humans) act until a human must move. */
  private runBots(): void {
    if (this.phase !== 'playing' || !this.game || this.botTimerArmed) return;
    const actor = this.seats.find((s) => (s.isBot || !s.connected) && legalActions(this.game!, s.seat).length > 0);
    if (!actor) return;
    const go = () => {
      this.botTimerArmed = false;
      if (this.phase !== 'playing' || !this.game) return;
      // The seat may have reconnected (or acted) while the timer was pending.
      if (!(actor.isBot || !actor.connected) || legalActions(this.game, actor.seat).length === 0) {
        this.runBots();
        return;
      }
      const a = chooseAction(this.game, actor.seat, { seed: `${this.matchId}:bot${actor.seat}`, skill: this.botSkill });
      if (a) this.apply(actor.seat, a, 'bot');
      else this.runBots();
    };
    if (this.botDelayMs > 0) {
      this.botTimerArmed = true;
      this.schedule(go, this.botDelayMs);
    } else go();
  }

  private onHandOver(): void {
    const game = this.game!;
    const audit: Audit = {
      matchId: this.matchId,
      handNumber: this.snapshot.handNumber,
      seed: game.seed,
      commits: this.commits(),
      reveals: this.reveals(),
      log: game.actionLog,
      finalHash: hashState(game),
      rngVersion: game.rngVersion,
      ceremonyAttempts: this.ceremonyAttempts,
      restarts: this.restarts.map((r) => ({ ...r, seats: r.seats.slice() })),
      restartReasons: this.restarts.map(describeRestart),
    };
    this.audits.push(audit);
    if (this.restoredAt?.handNumber === audit.handNumber) this.restoredAt = null;
    for (const w of game.result?.wins ?? []) this.wins[w.seat]++;
    this.phase = 'hand_over';
    for (const s of this.seats) s.ready = false;
    this.deadline = this.now() + this.intermissionMs;
    const now = this.now();
    this.broadcast((s) => ({ t: 'hand_over', result: game.result!, audit, view: viewFor(game, s.seat), now }));
    this.notify();
    this.emit('hand_over');
    // Nobody human is here to press "next": pause so a returning player finds the table where they left it.
    if (!this.anyHumanConnected()) this.deadline = null;
  }

  private anyHumanConnected(): boolean {
    return this.seats.some((s) => !s.isBot && s.connected);
  }

  private afterHand(): void {
    if (this.phase !== 'hand_over' || !this.game) return;
    this.snapshot = advanceMatch(this.game);
    if (this.snapshot.matchOver) {
      this.phase = 'match_over';
      this.deadline = null;
      const finalView = { ...this.game, scores: this.snapshot.scores };
      this.broadcast((s) => ({ t: 'match_over', scores: this.snapshot.scores, view: viewFor(finalView, s.seat) }));
      this.notify();
      this.emit('match_over');
      return;
    }
    this.beginHand();
  }

  /** Snapshot of match-level state (for the host UI). */
  match(): MatchSnapshot {
    return this.game && this.phase === 'playing' ? matchSnapshot(this.game) : this.snapshot;
  }

  /** Hands won per seat so far this match (a shared win counts for every winner). */
  handsWon(): number[] {
    return this.wins.slice();
  }
}

/** Display text for a restart (seats shown 1-based). */
function describeRestart(r: CeremonyRestart): string {
  const who = r.seats.map((s) => s + 1).join(', ');
  if (r.cause === 'no_reveal') return `seat ${who} did not reveal in time`;
  if (r.cause === 'disconnect') return `seat ${who} disconnected before revealing`;
  return 'the table restarted during the deal';
}
