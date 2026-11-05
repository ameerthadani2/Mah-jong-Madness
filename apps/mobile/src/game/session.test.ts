import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES } from '@mjm/engine';
import { createLocalSession, createOnlineSession } from './session';

/** A scripted signalling server behind a fake WebSocket: records every frame and answers hello/create/join. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static reply: (frame: Record<string, unknown>) => Record<string, unknown> | null = () => null;
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    const answer = frame.t === 'hello' ? { t: 'hello', peerId: 'p-me' } : FakeSocket.reply(frame);
    if (answer) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(answer) }));
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({});
  }
}

const base = { signalUrl: 'wss://game.example/ws', name: 'Tester', avatar: 'lady', userId: 'user-123456', rules: DEFAULT_RULES };

beforeEach(() => {
  FakeSocket.last = null;
  FakeSocket.reply = (f) => (f.t === 'create' || f.t === 'join' ? { t: 'room', room: 'ABC123', peers: ['p-me', 'server-1'], host: 'server-1' } : null);
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createOnlineSession', () => {
  it('always asks the server to host a new table, with the rules and bot skill', async () => {
    const s = await createOnlineSession({ ...base, action: 'create', botSkill: 'club' });
    const ws = FakeSocket.last!;
    expect(ws.url).toBe(base.signalUrl);
    expect(ws.sent.find((f) => f.t === 'create')).toEqual({ t: 'create', hosted: true, rules: DEFAULT_RULES, botSkill: 'club' });
    expect(s.mode).toBe('online');
    expect(s.host).toBeNull();
    expect(s.transportKind).toBe('relay');
    expect(s.roomCode).toBe('ABC123');
    expect(s.serverUrl).toBe(base.signalUrl);
    // The player joins the server's table through the relay.
    const join = ws.sent.find((f) => f.t === 'to');
    expect(join).toMatchObject({ t: 'to', to: 'server-1', data: { ch: 'game', msg: { t: 'join', name: 'Tester', userId: 'user-123456' } } });
    s.close();
  });

  it('joins an existing table by code without creating one', async () => {
    const s = await createOnlineSession({ ...base, action: 'join', code: 'abc123', token: '0123456789abcdef0123456789abcdef' });
    const ws = FakeSocket.last!;
    expect(ws.sent.some((f) => f.t === 'create')).toBe(false);
    expect(ws.sent.find((f) => f.t === 'join')).toEqual({ t: 'join', room: 'ABC123' });
    expect(ws.sent.find((f) => f.t === 'to')).toMatchObject({ data: { msg: { t: 'join', token: '0123456789abcdef0123456789abcdef' } } });
    expect(s.mode).toBe('online');
    s.close();
  });

  it('closes the socket and rejects when the server refuses', async () => {
    FakeSocket.reply = (f) => (f.t === 'join' ? { t: 'error', message: 'Room not found' } : null);
    await expect(createOnlineSession({ ...base, action: 'join', code: 'NOPE99' })).rejects.toThrow('Room not found');
    expect(FakeSocket.last!.closed).toBe(true);
  });

  it('leaving the table closes the signalling socket', async () => {
    const s = await createOnlineSession({ ...base, action: 'create' });
    const ws = FakeSocket.last!;
    s.close();
    expect(ws.sent.some((f) => f.t === 'to' && (f.data as { msg?: { t?: string } }).msg?.t === 'leave')).toBe(true);
    expect(ws.closed).toBe(true);
  });
});

describe('createLocalSession', () => {
  it('runs the table on this device in local mode', () => {
    const s = createLocalSession('Tester', 'lady', DEFAULT_RULES, { botSkill: 'beginner' });
    expect(s.mode).toBe('local');
    expect(s.host).not.toBeNull();
    expect(s.transportKind).toBe('loopback');
    expect(s.serverUrl).toBeUndefined();
    s.close();
  });
});
