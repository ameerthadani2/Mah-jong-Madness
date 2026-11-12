/**
 * Room registry and message routing, independent of the WebSocket layer so it
 * can be unit-tested. Rooms are identified by short codes players can read out
 * loud (PokerBros-style club/table codes).
 */
import { emotePackOf, isQuickChatId, isTableEmoteId, TableHost, type HostEvent, type SeatInfo, type SerializedHost, type Transport, type Unsubscribe } from '@mjm/net';
import { BOT_SKILLS, randomHex, sanitizeRules, type BotSkill, type RuleSet } from '@mjm/engine';
import { uniqueCode, type HexSource } from './codes';
import { LIMITS } from './config';
import { BucketTable, cleanField } from './limits';
import { QUEUE_MESSAGES, type QueueGate } from './matchmaking';
import { nameAllowed } from './moderation';
import type { LatencyWindow } from './metrics';

export interface Socket {
  send(json: string): void;
  /** Close the connection; `code` and `reason` go out in the close frame when given. */
  close(code?: number, reason?: string): void;
}

export type Inbound =
  | { t: 'hello'; auth?: unknown }
  | { t: 'create'; room?: string; hosted?: boolean; rules?: Partial<RuleSet>; botSkill?: BotSkill | string; club?: string }
  | { t: 'join'; room: string }
  | { t: 'to'; to: string; data: unknown }
  | { t: 'leave' }
  /** The client's heartbeat; answered with `{t:'pong'}`. */
  | { t: 'ping' }
  /** Ask for a quick match (matchmaking.ts); `preset` is reserved, only 'normal' exists. */
  | { t: 'queue'; preset?: string }
  | { t: 'leave_queue' };

interface Peer {
  id: string;
  socket: Socket;
  room: string | null;
  /** The account behind the socket, verified from its session token in `hello` (absent only without auth). */
  userId?: string;
  /** The session that proved `userId`; a logout or revocation of it closes the socket (see `endSessions`). */
  sessionId?: string;
  /** The client address the socket came from, for the per-IP create and join buckets (absent in unit tests). */
  ip?: string;
  /** The account's display name, cleaned and passed by the name check; when set it is the name the peer sits down under. */
  name?: string;
}

interface Room {
  code: string;
  host: string;
  peers: Set<string>;
  createdAt: number;
  /** Present when the server itself hosts the table (neutral host mode). */
  table?: { host: TableHost; transport: ServerTransport };
  /** A room with no peers stays alive until this time (refreshed while a human holds a seat). */
  keepAliveUntil?: number;
  /** Opened through the API or restored from a snapshot: kept alive even before anyone has sat down. */
  pinned?: boolean;
  /** The club this table belongs to; only its members may join. */
  clubCode?: string;
  /** The account that opened the table; counts towards that account's `maxTablesPerUser`. */
  createdBy?: string;
  /** Accounts the club took off this table: they may not come back to it. */
  evicted?: Set<string>;
  /**
   * A quick-match table: only these accounts may enter, and it starts by itself (see `autoStart`).
   * `emptySince` is when its last peer left (or when it was opened or restored), null while anyone
   * is connected: once started it closes `QUICK_ABANDONED_MS` after that.
   */
  quick?: { players: Set<string>; startBy: number; started: boolean; emptySince: number | null };
}

/**
 * Membership checks for club tables, supplied by the server (the registry knows nothing of clubs).
 * Every method is synchronous because the club registry keeps its clubs in memory.
 */
export interface ClubGate {
  /**
   * The rules a new table for this club should use (the house rules for a member) and its bots'
   * strength (the club's, replacing the opener's choice), or the reason the user may not open one.
   */
  openTable(clubCode: string, userId: string | undefined, rules: unknown): { rules: RuleSet; botSkill?: BotSkill } | { error: string };
  /** Called once the room exists, to list the table in the club. */
  tableOpened(clubCode: string, roomCode: string, userId: string, rules: RuleSet): void;
  /** True when the user is a full member of the club (pending requests do not count). */
  mayJoin(clubCode: string, userId: string | undefined): boolean;
  /** True when the user is the club's owner or an admin: they may add bots and start any of its tables. */
  isAdmin?(clubCode: string, userId: string | undefined): boolean;
}

export interface RoomEvent {
  room: string;
  event: HostEvent;
}

/** Sent whether a code does not exist or the room is full, so the reply does not reveal which codes are live. */
export const ROOM_UNAVAILABLE = 'Room not found or full';
/** The `code` on the error frame carrying `ROOM_UNAVAILABLE`, so a client can tell a dead table from a transient failure. */
export const ROOM_UNAVAILABLE_CODE = 'room_unavailable';
/** WebSocket close code for a socket whose session has ended (logout, revocation, deletion, expiry); the same code a bad `hello` gets. */
export const SESSION_ENDED = 4401;
/** WebSocket close code for a socket whose account a moderator banned (and for a banned account's `hello`). */
export const BANNED_CLOSE_CODE = 4403;
export const HOSTED_ONLY = 'Only server-hosted tables can be created';
/** Sent for a hosted create while `HOST_TABLES=0`, instead of quietly opening a relay-only room. */
export const HOSTED_DISABLED = 'Hosted tables are disabled';
/** Sent to the peers left in a relay-only room when its host leaves, as `{t:'error', code:'closed', message}`. */
export const ROOM_CLOSED = 'The host left, so the room has closed';
export const CREATE_COOLDOWN = 'Please wait a few seconds before creating another room';
export const JOIN_THROTTLED = 'Too many join attempts; please wait a few seconds';
export const SERVER_FULL = 'The server is full right now; please try again in a few minutes';
/** Sent when an account already has `maxTablesPerUser` tables open, as `{t:'error', code:'table_cap', message}`. */
export const TABLE_CAP = 'You already have the most tables open; finish or leave one first';
export const TABLE_CAP_CODE = 'table_cap';
/** Sent when a user who is not a full member of the club tries to open or join one of its tables. */
export const CLUB_MEMBERS_ONLY = 'Join the club first';
/** Sent to everyone at a club table its owner or an admin closed, as `{t:'error', code:'closed', message}`. */
export const TABLE_CLOSED_BY_CLUB = 'The club closed this table.';
/** Sent to a player the club took off a table, as `{t:'error', code:'closed', message}` (and `code:'evicted'` from the table). */
export const EVICTED_BY_CLUB = 'The club removed you from this table.';

/** How long a table with nobody connected is kept after its last activity while a human holds a seat. */
export const KEEP_ALIVE_MS = 15 * 60_000;

/**
 * Most peers one room can hold: the four seats plus spare places for players who drop out and
 * rejoin. A player who holds a human seat is always let back in, past this limit.
 */
const MAX_ROOM_PEERS = 12;
/**
 * Places at a hosted table for peers who hold no seat (onlookers, and players about to sit down).
 * An account has one of them at most, however many sockets it opens.
 */
