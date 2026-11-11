import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RULES } from '@mjm/engine';
import { BANNED_CLOSE_CODE, BANNED_MESSAGE, QueueError } from '@mjm/net';
import { hideBlocked, BlockedStore } from '../api/blocks';
import en from '../i18n/locales/en/quickmatch.json';
import zhTW from '../i18n/locales/zh-TW/quickmatch.json';
import { quickMatchAnnouncement, quickMatchFailure, quickMatchView, RATE_LIMIT_WAIT_MS, retryWaitSeconds, runQuickMatch, savedRejoinToken } from './quickMatch';
import { createOnlineSession, startQuickMatch } from './session';

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
    FakeSocket.reply = (f) => (f.t === 'queue' ? [{ t: 'queue_error', code: 'age_missing', message: 'birth year' }] : []);
    const { session } = startQuickMatch(base);
    await expect(session).rejects.toMatchObject({ code: 'age_missing' });
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

  it('a banned account (closed with 4403 at hello) is told it is banned, and so is the account layer', async () => {
    FakeSocket.helloClose = BANNED_CLOSE_CODE;
    const onBanned = vi.fn();
    const { session } = startQuickMatch({ ...base, onBanned });
    await expect(session).rejects.toMatchObject({ code: 'banned' });
    expect(onBanned).toHaveBeenCalledTimes(1);
  });

  it('a ban reported by the queue reaches the account layer too', async () => {
    FakeSocket.reply = (f) => (f.t === 'queue' ? [{ t: 'queue_error', code: 'banned', message: 'This account has been banned' }] : []);
    const onBanned = vi.fn();
    const { session } = startQuickMatch({ ...base, onBanned });
    await expect(session).rejects.toMatchObject({ code: 'banned' });
    expect(onBanned).toHaveBeenCalledTimes(1);
  });
});

