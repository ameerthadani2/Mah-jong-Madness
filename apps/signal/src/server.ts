import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApiHandler } from './api';
import { ClubRegistry, type ClubData, type ClubStore } from './clubs';
import { LIMITS, loadConfig } from './config';
import { BucketTable, clientIp, TokenBucket } from './limits';
import { RoomRegistry, type Inbound } from './rooms';

const config = loadConfig();

/**
 * Persistence to a JSON file; replace it with a database once clubs outgrow a single node.
 * Writes are atomic (temp file then rename). A corrupt file is moved aside rather
 * than silently replaced by an empty registry.
 */
function fileStore(path: string): ClubStore {
  return {
    load: () => {
      if (!existsSync(path)) return { clubs: [], credentials: {} };
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as ClubData | unknown[];
        if (Array.isArray(parsed)) return { clubs: parsed as ClubData['clubs'], credentials: {} }; // legacy shape
        return { clubs: parsed.clubs ?? [], credentials: parsed.credentials ?? {} };
      } catch (e) {
        const backup = `${path}.corrupt-${Date.now()}`;
        renameSync(path, backup);
        console.error(`[signal] club store unreadable (${(e as Error).message}); moved to ${backup}`);
        return { clubs: [], credentials: {} };
      }
    },
    save: (data) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, path);
    },
  };
}

const rooms = new RoomRegistry({ allowHosted: config.hostTables, allowP2P: config.p2pRooms, maxHostedTables: config.maxHostedTables });
const clubs = new ClubRegistry({ store: fileStore(join(config.dataDir, 'clubs.json')) });
const httpLimiter = new BucketTable<string>(LIMITS.httpBurst, LIMITS.httpPerSec);
const api = createApiHandler({ clubs, rooms }, { corsOrigins: config.corsOrigins, limiter: httpLimiter, trustProxy: config.trustProxy });

// Keep club table listings in step with the hosted tables, and add results to the standings.
rooms.onRoomEvent(({ room, event }) => {
  const club = clubs.clubForTable(room);
  if (!club) return;
  const players = event.seats.map((s) => ({ seat: s.seat, name: s.name, userId: s.userId, isBot: s.isBot, connected: s.connected }));
  if (event.type === 'match_over' && event.handNumber >= 0) {
    clubs.recordMatch(club.code, event.seats.map((s) => ({ userId: s.userId, points: event.scores[s.seat] ?? 0, handsWon: event.handsWon[s.seat] ?? 0 })));
    clubs.updateTable(club.code, room, { status: 'finished', players, scores: event.scores });
  } else if (event.type === 'match_over') {
    // The room closed: it expired, or every player left for good.
    clubs.removeTable(club.code, room);
  } else {
    const playing = event.type === 'state' || event.type === 'hand_over' || event.handNumber > 0;
    clubs.updateTable(club.code, room, { status: playing ? 'playing' : 'open', players, handNumber: event.handNumber, scores: event.scores });
  }
});

const http = createServer((req, res) => {
  api(req, res)
    .then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    })
    .catch((e: Error) => {
      console.error('[signal] api error', e.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    });
});

// 64 KiB is far larger than any legitimate game frame; ws drops bigger payloads.
const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 });
/** Open sockets per client IP. */
const socketsByIp = new Map<string, number>();
/** WebSocket close code 1008 means "policy violation". */
const POLICY_VIOLATION = 1008;

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
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
  if (open > LIMITS.socketsPerIp) {
    ws.close(POLICY_VIOLATION, 'Too many connections');
    return;
  }

  let peerId = rooms.connect({ send: (json) => ws.readyState === ws.OPEN && ws.send(json), close: () => ws.close() });
  const bucket = new TokenBucket(LIMITS.messageBurst, LIMITS.messagesPerSec);
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
      msg = JSON.parse(raw.toString()) as Inbound;
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
  }, 30_000);
  ws.on('close', () => clearInterval(hb));
});

setInterval(() => {
  try {
    rooms.tick();
  } catch (e) {
    console.error('[signal] tick error', (e as Error).message);
  }
}, 500);

http.listen(config.port, () => {
  console.log(
    `[signal] listening on :${config.port} (hosted tables ${config.hostTables ? `enabled, up to ${config.maxHostedTables}` : 'disabled'}, relay-only rooms ${config.p2pRooms ? 'enabled' : 'disabled'}, CORS ${config.corsOrigins.length ? config.corsOrigins.join(' ') : 'same origin only'}, data in ${config.dataDir})`,
  );
});