const MAX_ROOM_WATCHERS = 4;
/** Sent to a watcher whose place a player needed, as `{t:'error', code:'closed', message}`. */
export const WATCHER_DROPPED = 'A player needed your place at this table; join again to sit down.';

/** Thrown by `createHostedRoom` when the server cannot open another table. */
export class RoomLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomLimitError';
  }
}

export function isBotSkill(v: unknown): v is BotSkill {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(BOT_SKILLS, v);
}

export interface RoomRegistryOptions {
  /** Let the server host tables itself. Unless `allowP2P` is set, these are the only rooms players can create. */
  allowHosted?: boolean;
  /** Allow rooms the server only relays, with a peer acting as host. For development and tests only. */
  allowP2P?: boolean;
  /** Maximum number of tables hosted at once (default 500). */
  maxHostedTables?: number;
  /** Maximum number of unfinished tables one account may have opened (default `DEFAULT_MAX_TABLES_PER_USER`). */
  maxTablesPerUser?: number;
  now?: () => number;
  /** Secure random source for room codes and peer ids. Injected in tests. */
  randomHex?: HexSource;
  /** Delay before a hosted table's bot acts (default 600 ms; 0 in tests). */
  botDelayMs?: number;
  /** Membership checks for club tables. Without it, a `create` naming a club is refused. */
  clubs?: ClubGate;
  /**
   * Records how long a hosted table takes from a player's action arriving to the resulting state
   * having been sent (the host handles an action and broadcasts synchronously). Shown on `/health`.
   */
  actionLatency?: LatencyWindow;
  /** High-resolution clock in milliseconds for `actionLatency` (default `performance.now`). */
  perfNow?: () => number;
  /** The quick-match queue (matchmaking.ts). Without it, `{t:'queue'}` is refused as unavailable. */
  queue?: QueueGate;
  /** Accounts whose chat lines and emotes are dropped at every table (a moderator's mute). */
  isMuted?: (userId: string | undefined) => boolean;
  /**
   * Who owns which paid emote pack. With it, an emote from a pack is relayed only when the
   * sender's account owns that pack; without it (tests of the relay alone) every known emote is.
   */
  emotePacks?: EmotePackGate;
}

/** Ownership of the paid emote packs, as the tables ask it (see `EmotePackOwners`). */
export interface EmotePackGate {
  /** Whether the account owns the pack (a product id such as `emotes.zodiac`); a promise while the answer is being read. */
  owns(userId: string, pack: string): boolean | Promise<boolean>;
  /** The account sat down at a table: have the answer ready before its first emote. */
  warm?(userId: string): void;
}

/** How long an account's emote packs are remembered. */
export const EMOTE_PACKS_TTL_MS = 60_000;
/** How soon a pack the account did not own is looked up again (so a pack bought mid-match works within seconds). */
export const EMOTE_PACKS_RECHECK_MS = 10_000;
/** Accounts remembered at most; the oldest answers go first. */
const EMOTE_PACKS_MAX = 20_000;

/**
 * Each account's emote packs, read once (from the wallet's cosmetics) and remembered for about a
 * minute, so an emote at the table does not cost a database round trip. A pack the account did
 * not own when last read is looked up again after `recheckMs`. When the read fails the last known
 * answer stands, and with none the emote is dropped.
 */
export class EmotePackOwners implements EmotePackGate {
  private readonly known = new Map<string, { packs: ReadonlySet<string>; at: number }>();
  private readonly reading = new Map<string, Promise<ReadonlySet<string>>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly recheckMs: number;

  constructor(
    private readonly load: (userId: string) => Promise<Iterable<string>>,
    opts: { now?: () => number; ttlMs?: number; recheckMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? EMOTE_PACKS_TTL_MS;
    this.recheckMs = opts.recheckMs ?? EMOTE_PACKS_RECHECK_MS;
  }

  owns(userId: string, pack: string): boolean | Promise<boolean> {
    const hit = this.known.get(userId);
    if (hit) {
      const age = this.now() - hit.at;
      if (age < (hit.packs.has(pack) ? this.ttlMs : this.recheckMs)) return hit.packs.has(pack);
    }
    return this.read(userId).then((packs) => packs.has(pack));
  }

  warm(userId: string): void {
    const hit = this.known.get(userId);
    if (!hit || this.now() - hit.at >= this.ttlMs) void this.read(userId);
  }

  /** Forget an account's answer (after a purchase, say). */
  forget(userId: string): void {
    this.known.delete(userId);
  }

  private read(userId: string): Promise<ReadonlySet<string>> {
    let reading = this.reading.get(userId);
    if (reading) return reading;
    reading = this.load(userId)
      .then((ids): ReadonlySet<string> => {
        const packs = new Set(ids);
        this.known.delete(userId);
        this.known.set(userId, { packs, at: this.now() });
        if (this.known.size > EMOTE_PACKS_MAX) this.known.delete(this.known.keys().next().value as string);
        return packs;
      })
      .catch((): ReadonlySet<string> => this.known.get(userId)?.packs ?? new Set<string>())
      .finally(() => this.reading.delete(userId));
    this.reading.set(userId, reading);
    return reading;
  }
}

export interface HostedRoomOptions {
  code?: string;
  rules?: unknown;
  botSkill?: unknown;
  keepAliveMs?: number;
  /** The club the table belongs to. */
  clubCode?: string;
  /**
   * The account opening the table. A new table is refused with `TABLE_CAP` once that account has
   * `maxTablesPerUser` unfinished tables; a restored one keeps its creator without the check.
   */
  createdBy?: string;
  /** Resume a table from its snapshot (after a restart). The room keeps the snapshot's code. */
  restore?: SerializedHost;
  /**
   * A quick-match table for these accounts: nobody else may enter it, no player may start it or
   * add bots, and it starts by itself once every one of them has sat down, or `startAfterMs`
   * after it opened with bots in the seats still empty (closed instead if nobody came).
   */
  quickMatch?: { players: string[]; startAfterMs?: number };
  /** Accounts taken off this table before a restart (from its snapshot): they still may not come back. */
  evicted?: string[];
}

/** How long a quick-match table waits for its players before it starts with bots in the empty seats. */
export const QUICK_START_MS = 15_000;
/**
 * How long a started quick-match table lives with none of its players connected. Much shorter
 * than `KEEP_ALIVE_MS`: nobody else can enter it, so once its humans are gone it is only bots
 * playing each other and a place taken from the server's table cap. The wait is for a player
 * whose connection dropped; when every player left on purpose the table closes at once.
 */
export const QUICK_ABANDONED_MS = 2 * 60_000;
/** Table frames a quick-match player may not send: the table starts itself and its bots are the server's. */
const QUICK_BLOCKED = new Set(['start', 'add_bot']);
/** Table frames a muted account's are dropped. */
const MUTED_BLOCKED = new Set(['chat', 'emote']);

/** Default for `RoomRegistryOptions.maxTablesPerUser` (`MAX_TABLES_PER_USER`). */
export const DEFAULT_MAX_TABLES_PER_USER = 3;

export class RoomRegistry {
  private readonly peers = new Map<string, Peer>();
  private readonly rooms = new Map<string, Room>();
  private readonly eventHandlers = new Set<(ev: RoomEvent) => void>();
  private readonly changeHandlers = new Set<(room: string) => void>();
  private readonly hex: HexSource;
  private closed = false;
  /**
   * Create and join allowances, kept per account (or per socket for a peer with no account) and
   * per client address, so reconnecting does not refill them and many guest accounts from one
   * address share one allowance.
   */
  private readonly createsByUser: BucketTable<string>;
  private readonly createsByIp: BucketTable<string>;
  private readonly joinsByUser: BucketTable<string>;
  private readonly joinsByIp: BucketTable<string>;
  constructor(private readonly opts: RoomRegistryOptions = {}) {
    this.hex = opts.randomHex ?? randomHex;
    const now = () => this.now();
    this.createsByUser = new BucketTable(1, 1000 / LIMITS.createCooldownMs, { now });
    this.createsByIp = new BucketTable(LIMITS.createsPerIpPerMinute, LIMITS.createsPerIpPerMinute / 60, { now });
    this.joinsByUser = new BucketTable(LIMITS.joinsPerWindow, (LIMITS.joinsPerWindow * 1000) / LIMITS.joinWindowMs, { now });
    this.joinsByIp = new BucketTable(LIMITS.joinsPerIpPerWindow, (LIMITS.joinsPerIpPerWindow * 1000) / LIMITS.joinWindowMs, { now });
  }

