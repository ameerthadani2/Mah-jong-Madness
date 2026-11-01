import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { createApiHandler } from './api';
import { ClubRegistry, type Club, type ClubStore } from './clubs';
import { RoomRegistry, type Inbound } from './rooms';

const PORT = Number(process.env.PORT ?? 8787);
const ALLOW_HOSTED = process.env.HOST_TABLES !== '0';
const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');

/** JSON-file persistence; swap for a database when clubs outgrow one node. */
function fileStore(path: string): ClubStore {
  return {
    load: () => {
      try {
        return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Club[]) : [];
      } catch {
        return [];
      }
    },
    save: (clubs) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(clubs));
    },
  };
}

const rooms = new RoomRegistry({ allowHosted: ALLOW_HOSTED });
const clubs = new ClubRegistry({ store: fileStore(join(DATA_DIR, 'clubs.json')) });
const api = createApiHandler({ clubs, rooms });

// Keep club table listings in sync with the hosted tables and fold results into standings.
rooms.onRoomEvent(({ room, event }) => {
  const club = clubs.clubForTable(room);
  if (!club) return;
  const players = event.seats.map((s) => ({ seat: s.seat, name: s.name, userId: s.userId, isBot: s.isBot, connected: s.connected }));
  if (event.type === 'match_over' && event.handNumber >= 0) {
    clubs.recordMatch(club.code, event.seats.map((s) => ({ userId: s.userId, points: event.scores[s.seat] ?? 0, handsWon: 0 })));
    clubs.updateTable(club.code, room, { status: 'finished', players, scores: event.scores });
  } else if (event.type === 'match_over') {
    // Room closed (expired or everyone left for good).
    clubs.removeTable(club.code, room);
  } else {
    const playing = event.type === 'state' || event.type === 'hand_over' || event.handNumber > 0;
    clubs.updateTable(club.code, room, { status: playing ? 'playing' : 'open', players, handNumber: event.handNumber, scores: event.scores });
  }
});

const http = createServer((req, res) => {
  void api(req, res).then((handled) => {
    if (!handled) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    }
  });
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws: WebSocket) => {
  let peerId = rooms.connect({ send: (json) => ws.readyState === ws.OPEN && ws.send(json), close: () => ws.close() });
  let alive = true;
  ws.on('pong', () => (alive = true));
  ws.on('message', (raw) => {
    let msg: Inbound;
    try {
      msg = JSON.parse(raw.toString()) as Inbound;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof (msg as { t?: unknown }).t !== 'string') return;
    peerId = rooms.handle(peerId, msg);
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

setInterval(() => rooms.tick(), 500);

http.listen(PORT, () => {
  console.log(`[signal] listening on :${PORT} (hosted tables ${ALLOW_HOSTED ? 'enabled' : 'disabled'}, data in ${DATA_DIR})`);
});