describe('an account still seated at a quick-match table', () => {
  /** The queue answers `seated`; the table socket that follows lets the join in. */
  const seatedServer = (joinReply: (f: Frame) => Frame[] = () => [{ t: 'room', room: 'QM7777', peers: ['p-me', 'server-QM7777'], host: 'server-QM7777' }]) => {
    FakeSocket.reply = (f) => {
      if (f.t === 'queue') return [{ t: 'queue_error', code: 'seated', message: 'You are still at a table', room: 'QM7777' }];
      if (f.t === 'join') return joinReply(f);
      return [];
    };
  };
  const tableJoin = (ws: FakeSocket) => (ws.sent.find((f) => f.t === 'to') as { data: { msg: Record<string, unknown> } }).data.msg;

  it('goes back to that table with the saved rejoin token instead of queueing or failing', async () => {
    seatedServer();
    const sockets: FakeSocket[] = [];
    const seated: string[] = [];
    const asked: string[] = [];
    const { session } = startQuickMatch({
      ...base,
      auth: async () => 'mjs_token',
      webSocket: (u) => {
        const ws = new FakeSocket(u);
        sockets.push(ws);
        return ws;
      },
      onSeated: (room) => seated.push(room),
      savedToken: (room) => {
        asked.push(room);
        return 'saved-rejoin-token';
      },
    });
    const s = await session;
    expect(sockets).toHaveLength(2);
    // The queue socket is finished with; the table is joined on a socket of its own, signed in the same way.
    expect(sockets[0].sent.map((f) => f.t).slice(0, 2)).toEqual(['hello', 'queue']);
    expect(sockets[0].sent.map((f) => f.t)).not.toContain('join');
    expect(sockets[0].closed).toBe(true);
    expect(sockets[1].sent.map((f) => f.t)).toEqual(['hello', 'join', 'to']);
    expect(sockets[1].sent[0]).toEqual({ t: 'hello', auth: 'mjs_token' });
    expect(sockets[1].sent[1]).toMatchObject({ t: 'join', room: 'QM7777' });
    expect(tableJoin(sockets[1])).toMatchObject({ t: 'join', token: 'saved-rejoin-token', userId: 'u-1' });
    expect(seated).toEqual(['QM7777']);
    expect(asked).toEqual(['QM7777']);
    expect(s.roomCode).toBe('QM7777');
    expect(s.quickMatch).toBe(true);
    s.close();
  });

  it('joins with no token when this device saved none for that room: the server seats the account and issues a new one', async () => {
    seatedServer();
    const { session } = startQuickMatch({ ...base, savedToken: () => undefined });
    const s = await session;
    const join = tableJoin(FakeSocket.last!);
    expect(join).toMatchObject({ t: 'join', userId: 'u-1' });
    expect(join.token).toBeUndefined();
    // The table answers welcome with the seat's new token; the client holds it, which is what the app saves.
    FakeSocket.last!.push({ t: 'from', from: 'server-QM7777', data: { ch: 'game', msg: { t: 'welcome', seat: 2, token: 'fresh-token', roomCode: 'QM7777', matchId: 'm-1', rules: DEFAULT_RULES, seats: [] } } });
    await flush();
    expect(s.client.state.token).toBe('fresh-token');
    s.close();
  });

  it('fails with rejoin_failed only when that table can no longer be joined', async () => {
    seatedServer(() => [{ t: 'error', code: 'room_unavailable', message: 'Room not found or full' }]);
    const { session } = startQuickMatch({ ...base, savedToken: () => undefined });
    await expect(session).rejects.toMatchObject({ code: 'rejoin_failed', room: 'QM7777' });
    expect(quickMatchFailure(await session.catch((e) => e))).toEqual({ kind: 'message', message: { key: 'quickmatch.errors.seatedFailed' }, final: false });
  });

  it('asks for a few seconds when the server throttles the way back, instead of calling the table lost', async () => {
    seatedServer(() => [{ t: 'error', message: 'Too many join attempts; please wait a few seconds' }]);
    const { session } = startQuickMatch({ ...base, savedToken: () => undefined });
    const error = await session.catch((e) => e);
    expect(error).toMatchObject({ code: 'rate_limited', room: 'QM7777' });
    expect(quickMatchFailure(error)).toEqual({ kind: 'message', message: { key: 'quickmatch.errors.rateLimited' }, final: false, retryAfterMs: RATE_LIMIT_WAIT_MS });
  });

  it('a quick-match table resumed from the saved record is still a quick-match table', async () => {
    FakeSocket.reply = (f) => (f.t === 'join' ? [{ t: 'room', room: 'QM7777', peers: ['p-me', 'server-QM7777'], host: 'server-QM7777' }] : []);
    const resumed = await createOnlineSession({ ...base, rules: DEFAULT_RULES, action: 'join', code: 'QM7777', token: 'saved', quickMatch: true });
    expect(resumed.quickMatch).toBe(true);
    resumed.close();
    const ordinary = await createOnlineSession({ ...base, rules: DEFAULT_RULES, action: 'join', code: 'QM7777', token: 'saved' });
    expect(ordinary.quickMatch).toBe(false);
    ordinary.close();
  });

  it('uses the saved token only for that room on that game server', () => {
    const saved = { kind: 'online', signalUrl: 'wss://game.example/ws', roomCode: 'QM7777', token: 'tok' };
    expect(savedRejoinToken(saved, 'wss://game.example/ws', 'QM7777')).toBe('tok');
    expect(savedRejoinToken(saved, 'wss://game.example/ws', 'qm7777')).toBe('tok');
    expect(savedRejoinToken(saved, 'wss://game.example/ws', 'QM0000')).toBeUndefined();
    expect(savedRejoinToken(saved, 'wss://other.example/ws', 'QM7777')).toBeUndefined();
    expect(savedRejoinToken({ kind: 'local', token: 'tok' }, 'wss://game.example/ws', 'QM7777')).toBeUndefined();
    expect(savedRejoinToken(null, 'wss://game.example/ws', 'QM7777')).toBeUndefined();
  });
});