  /** Subscribe to events from server-hosted tables (for club standings). */
  onRoomEvent(cb: (ev: RoomEvent) => void): () => void {
    this.eventHandlers.add(cb);
    return () => this.eventHandlers.delete(cb);
  }

  /** Subscribe to every state change of a hosted table (for snapshots). Fires synchronously, often. */
  onTableChange(cb: (room: string) => void): () => void {
    this.changeHandlers.add(cb);
    return () => this.changeHandlers.delete(cb);
  }

  /**
   * Create a server-hosted room with no peers yet: a club table opened from the API, or a table
   * restored from its snapshot after a restart. A restored table keeps its code; if that code is
   * malformed or already live, this throws rather than resume the table under another code.
   */
  createHostedRoom(opts: HostedRoomOptions = {}): string {
    if (!this.opts.allowHosted) throw new RoomLimitError(HOSTED_DISABLED);
    if (this.hostedCount() >= this.maxHostedTables()) throw new RoomLimitError(SERVER_FULL);
    if (!opts.restore && opts.createdBy && this.openTablesOf(opts.createdBy) >= this.maxTablesPerUser()) throw new RoomLimitError(TABLE_CAP);
    const wanted = opts.restore ? opts.restore.roomCode : opts.code;
    const usable = typeof wanted === 'string' && /^[A-Z0-9]{4,8}$/.test(wanted) && !this.rooms.has(wanted);
    if (opts.restore && !usable) throw new Error(`Cannot restore table ${String(wanted)}: the code is malformed or in use`);
    const code = usable ? wanted : this.newCode();
    const room: Room = { code, host: '', peers: new Set(), createdAt: this.now(), keepAliveUntil: this.now() + (opts.keepAliveMs ?? KEEP_ALIVE_MS), pinned: true };
    if (opts.clubCode) room.clubCode = opts.clubCode.toUpperCase();
    if (opts.createdBy) room.createdBy = opts.createdBy;
    if (opts.evicted?.length) room.evicted = new Set(opts.evicted);
    if (opts.quickMatch) room.quick = { players: new Set(opts.quickMatch.players), startBy: this.now() + (opts.quickMatch.startAfterMs ?? QUICK_START_MS), started: false, emptySince: this.now() };
    this.attachTable(room, opts.rules, opts.botSkill, opts.restore);
    this.rooms.set(code, room);
    return code;
  }

  /**
   * Open a quick-match table for a matched group (decision 3): the default rules at Normal speed,
   * Club bots, restricted to these accounts, never a club table. It is not counted against
   * anyone's `maxTablesPerUser`; the queue keeps quick-match tables in bounds instead (one per
   * account at a time, `quickTableOf`, and each one charged like a create, `chargeQuickMatch`),
   * and a started one closes `QUICK_ABANDONED_MS` after its last player disconnected (at once
   * when they all left on purpose).
   */
  createQuickMatchRoom(players: string[], opts: { startAfterMs?: number } = {}): string {
    return this.createHostedRoom({ botSkill: 'club', quickMatch: { players, startAfterMs: opts.startAfterMs } });
  }

  /**
   * The unfinished quick-match table this account is still at, if any: one it holds a seat at
   * (connected or not), or one that has not started and is waiting for it to sit down. A seat the
   * player left on purpose (the table's `leave`, which the app sends when the player abandons the
   * match; a bot plays it from then on) does not count: that player may queue for another table, which
   * is charged like any other (`chargeQuickMatch`). A dropped connection is not a leave.
   */
  quickTableOf(userId: string): string | undefined {
    for (const r of this.rooms.values()) {
      if (!r.quick || !r.table || !r.quick.players.has(userId) || r.table.host.phase === 'match_over') continue;
      if (!r.quick.started || r.table.host.seatInfo().some((s) => !s.isBot && s.userId === userId && !s.left)) return r.code;
    }
    return undefined;
  }

  /**
   * Charge a quick-match table to the sockets it is opened for: one create from each account's
   * allowance and one from each distinct address (the same buckets a `create` spends). Returns
   * the peer ids that had none left; the queue keeps those waiting and seats the others.
   */
  chargeQuickMatch(peerIds: string[]): string[] {
    const refused: string[] = [];
    const byIp = new Map<string, string[]>();
    for (const id of peerIds) {
      const peer = this.peers.get(id);
      if (!peer) continue;
      if (!this.createsByUser.take(peer.userId ? `u:${peer.userId}` : `p:${peer.id}`)) refused.push(id);
      else if (peer.ip !== undefined) byIp.set(peer.ip, [...(byIp.get(peer.ip) ?? []), id]);
    }
    for (const [ip, ids] of byIp) if (!this.createsByIp.take(ip)) refused.push(...ids);
    return refused;
  }

  /**
   * Charge a table opened outside the socket (a club table over the HTTP API) like a `create`: one
   * from the account's allowance (one per `createCooldownMs`) and one from the address's
   * (`createsPerIpPerMinute`), the same buckets a socket `create` and a quick-match table spend.
   * False when either is spent; the caller answers 429 and opens nothing. Call it after every
   * other check that can refuse the table, so a refusal does not cost the next create. A table
   * `createHostedRoom` is about to refuse (hosting off, the server full, the account at its table
   * cap) is not charged either: that refusal is the answer.
   */
  chargeCreate(userId: string, ip?: string): boolean {
    if (!this.opts.allowHosted || this.hostedCount() >= this.maxHostedTables() || this.openTablesOf(userId) >= this.maxTablesPerUser()) return true;
    if (!this.createsByUser.take(`u:${userId}`)) return false;
    return ip === undefined || this.createsByIp.take(ip);
  }

