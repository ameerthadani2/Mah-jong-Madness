/**
 * Creates a playable table session: either fully local (this device hosts and
 * plays against bots, offline) or online (the game server hosts the table and
 * every player, this device included, verifies each hand).
 *
 * An online session survives a dropped socket: it rejoins the same room with the
 * saved rejoin token on a backoff of 1, 2, 4 … 60 s (src/logic/reconnect.ts) and
 * rebinds its one TableClient to the new relay, so screens that follow
 * `session.onChange` never notice beyond the "Reconnecting" banner, and the client
 * keeps everything it needs to verify the deal (a fresh client would forget the
 * ceremony it watched, which is what a server dropping the link would count on).
 * A cold resume after an app restart passes the client's saved record back in
 * (`OnlineOptions.restoreClient`, or the source registered with `setSavedClientSource`).
 */
import { DEFAULT_RULES, type BotSkill, type RuleSet } from '@mjm/engine';
import {
  BANNED_CLOSE_CODE,
  BANNED_MESSAGE,
  isRoomUnavailable,
  QueueError,
  LoopbackHub,
  RelayTransport,
  SignalingClient,
  TableClient,
  TableHost,
  transportLink,
  type ClientState,
  type Link as TableLink,
  type QueueStatus,
  type RoomInfo,
  type SerializedClient,
  type SerializedHost,
  type WebSocketFactory,
  type WebSocketLike,
} from '@mjm/net';
import { friendlyErrorMessage } from '../logic/errors';
import { CONNECTED, isWatcherMadeWay, nextDelayMs, reconnectStep, type ConnectionStatus, type ReconnectEvent, type ReconnectState } from '../logic/reconnect';

export type { ConnectionStatus } from '../logic/reconnect';

type Unsubscribe = () => void;

export interface Session {
  /** The table client: one per table, kept across reconnects (it is rebound to each new link). */
  readonly client: TableClient;
  /** Present only for local play, where this device runs the table. */
  host: TableHost | null;
  roomCode: string;
  mode: 'local' | 'online';
  transportKind: 'loopback' | 'relay';
  /** Online only: the game server this table lives on (a resume must go back to it). */
  serverUrl?: string;
  clubCode?: string;
  /** A quick-match table: the server seats the matched players and starts it by itself. */
  readonly quickMatch?: boolean;
  /** Link to the table: always 'connected' locally. */
  readonly status: ConnectionStatus;
  /** While reconnecting, the attempt being waited for or made (1-based). */
  readonly attempt: number;
  /** Why a lost table was lost. */
  readonly lostReason: ReconnectState['reason'];
  /** Client state; also fires once after each reconnect. */
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
  /** The server closed the socket with 4403: this account is banned, which no new guest gets round. */
  onBanned?: () => Promise<void> | void;
  /** A quick-match table (resumed, or returned to after `seated`): nobody else can enter it and it starts by itself. */
  quickMatch?: boolean;
  /** Tests inject a fake socket; defaults to the global WebSocket. */
  webSocket?: WebSocketFactory;
  /**
   * The table client's saved record (`TableClient.serialize()`) from before an app restart, so the
   * resumed client keeps verifying where it left off. Ignored unless it is for this room and token.
   */
  restoreClient?: SerializedClient;
}

/** Where a cold resume finds a saved client record when the caller passes none (app-state registers it). */
type SavedClientSource = (signalUrl: string, roomCode: string, token: string) => SerializedClient | undefined;
let savedClientSource: SavedClientSource | null = null;

/** Register where saved client records live (the app's ActiveSession); null unregisters. */
export function setSavedClientSource(source: SavedClientSource | null): void {
  savedClientSource = source;
}