describe('one quick match, from the tap to a seat or a message', () => {
  /** A queue that answers each search with the next scripted reply (a refusal code, or 'seat'). */
  const run = (replies: string[], device: { birthYear?: number; send?: 'sent' | 'on_file' | 'failed' } = {}) => {
    const log: string[] = [];
    const outcome = runQuickMatch<string>({
      search: async () => {
        const next = replies.shift() ?? 'unavailable';
        log.push(`queue:${next}`);
        if (next === 'seat') return 'table';
        throw new QueueError('refused', next);
      },
      birthYear: () => device.birthYear,
      sendBirthYear: async (year) => {
        log.push(`patch:${year}`);
        return device.send ?? 'sent';
      },
    });
    return { outcome, log };
  };

  it('after age_missing sends the birth year this device holds once, then queues again', async () => {
    const { outcome, log } = run(['age_missing', 'seat'], { birthYear: 1990 });
    expect(await outcome).toEqual({ kind: 'session', session: 'table' });
    expect(log).toEqual(['queue:age_missing', 'patch:1990', 'queue:seat']);
  });

  it('queues again when the server says a birth year is already on file', async () => {
    const { outcome, log } = run(['age_missing', 'seat'], { birthYear: 1990, send: 'on_file' });
    expect(await outcome).toEqual({ kind: 'session', session: 'table' });
    expect(log).toEqual(['queue:age_missing', 'patch:1990', 'queue:seat']);
  });

  it('never sends the year twice: a second age_missing is a message', async () => {
    const { outcome, log } = run(['age_missing', 'age_missing', 'seat'], { birthYear: 1990 });
    expect(await outcome).toEqual({ kind: 'failed', message: { key: 'quickmatch.errors.ageSync' }, final: false });
    expect(log).toEqual(['queue:age_missing', 'patch:1990', 'queue:age_missing']);
  });

  it('does not queue again when the year could not be sent', async () => {
    const { outcome, log } = run(['age_missing', 'seat'], { birthYear: 1990, send: 'failed' });
    expect(await outcome).toEqual({ kind: 'failed', message: { key: 'quickmatch.errors.ageSync' }, final: false });
    expect(log).toEqual(['queue:age_missing', 'patch:1990']);
  });

  it('sends the player through the age gate when the device has no birth year either', async () => {
    const { outcome, log } = run(['age_missing', 'seat']);
    expect(await outcome).toEqual({ kind: 'ask_age' });
    expect(log).toEqual(['queue:age_missing']);
  });

  it('age_under is final: a message, never a birth year sent and never another try', async () => {
    const { outcome, log } = run(['age_under', 'seat'], { birthYear: 1990 });
    expect(await outcome).toEqual({ kind: 'failed', message: { key: 'quickmatch.errors.ageUnder' }, final: true });
    expect(log).toEqual(['queue:age_under']);
  });

  it('age_under after the year went through is final too', async () => {
    const { outcome, log } = run(['age_missing', 'age_under', 'seat'], { birthYear: 1990, send: 'on_file' });
    expect(await outcome).toMatchObject({ kind: 'failed', message: { key: 'quickmatch.errors.ageUnder' }, final: true });
    expect(log).toEqual(['queue:age_missing', 'patch:1990', 'queue:age_under']);
  });

  it('a ban is final, and too many tries asks for a few seconds before the next', async () => {
    expect(await run(['banned']).outcome).toEqual({ kind: 'failed', message: { key: 'quickmatch.errors.banned' }, final: true });
    expect(await run(['rate_limited']).outcome).toEqual({ kind: 'failed', message: { key: 'quickmatch.errors.rateLimited' }, final: false, retryAfterMs: RATE_LIMIT_WAIT_MS });
    expect(RATE_LIMIT_WAIT_MS).toBeGreaterThanOrEqual(3_000);
    expect(retryWaitSeconds(10_000, 5_200)).toBe(5);
    expect(retryWaitSeconds(10_000, 10_000)).toBe(0);
    expect(retryWaitSeconds(10_000, 12_000)).toBe(0);
  });

  it('a cancelled search ends quietly, and an unknown failure is left to the generic message', async () => {
    expect(await run(['cancelled']).outcome).toEqual({ kind: 'cancelled' });
    const odd = new Error('Connection closed');
    const outcome = await runQuickMatch<string>({ search: () => Promise.reject(odd), birthYear: () => 1990, sendBirthYear: async () => 'sent' });
    expect(outcome).toEqual({ kind: 'failed', message: null, final: false, error: odd });
  });
});