  /** The accounts a quick-match table was opened for (undefined for any other room); for its snapshot. */
  quickPlayersOf(code: string): string[] | undefined {
    const quick = this.rooms.get(code.toUpperCase())?.quick;
    return quick ? [...quick.players] : undefined;
  }

  /** The accounts taken off a table, which may not come back to it (undefined when there are none); for its snapshot. */
  evictedOf(code: string): string[] | undefined {
    const evicted = this.rooms.get(code.toUpperCase())?.evicted;
    return evicted?.size ? [...evicted] : undefined;
  }

  /** Whether a room is a quick-match table. */
  isQuickMatch(code: string): boolean {
    return this.rooms.get(code.toUpperCase())?.quick !== undefined;
  }

  /**
   * Start a quick-match table once every matched player holds a connected seat, or at its
   * deadline with whoever came (bots take the other seats); with nobody there by then it closes.
   */
  private autoStart(room: Room): void {
    const quick = room.quick;
    const host = room.table?.host;
    if (!quick || quick.started || !host || !this.rooms.has(room.code)) return;
    if (host.phase !== 'lobby') {
      quick.started = true;
      return;
    }
    const seated = new Set(host.seatInfo().filter((s) => !s.isBot && s.connected && s.userId).map((s) => s.userId!));
    const everyone = [...quick.players].every((id) => seated.has(id));
    if (!everyone && this.now() < quick.startBy) return;
    quick.started = true;
    if (seated.size === 0) {
      this.closeRoom(room);
      return;
    }
    try {
      host.start();
    } catch {
      /* the table refused to start (it never should with bots to fill it) */
    }
  }

  /** Rules and bot skill come in from the network, so both are sanitised before the table sees them. */
  private attachTable(room: Room, rules: unknown, botSkill: unknown, restore?: SerializedHost): void {
    const transport = new ServerTransport(this, room.code, `server-${room.code}`);
    const host = new TableHost(transport, {
      roomCode: room.code,
      rules: sanitizeRules(rules),
      botDelayMs: this.opts.botDelayMs ?? 600,
      botSkill: isBotSkill(botSkill) ? botSkill : undefined,
      now: this.opts.now,
      restore,
      isController: this.controllersOf(room),
      // The user id in a table join is the account the socket's session proved (`bindUser`), never the client's claim: an account may take its own seat back without the rejoin token.
      verifiedUserIds: true,
    });
    host.onEvent((event) => {
      // While a human holds a seat (connected or not) the table lives 15 minutes past its last activity.
      // A room opened over the socket with nobody seated any more closes as soon as its last peer leaves.
      if (event.seats.some((s) => !s.isBot && s.name !== '')) room.keepAliveUntil = this.now() + KEEP_ALIVE_MS;
      else if (!room.pinned) room.keepAliveUntil = undefined;
      for (const h of this.eventHandlers) h({ room: room.code, event });
      // A player sat down at a quick-match table: start it once this frame has been handled.
      if (room.quick && !room.quick.started && event.type === 'lobby') queueMicrotask(() => this.autoStart(room));
    });
    host.onChange(() => {
      for (const h of this.changeHandlers) h(room.code);
    });
    room.table = { host, transport };
    room.host = transport.id;
  }

  /**
   * Who may add bots and start at this table (see `HostOptions.isController`): its opener, and at
   * a club table the club's owner and admins as the club says now. A table opened without an
   * account has no controllers (anyone seated may).
   */
  private controllersOf(room: Room): ((userId: string | undefined) => boolean) | undefined {
    if (!room.createdBy) return undefined;
    return (userId) => {
      if (!userId) return false;
      if (userId === room.createdBy) return true;
      return room.clubCode !== undefined && (this.opts.clubs?.isAdmin?.(room.clubCode, userId) ?? false);
    };
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private perfNow(): number {
    return (this.opts.perfNow ?? (() => performance.now()))();
  }

  private maxHostedTables(): number {
    return this.opts.maxHostedTables ?? 500;
  }

  private hostedCount(): number {
    let n = 0;
    for (const r of this.rooms.values()) if (r.table) n++;
    return n;
  }

  private maxTablesPerUser(): number {
    return this.opts.maxTablesPerUser ?? DEFAULT_MAX_TABLES_PER_USER;
  }

  /** Hosted tables this account opened that have not finished (a finished match no longer counts). */
  openTablesOf(userId: string): number {
    let n = 0;
    for (const r of this.rooms.values()) if (r.table && r.createdBy === userId && r.table.host.phase !== 'match_over') n++;
    return n;
  }

  /** Spend one token from the account's (or socket's) bucket and, when the address is known, the address's. */
  private allow(peer: Peer, byUser: BucketTable<string>, byIp: BucketTable<string>): boolean {
    if (!byUser.take(peer.userId ? `u:${peer.userId}` : `p:${peer.id}`)) return false;
    return peer.ip === undefined || byIp.take(peer.ip);
  }

  /**
   * For the socket layer, before it spends a database round trip on checking the session again:
   * when the allowance this `create`, `join` or `queue` needs is already spent, the peer is told
   * what `handle` would tell it and this returns true (the frame is done with). Nothing is taken.
   * A frame `handle` would refuse for another reason first (a full server, the table cap, a club's
   * answer) returns false and takes the usual path, so every reply stays what it was.
   */
  throttled(peerId: string, msg: Inbound): boolean {
    const peer = this.peers.get(peerId);
    if (!peer || this.closed || peer.id.startsWith('tmp-')) return false;
    const spent = (byUser: BucketTable<string>, byIp: BucketTable<string>): boolean =>
      !byUser.has(peer.userId ? `u:${peer.userId}` : `p:${peer.id}`) || (peer.ip !== undefined && !byIp.has(peer.ip));
    switch (msg.t) {
      case 'create': {
        if (typeof msg.club === 'string' && msg.club) return false;
        const hosted = msg.hosted === true;
        if (hosted ? !this.opts.allowHosted : !this.opts.allowP2P) return false;
        if (hosted && this.hostedCount() >= this.maxHostedTables()) return false;
        if (hosted && peer.userId && this.openTablesOf(peer.userId) >= this.maxTablesPerUser()) return false;
        if (!spent(this.createsByUser, this.createsByIp)) return false;
        this.error(peer, CREATE_COOLDOWN);
        return true;
      }
      case 'join':
        if (typeof msg.room !== 'string' || !spent(this.joinsByUser, this.joinsByIp)) return false;
        this.error(peer, JOIN_THROTTLED);
        return true;
      case 'queue':
        if (!this.opts.queue || !this.opts.allowHosted || !peer.userId || !spent(this.joinsByUser, this.joinsByIp)) return false;
        peer.socket.send(JSON.stringify({ t: 'queue_error', code: 'rate_limited', message: QUEUE_MESSAGES.rate_limited }));
        return true;
      default:
        return false;
    }
  }

  newCode(len = 6): string {
    return uniqueCode((c) => this.rooms.has(c), len, this.hex);
  }

  private newPeerId(prefix: string): string {
    let id = `${prefix}${this.hex(8)}`;
    while (this.peers.has(id)) id = `${prefix}${this.hex(8)}`;
    return id;
  }

  /** Register a new socket; `ip` is the client address (see `clientIp`), used for the per-address limits. */
  connect(socket: Socket, ip?: string): string {
    const id = this.newPeerId('tmp-');
    const peer: Peer = { id, socket, room: null };
    if (ip !== undefined) peer.ip = ip;
    this.peers.set(id, peer);
    return id;
  }

  private error(peer: Peer, message: string, code?: string): void {
    peer.socket.send(JSON.stringify(code ? { t: 'error', code, message } : { t: 'error', message }));
  }

  /**
   * Assign the peer its permanent id (once) and bind the account its session token proved. The
   * socket layer calls this after verifying `{t:'hello', auth}`; without auth, `handle` calls it
   * with no user. Ids are always server-assigned and never change for the life of the socket, so
   * a peer cannot impersonate a departed player or the server-side host ('server-…').
   */
  hello(peerId: string, userId?: string, sessionId?: string, name?: string): string {
    const peer = this.peers.get(peerId);
    if (!peer) return peerId;
    if (peerId.startsWith('tmp-')) {
      const id = this.newPeerId('p-');
      this.peers.delete(peerId);
      peer.id = id;
      this.peers.set(id, peer);
      if (userId) peer.userId = userId;
      if (sessionId) peer.sessionId = sessionId;
      this.setPeerName(id, name);
    }
    // `peerId` is the older name of `id`, kept for clients built before accounts.
    peer.socket.send(JSON.stringify({ t: 'hello', id: peer.id, peerId: peer.id, userId: peer.userId }));
    return peer.id;
  }

  /** The verified account behind a peer, if any. */
  peerUser(peerId: string): string | undefined {
    return this.peers.get(peerId)?.userId;
  }

  /**
   * The account's display name, as the socket layer last read it (at `hello` and before each
   * create or join). A peer with an account always sits down under it, or under the generated
   * default (`Player XXXX`) when the account has no name or the name check refuses it: whatever
   * name the client puts in its table `join` is ignored. Only a peer without an account (relay
   * tests and development) keeps the client's name, cleaned and checked the same way.
   */
  setPeerName(peerId: string, name: string | undefined): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    const clean = cleanField(name, SEAT_NAME_MAX);
    if (clean && nameAllowed(clean)) peer.name = clean;
    else delete peer.name;
  }

