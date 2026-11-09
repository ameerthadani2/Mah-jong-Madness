/**
 * WebSocket wiring for the game server: per-IP socket cap, per-socket message
 * bucket, heartbeat, and routing of each frame into the room registry. Kept apart
 * from `server.ts` (the entry point) so tests can run it on a real socket server.
 *
 * Nothing a client sends may bring the process down. `ws` reports an oversized
 * or malformed frame by emitting `'error'` on the socket, and Node treats an
 * `'error'` event with no listener as an uncaught exception, so every socket,
 * the socket server and the HTTP server each get an error listener.
 *
 * With a session verifier (the real server), the first frame must be `{t:'hello', auth}`; until
 * the token is verified nothing else is routed (frames sent meanwhile wait, in order), and a
 * missing or rejected token closes the socket with 4401. The token is checked again before every
 * `create` and `join`, so a session that has since expired or been revoked cannot open or enter a
 * table; a revocation also closes the socket at once through `RoomRegistry.endSessions`.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIMITS, type SignalConfig } from './config';
import { clientIp, TokenBucket } from './limits';
import { reportError } from './observability';
import { SESSION_ENDED, type Inbound, type RoomRegistry } from './rooms';

/** Largest frame accepted, far above any legitimate game message. `ws` closes the socket with 1009 when a frame is bigger. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** WebSocket close code 1008 means "policy violation". */
export const POLICY_VIOLATION = 1008;
/** Application close code for a missing, malformed or rejected session token in the first frame (and for a session that ends later). */
export const UNAUTHORISED = SESSION_ENDED;
/** WebSocket close code 1013 means "try again later": the session could not be checked (the database is down), not that it is bad. */
export const TRY_AGAIN_LATER = 1013;

/**
 * Thrown by a verifier that could not check the token at all (the database did not answer). The
 * socket is closed with 1013 instead of 4401, so the app retries instead of asking the player to
 * sign in again.
 */
export class VerifyUnavailable extends Error {
  constructor(message = 'The session could not be checked') {
    super(message);
    this.name = 'VerifyUnavailable';
  }
}
const HEARTBEAT_MS = 30_000;
/** How long a new socket has to send a verified `hello` before it is closed with 4401. */
const HELLO_TIMEOUT_MS = 10_000;
/** Frames a client may send while its token is still being checked; they are handled in order once it passes. */
const MAX_QUEUED_FRAMES = 16;

export type SocketLimits = Pick<typeof LIMITS, 'socketsPerIp' | 'messagesPerSec' | 'messageBurst'>;

/** What a verifier says about a session token: the user, the session itself when known, and the account's display name. */
export type VerifiedToken = string | { userId: string; sessionId?: string; name?: string };

export interface SocketAuthOptions {
  /**
   * Resolve the session token in the first frame (`{t:'hello', auth}`) to its user id (and session
   * id), or reject. When set, every socket must authenticate before anything else, and the token
   * is checked again before each `create` or `join`; when absent (unit tests of the relay alone),
   * `hello` needs no token and peers have no user.
   */
  verify?: (token: unknown) => Promise<VerifiedToken>;
  helloTimeoutMs?: number;
}

/** Frames that open or enter a table: the session is verified again before each one. */
const RECHECKED = new Set<string>(['create', 'join']);

