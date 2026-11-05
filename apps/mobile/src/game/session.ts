/**
 * Creates a playable table session: either fully local (this device hosts and
 * plays against bots, offline) or online (the game server hosts the table and
 * every player, this device included, verifies each hand).
 *
 * An online session survives a dropped socket: it rejoins the same room with the
 * saved rejoin token on a backoff of 1, 2, 4 … 60 s (src/logic/reconnect.ts), builds
 * a fresh TableClient over a new relay and swaps it in, so screens that follow
 * `session.onChange` never notice beyond the "Reconnecting" banner.
 */
import { type BotSkill, type RuleSet } from '@mjm/engine';
import {
  isRoomUnavailable,
  LoopbackHub,
  RelayTransport,
  SignalingClient,
  TableClient,
  TableHost,
  transportLink,
  type ClientState,
  type RoomInfo,
  type SerializedHost,
  type WebSocketFactory,
  type WebSocketLike,
} from '@mjm/net';
import { CONNECTED, nextDelayMs, reconnectStep, type ConnectionStatus, type ReconnectEvent, type ReconnectState } from '../logic/reconnect';

export type { ConnectionStatus } from '../logic/reconnect';

type Unsubscribe = () => void;

export interface Session {
  /** The live table client. Online, it is replaced after a reconnect: follow `onChange`, not `client.onChange`. */
  readonly client: TableClient;
  /** Present only for local play, where this device runs the table. */
  host: TableHost | null;
  roomCode: string;
  mode: 'local' | 'online';
  transportKind: 'loopback' | 'relay';
  /** Online only: the game server this table lives on (a resume must go back to it). */
  serverUrl?: string;
  clubCode?: string;
  /** Link to the table: always 'connected' locally. */
  readonly status: ConnectionStatus;
  /** While reconnecting, the attempt being waited for or made (1-based). */
  readonly attempt: number;
  /** Why a lost table was lost. */
  readonly lostReason: ReconnectState['reason'];
  /** Client state, from whichever client is current; fires on every swap. */
  onChange(cb: (s: ClientState) => void): Unsubscribe;
  /** Connection status and attempt changes. */
  onStatus(cb: (s: ReconnectState) => void): Unsubscribe;
  /** Skip the backoff wait and try now (while reconnecting). */
  retryNow(): void;
  close(): void;
}

export interface LocalOptions {
  botSkill?: BotSkill;
  /** Resume a saved table. */
  restore?: { host: SerializedHost; token: string };
}

export function createLocalSession(name: string, avatar: string, rules: RuleSet, opts: LocalOptions = {}): Session {
  const hub = new LoopbackHub();
  const host = new TableHost(hub.create('host'), {
    roomCode: 'LOCAL',
    rules,
    botDelayMs: 650,
    intermissionSeconds: 600,
    botSkill: opts.botSkill,
    restore: opts.restore?.host,
  });
  const client = new TableClient(host.localLink('me'), name, avatar, { token: opts.restore?.token });
  client.join();
  return {
    client,
    host,
    roomCode: 'LOCAL',
    mode: 'local',
    transportKind: 'loopback',
    status: 'connected',
    attempt: 0,
    lostReason: null,
    onChange: (cb) => client.onChange(cb),
    onStatus: () => () => undefined,
    retryNow: () => undefined,
    close: () => {
      client.leave();
      host.close();
    },
  };
}

export interface OnlineOptions {
  signalUrl: string;
  name: string;
  avatar: string;
  userId?: string;
  rules: RuleSet;
  /** 'create' asks the game server for a new table; 'join' joins one by code. */
  action: 'create' | 'join';
  code?: string;
  botSkill?: BotSkill;
  /** Rejoin token from a previous session at this table. */
  token?: string;
  clubCode?: string;
  /** The account session token for the socket's `hello`, fetched afresh for every (re)connect. */
  auth?: () => Promise<string | undefined>;
  /** The server refused the session (4401): drop it so the next `auth()` brings a fresh one. */
  onUnauthorised?: () => Promise<void> | void;
  /** Tests inject a fake socket; defaults to the global WebSocket. */
  webSocket?: WebSocketFactory;
}

/** WebSocket close code the game server uses for a missing or bad session token. */
export const UNAUTHORISED_CLOSE = 4401;
export const UNAUTHORISED_MESSAGE = 'Unauthorised: the game server did not accept this session.';

