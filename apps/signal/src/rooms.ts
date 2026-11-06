/**
 * Room registry and message routing, independent of the WebSocket layer so it
 * can be unit-tested. Rooms are identified by short codes players can read out
 * loud (PokerBros-style club/table codes).
 */
import { TableHost, type HostEvent, type SerializedHost, type Transport, type Unsubscribe } from '@mjm/net';
import { BOT_SKILLS, randomHex, sanitizeRules, type BotSkill, type RuleSet } from '@mjm/engine';
import { uniqueCode, type HexSource } from './codes';
import { LIMITS } from './config';
import { TokenBucket } from './limits';
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
  | { t: 'leave' };

interface Peer {
  id: string;
  socket: Socket;
  room: string | null;
  /** The account behind the socket, verified from its session token in `hello` (absent only without auth). */
  userId?: string;
  /** The session that proved `userId`; a logout or revocation of it closes the socket (see `endSessions`). */
  sessionId?: string;
  /** Allows one room per `LIMITS.createCooldownMs`. */
  creates: TokenBucket;
  /** Allows `LIMITS.joinsPerWindow` join attempts per `LIMITS.joinWindowMs`, so codes cannot be guessed quickly. */
  joins: TokenBucket;
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
}

/**
 * Membership checks for club tables, supplied by the server (the registry knows nothing of clubs).
 * Every method is synchronous because the club registry keeps its clubs in memory.
 */
export interface ClubGate {
  /** The rules a new table for this club should use, or the reason the user may not open one. */
  openTable(clubCode: string, userId: string | undefined, rules: unknown): { rules: RuleSet } | { error: string };
  /** Called once the room exists, to list the table in the club. */
  tableOpened(clubCode: string, roomCode: string, userId: string, rules: RuleSet): void;
  /** True when the user is a full member of the club (pending requests do not count). */
  mayJoin(clubCode: string, userId: string | undefined): boolean;
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
export const HOSTED_ONLY = 'Only server-hosted tables can be created';
/** Sent for a hosted create while `HOST_TABLES=0`, instead of quietly opening a relay-only room. */
export const HOSTED_DISABLED = 'Hosted tables are disabled';
/** Sent to the peers left in a relay-only room when its host leaves, as `{t:'error', code:'closed', message}`. */
export const ROOM_CLOSED = 'The host left, so the room has closed';
export const CREATE_COOLDOWN = 'Please wait a few seconds before creating another room';
export const JOIN_THROTTLED = 'Too many join attempts; please wait a few seconds';
export const SERVER_FULL = 'The server is full right now; please try again in a few minutes';
/** Sent when a user who is not a full member of the club tries to open or join one of its tables. */
export const CLUB_MEMBERS_ONLY = 'Join the club first';

/** How long a table with nobody connected is kept after its last activity while a human holds a seat. */
export const KEEP_ALIVE_MS = 15 * 60_000;

/** Most peers one room can hold: the four seats plus spare places for players who drop out and rejoin. */
const MAX_ROOM_PEERS = 12;

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
}

export interface HostedRoomOptions {
  code?: string;
  rules?: unknown;
  botSkill?: unknown;
  keepAliveMs?: number;
  /** The club the table belongs to. */
  clubCode?: string;
  /** Resume a table from its snapshot (after a restart). The room keeps the snapshot's code. */
  restore?: SerializedHost;
}