  /**
   * Close every socket whose session has ended (code 4401), so a logout, a revocation, an account
   * deletion or a merge takes effect at the table as well as on the API: by session, or every
   * session of a user except `exceptSessionId` (the caller's own, after a link). Returns how many
   * sockets were closed. The seats stay as they are: a player who signs in again reclaims one
   * with the rejoin token like any other reconnect.
   */
  endSessions(which: { sessionId?: string; userId?: string; exceptSessionId?: string }, close: { code: number; reason: string } = { code: SESSION_ENDED, reason: 'Session ended' }): number {
    let n = 0;
    for (const peer of [...this.peers.values()]) {
      if (!peer.sessionId && !peer.userId) continue;
      const bySession = which.sessionId !== undefined && peer.sessionId === which.sessionId;
      const byUser = which.userId !== undefined && peer.userId === which.userId && peer.sessionId !== which.exceptSessionId;
      if (!bySession && !byUser) continue;
      peer.socket.close(close.code, close.reason);
      n++;
    }
    return n;
  }

  /** Handle one inbound message from the peer currently known as `peerId`. Returns the (possibly renamed) peer id. */
  handle(peerId: string, msg: Inbound): string {
    const peer = this.peers.get(peerId);
    if (!peer || this.closed) return peerId;
    switch (msg.t) {
      case 'hello':
        return this.hello(peerId);
      case 'create': {
        if (peer.id.startsWith('tmp-')) return peer.id;
        const club = typeof msg.club === 'string' && msg.club ? msg.club.toUpperCase().slice(0, 8) : undefined;
        // A club table is always hosted by the server.
        const hosted = msg.hosted === true || club !== undefined;
        // A hosted request is never downgraded to a relay-only room the creator would host.
        if (hosted && !this.opts.allowHosted) {
          this.error(peer, HOSTED_DISABLED);
          return peer.id;
        }
        if (!hosted && !this.opts.allowP2P) {
          this.error(peer, HOSTED_ONLY);
          return peer.id;
        }
        if (hosted && this.hostedCount() >= this.maxHostedTables()) {
          this.error(peer, SERVER_FULL);
          return peer.id;
        }
        if (hosted && peer.userId && this.openTablesOf(peer.userId) >= this.maxTablesPerUser()) {
          this.error(peer, TABLE_CAP, TABLE_CAP_CODE);
          return peer.id;
        }
        let rules: unknown = msg.rules;
        let botSkill: unknown = msg.botSkill;
        if (club !== undefined) {
          // Checked before the cooldown, so a refusal does not cost the peer its next create.
          const gate = this.opts.clubs?.openTable(club, peer.userId, msg.rules) ?? { error: CLUB_MEMBERS_ONLY };
          if ('error' in gate) {
            this.error(peer, gate.error);
            return peer.id;
          }
          rules = gate.rules;
          if (gate.botSkill !== undefined) botSkill = gate.botSkill;
        }
        if (!this.allow(peer, this.createsByUser, this.createsByIp)) {
          this.error(peer, CREATE_COOLDOWN);
          return peer.id;
        }
        this.opts.queue?.leave(peer.id);
        this.leave(peer);
        const wanted = typeof msg.room === 'string' ? msg.room : undefined;
        const code = wanted && /^[A-Z0-9]{4,8}$/.test(wanted) && !this.rooms.has(wanted) ? wanted : this.newCode();
        const room: Room = { code, host: peer.id, peers: new Set([peer.id]), createdAt: this.now() };
        if (club !== undefined) room.clubCode = club;
        if (hosted && peer.userId) room.createdBy = peer.userId;
        if (hosted) this.attachTable(room, rules, botSkill);
        this.rooms.set(code, room);
        peer.room = code;
        if (club !== undefined && peer.userId && room.table) {
          try {
            this.opts.clubs?.tableOpened(club, code, peer.userId, room.table.host.rules);
          } catch (e) {
            // The club refused the listing after all (a cap reached in the meantime): no unlisted club table is left open.
            peer.room = null;
            this.closeRoom(room);
            this.error(peer, (e as Error).message);
            return peer.id;
          }
        }
        this.sendRoom(peer, room);
        return peer.id;
      }
      case 'join': {
        if (peer.id.startsWith('tmp-') || typeof msg.room !== 'string') return peer.id;
        if (!this.allow(peer, this.joinsByUser, this.joinsByIp)) {
          this.error(peer, JOIN_THROTTLED);
          return peer.id;
        }
        const room = msg.room.length <= 8 ? this.rooms.get(msg.room.toUpperCase()) : undefined;
        if (!room || !this.hasPlaceFor(room, peer)) {
          this.error(peer, ROOM_UNAVAILABLE, ROOM_UNAVAILABLE_CODE);
          return peer.id;
        }
        if (room.clubCode && !(this.opts.clubs?.mayJoin(room.clubCode, peer.userId) ?? false)) {
          this.error(peer, CLUB_MEMBERS_ONLY);
          return peer.id;
        }
        if (peer.userId && room.evicted?.has(peer.userId)) {
          this.error(peer, ROOM_UNAVAILABLE, ROOM_UNAVAILABLE_CODE);
          return peer.id;
        }
        // A quick-match table is only for the players it was opened for (no onlookers either).
        if (room.quick && !(peer.userId && room.quick.players.has(peer.userId))) {
          this.error(peer, ROOM_UNAVAILABLE, ROOM_UNAVAILABLE_CODE);
          return peer.id;
        }
        this.opts.queue?.leave(peer.id);
        this.leave(peer);
        this.makeRoomFor(room, peer);
        room.peers.add(peer.id);
        if (room.quick) room.quick.emptySince = null;
        peer.room = room.code;
        this.sendRoom(peer, room);
        this.broadcast(room, { t: 'peer', peerId: peer.id, event: 'join' }, peer.id);
        return peer.id;
      }
      case 'to': {
        const room = peer.room ? this.rooms.get(peer.room) : undefined;
        if (!room || typeof msg.to !== 'string') return peer.id;
        const to = msg.to;
        if (room.table && to === room.table.transport.id) {
          const timed = this.opts.actionLatency && isAction(msg.data);
          const t0 = timed ? this.perfNow() : 0;
          const t = tableFrameType(msg.data);
          if (room.quick && t !== undefined && QUICK_BLOCKED.has(t)) return peer.id;
          if (t !== undefined && MUTED_BLOCKED.has(t) && this.opts.isMuted?.(peer.userId)) return peer.id;
          // No free text: only a quick-phrase id or a known emote id goes on to the table.
          if (t === 'chat' && !isQuickChatId(tableFrameField(msg.data, 'text'))) return peer.id;
          if (t === 'emote' && !this.mayEmote(peer, room, msg.data)) return peer.id;
          const data = bindUser(msg.data, peer.userId, peer.name);
          if (t === 'join' && peer.userId) this.opts.emotePacks?.warm?.(peer.userId);
          room.table.transport.receive(peer.id, data);
          if (timed) this.opts.actionLatency!.record(this.perfNow() - t0);
          return peer.id;
        }
        if (!room.peers.has(to)) return peer.id;
        this.peers.get(to)?.socket.send(JSON.stringify({ t: 'from', from: peer.id, data: msg.data }));
        return peer.id;
      }
      case 'leave':
        this.leave(peer);
        return peer.id;
      case 'ping':
        peer.socket.send(PONG);
        return peer.id;
      case 'queue': {
        if (peer.id.startsWith('tmp-')) return peer.id;
        const refuse = (code: keyof typeof QUEUE_MESSAGES) => peer.socket.send(JSON.stringify({ t: 'queue_error', code, message: QUEUE_MESSAGES[code] }));
        if (!this.opts.queue || !this.opts.allowHosted) return (refuse('unavailable'), peer.id);
        if (!peer.userId) return (refuse('sign_in'), peer.id);
        // The same per-account and per-address allowance as joining a table.
        if (!this.allow(peer, this.joinsByUser, this.joinsByIp)) return (refuse('rate_limited'), peer.id);
        const socket = peer.socket;
        void this.opts.queue.enqueue({ peerId: peer.id, userId: peer.userId, send: (m) => socket.send(JSON.stringify(m)) });
        return peer.id;
      }
      case 'leave_queue':
        this.opts.queue?.leave(peer.id);
        return peer.id;
      default:
        return peer.id;
    }
  }

