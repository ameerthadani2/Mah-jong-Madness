import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNED_CLOSE_CODE, QueueError } from '@mjm/net';
import { hideBlocked, BlockedStore } from '../api/blocks';
import { quickMatchFailure, quickMatchView } from './quickMatch';
import { startQuickMatch } from './session';

type Frame = Record<string, unknown>;

/** A scripted game server behind a fake WebSocket. */
class FakeSocket {
  static last: FakeSocket | null = null;
  static reply: (frame: Frame) => Frame[] = () => [];
  static helloClose: number | null = null;
  readyState = 0;
  sent: Frame[] = [];
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
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    if (frame.t === 'hello' && FakeSocket.helloClose !== null) {
      const code = FakeSocket.helloClose;
      queueMicrotask(() => this.serverClose(code));
      return;
    }
    const answers = frame.t === 'hello' ? [{ t: 'hello', id: 'p-me', userId: 'u-1' }] : FakeSocket.reply(frame);
    for (const a of answers) queueMicrotask(() => this.push(a));
  }
  push(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverClose(code = 1006): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code });
  }
  close(): void {
    this.serverClose(1000);
  }
}

const base = { signalUrl: 'wss://game.example/ws', name: 'Mei', avatar: 'lady', userId: 'u-1' };

beforeEach(() => {
  FakeSocket.last = null;
  FakeSocket.helloClose = null;
  FakeSocket.reply = (f) => {
    if (f.t === 'queue') return [{ t: 'queue_status', position: 1, waitedMs: 0, humans: 2, fillMs: 20_000 }, { t: 'matched', room: 'QM2345', humans: 2, bots: 2 }];
    if (f.t === 'join') return [{ t: 'room', room: 'QM2345', peers: ['p-me', 'server-QM2345'], host: 'server-QM2345' }];
    return [];
  };
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('startQuickMatch', () => {
  it('queues, then joins the matched room on the same socket and sits down', async () => {
    const statuses: number[] = [];
    let matched = '';
    const { session } = startQuickMatch({ ...base, auth: async () => 'mjs_token', onStatus: (s) => statuses.push(s.humans), onMatched: (r) => (matched = r) });
    const s = await session;
    const ws = FakeSocket.last!;
    expect(ws.sent.map((f) => f.t)).toEqual(['hello', 'queue', 'join', 'to']);
    expect(ws.sent[0]).toEqual({ t: 'hello', auth: 'mjs_token' });
    expect(ws.sent[1]).toEqual({ t: 'queue', preset: 'normal' });
    expect(ws.sent[3]).toMatchObject({ to: 'server-QM2345', data: { ch: 'game', msg: { t: 'join', name: 'Mei', userId: 'u-1' } } });
    expect(statuses).toEqual([2]);
    expect(matched).toBe('QM2345');
    expect(s.roomCode).toBe('QM2345');
    expect(s.mode).toBe('online');
    s.close();
  });

  it('rejects with the refusal code and closes the socket', async () => {
    FakeSocket.reply = (f) => (f.t === 'queue' ? [{ t: 'queue_error', code: 'age_required', message: 'birth year' }] : []);
    const { session } = startQuickMatch(base);
    await expect(session).rejects.toMatchObject({ code: 'age_required' });
    expect(FakeSocket.last!.closed).toBe(true);
  });

  it('cancel leaves the queue', async () => {
    FakeSocket.reply = (f) => (f.t === 'queue' ? [{ t: 'queue_status', position: 1, waitedMs: 0, humans: 1 }] : []);
    const q = startQuickMatch(base);
    await flush();
    await flush();
    q.cancel();
    await expect(q.session).rejects.toMatchObject({ code: 'cancelled' });
    expect(FakeSocket.last!.sent.map((f) => f.t)).toContain('leave_queue');
  });

  it('a banned account (closed with 4403 at hello) is told it is banned', async () => {
    FakeSocket.helloClose = BANNED_CLOSE_CODE;
    const { session } = startQuickMatch(base);
    await expect(session).rejects.toMatchObject({ code: 'banned' });
  });
});

describe('quick match copy', () => {
  it('shows the humans found, the wait and the seconds until bots join', () => {
    expect(quickMatchView(null)).toEqual({ humans: 1, waitedSeconds: 0, fillSeconds: 20, botsInSeconds: 20 });
    expect(quickMatchView({ t: 'queue_status', position: 2, waitedMs: 12_400, humans: 3, fillMs: 20_000 })).toEqual({ humans: 3, waitedSeconds: 12, fillSeconds: 20, botsInSeconds: 8 });
    expect(quickMatchView({ t: 'queue_status', position: 1, waitedMs: 0, humans: 1, fillMs: 20_000 }, 25_000).botsInSeconds).toBe(0);
  });

  it('routes age_required to the age gate and localises the other refusals', () => {
    expect(quickMatchFailure(new QueueError('x', 'age_required'))).toEqual({ kind: 'age' });
    expect(quickMatchFailure(new QueueError('x', 'banned'))).toEqual({ kind: 'message', message: { key: 'quickmatch.errors.banned' } });
    expect(quickMatchFailure(new QueueError('x', 'rate_limited'))).toEqual({ kind: 'message', message: { key: 'quickmatch.errors.rateLimited' } });
    expect(quickMatchFailure(new QueueError('x', 'cancelled'))).toEqual({ kind: 'cancelled' });
    expect(quickMatchFailure({ code: 'server_full', message: '' })).toEqual({ kind: 'message', message: { key: 'online.errors.serverFull' } });
    expect(quickMatchFailure(new Error('Connection closed'))).toEqual({ kind: 'other' });
  });
});

describe('blocked players at the table', () => {
  const seats = [
    { seat: 0, userId: 'me' },
    { seat: 1, userId: 'rude' },
    { seat: 2, userId: 'bot', isBot: true },
    { seat: 3, userId: 'kind' },
  ];
  it("hides a blocked account's chat lines and emotes, and nobody else's", () => {
    const chat = [
      { seat: 1, text: 'rude words' },
      { seat: 3, text: 'good game' },
    ];
    expect(hideBlocked(chat, seats, new Set(['rude']))).toEqual([{ seat: 3, text: 'good game' }]);
    expect(hideBlocked(chat, seats, new Set())).toEqual(chat);
    expect(hideBlocked([{ seat: 1, emote: 'laugh' }], seats, new Set(['someone-else']))).toEqual([{ seat: 1, emote: 'laugh' }]);
  });

  it('the store hides a player at once, and puts them back if the server refuses', async () => {
    const store = new BlockedStore();
    const seen: number[] = [];
    store.subscribe((ids) => seen.push(ids.size));
    const ok = { base: 'https://x', auth: { token: async () => 't', onUnauthorised: () => undefined }, fetch: async () => ({ ok: true, status: 201, text: async () => '{}' }) };
    await store.block(ok, 'rude');
    expect(store.get().has('rude')).toBe(true);
    const refuse = { ...ok, fetch: async () => ({ ok: false, status: 404, text: async () => '{"error":"not_found"}' }) };
    await expect(store.block(refuse, 'ghost')).rejects.toMatchObject({ code: 'not_found' });
    expect([...store.get()]).toEqual(['rude']);
    const list = { ...ok, fetch: async () => ({ ok: true, status: 200, text: async () => '{"blocks":[{"userId":"a"},{"userId":"b"}]}' }) };
    store.forget();
    await store.load(list, 'me');
    expect([...store.get()].sort()).toEqual(['a', 'b']);
    expect(seen.length).toBeGreaterThan(3);
  });
});
