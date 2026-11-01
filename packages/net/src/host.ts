/**
 * Authoritative table host. Runs on one player's phone (pure P2P) or on a
 * club-operated node (neutral host) — the code is identical.
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
  viewFor,
  type Action,
  type GameState,
  type MatchSnapshot,
  type RuleSet,
  type BotSkill,
} from '@mjm/engine';
import { commitFor, deriveSeed, makeSecret, verifyReveals, type Commitment, type Reveal } from './fairness';
import type { Audit, ClientMessage, HostMessage, SeatInfo } from './messages';
import type { Transport, Unsubscribe } from './transport';
import { randomHex } from './sha256';

export type HostPhase = 'lobby' | 'commit' | 'reveal' | 'playing' | 'hand_over' | 'match_over';

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
}

export interface HostEvent {
  type: 'hand_over' | 'match_over' | 'lobby' | 'state';
  roomCode: string;
  matchId: string;
  seats: SeatInfo[];
  scores: number[];
  handNumber: number;
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
}

interface SeatState extends SeatInfo {
  secret?: string;
  commit?: string;
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
  private restartReasons: string[] = [];

  constructor(
    private readonly transport: Transport,
    opts: HostOptions,
  ) {
    this.roomCode = opts.restore?.roomCode ?? opts.roomCode;
    this.rules = opts.restore?.rules ?? opts.rules ?? DEFAULT_RULES;
    this.matchId = opts.restore?.matchId ?? opts.matchId ?? randomHex(8);
    this.now = opts.now ?? (() => Date.now());
    this.botDelayMs = opts.botDelayMs ?? 0;
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
    this.fillWithBots = opts.fillWithBots ?? true;
    this.intermissionMs = (opts.intermissionSeconds ?? 12) * 1000;
    this.botNames = opts.botNames ?? DEFAULT_BOT_NAMES;
    this.botSkill = opts.botSkill ?? opts.restore?.botSkill ?? 'club';
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
    const ev: HostEvent = { type, roomCode: this.roomCode, matchId: this.matchId, seats: this.seatInfo(), scores: this.match().scores, handNumber: this.match().handNumber };
    for (const l of this.eventListeners) l(ev);
  }

  seatInfo(): SeatInfo[] {
    return this.seats.map(({ seat, name, peerId, isBot, connected, avatar, userId }, i) => ({ seat, name, peerId: peerId && peerId.startsWith('gone-') ? null : peerId, isBot, connected, avatar, userId, timeBank: Math.round(this.banks[i] / 1000) }));
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
      restartReasons: this.restartReasons.slice(),
    };
  }

  private restore(data: SerializedHost): void {
    this.phase = data.phase;
    this.game = data.game;
    this.snapshot = data.snapshot;
    this.seats = data.seats.map((s) => ({ ...s, peerId: null, connected: s.isBot }));
    this.banks = data.banks.slice();
    this.audits.push(...data.audits);
    this.hostSecret = data.hostSecret ?? '';
    this.hostCommit = data.hostCommit ?? '';
    this.ceremonyAttempts = data.ceremonyAttempts ?? 1;
    this.restartReasons = data.restartReasons?.slice() ?? [];
    // Any ceremony in flight cannot continue without the peers' secrets; restart it when they return.
    if (this.phase === 'commit' || this.phase === 'reveal') {
      for (const s of this.seats) {
        s.commit = undefined;
        s.secret = undefined;
      }
      this.phase = 'lobby';
      this.pendingRestart = true;
    }
    if (this.phase === 'playing') this.clocks.clear();
  }

  private pendingRestart = false;
  /** Seats whose share the host supplies in the next ceremony (they missed the window; they stay human). */
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
    this.broadcastLobby();
    return free.seat;
  }

  removeBot(seat: number): void {
    const s = this.seats[seat];
    if (!s.isBot || this.phase !== 'lobby') return;
    s.isBot = false;
    s.connected = false;
    s.name = '';
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
        this.restartCeremony(late, `seat ${late.map((s) => s.seat + 1).join(', ')} did not reveal in time`);
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
      const a = chooseAction(this.game, seat, { seed: `timeout:${seat}`, skill: this.botSkill }) ?? { type: 'pass' };
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
        const name = typeof msg.name === 'string' ? msg.name : '';
        const avatar = typeof msg.avatar === 'string' ? msg.avatar.slice(0, 8) : undefined;
        const wantSeat = Number.isInteger(msg.wantSeat) && (msg.wantSeat as number) >= 0 && (msg.wantSeat as number) <= 3 ? (msg.wantSeat as number) : undefined;
        const token = typeof msg.token === 'string' && /^[0-9a-f]{32}$/.test(msg.token) ? msg.token : undefined;
        const userId = typeof msg.userId === 'string' && /^[\w-]{6,64}$/.test(msg.userId) ? msg.userId : undefined;
        return this.onJoin(from, name, avatar, wantSeat, token, userId);
      }
      case 'leave':
        return this.onDisconnect(from);
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
        if (typeof msg.secret !== 'string' || msg.secret.length > 128) return;
        if (commitFor(msg.secret) !== seat.commit) return this.sendTo(from, { t: 'error', code: 'bad_reveal', message: 'Secret does not match your commitment.' });
        seat.secret = msg.secret;
        return this.checkCeremony();
      case 'start':
        if (this.phase !== 'lobby' || this.pendingRestart) return;
        try {
          this.start();
        } catch (e) {
          this.sendTo(from, { t: 'error', code: 'cannot_start', message: (e as Error).message });
        }
        return;
      case 'add_bot':
        if (this.phase !== 'lobby' || this.pendingRestart) return;
        this.addBot();
        return;
      case 'action':
        if (seat.isBot) return;
        if (this.phase !== 'playing' || !this.game) return this.sendTo(from, { t: 'error', code: 'not_playing', message: 'No hand in progress.' });
        if (msg.seat !== seat.seat) return this.sendTo(from, { t: 'error', code: 'wrong_seat', message: 'You can only act for your own seat.' });
        try {
          this.apply(seat.seat, msg.action, 'player');
        } catch (e) {
          this.sendTo(from, { t: 'error', code: 'illegal', message: (e as Error).message });
          this.sendTo(from, this.stateMsg(seat.seat));
        }
        return;
      case 'ready':
        if (seat.isBot || this.phase !== 'hand_over') return;
        seat.ready = true;
        if (this.seats.every((s) => s.isBot || !s.connected || s.ready)) this.afterHand();
        return;
      case 'chat':
        if (typeof msg.text !== 'string' || !msg.text.trim()) return;
        return this.broadcast(() => ({ t: 'chat', seat: seat.seat, name: seat.name, text: msg.text.slice(0, 280) }));
      case 'emote':
        if (typeof msg.emote !== 'string') return;
        return this.broadcast(() => ({ t: 'emote', seat: seat.seat, emote: msg.emote.slice(0, 16) }));
      default:
        return;
    }
  }

  private onJoin(from: string, name: string, avatar: string | undefined, wantSeat?: number, token?: string, userId?: string): void {
    let seat = this.seats.find((s) => s.peerId === from && s.connected);
    let newOccupant = false;
    if (!seat && token) {
      // Reconnect with the rejoin token — the only way to reclaim a seat. Names and user ids are public and never trusted.
      seat = this.seats.find((s) => s.token === token);
      if (seat) {
        if (seat.connected && seat.peerId && seat.peerId !== from) {
          // The token is live on another connection: kick the old one (the newest device wins, like PokerBros).
          this.sendTo(seat.peerId, { t: 'disconnected' });
        }
        seat.peerId = from;
      }
    }
    if (!seat) {
      // Mid-match (or a restored table waiting for its players) only token holders may sit.
      if (this.phase !== 'lobby' || this.pendingRestart) return this.sendTo(from, { t: 'error', code: 'full', message: 'Match already in progress.' });
      seat = (wantSeat !== undefined && this.seats[wantSeat] && !this.seats[wantSeat].peerId && !this.seats[wantSeat].isBot ? this.seats[wantSeat] : undefined) ?? this.seats.find((s) => !s.peerId && !s.isBot);
      if (!seat) return this.sendTo(from, { t: 'error', code: 'full', message: 'Table is full.' });
      seat.peerId = from;
      newOccupant = true;
    }
    // Hosts serialised by older builds marked departed humans as bots named '… (away)'. A human binding to the seat takes it back.
    if (seat.isBot && seat.name.endsWith('(away)')) seat.isBot = false;
    seat.name = name.slice(0, 24) || `Player ${seat.seat + 1}`;
    seat.avatar = avatar;
    seat.userId = userId ?? seat.userId;
    seat.connected = true;
    // A new occupant never inherits a previous player's token (that would let the old player kick them).
    if (newOccupant || !seat.token) seat.token = randomHex(16);
    this.sendTo(from, { t: 'welcome', seat: seat.seat, roomCode: this.roomCode, rules: this.rules, seats: this.seatInfo(), matchId: this.matchId, token: seat.token });
    this.broadcastLobby();
    if (this.pendingRestart && this.seats.some((s) => s.connected && !s.isBot)) {
      this.pendingRestart = false;
      this.beginHand();
      return;
    }
    if (this.phase === 'playing' && this.game) {
      this.armClocks();
      this.sendTo(from, this.stateMsg(seat.seat));
      this.runBots();
    } else if (this.phase === 'hand_over' && this.game) {
      const last = this.audits[this.audits.length - 1];
      if (last) this.sendTo(from, { t: 'hand_over', result: this.game.result!, audit: last, view: viewFor(this.game, seat.seat) });
      if (this.deadline === null) this.deadline = this.now() + this.intermissionMs;
    }
    else if (this.phase === 'match_over' && this.game) {
      const finalView = { ...this.game, scores: this.snapshot.scores };
      this.sendTo(from, { t: 'match_over', scores: this.snapshot.scores, view: viewFor(finalView, seat.seat) });
    }
    else if (this.phase === 'commit' && !seat.commit) this.sendTo(from, { t: 'commit_request', handNumber: this.snapshot.handNumber });
    else if (this.phase === 'reveal' && !seat.secret) this.sendTo(from, { t: 'reveal_request', handNumber: this.snapshot.handNumber });
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
        this.restartCeremony([seat], `seat ${seat.seat + 1} disconnected before revealing`);
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
    if (notify) this.notifyStandIn(seat);
  }

  /** Tell a connected player their share was supplied. Must follow any commit_request so the client drops its own secret. */
  private notifyStandIn(seat: SeatState): void {
    if (seat.connected && seat.peerId && !seat.isBot && !seat.peerId.startsWith('gone-')) this.sendTo(seat.peerId, { t: 'stand_in', handNumber: this.snapshot.handNumber });
  }

  /**
   * Seats committed but never revealed, so no fair seed exists. Restart the ceremony once; the
   * delinquent seats get host-supplied shares so they cannot stall the table again, but they stay
   * human and connected players keep receiving every message.
   */
  private restartCeremony(late: SeatState[], reason: string): void {
    for (const s of late) this.standInSeats.add(s.seat);
    this.beginHand(reason);
  }

  // ---------------------------------------------------------------- ceremony

  private beginHand(reason?: string): void {
    if (this.phase === 'commit' || this.phase === 'reveal') {
      this.ceremonyAttempts++;
      if (reason) this.restartReasons.push(reason);
    } else {
      this.ceremonyAttempts = 1;
      this.restartReasons = [];
    }
    this.phase = 'commit';
    this.clocks.clear();
    this.banks = [0, 1, 2, 3].map(() => this.rules.timeBankSeconds * 1000);
    this.hostSecret = makeSecret();
    this.hostCommit = commitFor(this.hostSecret);
    const supplied = this.standInSeats;
    this.standInSeats = new Set();
    for (const s of this.seats) {
      s.commit = undefined;
      s.secret = undefined;
      s.ready = false;
      if (s.isBot || !s.connected) {
        s.secret = makeSecret();
        s.commit = commitFor(s.secret);
      } else if (supplied.has(s.seat)) {
        this.supplyShare(s, false);
      }
    }
    this.deadline = this.now() + 10_000;
    this.broadcast(() => ({ t: 'commit_request', handNumber: this.snapshot.handNumber }));
    for (const n of supplied) this.notifyStandIn(this.seats[n]);
    this.notify();
    this.checkCeremony();
  }

  private checkCeremony(): void {
    if (this.phase === 'commit') {
      if (this.seats.some((s) => !s.commit)) return;
      this.phase = 'reveal';
      this.deadline = this.now() + 10_000;
      const commits = this.commits();
      this.broadcast(() => ({ t: 'commits', handNumber: this.snapshot.handNumber, commits }));
      this.broadcast(() => ({ t: 'reveal_request', handNumber: this.snapshot.handNumber }));
      this.notify();
    }
    if (this.phase === 'reveal') {
      if (this.seats.some((s) => !s.secret)) return;
      const check = verifyReveals(this.commits(), this.reveals());
      if (!check.ok) {
        this.restartCeremony(check.badSeats.filter((b) => b < 4).map((b) => this.seats[b]), `invalid reveal from seat ${check.badSeats.map((b) => b + 1).join(', ')}`);
        return;
      }
      const seed = deriveSeed(`${this.matchId}:${this.snapshot.handNumber}`, this.reveals());
      this.game = dealFromSnapshot(this.snapshot, seed, this.rules);
      this.phase = 'playing';
      this.deadline = null;
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
    this.game = applyAction(this.game, seat, action);
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
      restartReasons: this.restartReasons.slice(),
    };
    this.audits.push(audit);
    this.phase = 'hand_over';
    for (const s of this.seats) s.ready = false;
    this.deadline = this.now() + this.intermissionMs;
    this.broadcast((s) => ({ t: 'hand_over', result: game.result!, audit, view: viewFor(game, s.seat) }));
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
}