  /**
   * Whether an `emote` frame goes on to the table now: a free emote always, an emote from a paid
   * pack only when the sender's account owns the pack. While ownership is still being read the
   * frame waits for the answer and is delivered then (if the peer is still at the table).
   */
  private mayEmote(peer: Peer, room: Room, data: unknown): boolean {
    const emote = tableFrameField(data, 'emote');
    if (!isTableEmoteId(emote)) return false;
    const pack = emotePackOf(emote);
    const gate = this.opts.emotePacks;
    if (!pack || !gate) return true;
    if (!peer.userId) return false;
    const owns = gate.owns(peer.userId, pack);
    if (typeof owns === 'boolean') return owns;
    owns.then(
      (ok) => {
        if (ok && !this.closed && peer.room === room.code && this.rooms.get(room.code) === room) room.table?.transport.receive(peer.id, data);
      },
      () => undefined,
    );
    return false;
  }

  disconnect(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.opts.queue?.leave(peerId);
    this.leave(peer);
    this.peers.delete(peerId);
  }

  private leave(peer: Peer): void {
    if (!peer.room) return;
    const room = this.rooms.get(peer.room);
    peer.room = null;
    if (!room) return;
    room.peers.delete(peer.id);
    this.broadcast(room, { t: 'peer', peerId: peer.id, event: 'leave' });
    room.table?.transport.peerLeft(peer.id);
    // The host role never passes to another peer. A guest promoted to host would hold none of
    // the table's state and could rewrite the game. A relay-only room closes when its host leaves,
    // and the peers still in it are told so and released to create or join another room.
    if (!room.table && peer.id === room.host) {
      const closed = JSON.stringify({ t: 'error', code: 'closed', message: ROOM_CLOSED });
      for (const id of room.peers) {
        const other = this.peers.get(id);
        if (!other) continue;
        other.room = null;
        other.socket.send(closed);
      }
      room.peers.clear();
      this.closeRoom(room);
      return;
    }
    if (room.peers.size === 0) {
      if (room.quick) room.quick.emptySince = this.now();
      if (room.keepAliveUntil !== undefined && room.keepAliveUntil > this.now()) {
        // Give players time to come back (bots play for them, or the table pauses between hands).
        room.keepAliveUntil = this.now() + KEEP_ALIVE_MS;
      } else this.closeRoom(room);
    }
  }

