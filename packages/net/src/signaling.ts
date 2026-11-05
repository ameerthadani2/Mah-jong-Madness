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
/** Close code the server uses when the session token in `hello` is missing or not accepted. */
export const UNAUTHORISED_CLOSE_CODE = 4401;
/** `connect()` rejects with a message starting with this when the server closes with 4401. */
export const UNAUTHORISED_MESSAGE = 'Unauthorised: the game server did not accept this session. Sign in again and retry.';

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
  | { t: 'error'; message: string; code?: string };

export type ClientToServer =
  /** `auth` is the session token; the server closes the socket with 4401 without a valid one. */
  | { t: 'hello'; auth?: string }
  /** `hosted: true` asks the server to run the table itself; the server sanitises `rules` and `botSkill`. `club` opens it as a club table (members only). */
  | { t: 'create'; room?: string; hosted?: boolean; rules?: Partial<RuleSet>; botSkill?: BotSkill; club?: string }
  | { t: 'join'; room: string }
  | { t: 'to'; to: string; data: unknown }
  | { t: 'leave' };

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
}

const defaultSocket: WebSocketFactory = (u) => new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(u);

export class SignalingClient {
  peerId: string | null = null;
  /** The account the server verified from the session token (absent on servers without accounts). */
  userId: string | null = null;
  room: RoomInfo | null = null;
  /** Close code of the last connection that ended (4401: the session was not accepted). */
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
        if (this.ws === ws) this.ws = null;
        const code = typeof (ev as { code?: unknown } | null)?.code === 'number' ? (ev as { code: number }).code : null;
        this.lastCloseCode = code;
        settle(new Error(code === UNAUTHORISED_CLOSE_CODE ? UNAUTHORISED_MESSAGE : 'Connection closed'));
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
        if (m.t === 'hello') {
          const id = m.id ?? m.peerId;
          if (typeof id !== 'string') return;
          this.peerId = id;
          this.userId = typeof m.userId === 'string' ? m.userId : null;
          for (const p of this.pendingHello) p(id);
          this.pendingHello = [];
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
          p?.reject(new Error(m.message));
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