describe('quick match copy', () => {
  it('shows the humans found, the wait and the seconds until bots join', () => {
    expect(quickMatchView(null)).toEqual({ humans: 1, waitedSeconds: 0, fillSeconds: 20, botsInSeconds: 20 });
    expect(quickMatchView({ t: 'queue_status', position: 2, waitedMs: 12_400, humans: 3, fillMs: 20_000 })).toEqual({ humans: 3, waitedSeconds: 12, fillSeconds: 20, botsInSeconds: 8 });
    expect(quickMatchView({ t: 'queue_status', position: 1, waitedMs: 0, humans: 1, fillMs: 20_000 }, 25_000).botsInSeconds).toBe(0);
  });

  it('tells a screen reader about players found and the match, and never about the seconds ticking by', () => {
    const status = (humans: number, waitedMs: number) => ({ t: 'queue_status' as const, position: 1, waitedMs, humans, fillMs: 20_000 });
    const said = (humans: number, waitedMs: number) => quickMatchAnnouncement('searching', quickMatchView(status(humans, waitedMs), waitedMs).humans);
    // Twenty seconds alone in the queue: one announcement, although the visible wait changed twenty times.
    const alone = Array.from({ length: 20 }, (_, i) => JSON.stringify(said(1, i * 1000)));
    expect(new Set(alone).size).toBe(1);
    expect(new Set(Array.from({ length: 20 }, (_, i) => quickMatchView(status(1, i * 1000), i * 1000).waitedSeconds)).size).toBe(20);
    expect(said(1, 0)).toEqual({ key: 'quickmatch.humans', params: { count: 1 } });
    // A second player arrives: that is news.
    expect(said(2, 7000)).toEqual({ key: 'quickmatch.humans', params: { count: 2 } });
    expect(said(2, 7000)).not.toEqual(said(1, 7000));
    // So is the match, and being taken back to a table.
    expect(quickMatchAnnouncement('matched', 2)).toEqual({ key: 'quickmatch.matched' });
    expect(quickMatchAnnouncement('returning', 1)).toEqual({ key: 'quickmatch.returning' });
    // None of the announced sentences has the wait in it, in either language.
    for (const locale of [en, zhTW]) for (const text of [locale.humans.one, locale.humans.other, locale.matched, locale.returning]) expect(text).not.toContain('%{seconds}');
  });

  it('routes age_missing to the birth-year path and gives every other refusal its own translated message', () => {
    expect(quickMatchFailure(new QueueError('x', 'age_missing'))).toEqual({ kind: 'age' });
    const message = (code: string) => {
      const f = quickMatchFailure(new QueueError('the server sentence', code));
      return f.kind === 'message' ? { key: f.message.key, final: f.final } : f;
    };
    expect(message('age_under')).toEqual({ key: 'quickmatch.errors.ageUnder', final: true });
    expect(message('banned')).toEqual({ key: 'quickmatch.errors.banned', final: true });
    expect(message('rate_limited')).toEqual({ key: 'quickmatch.errors.rateLimited', final: false });
    expect(message('unavailable')).toEqual({ key: 'quickmatch.errors.unavailable', final: false });
    expect(message('replaced')).toEqual({ key: 'quickmatch.errors.replaced', final: false });
    expect(message('sign_in')).toEqual({ key: 'quickmatch.errors.signIn', final: false });
    expect(message('seated')).toEqual({ key: 'quickmatch.errors.seatedFailed', final: false });
    expect(quickMatchFailure(new QueueError('x', 'cancelled'))).toEqual({ kind: 'cancelled' });
    expect(quickMatchFailure({ code: BANNED_CLOSE_CODE, message: BANNED_MESSAGE })).toMatchObject({ kind: 'message', final: true });
    expect(quickMatchFailure({ code: 'server_full', message: '' })).toEqual({ kind: 'message', message: { key: 'online.errors.serverFull' }, final: false });
    expect(quickMatchFailure(new Error('Connection closed'))).toEqual({ kind: 'other' });
    // A code this build has never heard of (an older server's age_required, or a future one) is not guessed at.
    expect(quickMatchFailure(new QueueError('x', 'age_required'))).toEqual({ kind: 'other' });
    expect(quickMatchFailure(new QueueError('x', 'toString'))).toEqual({ kind: 'other' });
  });

  it('every quick-match message exists in English and Traditional Chinese', () => {
    for (const code of ['age_under', 'banned', 'rate_limited', 'unavailable', 'replaced', 'sign_in', 'seated', 'rejoin_failed']) {
      const f = quickMatchFailure(new QueueError('x', code));
      if (f.kind !== 'message') throw new Error(`${code} has no message`);
      const path = f.message.key.split('.').slice(1);
      for (const locale of [en, zhTW]) {
        const text = path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], locale);
        expect(typeof text === 'string' && text.length > 0, `${code} in ${locale === en ? 'en' : 'zh-TW'}`).toBe(true);
      }
    }
    expect(zhTW.errors.ageUnder).not.toBe(en.errors.ageUnder);
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