  /**
   * Whether `peer` may enter `room`: always when its account holds a human seat there (a player
   * coming back after a drop). Otherwise it would be a watcher, a peer without a seat, and an
   * account gets one watcher place however many sockets it opens: a second one is refused. While
   * the table is in its lobby with a seat still open, a would-be player is always admitted (if the
   * room is at its limit, `makeRoomFor` gives it the place of the longest-idle watcher), so idle
   * sockets can never keep invited players out. Past that, the room holds `MAX_ROOM_PEERS` peers
   * and a hosted table `MAX_ROOM_WATCHERS` watchers.
   */
  private hasPlaceFor(room: Room, peer: Peer): boolean {
    if (room.peers.has(peer.id)) return true;
    const host = room.table?.host;
    if (!host) return room.peers.size < MAX_ROOM_PEERS;
    const seats = host.seatInfo();
    if (peer.userId && seats.some((s) => !s.isBot && s.userId === peer.userId)) return true;
    const watchers = this.watchersOf(room, seats);
    const key = watcherKey(peer);
    if (watchers.some((w) => watcherKey(w) === key)) return false;
    if (host.phase === 'lobby' && seats.some(isOpenSeat)) return true;
    if (room.peers.size >= MAX_ROOM_PEERS) return false;
    return watchers.length < MAX_ROOM_WATCHERS;
  }

  /** The peers in a hosted room that hold no seat, longest in the room first. */
  private watchersOf(room: Room, seats: SeatInfo[]): Peer[] {
    const seated = new Set(seats.filter((s) => !s.isBot && s.peerId).map((s) => s.peerId));
    const watchers: Peer[] = [];
    for (const id of room.peers) {
      const p = seated.has(id) ? undefined : this.peers.get(id);
      if (p) watchers.push(p);
    }
    return watchers;
  }

  /**
   * Called once `peer` is certain to enter `room`: when the room is at `MAX_ROOM_PEERS` (only a
   * would-be player coming to a lobby with an open seat, or a seated player coming back, gets this
   * far then), the watchers that have been there longest without sitting down are told
   * (`{t:'error', code:'closed', message: WATCHER_DROPPED}`) and leave the room, so many idle
   * accounts cannot fill a table's room either.
   */
  private makeRoomFor(room: Room, peer: Peer): void {
    if (!room.table || room.peers.has(peer.id) || room.peers.size < MAX_ROOM_PEERS) return;
    const dropped = JSON.stringify({ t: 'error', code: 'closed', message: WATCHER_DROPPED });
    for (const w of this.watchersOf(room, room.table.host.seatInfo())) {
      if (room.peers.size < MAX_ROOM_PEERS) break;
      if (w.id === peer.id) continue;
      w.socket.send(dropped);
      this.leave(w);
    }
  }

  private sendRoom(peer: Peer, room: Room): void {
    const peers = [...room.peers];
    if (room.table) peers.push(room.table.transport.id);
    peer.socket.send(JSON.stringify({ t: 'room', room: room.code, peers, host: room.host }));
  }

  /** @internal */
  broadcast(room: Room, msg: unknown, except?: string): void {
    const json = JSON.stringify(msg);
    for (const id of room.peers) if (id !== except) this.peers.get(id)?.socket.send(json);
  }

  /** @internal used by ServerTransport */
  sendFromServer(roomCode: string, serverId: string, to: string, data: unknown): void {
    const room = this.rooms.get(roomCode);
    if (!room || !room.peers.has(to)) return;
    this.peers.get(to)?.socket.send(JSON.stringify({ t: 'from', from: serverId, data: { ch: 'game', msg: data } }));
  }

  roomPeers(code: string): string[] {
    return [...(this.rooms.get(code)?.peers ?? [])];
  }

  stats(): { peers: number; rooms: number; hostedTables: number } {
    return { peers: this.peers.size, rooms: this.rooms.size, hostedTables: this.hostedCount() };
  }

  private closeRoom(room: Room): void {
    room.table?.host.close();
    this.rooms.delete(room.code);
    for (const h of this.eventHandlers) h({ room: room.code, event: { type: 'match_over', roomCode: room.code, matchId: room.table?.host.matchId ?? '', seats: room.table?.host.seatInfo() ?? [], scores: room.table?.host.match().scores ?? [], handNumber: -1, handsWon: room.table?.host.handsWon() ?? [0, 0, 0, 0] } });
  }

  /** Drive hosted tables' timers and expire abandoned API-created rooms. */
  tick(): void {
    for (const r of [...this.rooms.values()]) {
      if (r.quick && !r.quick.started) this.autoStart(r);
      if (!this.rooms.has(r.code)) continue;
      r.table?.host.tick();
      if (r.peers.size !== 0) continue;
      // A started quick-match table with nobody connected: two minutes for a player who dropped to
      // come back, and none at all when every player walked away on purpose.
      const abandoned = r.quick?.started && r.quick.emptySince !== null && (this.now() - r.quick.emptySince >= QUICK_ABANDONED_MS || !r.table?.host.seatInfo().some((s) => !s.isBot && !s.left));
      if (abandoned || (r.keepAliveUntil !== undefined && r.keepAliveUntil <= this.now())) this.closeRoom(r);
    }
  }

  hasRoom(code: string): boolean {
    return this.rooms.has(code.toUpperCase());
  }

  closeRoomByCode(code: string): void {
    const room = this.rooms.get(code.toUpperCase());
    if (room) this.closeRoom(room);
  }

  /**
   * A club owner or admin closed this table: everyone in the room is told (`{t:'error',
   * code:'closed', message}` from the server, and `{t:'error', code:'table_closed'}` from the
   * table to each seated player) and released, then the table ends at once. Nothing is added to
   * the standings (the close reports the room as gone, not as a finished match). False when no
   * such room is live.
   */
  closeTable(code: string, message = TABLE_CLOSED_BY_CLUB): boolean {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return false;
    room.table?.host.notifySeated({ t: 'error', code: 'table_closed', message });
    const closed = JSON.stringify({ t: 'error', code: 'closed', message });
    for (const id of room.peers) {
      const peer = this.peers.get(id);
      if (!peer) continue;
      peer.room = null;
      peer.socket.send(closed);
    }
    room.peers.clear();
    this.closeRoom(room);
    return true;
  }

  /**
   * Take an account off a table (a club owner's eviction, a removed or banned member): its seat is
   * played by the table's bot to the end of the match (freed in the lobby), each of its sockets in
   * the room is told (`{t:'error', code:'closed', message}`) and leaves, and it may not come back
   * to this table, after a restart either (the evicted accounts are written with the table's
   * snapshot). Returns how many seats it held.
   */
  evictFromTable(code: string, userId: string, message = EVICTED_BY_CLUB): number {
    const room = this.rooms.get(code.toUpperCase());
    if (!room) return 0;
    (room.evicted ??= new Set()).add(userId);
    const seats = room.table?.host.evictUser(userId, message) ?? [];
    const closed = JSON.stringify({ t: 'error', code: 'closed', message });
    for (const id of [...room.peers]) {
      const peer = this.peers.get(id);
      if (!peer || peer.userId !== userId) continue;
      peer.socket.send(closed);
      this.leave(peer);
    }
    // The eviction is part of the table's snapshot, also when the account held no seat.
    if (room.table && this.rooms.has(room.code)) for (const h of this.changeHandlers) h(room.code);
    return seats.length;
  }

