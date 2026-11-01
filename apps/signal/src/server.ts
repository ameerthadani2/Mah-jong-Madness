import { createServer } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { RoomRegistry, type Inbound } from './rooms';

const PORT = Number(process.env.PORT ?? 8787);
const ALLOW_HOSTED = process.env.HOST_TABLES !== '0';

const registry = new RoomRegistry({ allowHosted: ALLOW_HOSTED });

const http = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...registry.stats() }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http });

wss.on('connection', (ws: WebSocket) => {
  let peerId = registry.connect({ send: (json) => ws.readyState === ws.OPEN && ws.send(json), close: () => ws.close() });
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
    peerId = registry.handle(peerId, msg);
  });
  ws.on('close', () => registry.disconnect(peerId));
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

setInterval(() => registry.tick(), 500);

http.listen(PORT, () => {
  console.log(`[signal] listening on :${PORT} (hosted tables ${ALLOW_HOSTED ? 'enabled' : 'disabled'})`);
});