/** A refusal of the session token, whether the signalling client reports it by message or we saw the 4401 close. */
export function isUnauthorised(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const { message, code } = e as { message?: unknown; code?: unknown };
  return code === UNAUTHORISED_CLOSE || (typeof message === 'string' && /^unauthori[sz]ed/i.test(message));
}

const defaultSocket: WebSocketFactory = (u) => new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(u);

/**
 * A signalling client that authenticates its `hello` with `auth` and remembers the close code.
 *
 * Shim until SignalingClient takes `{ auth, webSocket }` itself: the token is added to the first
 * `hello` frame on the way out (left alone if the client already sent one), which is the frame
 * docs/API.md specifies. With the new constructor this becomes
 * `new SignalingClient(url, { auth, webSocket: wrapped })`; the wrapper still supplies the close code.
 */
export function connectSignaling(url: string, auth: string | undefined, webSocket: WebSocketFactory = defaultSocket): { signaling: SignalingClient; closeCode(): number | undefined } {
  let lastCode: number | undefined;
  const wrapped: WebSocketFactory = (u) => {
    const ws = webSocket(u);
    const proxy: WebSocketLike = {
      get readyState() {
        return ws.readyState;
      },
      send(data: string) {
        if (auth && typeof data === 'string' && data.startsWith('{"t":"hello"')) {
          try {
            const frame = JSON.parse(data) as { t?: string; auth?: string };
            if (frame.t === 'hello' && !frame.auth) data = JSON.stringify({ ...frame, auth });
          } catch {
            /* not JSON: send as is */
          }
        }
        ws.send(data);
      },
      close: () => ws.close(),
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    };
    ws.onopen = (ev) => proxy.onopen?.(ev);
    ws.onerror = (ev) => proxy.onerror?.(ev);
    ws.onmessage = (ev) => proxy.onmessage?.(ev);
    ws.onclose = (ev) => {
      const code = (ev as { code?: unknown } | null)?.code;
      lastCode = typeof code === 'number' ? code : undefined;
      proxy.onclose?.(ev);
    };
    return proxy;
  };
  return { signaling: new SignalingClient(url, { auth, webSocket: wrapped }), closeCode: () => lastCode };
}

/**
 * Asks the game server to host a new table with these rules. The only place that
 * reaches past the public SignalingClient API; swap the body for
 * `signaling.createHostedRoom(rules, botSkill)` once that method exists.
 */
export function requestHostedRoom(signaling: SignalingClient, rules: RuleSet, botSkill: BotSkill | undefined): Promise<RoomInfo> {
  return signaling.createHostedRoom(rules, botSkill);
}

interface Link {
  signaling: SignalingClient;
  client: TableClient;
  room: RoomInfo;
  /** Set by the session: runs before the client's own close handler. */
  dropped: { handler: ((code: number | undefined) => void) | null };
}

/** Connects, authenticates, creates or joins the room and seats a new client (not yet joined). */
async function openLink(opts: OnlineOptions, action: 'create' | 'join', code: string, token: string | undefined): Promise<Link> {
  const auth = opts.auth ? await opts.auth() : undefined;
  const { signaling, closeCode } = connectSignaling(opts.signalUrl, auth, opts.webSocket);
  const dropped: Link['dropped'] = { handler: null };
  // Registered first so the session sees the drop before the client marks itself disconnected.
  signaling.onClose(() => dropped.handler?.(closeCode()));
  try {
    await signaling.connect();
  } catch (e) {
    if (closeCode() === UNAUTHORISED_CLOSE || isUnauthorised(e)) throw Object.assign(new Error(UNAUTHORISED_MESSAGE), { code: UNAUTHORISED_CLOSE });
    throw e;
  }
  try {
    const transport = new RelayTransport(signaling, 'game');
    const room = action === 'create' ? await requestHostedRoom(signaling, opts.rules, opts.botSkill) : await signaling.joinRoom(code);
    const client = new TableClient(transportLink(transport, room.host), opts.name, opts.avatar, { token, userId: opts.userId });
    return { signaling, client, room, dropped };
  } catch (e) {
    signaling.close();
    throw e;
  }
}