export class RoomRegistry {
  private readonly peers = new Map<string, Peer>();
  private readonly rooms = new Map<string, Room>();
  private readonly eventHandlers = new Set<(ev: RoomEvent) => void>();
  private readonly changeHandlers = new Set<(room: string) => void>();
  private readonly hex: HexSource;
  private closed = false;
  constructor(private readonly opts: RoomRegistryOptions = {}) {
    this.hex = opts.randomHex ?? randomHex;
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
    const wanted = opts.restore ? opts.restore.roomCode : opts.code;
    const usable = typeof wanted === 'string' && /^[A-Z0-9]{4,8}$/.test(wanted) && !this.rooms.has(wanted);
    if (opts.restore && !usable) throw new Error(`Cannot restore table ${String(wanted)}: the code is malformed or in use`);
    const code = usable ? wanted : this.newCode();
    const room: Room = { code, host: '', peers: new Set(), createdAt: this.now(), keepAliveUntil: this.now() + (opts.keepAliveMs ?? KEEP_ALIVE_MS), pinned: true };
    if (opts.clubCode) room.clubCode = opts.clubCode.toUpperCase();
    this.attachTable(room, opts.rules, opts.botSkill, opts.restore);
    this.rooms.set(code, room);
    return code;
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
    });
    host.onEvent((event) => {
      // While a human holds a seat (connected or not) the table lives 15 minutes past its last activity.
      // A room opened over the socket with nobody seated any more closes as soon as its last peer leaves.
      if (event.seats.some((s) => !s.isBot && s.name !== '')) room.keepAliveUntil = this.now() + KEEP_ALIVE_MS;
      else if (!room.pinned) room.keepAliveUntil = undefined;
      for (const h of this.eventHandlers) h({ room: room.code, event });
    });
    host.onChange(() => {
      for (const h of this.changeHandlers) h(room.code);
    });
    room.table = { host, transport };
    room.host = transport.id;
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

  newCode(len = 6): string {
    return uniqueCode((c) => this.rooms.has(c), len, this.hex);
  }

  private newPeerId(prefix: string): string {
    let id = `${prefix}${this.hex(8)}`;
    while (this.peers.has(id)) id = `${prefix}${this.hex(8)}`;
    return id;
  }

  connect(socket: Socket): string {
    const id = this.newPeerId('tmp-');
    const now = () => this.now();
    this.peers.set(id, {
      id,
      socket,
      room: null,
      creates: new TokenBucket(1, 1000 / LIMITS.createCooldownMs, now),
      joins: new TokenBucket(LIMITS.joinsPerWindow, (LIMITS.joinsPerWindow * 1000) / LIMITS.joinWindowMs, now),
    });
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
  hello(peerId: string, userId?: string, sessionId?: string): string {
    const peer = this.peers.get(peerId);
    if (!peer) return peerId;
    if (peerId.startsWith('tmp-')) {
      const id = this.newPeerId('p-');
      this.peers.delete(peerId);
      peer.id = id;
      this.peers.set(id, peer);
      if (userId) peer.userId = userId;
      if (sessionId) peer.sessionId = sessionId;
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
   * Close every socket whose session has ended (code 4401), so a logout, a revocation, an account
   * deletion or a merge takes effect at the table as well as on the API: by session, or every
   * session of a user except `exceptSessionId` (the caller's own, after a link). Returns how many
   * sockets were closed. The seats stay as they are: a player who signs in again reclaims one
   * with the rejoin token like any other reconnect.
   */
  endSessions(which: { sessionId?: string; userId?: string; exceptSessionId?: string }): number {
    let n = 0;
    for (const peer of [...this.peers.values()]) {
      if (!peer.sessionId && !peer.userId) continue;
      const bySession = which.sessionId !== undefined && peer.sessionId === which.sessionId;
      const byUser = which.userId !== undefined && peer.userId === which.userId && peer.sessionId !== which.exceptSessionId;
      if (!bySession && !byUser) continue;
      peer.socket.close(SESSION_ENDED, 'Session ended');
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
        let rules: unknown = msg.rules;
        if (club !== undefined) {
          // Checked before the cooldown, so a refusal does not cost the peer its next create.
          const gate = this.opts.clubs?.openTable(club, peer.userId, msg.rules) ?? { error: CLUB_MEMBERS_ONLY };
          if ('error' in gate) {
            this.error(peer, gate.error);
            return peer.id;
          }
          rules = gate.rules;
        }
        if (!peer.creates.take()) {
          this.error(peer, CREATE_COOLDOWN);
          return peer.id;
        }
        this.leave(peer);
        const wanted = typeof msg.room === 'string' ? msg.room : undefined;
        const code = wanted && /^[A-Z0-9]{4,8}$/.test(wanted) && !this.rooms.has(wanted) ? wanted : this.newCode();
        const room: Room = { code, host: peer.id, peers: new Set([peer.id]), createdAt: this.now() };
        if (club !== undefined) room.clubCode = club;
        if (hosted) this.attachTable(room, rules, msg.botSkill);
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
        if (!peer.joins.take()) {
          this.error(peer, JOIN_THROTTLED);
          return peer.id;
        }
        const room = msg.room.length <= 8 ? this.rooms.get(msg.room.toUpperCase()) : undefined;
        if (!room || (room.peers.size >= MAX_ROOM_PEERS && !room.peers.has(peer.id))) {
          this.error(peer, ROOM_UNAVAILABLE, ROOM_UNAVAILABLE_CODE);
          return peer.id;
        }
        if (room.clubCode && !(this.opts.clubs?.mayJoin(room.clubCode, peer.userId) ?? false)) {
          this.error(peer, CLUB_MEMBERS_ONLY);
          return peer.id;
        }
        this.leave(peer);
        room.peers.add(peer.id);
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
          room.table.transport.receive(peer.id, bindUser(msg.data, peer.userId));
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
      default:
        return peer.id;
    }
  }

  disconnect(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
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
      if (room.keepAliveUntil !== undefined && room.keepAliveUntil > this.now()) {
        // Give players time to come back (bots play for them, or the table pauses between hands).
        room.keepAliveUntil = this.now() + KEEP_ALIVE_MS;
      } else this.closeRoom(room);
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
      r.table?.host.tick();
      if (r.peers.size === 0 && r.keepAliveUntil !== undefined && r.keepAliveUntil <= this.now()) this.closeRoom(r);
    }
  }

  hasRoom(code: string): boolean {
    return this.rooms.has(code.toUpperCase());
  }

  closeRoomByCode(code: string): void {
    const room = this.rooms.get(code.toUpperCase());
    if (room) this.closeRoom(room);
  }

  hostedTable(code: string): TableHost | undefined {
    return this.rooms.get(code)?.table?.host;
  }

  /** The club a room belongs to, if any. */
  clubOf(code: string): string | undefined {
    return this.rooms.get(code)?.clubCode;
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

/** A game action for the table (`{ch:'game', msg:{t:'action'}}`). */
function isAction(data: unknown): boolean {
  const env = data as { ch?: unknown; msg?: { t?: unknown } } | null;
  return !!env && typeof env === 'object' && env.ch === 'game' && !!env.msg && typeof env.msg === 'object' && env.msg.t === 'action';
}

/**
 * The table's `join` carries the verified account, never the one the client claims, so the host
 * (which reads `msg.userId`) binds the seat to the user the session proved. An unauthenticated
 * peer's claim is dropped.
 */
function bindUser(data: unknown, userId: string | undefined): unknown {
  const env = data as { ch?: unknown; msg?: unknown } | null;
  if (!env || typeof env !== 'object' || env.ch !== 'game' || !env.msg || typeof env.msg !== 'object') return data;
  if ((env.msg as { t?: unknown }).t !== 'join') return data;
  const msg: Record<string, unknown> = { ...(env.msg as Record<string, unknown>) };
  if (userId) msg.userId = userId;
  else delete msg.userId;
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
