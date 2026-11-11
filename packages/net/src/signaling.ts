/**
 * Client for the game server's WebSocket endpoint: creates or joins a room and
 * relays every game message between this device and the server-hosted table.
 *
 * The protocol is tiny and documented in apps/signal/README.md.
 */
import type { BotSkill, RuleSet } from '@mjm/engine';
import type { Transport, Unsubscribe } from './transport';

/** How long `connect()` and each room request wait for the server before giving up. */
export const SIGNALING_TIMEOUT_MS = 10_000;
export const SIGNALING_TIMEOUT_MESSAGE = 'The game server did not answer in time. Check your connection and try again.';
/** How often a connected client asks the server for a `pong`. */
export const HEARTBEAT_MS = 15_000;
/** How long a client waits for that `pong` before it treats the link as dead and closes it. */
export const PONG_TIMEOUT_MS = 10_000;
/** `lastCloseCode` after the client closed a link that stopped answering its pings. */
export const HEARTBEAT_CLOSE_CODE = 4408;
/** Close code the server uses when the session token in `hello` is missing or not accepted. */
export const UNAUTHORISED_CLOSE_CODE = 4401;
/** `connect()` rejects with a message starting with this when the server closes with 4401. */
export const UNAUTHORISED_MESSAGE = 'Unauthorised: the game server did not accept this session. Sign in again and retry.';
/** Close code the server uses for a banned account (at `hello`, or when a moderator bans it). */
export const BANNED_CLOSE_CODE = 4403;
/** `connect()` rejects with this message when the server closes with 4403. */
export const BANNED_MESSAGE = 'Banned: this account has been banned from online play.';
/** The server's answer to a create or join for a room that has ended, been reaped or is full (apps/signal/src/rooms.ts). */
export const ROOM_UNAVAILABLE_CODE = 'room_unavailable';
export const ROOM_UNAVAILABLE_MESSAGE = 'Room not found or full';

/**
 * A refused create or join: the server's message, with its `code` when it sent one (newer servers
 * send `room_unavailable` with ROOM_UNAVAILABLE_MESSAGE; older ones only the message).
 */
export class RoomRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RoomRequestError';
  }
}

/** True when a create or join failed because the room is definitively gone or full: retrying the same room is pointless. */
export function isRoomUnavailable(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const { code, message } = e as { code?: unknown; message?: unknown };
  return code === ROOM_UNAVAILABLE_CODE || (typeof message === 'string' && message.trim().toLowerCase() === ROOM_UNAVAILABLE_MESSAGE.toLowerCase());
}

export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  /** Browsers, React Native and `ws` all pass a CloseEvent carrying the close `code`. */
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export type ServerMessage =
  /** `id` is the peer id (older servers sent it as `peerId`); `userId` is the account the session proved. */
  | { t: 'hello'; id?: string; peerId?: string; userId?: string }
  | { t: 'room'; room: string; peers: string[]; host: string }
  | { t: 'peer'; peerId: string; event: 'join' | 'leave' }
  | { t: 'from'; from: string; data: unknown }
  /** In reply to a refused create or join; with `code: 'closed'`, sent unprompted when the room has closed. */
  | { t: 'error'; message: string; code?: string }
  /** The answer to a client `ping`. */
  | { t: 'pong' }
  /** While a quick match is being found: sent at once and every 2 s (see `SignalingClient.joinQueue`). */
  | QueueStatus
  /** A quick match was found: join `room` by its code as usual (only the matched players may). */
  | { t: 'matched'; room: string; humans?: number; bots?: number }
  /** The queue refused or dropped this socket; `code` is one of `QueueErrorCode`. */
  | { t: 'queue_error'; code: string; message: string; room?: string }
  /** The answer to `leave_queue`. */
  | { t: 'queue_left' };

/** Where a quick-match search stands. */
export interface QueueStatus {
  t: 'queue_status';
  /** 1 for the player who has waited longest. */
  position: number;
  waitedMs: number;
  /** Humans in the group this player would be seated with now (itself included). */
  humans: number;
  /** How long a group short of four waits before bots fill its empty seats (absent on older servers). */
  fillMs?: number;
}

/**
 * Why the queue refused or dropped a socket: `banned` (the account is banned), `age_missing` (the
 * server has no birth year: send it once and queue again), `age_under` (the year on file is under
 * 17: final), `rate_limited`, `sign_in` (no account), `unavailable` (try again), `replaced` (the
 * same account queued from another socket), `seated` (the account still has a seat at an
 * unfinished quick-match table: `room` names it).
 */
export type QueueErrorCode = 'banned' | 'age_missing' | 'age_under' | 'rate_limited' | 'sign_in' | 'unavailable' | 'replaced' | 'seated';