/** The saved record to restore for this table, if it matches the room and the seat's token. */
function savedClientFor(opts: OnlineOptions, code: string): SerializedClient | undefined {
  if (!opts.token) return undefined;
  const saved = opts.restoreClient ?? savedClientSource?.(opts.signalUrl, code, opts.token);
  if (!saved || saved.state?.roomCode !== code || saved.state?.token !== opts.token) return undefined;
  return saved;
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
export function connectSignaling(
  url: string,
  auth: string | undefined,
  webSocket: WebSocketFactory = defaultSocket,
): { signaling: SignalingClient; closeCode(): number | undefined; roomClosed(): string | undefined } {
  let lastCode: number | undefined;
  // The sentence of the last `{t:'error', code:'closed'}` frame: the signalling client reports that frame
  // like a closed socket, before anything can read why, and the reason decides whether to come back.
  let closedWhy: string | undefined;
  const noteClosed = (data: unknown) => {
    if (typeof data !== 'string' || !data.includes('"closed"')) return;
    try {
      const frame = JSON.parse(data) as { t?: unknown; code?: unknown; message?: unknown };
      if (frame.t === 'error' && frame.code === 'closed') closedWhy = typeof frame.message === 'string' ? frame.message : '';
    } catch {
      /* not JSON: the signalling client ignores it too */
    }
  };
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
    ws.onmessage = (ev) => {
      noteClosed((ev as { data?: unknown } | null)?.data);
      proxy.onmessage?.(ev);
    };
    ws.onclose = (ev) => {
      const code = (ev as { code?: unknown } | null)?.code;
      lastCode = typeof code === 'number' ? code : undefined;
      proxy.onclose?.(ev);
    };
    return proxy;
  };
  return { signaling: new SignalingClient(url, { auth, webSocket: wrapped }), closeCode: () => lastCode, roomClosed: () => closedWhy };
}

/**
 * Asks the game server to host a new table with these rules. The only place that
 * reaches past the public SignalingClient API; swap the body for
 * `signaling.createHostedRoom(rules, botSkill)` once that method exists.
 */
export function requestHostedRoom(signaling: SignalingClient, rules: RuleSet, botSkill: BotSkill | undefined): Promise<RoomInfo> {
  return signaling.createHostedRoom(rules, botSkill);
}

/** One connection to the table: a signalling socket, the room it joined and the link to its host. */
interface Connection {
  signaling: SignalingClient;
  link: TableLink;
  room: RoomInfo;
  /**
   * Set by the session: runs before the client's own close handler, with the socket's close code and,
   * when the server closed the room under us instead (`{t:'error', code:'closed'}`), its sentence.
   */
  dropped: { handler: ((code: number | undefined, roomClosed?: string) => void) | null };
}

/** Connects, authenticates, and creates or joins the room. The caller binds a client to `link`. */
async function openConnection(opts: OnlineOptions, action: 'create' | 'join', code: string): Promise<Connection> {
  const auth = opts.auth ? await opts.auth() : undefined;
  const { signaling, closeCode, roomClosed } = connectSignaling(opts.signalUrl, auth, opts.webSocket);
  const dropped: Connection['dropped'] = { handler: null };
  // Registered first so the session sees the drop before the client marks itself disconnected.
  signaling.onClose(() => dropped.handler?.(closeCode(), roomClosed()));
  try {
    await signaling.connect();
  } catch (e) {
    if (closeCode() === UNAUTHORISED_CLOSE || isUnauthorised(e)) throw Object.assign(new Error(UNAUTHORISED_MESSAGE), { code: UNAUTHORISED_CLOSE });
    if (closeCode() === BANNED_CLOSE_CODE) {
      void opts.onBanned?.();
      throw Object.assign(new Error(BANNED_MESSAGE), { code: BANNED_CLOSE_CODE });
    }
    throw e;
  }
  try {
    const transport = new RelayTransport(signaling, 'game');
    const room = action === 'create' ? await requestHostedRoom(signaling, opts.rules, opts.botSkill) : await signaling.joinRoom(code);
    return { signaling, link: transportLink(transport, room.host), room, dropped };
  } catch (e) {
    signaling.close();
    throw e;
  }
}

class OnlineSession implements Session {
  readonly quickMatch: boolean;
  readonly host = null;
  readonly mode = 'online' as const;
  readonly transportKind = 'relay' as const;
  readonly roomCode: string;
  readonly serverUrl: string;
  readonly clubCode?: string;
  readonly client: TableClient;
  private connection: Connection;
  private conn: ReconnectState = CONNECTED;
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private readonly unsubClient: Unsubscribe;
  private readonly stateListeners = new Set<(s: ClientState) => void>();
  private readonly statusListeners = new Set<(s: ReconnectState) => void>();

