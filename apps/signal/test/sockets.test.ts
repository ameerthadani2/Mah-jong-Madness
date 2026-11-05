/**
 * The socket wiring on a real HTTP + WebSocket server (port 0). Ported from the review
 * probes `verify-signal/big.mjs` and `integration/ws.mjs`: one oversized frame used to
 * crash the whole process because the socket had no 'error' listener.
 */
import { createServer, type Server } from 'node:http';
import { connect as netConnect, type AddressInfo, type Socket as NetSocket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type WebSocketServer } from 'ws';
import { RoomRegistry } from '../src/rooms';
import { createSocketServer, MAX_FRAME_BYTES } from '../src/sockets';

type Frame = { t: string; peerId?: string; room?: string; host?: string; data?: { msg?: { t?: string } } };

let http: Server;
let wss: WebSocketServer;
let rooms: RoomRegistry;
let url: string;
let port: number;
const clients: WebSocket[] = [];

beforeEach(async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  rooms = new RoomRegistry({ allowHosted: true });
  http = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  wss = createSocketServer(http, rooms, { trustProxy: 0 });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  port = (http.address() as AddressInfo).port;
  url = `ws://127.0.0.1:${port}`;
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate();
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => http.close(() => resolve()));
  vi.restoreAllMocks();
});

/** Open a client and collect every JSON frame it receives. */
async function open(): Promise<{ ws: WebSocket; frames: Frame[]; next: (pred: (f: Frame) => boolean) => Promise<Frame> }> {
  const ws = new WebSocket(url);
  clients.push(ws);
  ws.on('error', () => undefined);
  const frames: Frame[] = [];
  const waiters: Array<{ pred: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(String(raw)) as Frame;
    frames.push(f);
    for (const w of [...waiters]) {
      if (w.pred(f)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(f);
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const next = (pred: (f: Frame) => boolean) =>
    new Promise<Frame>((resolve) => {
      const hit = frames.find(pred);
      if (hit) resolve(hit);
      else waiters.push({ pred, resolve });
    });
  return { ws, frames, next };
}

const closed = (ws: WebSocket) => new Promise<number>((resolve) => ws.once('close', (code) => resolve(code)));

/** A client that has said hello and opened a server-hosted table. */
async function seatedClient() {
  const c = await open();
  c.ws.send(JSON.stringify({ t: 'hello' }));
  const hello = await c.next((f) => f.t === 'hello');
  c.ws.send(JSON.stringify({ t: 'create', hosted: true }));
  const room = await c.next((f) => f.t === 'room');
  return { ...c, peerId: hello.peerId!, room: room.room!, host: room.host! };
}

/** Prove the server still routes game traffic for an existing socket and accepts new ones. */
async function expectServerHealthy(alice: Awaited<ReturnType<typeof seatedClient>>) {
  alice.ws.send(JSON.stringify({ t: 'to', to: alice.host, data: { ch: 'game', msg: { t: 'join', name: 'Alice' } } }));
  const welcome = await alice.next((f) => f.t === 'from' && f.data?.msg?.t === 'welcome');
  expect(welcome).toBeDefined();
  const fresh = await open();
  fresh.ws.send(JSON.stringify({ t: 'hello' }));
  expect((await fresh.next((f) => f.t === 'hello')).peerId).toMatch(/^p-/);
  expect(rooms.hasRoom(alice.room)).toBe(true);
}

/** Send one raw, client-masked WebSocket frame (mask key 0) on the socket underneath `ws`. */
function rawFrame(ws: WebSocket, firstByte: number, payload: Buffer): void {
  const sock = (ws as unknown as { _socket: NetSocket })._socket;
  sock.write(Buffer.concat([Buffer.from([firstByte, 0x80 | payload.length, 0, 0, 0, 0]), payload]));
}

describe('socket server resilience', () => {
  it('closes an oversized frame with 1009 and keeps every other socket working', async () => {
    const alice = await seatedClient();
    const mallory = await open();
    const code = closed(mallory.ws);
    mallory.ws.send('x'.repeat(MAX_FRAME_BYTES + 6 * 1024));
    expect(await code).toBe(1009);
    await expectServerHealthy(alice);
  });

  it('closes a frame with a reserved opcode or invalid UTF-8 with 1002/1007 and keeps serving', async () => {
    const alice = await seatedClient();
    const badOpcode = await open();
    let code = closed(badOpcode.ws);
    rawFrame(badOpcode.ws, 0x83, Buffer.alloc(0)); // FIN + reserved opcode 3
    expect(await code).toBe(1002);
    const badText = await open();
    code = closed(badText.ws);
    rawFrame(badText.ws, 0x81, Buffer.from([0xff, 0xfe, 0xfd])); // text frame that is not UTF-8
    expect(await code).toBe(1007);
    await expectServerHealthy(alice);
  });

  it('drops a malformed HTTP request without affecting the server', async () => {
    const alice = await seatedClient();
    const sock = netConnect(port, '127.0.0.1');
    sock.on('error', () => undefined);
    await new Promise<void>((resolve) => sock.once('connect', () => resolve()));
    const ended = new Promise<void>((resolve) => sock.once('close', () => resolve()));
    sock.write('NOT HTTP AT ALL\r\n\r\n');
    await ended;
    await expectServerHealthy(alice);
  });

  it('logs socket server errors instead of throwing', () => {
    expect(() => wss.emit('error', new Error('boom'))).not.toThrow();
  });
});