  /** Every live table of this club (for owner actions on a member). */
  clubRooms(clubCode: string): string[] {
    const club = clubCode.toUpperCase();
    return [...this.rooms.values()].filter((r) => r.clubCode === club).map((r) => r.code);
  }

  hostedTable(code: string): TableHost | undefined {
    return this.rooms.get(code)?.table?.host;
  }

  /** The club a room belongs to, if any. */
  clubOf(code: string): string | undefined {
    return this.rooms.get(code)?.clubCode;
  }

  /** The account that opened a room, if known. */
  createdByOf(code: string): string | undefined {
    return this.rooms.get(code)?.createdBy;
  }

  /** Codes of every table the server is hosting. */
  hostedRooms(): string[] {
    return [...this.rooms.values()].filter((r) => r.table).map((r) => r.code);
  }

  /** When an empty room will be closed (for tests and diagnostics). */
  keepAliveUntil(code: string): number | undefined {
    return this.rooms.get(code)?.keepAliveUntil;
  }

  /**
   * Stop taking input for a restart: every frame that arrives from now on is dropped (never
   * acknowledged), while the tables stay as they are so they can be written one last time.
   * `shutdown()` then closes them.
   */
  freeze(): void {
    this.closed = true;
  }

  /**
   * Stop for a restart: close every table without reporting it as finished (the snapshots stay
   * restorable and club listings stay open), and ignore everything that arrives afterwards.
   */
  shutdown(): void {
    this.closed = true;
    const rooms = [...this.rooms.values()];
    this.rooms.clear();
    for (const peer of this.peers.values()) peer.room = null;
    for (const r of rooms) r.table?.host.close();
  }
}

/** The `t` of a table frame (`{ch:'game', msg:{t}}`), if it is one. */
function tableFrameType(data: unknown): string | undefined {
  const env = data as { ch?: unknown; msg?: { t?: unknown } } | null;
  if (!env || typeof env !== 'object' || env.ch !== 'game' || !env.msg || typeof env.msg !== 'object') return undefined;
  return typeof env.msg.t === 'string' ? env.msg.t : undefined;
}

/** One field of a table frame's message (`{ch:'game', msg:{[field]}}`). */
function tableFrameField(data: unknown, field: string): unknown {
  return (data as { msg?: Record<string, unknown> } | null)?.msg?.[field];
}

/** A game action for the table (`{ch:'game', msg:{t:'action'}}`). */
function isAction(data: unknown): boolean {
  const env = data as { ch?: unknown; msg?: { t?: unknown } } | null;
  return !!env && typeof env === 'object' && env.ch === 'game' && !!env.msg && typeof env.msg === 'object' && env.msg.t === 'action';
}

const PONG = JSON.stringify({ t: 'pong' });

/** What a peer without a seat counts as among a table's watchers: its account, or the socket itself without one. */
function watcherKey(peer: Peer): string {
  return peer.userId ? `u:${peer.userId}` : `p:${peer.id}`;
}

/** A seat nobody holds: not a bot's, no connection, and no player (connected or away) bound to it. */
function isOpenSeat(s: SeatInfo): boolean {
  return !s.isBot && !s.peerId && !s.userId && s.name === '';
}

/** Longest seat name and avatar id the table keeps. */
const SEAT_NAME_MAX = 24;
const AVATAR_MAX = 8;

/** The seat name of an account that has no usable display name: `Player` and the first four hex digits of its id. */
export function defaultSeatName(userId: string): string {
  return `Player ${userId.replace(/-/g, '').slice(0, 4).toUpperCase()}`;
}

/**
 * The table's `join` carries the verified account, never the one the client claims, so the host
 * (which reads `msg.userId`) binds the seat to the user the session proved. An unauthenticated
 * peer's claim is dropped. An account's seat name is its display name (`accountName`, already
 * cleaned and checked by `setPeerName`) or the generated default, never the name in the frame;
 * a peer without an account keeps the frame's name, cleaned like every other piece of free text
 * (a NUL in a seat name used to stop the table's snapshot being saved) and dropped when the name
 * check refuses it. Avatars are cleaned too.
 */
function bindUser(data: unknown, userId: string | undefined, accountName?: string): unknown {
  const env = data as { ch?: unknown; msg?: unknown } | null;
  if (!env || typeof env !== 'object' || env.ch !== 'game' || !env.msg || typeof env.msg !== 'object') return data;
  const t = (env.msg as { t?: unknown }).t;
  if (t !== 'join') return data;
  const msg: Record<string, unknown> = { ...(env.msg as Record<string, unknown>) };
  if (userId) msg.userId = userId;
  else delete msg.userId;
  let name = accountName || (userId ? defaultSeatName(userId) : '');
  if (!name && typeof msg.name === 'string') {
    const claimed = cleanField(msg.name, SEAT_NAME_MAX);
    if (claimed && nameAllowed(claimed)) name = claimed;
  }
  if (name) msg.name = name;
  else delete msg.name;
  if (typeof msg.avatar === 'string') {
    const avatar = cleanField(msg.avatar, AVATAR_MAX);
    if (avatar) msg.avatar = avatar;
    else delete msg.avatar;
  }
  return { ...env, msg };
}

/** Transport for a table hosted by the server itself: a virtual peer inside the room. */
export class ServerTransport implements Transport {
  private readonly msgHandlers = new Set<(from: string, msg: unknown) => void>();
  private readonly peerHandlers = new Set<(peerId: string, event: 'join' | 'leave') => void>();
  constructor(
    private readonly registry: RoomRegistry,
    private readonly roomCode: string,
    public readonly id: string,
  ) {}
  send(to: string, msg: unknown): void {
    this.registry.sendFromServer(this.roomCode, this.id, to, msg);
  }
  onMessage(cb: (from: string, msg: unknown) => void): Unsubscribe {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }
  onPeer(cb: (peerId: string, event: 'join' | 'leave') => void): Unsubscribe {
    this.peerHandlers.add(cb);
    return () => this.peerHandlers.delete(cb);
  }
  peers(): string[] {
    return this.registry.roomPeers(this.roomCode);
  }
  close(): void {
    this.msgHandlers.clear();
    this.peerHandlers.clear();
  }
  /** @internal */
  receive(from: string, data: unknown): void {
    const env = data as { ch?: string; msg?: unknown };
    if (!env || typeof env !== 'object' || env.ch !== 'game') return;
    for (const h of this.msgHandlers) {
      try {
        h(from, env.msg);
      } catch {
        /* a misbehaving peer must not break the table for others */
      }
    }
  }
  /** @internal */
  peerLeft(peerId: string): void {
    for (const h of this.peerHandlers) h(peerId, 'leave');
  }
}
