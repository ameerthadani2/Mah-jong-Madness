/**
 * WebSocket wiring for the game server: per-IP socket cap, per-socket message
 * bucket, heartbeat, and routing of each frame into the room registry. Kept apart
 * from `server.ts` (the entry point) so tests can run it on a real socket server.
 *
 * Nothing a client sends may bring the process down. `ws` reports an oversized
 * or malformed frame by emitting `'error'` on the socket, and Node treats an
 * `'error'` event with no listener as an uncaught exception, so every socket,
 * the socket server and the HTTP server each get an error listener.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { LIMITS, type SignalConfig } from './config';
import { clientIp, TokenBucket } from './limits';
import type { Inbound, RoomRegistry } from './rooms';

/** Largest frame accepted, far above any legitimate game message. `ws` closes the socket with 1009 when a frame is bigger. */
export const MAX_FRAME_BYTES = 64 * 1024;
/** WebSocket close code 1008 means "policy violation". */
export const POLICY_VIOLATION = 1008;
const HEARTBEAT_MS = 30_000;

export type SocketLimits = Pick<typeof LIMITS, 'socketsPerIp' | 'messagesPerSec' | 'messageBurst'>;

/** Attach the connection handler to `wss`. Returns a function that reports open sockets per IP (for tests and health checks). */
export function attachSocketHandlers(
  wss: WebSocketServer,
  rooms: RoomRegistry,
  config: Pick<SignalConfig, 'trustProxy'>,
  limits: SocketLimits = LIMITS,
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

    let peerId = rooms.connect({ send: (json) => ws.readyState === ws.OPEN && ws.send(json), close: () => ws.close() });
    const bucket = new TokenBucket(limits.messageBurst, limits.messagesPerSec);
    let alive = true;
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
      try {
        peerId = rooms.handle(peerId, msg);
      } catch (e) {
        // One peer's bad frame must never bring the server down.
        console.error('[signal] handle error', (e as Error).message);
      }
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

/** Create the WebSocket server on `http` with the frame cap, and wire every handler. */
export function createSocketServer(
  http: Server,
  rooms: RoomRegistry,
  config: Pick<SignalConfig, 'trustProxy'>,
  limits: SocketLimits = LIMITS,
): WebSocketServer {
  guardHttpServer(http);
  const wss = new WebSocketServer({ server: http, maxPayload: MAX_FRAME_BYTES });
  attachSocketHandlers(wss, rooms, config, limits);
  return wss;
}