/** Attach the connection handler to `wss`. Returns a function that reports open sockets per IP (for tests and health checks). */
export function attachSocketHandlers(
  wss: WebSocketServer,
  rooms: RoomRegistry,
  config: Pick<SignalConfig, 'trustProxy'>,
  limits: SocketLimits = LIMITS,
  auth: SocketAuthOptions = {},
): () => ReadonlyMap<string, number> {
  /** Open sockets per client IP. */
  const socketsByIp = new Map<string, number>();

  wss.on('error', (e: Error) => console.error('[signal] socket server error', e.message));

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    // Registered first: an oversized or malformed frame emits 'error' on the socket, and without
    // a listener that is an uncaught exception that takes down every table on the server.
    // `ws` has already queued the close frame (1009 or 1002) by the time this runs.
    ws.on('error', (e: Error) => {
      console.error('[signal] socket error', e.message);
      ws.terminate();
    });

    const ip = clientIp(req, config.trustProxy);
    const open = (socketsByIp.get(ip) ?? 0) + 1;
    socketsByIp.set(ip, open);
    let counted = true;
    const release = () => {
      if (!counted) return;
      counted = false;
      const left = (socketsByIp.get(ip) ?? 1) - 1;
      if (left > 0) socketsByIp.set(ip, left);
      else socketsByIp.delete(ip);
    };
    ws.on('close', release);
    if (open > limits.socketsPerIp) {
      ws.close(POLICY_VIOLATION, 'Too many connections');
      return;
    }

    let peerId = rooms.connect({ send: (json) => ws.readyState === ws.OPEN && ws.send(json), close: (code, reason) => ws.close(code, reason) }, ip);
    const bucket = new TokenBucket(limits.messageBurst, limits.messagesPerSec);
    let alive = true;
    let closed = false;
    ws.on('close', () => (closed = true));
    // Without a verifier the socket starts out ready; with one it must first prove a session.
    let stage: 'hello' | 'verifying' | 'ready' = auth.verify ? 'hello' : 'ready';
    const queued: Inbound[] = [];
    const unauthorised = (e?: unknown) => {
      if (closed) return;
      if (e instanceof VerifyUnavailable) ws.close(TRY_AGAIN_LATER, 'Try again later');
      else ws.close(UNAUTHORISED, 'Unauthorised');
    };
    const helloTimer = auth.verify ? setTimeout(() => stage !== 'ready' && unauthorised(), auth.helloTimeoutMs ?? HELLO_TIMEOUT_MS) : null;
    ws.on('close', () => helloTimer && clearTimeout(helloTimer));
    const dispatch = (msg: Inbound) => {
      try {
        peerId = rooms.handle(peerId, msg);
      } catch (e) {
        // One peer's bad frame must never bring the server down.
        console.error('[signal] handle error', (e as Error).message);
        reportError(e, { where: 'socket', frame: msg.t });
      }
    };
    /** The token the socket proved in `hello`, checked again before each create or join. */
    let sessionToken: string | null = null;
    const authenticate = (msg: Inbound) => {
      const token = (msg as { auth?: unknown }).auth;
      if (msg.t !== 'hello' || typeof token !== 'string' || !token) return unauthorised();
      stage = 'verifying';
      auth.verify!(token).then(
        (verified) => {
          if (closed) return;
          stage = 'ready';
          sessionToken = token;
          if (helloTimer) clearTimeout(helloTimer);
          const { userId, sessionId, name } = typeof verified === 'string' ? { userId: verified, sessionId: undefined, name: undefined } : verified;
          peerId = rooms.hello(peerId, userId, sessionId, name);
          for (const m of queued.splice(0)) dispatch(m);
        },
        (e: unknown) => unauthorised(e),
      );
    };
    /** Check the session still stands before a create or join; the frame (and any that follow) waits for the answer. */
    const recheck = (msg: Inbound) => {
      stage = 'verifying';
      queued.push(msg);
      auth.verify!(sessionToken).then(
        (verified) => {
          if (closed) return;
          stage = 'ready';
          // The player may have renamed themselves since `hello`: sit down under the current name.
          if (typeof verified !== 'string') rooms.setPeerName(peerId, verified.name);
          for (const m of queued.splice(0)) dispatch(m);
        },
        (e: unknown) => unauthorised(e),
      );
    };
    ws.on('pong', () => (alive = true));
    ws.on('message', (raw) => {
      if (!bucket.take()) {
        // A client that floods the relay is dropped, not slowed down: honest clients stay far below the limit.
        ws.close(POLICY_VIOLATION, 'Rate limit exceeded');
        return;
      }
      let msg: Inbound;
      try {
        msg = JSON.parse(String(raw)) as Inbound;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
      if (stage === 'hello') return authenticate(msg);
      if (stage === 'verifying') {
        if (queued.length >= MAX_QUEUED_FRAMES) ws.close(POLICY_VIOLATION, 'Rate limit exceeded');
        else queued.push(msg);
        return;
      }
      if (sessionToken !== null && RECHECKED.has(msg.t)) return recheck(msg);
      dispatch(msg);
    });
    ws.on('close', () => rooms.disconnect(peerId));
    const hb = setInterval(() => {
      if (!alive) {
        clearInterval(hb);
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    ws.on('close', () => clearInterval(hb));
  });

  return () => socketsByIp;
}

/**
 * A malformed HTTP request (bad request line, oversized headers, a reset mid-request)
 * is reported as `'clientError'`. The connection is simply dropped.
 */
export function guardHttpServer(http: Server): void {
  http.on('clientError', (err: NodeJS.ErrnoException, socket: Duplex) => {
    if (!socket.destroyed) socket.destroy();
    if (err.code !== 'ECONNRESET') console.error('[signal] http client error', err.message);
  });
}

/**
 * Create the WebSocket server on `http` with the frame cap, and wire every handler. While
 * `accepting()` is false (the server is shutting down) an upgrade is answered 503 and no socket opens.
 */
export function createSocketServer(
  http: Server,
  rooms: RoomRegistry,
  config: Pick<SignalConfig, 'trustProxy'>,
  limits: SocketLimits = LIMITS,
  auth: SocketAuthOptions = {},
  accepting: () => boolean = () => true,
): WebSocketServer {
  guardHttpServer(http);
  const wss = new WebSocketServer({
    server: http,
    maxPayload: MAX_FRAME_BYTES,
    verifyClient: (_info, done) => (accepting() ? done(true) : done(false, 503, 'Server is restarting')),
  });
  attachSocketHandlers(wss, rooms, config, limits, auth);
  return wss;
}

