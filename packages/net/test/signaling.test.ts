import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIGNALING_TIMEOUT_MESSAGE, SIGNALING_TIMEOUT_MS, SignalingClient, type WebSocketLike } from '../src/signaling';

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
  drop(): void {
    this.readyState = 3;
    this.onclose?.({});
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
    expect(vi.getTimerCount()).toBe(0);
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
});