/** A quick match the server refused or ended, with its `code` (and, for `seated`, the table's `room`). */
export class QueueError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly room?: string,
  ) {
    super(message);
    this.name = 'QueueError';
  }
}

export type ClientToServer =
  /** `auth` is the session token; the server closes the socket with 4401 without a valid one. */
  | { t: 'hello'; auth?: string }
  /** `hosted: true` asks the server to run the table itself; the server sanitises `rules` and `botSkill`. `club` opens it as a club table (members only). */
  | { t: 'create'; room?: string; hosted?: boolean; rules?: Partial<RuleSet>; botSkill?: BotSkill; club?: string }
  | { t: 'join'; room: string }
  | { t: 'to'; to: string; data: unknown }
  | { t: 'leave' }
  /**
   * Heartbeat: the server answers `{t:'pong'}`. A half-open link (a network handover, a NAT that
   * forgot the connection) delivers nothing and reports nothing; only a missing answer shows it.
   */
  | { t: 'ping' }
  /** Quick match: seat me with strangers (default rules at Normal speed; bots fill empty seats after 20 s). */
  | { t: 'queue'; preset?: 'normal' }
  | { t: 'leave_queue' };

/** Timer functions, injectable so tests can drive the heartbeat. */
export interface SignalingTimers {
  setInterval(cb: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: SignalingTimers = {
  setInterval: (cb, ms) => setInterval(cb, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface RoomInfo {
  room: string;
  peers: string[];
  host: string;
}

export interface SignalingOptions {
  /** Session token sent in `hello`. */
  auth?: string;
  /** Builds the socket (default: the platform's global WebSocket). Tests and Node pass `ws`. */
  webSocket?: WebSocketFactory;
  timeoutMs?: number;
  /** Ping interval once connected (default `HEARTBEAT_MS`; 0 turns the heartbeat off). */
  heartbeatMs?: number;
  /** How long to wait for each `pong` (default `PONG_TIMEOUT_MS`). */
  pongTimeoutMs?: number;
  /** Timers for the heartbeat (default the global ones). */
  timers?: SignalingTimers;
}

const defaultSocket: WebSocketFactory = (u) => new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(u);

export class SignalingClient {
  peerId: string | null = null;
  /** The account the server verified from the session token (absent on servers without accounts). */
  userId: string | null = null;
  room: RoomInfo | null = null;
  /** Close code of the last connection that ended (4401: the session was not accepted; 4408: it stopped answering pings). */
  lastCloseCode: number | null = null;
  private ws: WebSocketLike | null = null;
  private readonly msgHandlers = new Set<(m: ServerMessage) => void>();
  private readonly closeHandlers = new Set<() => void>();
  private closedLocally = false;
  private pendingHello: Array<(id: string) => void> = [];
  private pendingRoom: Array<{ resolve: (r: RoomInfo) => void; reject: (e: Error) => void }> = [];
  /**
   * Room replies still due for requests that already timed out. The server answers every
   * create/join with exactly one `room` or `error`, in order, so the next replies belong to
   * those abandoned requests and must not resolve a newer one.
   */
  private staleReplies = 0;
  private readonly timeoutMs: number;
  private readonly makeSocket: WebSocketFactory;
  private auth: string | undefined;
  private readonly heartbeatMs: number;
  private readonly pongTimeoutMs: number;
  private readonly timers: SignalingTimers;
  private heartbeat: unknown = null;
  private pongDue: unknown = null;

  /**
   * `options` may also be a bare WebSocketFactory (the older form), with the timeout in `legacy`.
   */
  constructor(
    private readonly url: string,
    options: SignalingOptions | WebSocketFactory = {},
    legacy: { timeoutMs?: number } = {},
  ) {
    const opts: SignalingOptions = typeof options === 'function' ? { webSocket: options, timeoutMs: legacy.timeoutMs } : options;
    this.makeSocket = opts.webSocket ?? defaultSocket;
    this.timeoutMs = opts.timeoutMs ?? legacy.timeoutMs ?? SIGNALING_TIMEOUT_MS;
    this.auth = opts.auth;
    this.heartbeatMs = opts.heartbeatMs ?? HEARTBEAT_MS;
    this.pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
    this.timers = opts.timers ?? realTimers;
  }

  /**
   * Every `heartbeatMs` once connected, send `{t:'ping'}`; if no `pong` (or any other frame) has
   * arrived `pongTimeoutMs` later, the link is dead even though no close was reported: close it
   * and fire the close handlers, which drives the app's usual reconnect.
   */
  private startHeartbeat(ws: WebSocketLike): void {
    this.stopHeartbeat();
    if (!(this.heartbeatMs > 0)) return;
    this.heartbeat = this.timers.setInterval(() => {
      if (this.ws !== ws || this.pongDue !== null) return;
      try {
        ws.send(JSON.stringify({ t: 'ping' } satisfies ClientToServer));
      } catch {
        /* a failing send shows up as a missing pong */
      }
      this.pongDue = this.timers.setTimeout(() => {
        this.pongDue = null;
        if (this.ws === ws) this.linkDead(ws);
      }, this.pongTimeoutMs);
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    if (this.pongDue !== null) this.timers.clearTimeout(this.pongDue);
    this.heartbeat = null;
    this.pongDue = null;
  }

  /** The link answered: whatever is in flight proves it is alive. */
  private heardFrom(): void {
    if (this.pongDue !== null) this.timers.clearTimeout(this.pongDue);
    this.pongDue = null;
  }

  /** Give up on a link that stopped answering: detach it, close it, and report it closed now (its own close event may never come). */
  private linkDead(ws: WebSocketLike): void {
    const onclose = ws.onclose;
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    try {
      ws.close();
    } catch {
      /* already closed */
    }
    onclose?.({ code: HEARTBEAT_CLOSE_CODE });
  }

  /** Use a new session token from the next `connect()` (after a refresh or a sign-in). */
  setAuth(token: string | undefined): void {
    this.auth = token;
  }

  /** Open the socket and wait for the server's `hello`. Rejects on error, early close or after `timeoutMs`. */
  connect(): Promise<string> {
    return new Promise((resolve, reject) => {
      const ws = this.makeSocket(this.url);
      this.ws = ws;
      let settled = false;
      const settle = (err: Error | null, id?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(id!);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        // The connection never got going: drop it quietly, without firing close handlers.
        ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
        if (this.ws === ws) this.ws = null;
        try {
          ws.close();
        } catch {
          /* already closed */
        }
        settle(new Error(SIGNALING_TIMEOUT_MESSAGE));
      }, this.timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify((this.auth ? { t: 'hello', auth: this.auth } : { t: 'hello' }) satisfies ClientToServer));
      ws.onerror = () => settle(new Error('Signaling connection failed'));
      ws.onclose = (ev) => {
        if (this.ws === ws) {
          this.ws = null;
          this.stopHeartbeat();
        }
        const code = typeof (ev as { code?: unknown } | null)?.code === 'number' ? (ev as { code: number }).code : null;
        this.lastCloseCode = code;
        settle(new Error(code === UNAUTHORISED_CLOSE_CODE ? UNAUTHORISED_MESSAGE : code === BANNED_CLOSE_CODE ? BANNED_MESSAGE : 'Connection closed'));
        if (!this.closedLocally) for (const h of this.closeHandlers) h();
        const pending = this.pendingRoom;
        this.pendingRoom = [];
        this.staleReplies = 0;
        for (const p of pending) p.reject(new Error('Connection closed'));
      };
      ws.onmessage = (ev) => {
        let m: ServerMessage;
        try {
          m = JSON.parse(String(ev.data)) as ServerMessage;
        } catch {
          return;
        }
        if (this.ws === ws) this.heardFrom();
        if (m.t === 'pong') return;
        if (m.t === 'hello') {
          const id = m.id ?? m.peerId;
          if (typeof id !== 'string') return;
          this.peerId = id;
          this.userId = typeof m.userId === 'string' ? m.userId : null;
          for (const p of this.pendingHello) p(id);
          this.pendingHello = [];
          if (!settled && this.ws === ws) this.startHeartbeat(ws);
          settle(null, id);
        } else if (m.t === 'room') {
          this.room = { room: m.room, peers: m.peers, host: m.host };
          const p = this.nextPending();
          p?.resolve(this.room);
        } else if (m.t === 'error' && m.code === 'closed') {
          // Unprompted: the room has closed under us. It answers no request, so nothing pending is consumed.
          this.room = null;
          for (const h of this.closeHandlers) h();
        } else if (m.t === 'error') {
          const p = this.nextPending();
          p?.reject(new RoomRequestError(m.message, typeof m.code === 'string' ? m.code : undefined));
        } else if (m.t === 'peer' && this.room) {
          if (m.event === 'join' && !this.room.peers.includes(m.peerId)) this.room.peers.push(m.peerId);
          if (m.event === 'leave') this.room.peers = this.room.peers.filter((p) => p !== m.peerId);
        }
        for (const h of this.msgHandlers) h(m);
      };
    });
  }

  createRoom(room?: string): Promise<RoomInfo> {
    return this.roomRequest({ t: 'create', room });
  }

  joinRoom(room: string): Promise<RoomInfo> {
    return this.roomRequest({ t: 'join', room: room.toUpperCase() });
  }

  /** Ask the server to open a table it hosts itself. This is how online games are created. `club` makes it a club table (members only). */
  createHostedRoom(rules: Partial<RuleSet>, botSkill?: BotSkill, opts: { club?: string } = {}): Promise<RoomInfo> {
    return this.roomRequest(opts.club ? { t: 'create', hosted: true, rules, botSkill, club: opts.club } : { t: 'create', hosted: true, rules, botSkill });
  }


  /**
   * Ask for a quick match. The answers arrive as messages: `queue_status` while waiting, then
   * `matched` (join that room with `joinRoom`) or `queue_error`. `onStatus` gets each status;
   * the promise resolves with the room code, or rejects with a QueueError, or with an Error when
   * the connection closes first. `cancel()` leaves the queue (and rejects with code 'cancelled').
   */
  findMatch(onStatus: (s: QueueStatus) => void = () => undefined): { match: Promise<string>; cancel: () => void } {
    let cancel: () => void = () => undefined;
    const match = new Promise<string>((resolve, reject) => {
      const ws = this.ws;
      if (!ws) return reject(new Error('Not connected'));
      let done = false;
      const finish = (err: Error | null, room?: string) => {
        if (done) return;
        done = true;
        offMsg();
        offClose();
        if (err) reject(err);
        else resolve(room!);
      };
      const offMsg = this.onMessage((m) => {
        if (m.t === 'queue_status') onStatus(m);
        else if (m.t === 'matched') finish(null, m.room);
        else if (m.t === 'queue_error') finish(new QueueError(m.message, m.code, typeof m.room === 'string' ? m.room : undefined));
      });
      const offClose = this.onClose(() => finish(new Error('Connection closed')));
      cancel = () => {
        if (done) return;
        try {
          this.ws?.send(JSON.stringify({ t: 'leave_queue' } satisfies ClientToServer));
        } catch {
          /* closed already */
        }
        finish(new QueueError('Cancelled', 'cancelled'));
      };
      ws.send(JSON.stringify({ t: 'queue', preset: 'normal' } satisfies ClientToServer));
    });
    return { match, cancel: () => cancel() };
  }

  private nextPending(): { resolve: (r: RoomInfo) => void; reject: (e: Error) => void } | undefined {
    if (this.staleReplies > 0) {
      this.staleReplies--;
      return undefined;
    }
    return this.pendingRoom.shift();
  }

  private roomRequest(msg: ClientToServer): Promise<RoomInfo> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws) return reject(new Error('Not connected'));
      const entry = {
        resolve: (r: RoomInfo) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        const i = this.pendingRoom.indexOf(entry);
        if (i < 0) return;
        this.pendingRoom.splice(i, 1);
        this.staleReplies++;
        reject(new Error(SIGNALING_TIMEOUT_MESSAGE));
      }, this.timeoutMs);
      this.pendingRoom.push(entry);
      ws.send(JSON.stringify(msg));
    });
  }