class OnlineSession implements Session {
  readonly host = null;
  readonly mode = 'online' as const;
  readonly transportKind = 'relay' as const;
  readonly roomCode: string;
  readonly serverUrl: string;
  readonly clubCode?: string;
  private link: Link;
  private conn: ReconnectState = CONNECTED;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private unsubClient: Unsubscribe = () => undefined;
  private readonly stateListeners = new Set<(s: ClientState) => void>();
  private readonly statusListeners = new Set<(s: ReconnectState) => void>();

  constructor(
    private readonly opts: OnlineOptions,
    link: Link,
  ) {
    this.link = link;
    this.roomCode = link.room.room;
    this.serverUrl = opts.signalUrl;
    this.clubCode = opts.clubCode;
    this.attach(link);
  }

  get client(): TableClient {
    return this.link.client;
  }
  get status(): ConnectionStatus {
    return this.conn.status;
  }
  get attempt(): number {
    return this.conn.attempt;
  }
  get lostReason(): ReconnectState['reason'] {
    return this.conn.reason;
  }

  onChange(cb: (s: ClientState) => void): Unsubscribe {
    this.stateListeners.add(cb);
    return () => this.stateListeners.delete(cb);
  }

  onStatus(cb: (s: ReconnectState) => void): Unsubscribe {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  private attach(link: Link): void {
    this.unsubClient();
    this.link = link;
    this.unsubClient = link.client.onChange((s) => {
      for (const l of this.stateListeners) l(s);
    });
    link.dropped.handler = (code) => this.onDrop(link, code);
  }

  private onDrop(link: Link, code: number | undefined): void {
    if (this.closed || link !== this.link) return;
    const st = link.client.state;
    // The seat was opened on another device: reconnecting would take it back and start a tug of war.
    if (st.disconnected || st.matchOver) return this.step({ type: 'ended' });
    if (code === UNAUTHORISED_CLOSE) {
      void this.opts.onUnauthorised?.();
      return this.step({ type: 'unauthorised' });
    }
    this.step({ type: 'closed' });
  }

  private step(e: ReconnectEvent): void {
    const next = reconnectStep(this.conn, e);
    if (next === this.conn) return;
    this.conn = next;
    for (const l of this.statusListeners) l(next);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const delay = nextDelayMs(this.conn);
    if (delay !== null && !this.inFlight) this.timer = setTimeout(() => void this.tryOnce(), delay);
  }

  retryNow(): void {
    if (this.closed || this.conn.status !== 'reconnecting' || this.inFlight) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    void this.tryOnce();
  }

  private async tryOnce(): Promise<void> {
    if (this.closed || this.conn.status !== 'reconnecting' || this.inFlight) return;
    this.timer = null;
    this.inFlight = true;
    const token = this.link.client.state.token ?? this.opts.token;
    let link: Link | null = null;
    let failure: unknown = null;
    try {
      link = await openLink(this.opts, 'join', this.roomCode, token);
    } catch (e) {
      failure = e;
    }
    this.inFlight = false;
    if (this.closed) {
      link?.signaling.close();
      return;
    }
    if (link) {
      this.attach(link);
      link.client.join();
      this.step({ type: 'succeeded' });
      for (const l of this.stateListeners) l(link.client.state);
      return;
    }
    const unauthorised = isUnauthorised(failure);
    if (unauthorised) void this.opts.onUnauthorised?.();
    // 'Room not found or full' is the server's final word (the table ended or was reaped while we were away):
    // stop at once instead of showing 'Reconnecting' through ten more attempts.
    this.step({ type: 'failed', unauthorised, gone: isRoomUnavailable(failure) });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.unsubClient();
    // Leaving closes the relay transport, which closes the signalling socket.
    this.link.client.leave();
  }
}

export async function createOnlineSession(opts: OnlineOptions): Promise<Session> {
  const code = (opts.code ?? '').toUpperCase();
  let link: Link;
  try {
    link = await openLink(opts, opts.action, code, opts.token);
  } catch (e) {
    // A stale session token: replace it once and try again.
    if (!isUnauthorised(e) || !opts.onUnauthorised) throw e;
    await opts.onUnauthorised();
    link = await openLink(opts, opts.action, code, opts.token);
  }
  const session = new OnlineSession(opts, link);
  link.client.join();
  return session;
}