  constructor(
    private readonly opts: OnlineOptions,
    connection: Connection,
    client: TableClient,
  ) {
    this.connection = connection;
    this.client = client;
    this.roomCode = connection.room.room;
    this.serverUrl = opts.signalUrl;
    this.clubCode = opts.clubCode;
    this.quickMatch = opts.quickMatch === true;
    this.unsubClient = client.onChange((s) => {
      // The seat was opened on another device: stop here, a reconnect would take it back.
      if (s.kicked && this.conn.status !== 'lost') this.step({ type: 'ended' });
      for (const l of this.stateListeners) l(s);
    });
    this.attach(connection);
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

  private attach(connection: Connection): void {
    this.connection = connection;
    connection.dropped.handler = (code, roomClosed) => this.onDrop(connection, code, roomClosed);
  }

  private onDrop(connection: Connection, code: number | undefined, roomClosed?: string): void {
    if (this.closed || connection !== this.connection) return;
    const st = this.client.state;
    // The seat was opened on another device: reconnecting would take it back and start a tug of war.
    // A dropped link alone (`disconnected`) is what reconnecting is for.
    if (st.kicked || st.matchOver) return this.step({ type: 'ended' });
    // A watcher the server moved out for a player: coming straight back would take the place again.
    // The socket itself is still open and has no room; it is of no more use.
    if (isWatcherMadeWay(roomClosed)) {
      this.step({ type: 'madeWay' });
      connection.signaling.close();
      return;
    }
    if (code === BANNED_CLOSE_CODE) {
      void this.opts.onBanned?.();
      return this.step({ type: 'ended' });
    }
    if (code === UNAUTHORISED_CLOSE) {
      void this.opts.onUnauthorised?.();
      return this.step({ type: 'unauthorised' });
    }
    // Every other close is a link to win back: a drop (1006), a restart (1001, 1012), or a server that
    // could not finish checking the session in time (1013). The session and its token are kept.
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
    let connection: Connection | null = null;
    let failure: unknown = null;
    try {
      connection = await openConnection(this.opts, 'join', this.roomCode);
    } catch (e) {
      failure = e;
    }
    this.inFlight = false;
    // Left meanwhile, or told to stop (the seat opened elsewhere, the match ended): the new link is not used.
    if (this.closed || this.conn.status !== 'reconnecting') {
      connection?.signaling.close();
      return;
    }
    if (connection) {
      // The same client on the new link: its ceremony record and evidence carry on. It rejoins with
      // the token it holds (the host's latest), so the seat it gets back is its own.
      this.attach(connection);
      this.client.rebind(connection.link);
      this.client.join();
      this.step({ type: 'succeeded' });
      for (const l of this.stateListeners) l(this.client.state);
      return;
    }
    // Banned while away: the server's final word, and `openConnection` has already told the account layer.
    if ((failure as { code?: unknown } | null)?.code === BANNED_CLOSE_CODE) return this.step({ type: 'ended' });
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
    this.client.leave();
  }
}

export async function createOnlineSession(opts: OnlineOptions): Promise<Session> {
  const code = (opts.code ?? '').toUpperCase();
  let connection: Connection;
  try {
    connection = await openConnection(opts, opts.action, code);
  } catch (e) {
    // A stale session token: replace it once and try again.
    if (!isUnauthorised(e) || !opts.onUnauthorised) throw e;
    await opts.onUnauthorised();
    connection = await openConnection(opts, opts.action, code);
  }
  const identity = { token: opts.token, userId: opts.userId };
  const saved = opts.action === 'join' ? savedClientFor(opts, connection.room.room) : undefined;
  const client = saved ? TableClient.restore(saved, connection.link, opts.name, opts.avatar, identity) : new TableClient(connection.link, opts.name, opts.avatar, identity);
  const session = new OnlineSession(opts, connection, client);
  client.join();
  return session;
}

// ---------------------------------------------------------------------------------------------
// Quick match
// ---------------------------------------------------------------------------------------------

export interface QuickMatchOptions {
  signalUrl: string;
  name: string;
  avatar: string;
  userId?: string;
  auth?: () => Promise<string | undefined>;
  onUnauthorised?: () => Promise<void> | void;
  /** The account is banned (socket closed with 4403, or the queue said so). */
  onBanned?: () => Promise<void> | void;
  webSocket?: WebSocketFactory;
  /** Each `queue_status` while the server looks for players. */
  onStatus?: (s: QueueStatus) => void;
  /** The server found a table and the session is joining it. */
  onMatched?: (room: string) => void;
  /**
   * The server answered `seated`: this account still holds a seat at the quick-match table `room`,
   * and the session is going back to it instead of queueing.
   */
  onSeated?: (room: string) => void;
  /** The rejoin token this device saved for `room`, when its saved table is that one. */
  savedToken?: (room: string) => string | undefined;
}

/** `QueueError.code` when the account is seated at a quick-match table that could not be rejoined. */
export const REJOIN_FAILED = 'rejoin_failed';

/**
 * Quick match: queue on the game server, and once it has matched a table, join that table on
 * the same socket and return an ordinary online session (it reconnects and rejoins like any
 * other table; only the matched accounts may enter it, and it starts by itself).
 *
 * `seated` is not a failure: the account still holds a seat at an unfinished quick-match table,
 * so the session goes back to it the way any saved table is resumed (`createOnlineSession`, a
 * join): with the saved rejoin token when this device's saved table is that room, otherwise with
 * none, since a server-hosted table gives a verified account its own seat back and answers with a
 * new token, which is saved like any other. Only when that join fails does the promise reject,
 * with code `rejoin_failed` (or `rate_limited` when the server throttled the join).
 *
 * Otherwise the session promise rejects with a QueueError (`code` banned, age_missing, age_under,
 * rate_limited, sign_in, unavailable, replaced, cancelled) or the usual join errors. `cancel()`
 * leaves the queue.
 */
export function startQuickMatch(opts: QuickMatchOptions): { session: Promise<Session>; cancel: () => void } {
  let cancelled = false;
  let leave: () => void = () => undefined;
  const banned = () => {
    void opts.onBanned?.();
    return new QueueError('This account has been banned', 'banned');
  };
  const backToSeat = async (room: string): Promise<Session> => {
    opts.onSeated?.(room);
    try {
      return await createOnlineSession({
        signalUrl: opts.signalUrl,
        name: opts.name,
        avatar: opts.avatar,
        userId: opts.userId,
        auth: opts.auth,
        onUnauthorised: opts.onUnauthorised,
        onBanned: opts.onBanned,
        webSocket: opts.webSocket,
        rules: DEFAULT_RULES,
        action: 'join',
        code: room,
        token: opts.savedToken?.(room),
        quickMatch: true,
      });
    } catch (e) {
      // `openConnection` has already told the account layer about a ban.
      if ((e as { code?: unknown } | null)?.code === BANNED_CLOSE_CODE) throw new QueueError('This account has been banned', 'banned');
      const message = (e as Error | null)?.message || 'Could not return to the table';
      // The queue and the join draw on one allowance: a throttled join is "wait a few seconds", not a lost table.
      if (friendlyErrorMessage(e).key === 'errors.rateLimited') throw new QueueError(message, 'rate_limited', room);
      throw new QueueError(message, REJOIN_FAILED, room);
    }
  };
  const attempt = async (): Promise<Session> => {
    const auth = opts.auth ? await opts.auth() : undefined;
    const { signaling, closeCode, roomClosed } = connectSignaling(opts.signalUrl, auth, opts.webSocket);
    const dropped: Connection['dropped'] = { handler: null };
    signaling.onClose(() => dropped.handler?.(closeCode(), roomClosed()));
    try {
      await signaling.connect();
    } catch (e) {
      if (closeCode() === UNAUTHORISED_CLOSE || isUnauthorised(e)) throw Object.assign(new Error(UNAUTHORISED_MESSAGE), { code: UNAUTHORISED_CLOSE });
      if (closeCode() === BANNED_CLOSE_CODE) throw banned();
      throw e;
    }
    try {
      if (cancelled) throw new QueueError('Cancelled', 'cancelled');
      const search = signaling.findMatch(opts.onStatus);
      leave = search.cancel;
      let room: string;
      try {
        room = await search.match;
      } catch (e) {
        if (closeCode() === BANNED_CLOSE_CODE || (e instanceof QueueError && e.code === 'banned')) throw banned();
        if (e instanceof QueueError && e.code === 'seated' && e.room && !cancelled) {
          // The queue socket has done its job: the table is resumed on a socket of its own.
          signaling.close();
          return backToSeat(e.room);
        }
        throw e;
      }
      opts.onMatched?.(room);
      const transport = new RelayTransport(signaling, 'game');
      const info = await signaling.joinRoom(room);
      const connection: Connection = { signaling, link: transportLink(transport, info.host), room: info, dropped };
      const online: OnlineOptions = { ...opts, rules: DEFAULT_RULES, action: 'join', code: info.room, quickMatch: true };
      const client = new TableClient(connection.link, opts.name, opts.avatar, { userId: opts.userId });
      const session = new OnlineSession(online, connection, client);
      client.join();
      return session;
    } catch (e) {
      signaling.close();
      throw e;
    }
  };
  const session = (async () => {
    try {
      return await attempt();
    } catch (e) {
      // A stale session token: replace it once and queue again.
      if (cancelled || !isUnauthorised(e) || !opts.onUnauthorised) throw e;
      await opts.onUnauthorised();
      return attempt();
    }
  })();
  return {
    session,
    cancel: () => {
      cancelled = true;
      leave();
    },
  };
}
