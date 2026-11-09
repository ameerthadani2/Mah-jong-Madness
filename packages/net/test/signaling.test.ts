import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BANNED_CLOSE_CODE,
  BANNED_MESSAGE,
  HEARTBEAT_CLOSE_CODE,
  HEARTBEAT_MS,
  PONG_TIMEOUT_MS,
  QueueError,
  SIGNALING_TIMEOUT_MESSAGE,
  SIGNALING_TIMEOUT_MS,
  SignalingClient,
  UNAUTHORISED_CLOSE_CODE,
  type QueueStatus,
  type SignalingTimers,
  type WebSocketLike,
} from '../src/signaling';

/** A scriptable stand-in for the browser WebSocket, handed to SignalingClient through its factory. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSays(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code?: number): void {
    this.readyState = 3;
    this.onclose?.(code === undefined ? {} : { code });
  }
}

function client() {
  const sockets: FakeSocket[] = [];
  const c = new SignalingClient('ws://test', () => {
    const s = new FakeSocket();
    sockets.push(s);
    return s;
  });
  return { c, socket: () => sockets[sockets.length - 1] };
}

async function connected() {
  const { c, socket } = client();
  const p = c.connect();
  socket().open();
  socket().serverSays({ t: 'hello', peerId: 'p-1' });
  await expect(p).resolves.toBe('p-1');
  return { c, ws: socket() };
}

describe('SignalingClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends hello on open and resolves with the server-assigned id', async () => {
    const { c, ws } = await connected();
    expect(ws.sent[0]).toEqual({ t: 'hello' });
    expect(c.peerId).toBe('p-1');
  });

  it('gives up on connect after 10 s without a hello, quietly closing the socket', async () => {
    const { c, socket } = client();
    const closes = vi.fn();
    c.onClose(closes);
    const p = c.connect();
    const assertion = expect(p).rejects.toThrow(SIGNALING_TIMEOUT_MESSAGE);
    socket().open(); // TCP opened, but the server never says hello
    await vi.advanceTimersByTimeAsync(SIGNALING_TIMEOUT_MS - 1);
    expect(socket().closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(socket().closed).toBe(true);
    expect(closes).not.toHaveBeenCalled();
    // A late hello on the abandoned socket is ignored.
    socket().serverSays({ t: 'hello', peerId: 'late' });
    expect(c.peerId).toBeNull();
    await expect(c.joinRoom('ABCDEF')).rejects.toThrow('Not connected');
  });

  it('rejects connect immediately when the socket closes before hello', async () => {
    const { c, socket } = client();
    const p = c.connect();
    socket().drop();
    await expect(p).rejects.toThrow('Connection closed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('createHostedRoom sends a hosted create with rules and bot skill and resolves with the room', async () => {
    const { c, ws } = await connected();
    const p = c.createHostedRoom({ handsPerMatch: 4 }, 'pro');
    expect(ws.sent[1]).toEqual({ t: 'create', hosted: true, rules: { handsPerMatch: 4 }, botSkill: 'pro' });
    ws.serverSays({ t: 'room', room: 'ABC234', peers: ['p-1', 'server-ABC234'], host: 'server-ABC234' });
    await expect(p).resolves.toEqual({ room: 'ABC234', peers: ['p-1', 'server-ABC234'], host: 'server-ABC234' });
    expect(c.room?.host).toBe('server-ABC234');
    // The request's timer is gone; only the heartbeat's interval remains.
    expect(vi.getTimerCount()).toBe(1);
  });

  it('rejects a room request with the server error message', async () => {
    const { c, ws } = await connected();
    const p = c.joinRoom('nope99');
    expect(ws.sent[1]).toEqual({ t: 'join', room: 'NOPE99' });
    ws.serverSays({ t: 'error', message: 'Room not found or full' });
    await expect(p).rejects.toThrow('Room not found or full');
  });

  it('times out a room request after 10 s, and a late reply does not resolve the next request', async () => {
    const { c, ws } = await connected();
    const first = c.joinRoom('SLOW01');
    const firstFails = expect(first).rejects.toThrow(SIGNALING_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(SIGNALING_TIMEOUT_MS);
    await firstFails;
    const second = c.createHostedRoom({}, 'club');
    let settled = false;
    second.then(
      () => (settled = true),
      () => (settled = true),
    );
    // The overdue answer to the first request arrives now; it belongs to that request, not this one.
    ws.serverSays({ t: 'error', message: 'Room not found or full' });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    ws.serverSays({ t: 'room', room: 'NEW234', peers: ['p-1', 'server-NEW234'], host: 'server-NEW234' });
    await expect(second).resolves.toMatchObject({ room: 'NEW234' });
  });

  it('rejects pending requests and fires close handlers when the connection drops', async () => {
    const { c, ws } = await connected();
    const closes = vi.fn();
    c.onClose(closes);
    const p = c.joinRoom('ABCDEF');
    ws.drop();
    await expect(p).rejects.toThrow('Connection closed');
    expect(closes).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('honours a custom timeout', async () => {
    const sockets: FakeSocket[] = [];
    const c = new SignalingClient('ws://test', () => (sockets.push(new FakeSocket()), sockets[sockets.length - 1]), { timeoutMs: 500 });
    const p = c.connect();
    const assertion = expect(p).rejects.toThrow(SIGNALING_TIMEOUT_MESSAGE);
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('takes an options object: the session token goes in hello and the server-verified user is kept', async () => {
    const sockets: FakeSocket[] = [];
    const c = new SignalingClient('ws://test', { auth: 'mjs_token', webSocket: () => (sockets.push(new FakeSocket()), sockets[sockets.length - 1]) });
    const p = c.connect();
    sockets[0].open();
    expect(sockets[0].sent[0]).toEqual({ t: 'hello', auth: 'mjs_token' });
    // The current server names the id `id`; `peerId` is the older spelling, still read.
    sockets[0].serverSays({ t: 'hello', id: 'p-9', userId: 'user-1' });
    await expect(p).resolves.toBe('p-9');
    expect(c.userId).toBe('user-1');
    // A refreshed token is used for the next connection.
    c.setAuth('mjs_next');
    const again = c.connect();
    sockets[1].open();
    expect(sockets[1].sent[0]).toEqual({ t: 'hello', auth: 'mjs_next' });
    sockets[1].serverSays({ t: 'hello', peerId: 'p-10' });
    await expect(again).resolves.toBe('p-10');
    expect(c.userId).toBeNull();
  });

  it('rejects connect with an Unauthorised error when the server closes with 4401', async () => {
    const { c, socket } = client();
    const closes = vi.fn();
    c.onClose(closes);
    const p = c.connect();
    socket().open();
    socket().drop(UNAUTHORISED_CLOSE_CODE);
    await expect(p).rejects.toThrow(/^Unauthorised/);
    expect(c.lastCloseCode).toBe(4401);
    expect(vi.getTimerCount()).toBe(0);
    // Any other close is still a plain closed connection.
    const second = client();
    const q = second.c.connect();
    second.socket().drop(1006);
    await expect(q).rejects.toThrow('Connection closed');
  });

  it('treats an unprompted closed error as the room ending: it clears the room and fires close handlers without consuming a pending request', async () => {
    const { c, ws } = await connected();
    const joined = c.joinRoom('ABC234');
    ws.serverSays({ t: 'room', room: 'ABC234', peers: ['p-1', 'p-2'], host: 'p-2' });
    await joined;
    const closes = vi.fn();
    c.onClose(closes);
    const next = c.createHostedRoom({}, 'club');
    ws.serverSays({ t: 'error', code: 'closed', message: 'The host left, so the room has closed' });
    expect(c.room).toBeNull();
    expect(closes).toHaveBeenCalledTimes(1);
    // The pending create still waits for its own answer.
    ws.serverSays({ t: 'room', room: 'NEW234', peers: ['p-1', 'server-NEW234'], host: 'server-NEW234' });
    await expect(next).resolves.toMatchObject({ room: 'NEW234' });
  });

  it('sends the club code with a club table create', async () => {
    const { c, ws } = await connected();
    void c.createHostedRoom({ handsPerMatch: 4 }, 'pro', { club: 'CLUB22' });
    expect(ws.sent[1]).toEqual({ t: 'create', hosted: true, rules: { handsPerMatch: 4 }, botSkill: 'pro', club: 'CLUB22' });
  });
});

describe('SignalingClient heartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const pings = (ws: FakeSocket) => ws.sent.filter((m) => m.t === 'ping').length;

  it('pings every 15 s once connected and keeps a link that answers', async () => {
    expect(HEARTBEAT_MS).toBe(15_000);
    expect(PONG_TIMEOUT_MS).toBe(10_000);
    const { c, socket } = client();
    const p = c.connect();
    socket().open();
    // Nothing before the hello: the first frame must be the session.
    await vi.advanceTimersByTimeAsync(5_000);
    socket().serverSays({ t: 'hello', peerId: 'p-1' });
    await p;
    const ws = socket();
    const closes = vi.fn();
    c.onClose(closes);
    for (let i = 1; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
      expect(pings(ws)).toBe(i);
      await vi.advanceTimersByTimeAsync(1_000);
      ws.serverSays({ t: 'pong' });
    }
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);
    expect(ws.closed).toBe(false);
    expect(closes).not.toHaveBeenCalled();
  });

  it('closes a half-open link 10 s after an unanswered ping and fires the close handlers at once', async () => {
    const { c, ws } = await connected();
    const closes = vi.fn();
    c.onClose(closes);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(pings(ws)).toBe(1);
    // A request made while the link is already dead fails with the link, not after its own timeout.
    const pending = c.joinRoom('ABC234');
    pending.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS - 1);
    expect(closes).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    // Detected within 25 s of the link going quiet.
    expect(ws.closed).toBe(true);
    expect(closes).toHaveBeenCalledTimes(1);
    expect(c.lastCloseCode).toBe(HEARTBEAT_CLOSE_CODE);
    await expect(pending).rejects.toThrow('Connection closed');
    // The socket's own close event, if it ever comes, changes nothing.
    ws.drop(1006);
    expect(closes).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('counts any frame from the server as an answer, and stops after close()', async () => {
    const { c, ws } = await connected();
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    ws.serverSays({ t: 'peer', peerId: 'p-2', event: 'join' });
    await vi.advanceTimersByTimeAsync(PONG_TIMEOUT_MS);
    expect(ws.closed).toBe(false);
    c.close();
    const before = pings(ws);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 3);
    expect(pings(ws)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses injected timers, and none when the heartbeat is off', async () => {
    const intervals: Array<{ cb: () => void; ms: number }> = [];
    const timeouts: Array<{ cb: () => void; ms: number }> = [];
    const timers: SignalingTimers = {
      setInterval: (cb, ms) => (intervals.push({ cb, ms }), intervals.length),
      clearInterval: () => undefined,
      setTimeout: (cb, ms) => (timeouts.push({ cb, ms }), timeouts.length),
      clearTimeout: () => undefined,
    };
    const sockets: FakeSocket[] = [];
    const c = new SignalingClient('ws://test', { webSocket: () => (sockets.push(new FakeSocket()), sockets[sockets.length - 1]), heartbeatMs: 1_000, pongTimeoutMs: 500, timers });
    const closes = vi.fn();
    c.onClose(closes);
    const p = c.connect();
    sockets[0].open();
    sockets[0].serverSays({ t: 'hello', peerId: 'p-1' });
    await p;
    expect(intervals.map((i) => i.ms)).toEqual([1_000]);
    intervals[0].cb();
    expect(sockets[0].sent.at(-1)).toEqual({ t: 'ping' });
    expect(timeouts.map((t) => t.ms)).toEqual([500]);
    timeouts[0].cb();
    expect(closes).toHaveBeenCalledTimes(1);
    expect(sockets[0].closed).toBe(true);

    const off = new SignalingClient('ws://test', { webSocket: () => (sockets.push(new FakeSocket()), sockets[sockets.length - 1]), heartbeatMs: 0 });
    const q = off.connect();
    sockets[1].open();
    sockets[1].serverSays({ t: 'hello', peerId: 'p-2' });
    await q;
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SignalingClient quick match', () => {
  it('sends queue, reports each status and resolves with the matched room; room requests are unaffected', async () => {
    const { c, ws } = await connected();
    const statuses: QueueStatus[] = [];
    const { match } = c.findMatch((st) => statuses.push(st));
    expect(ws.sent.at(-1)).toEqual({ t: 'queue', preset: 'normal' });
    ws.serverSays({ t: 'queue_status', position: 1, waitedMs: 0, humans: 1, fillMs: 20_000 });
    ws.serverSays({ t: 'queue_status', position: 1, waitedMs: 2000, humans: 2, fillMs: 20_000 });
    ws.serverSays({ t: 'matched', room: 'QM1234', humans: 2, bots: 2 });
    await expect(match).resolves.toBe('QM1234');
    expect(statuses.map((st) => st.humans)).toEqual([1, 2]);
    const join = c.joinRoom('QM1234');
    ws.serverSays({ t: 'room', room: 'QM1234', peers: ['p-1', 'server-QM1234'], host: 'server-QM1234' });
    await expect(join).resolves.toMatchObject({ room: 'QM1234' });
  });

  it('rejects with the refusal code, and cancel leaves the queue', async () => {
    const { c, ws } = await connected();
    const refused = c.findMatch();
    ws.serverSays({ t: 'queue_error', code: 'age_required', message: 'Quick match needs your birth year' });
    await expect(refused.match).rejects.toBeInstanceOf(QueueError);
    await expect(refused.match).rejects.toMatchObject({ code: 'age_required' });
    const waiting = c.findMatch();
    waiting.cancel();
    expect(ws.sent.at(-1)).toEqual({ t: 'leave_queue' });
    await expect(waiting.match).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('a dropped connection rejects the search; a ban closes with 4403 and connect says so', async () => {
    const { c, ws } = await connected();
    const search = c.findMatch();
    ws.drop(BANNED_CLOSE_CODE);
    await expect(search.match).rejects.toThrow('Connection closed');
    expect(c.lastCloseCode).toBe(BANNED_CLOSE_CODE);
    const { c: c2, socket } = client();
    const p = c2.connect();
    socket().open();
    socket().drop(BANNED_CLOSE_CODE);
    await expect(p).rejects.toThrow(BANNED_MESSAGE);
  });
});