  sendTo(to: string, data: unknown): void {
    this.ws?.send(JSON.stringify({ t: 'to', to, data } satisfies ClientToServer));
  }

  onMessage(cb: (m: ServerMessage) => void): Unsubscribe {
    this.msgHandlers.add(cb);
    return () => this.msgHandlers.delete(cb);
  }

  onClose(cb: () => void): Unsubscribe {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  close(): void {
    this.closedLocally = true;
    this.stopHeartbeat();
    try {
      this.ws?.send(JSON.stringify({ t: 'leave' } satisfies ClientToServer));
    } catch {
      /* already closed */
    }
    this.ws?.close();
    this.ws = null;
  }
}

/** Transport that relays every message through the game server's WebSocket. */
export class RelayTransport implements Transport {
  private readonly msgHandlers = new Set<(from: string, msg: unknown) => void>();
  private readonly peerHandlers = new Set<(peerId: string, event: 'join' | 'leave') => void>();
  private readonly unsub: Unsubscribe;

  constructor(
    private readonly signaling: SignalingClient,
    /** Channel tag so several kinds of traffic can share one socket. */
    private readonly channel = 'game',
  ) {
    this.unsub = signaling.onMessage((m) => {
      if (m.t === 'from') {
        const env = m.data as { ch?: string; msg?: unknown };
        if (env && env.ch === this.channel) for (const h of this.msgHandlers) h(m.from, env.msg);
      } else if (m.t === 'peer') {
        for (const h of this.peerHandlers) h(m.peerId, m.event);
      }
    });
  }

  get id(): string {
    return this.signaling.peerId ?? '';
  }
  send(to: string, msg: unknown): void {
    this.signaling.sendTo(to, { ch: this.channel, msg });
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
    return (this.signaling.room?.peers ?? []).filter((p) => p !== this.id);
  }
  onClose(cb: () => void): Unsubscribe {
    return this.signaling.onClose(cb);
  }
  close(): void {
    this.unsub();
    this.signaling.close();
  }
}
