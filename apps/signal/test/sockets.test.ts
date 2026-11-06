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

describe('session handshake', () => {
  /** A second server on the same registry whose sockets must prove a session; 'good' is the only valid token. */
  async function authServer(helloTimeoutMs = 10_000) {
    const http2 = createServer();
    const verify = vi.fn(async (token: unknown) => {
      await new Promise((r) => setTimeout(r, 20)); // a database round trip
      if (token !== 'good') throw new Error('bad token');
      return 'user-verified-1';
    });
    const wss2 = createSocketServer(http2, rooms, { trustProxy: 0 }, undefined, { verify, helloTimeoutMs });
    await new Promise<void>((resolve) => http2.listen(0, '127.0.0.1', resolve));
    const url2 = `ws://127.0.0.1:${(http2.address() as AddressInfo).port}`;
    const stop = async () => {
      for (const c of wss2.clients) c.terminate();
      await new Promise<void>((resolve) => wss2.close(() => resolve()));
      await new Promise<void>((resolve) => http2.close(() => resolve()));
    };
    return { url2, verify, stop };
  }

  it('closes with 4401 unless the first frame is a hello with a valid token, and handles frames sent during the check in order', async () => {
    const { url2, verify, stop } = await authServer();
    try {
      const attempt = (frames: unknown[]) =>
        new Promise<{ code: number; frames: Frame[] }>((resolve) => {
          const ws = new WebSocket(url2);
          clients.push(ws);
          const got: Frame[] = [];
          ws.on('error', () => undefined);
          ws.on('message', (raw) => got.push(JSON.parse(String(raw)) as Frame));
          ws.on('open', () => frames.forEach((f) => ws.send(JSON.stringify(f))));
          ws.on('close', (code) => resolve({ code, frames: got }));
          // A socket that stays open is closed by the test once it has had its answers.
          setTimeout(() => ws.close(), 300);
        });
      expect((await attempt([{ t: 'hello' }])).code).toBe(4401);
      expect((await attempt([{ t: 'create', hosted: true }])).code).toBe(4401);
      expect((await attempt([{ t: 'hello', auth: 'bad' }])).code).toBe(4401);
      expect(verify).toHaveBeenCalledTimes(1); // only a hello with a token reaches the verifier
      // A valid token: the create sent before the answer is handled after the hello, as this user.
      const ok = await attempt([{ t: 'hello', auth: 'good' }, { t: 'create', hosted: true }]);
      expect(ok.code).toBe(1005);
      expect(ok.frames.map((f) => f.t)).toEqual(['hello', 'room']);
      expect(ok.frames[0]).toMatchObject({ userId: 'user-verified-1' });
      expect((ok.frames[0] as { id?: string }).id).toBe(ok.frames[0].peerId);
    } finally {
      await stop();
    }
  });

  it('checks the session again before a create or join, and ends a verified socket with 4401 once its session is revoked', async () => {
    const http2 = createServer();
    // 'good' verifies while `valid` holds; the verifier also names the session so the registry can end it.
    let valid = true;
    const verify = vi.fn(async (token: unknown) => {
      await new Promise((r) => setTimeout(r, 5));
      if (token !== 'good' || !valid) throw new Error('bad token');
      return { userId: 'user-verified-2', sessionId: 'session-2' };
    });
    const wss2 = createSocketServer(http2, rooms, { trustProxy: 0 }, undefined, { verify });
    await new Promise<void>((resolve) => http2.listen(0, '127.0.0.1', resolve));
    const url2 = `ws://127.0.0.1:${(http2.address() as AddressInfo).port}`;
    try {
      const connect = async () => {
        const ws = new WebSocket(url2);
        clients.push(ws);
        ws.on('error', () => undefined);
        const frames: Frame[] = [];
        ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Frame));
        const done = closed(ws);
        await new Promise<void>((resolve) => ws.once('open', () => resolve()));
        ws.send(JSON.stringify({ t: 'hello', auth: 'good' }));
        await vi.waitFor(() => expect(frames.some((f) => f.t === 'hello')).toBe(true));
        return { ws, frames, done };
      };
      // A live session creates a table (the token is checked again for it).
      const a = await connect();
      a.ws.send(JSON.stringify({ t: 'create', hosted: true }));
      await vi.waitFor(() => expect(a.frames.some((f) => f.t === 'room')).toBe(true));
      expect(verify).toHaveBeenCalledTimes(2);
      // The session ends on the API side: the registry closes its socket at once.
      expect(rooms.endSessions({ sessionId: 'session-2' })).toBe(1);
      expect(await a.done).toBe(4401);
      // A session that expired quietly: the next create is refused and the socket closed, nothing is opened.
      const b = await connect();
      valid = false;
      const before = rooms.stats().rooms;
      b.ws.send(JSON.stringify({ t: 'create', hosted: true }));
      expect(await b.done).toBe(4401);
      expect(b.frames.map((f) => f.t)).toEqual(['hello']);
      expect(rooms.stats().rooms).toBe(before);
    } finally {
      for (const c of wss2.clients) c.terminate();
      await new Promise<void>((resolve) => wss2.close(() => resolve()));
      await new Promise<void>((resolve) => http2.close(() => resolve()));
    }
  });

  it('closes a socket that never says hello', async () => {
    const { url2, stop } = await authServer(50);
    try {
      const ws = new WebSocket(url2);
      clients.push(ws);
      ws.on('error', () => undefined);
      expect(await closed(ws)).toBe(4401);
    } finally {
      await stop();
    }
  });
});
