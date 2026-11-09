import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseAction, DEFAULT_RULES, legalActions, withRules } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink, type ClientState, type SerializedClient } from '@mjm/net';
import { connectSignaling, createLocalSession, createOnlineSession, isUnauthorised, setSavedClientSource, UNAUTHORISED_CLOSE, type Session } from './session';

type Frame = Record<string, unknown>;

/** A scripted signalling server behind a fake WebSocket: records every frame and answers hello/create/join. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static last: FakeSocket | null = null;
  static reply: (frame: Frame, ws: FakeSocket) => Frame | null = () => null;
  /** How the server treats a new connection: answer it, refuse the session (4401), or be unreachable. */
  static accept: (ws: FakeSocket) => 'ok' | 'unauthorised' | 'down' = () => 'ok';
  readyState = 0;
  sent: Frame[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.all.push(this);
    const mode = FakeSocket.accept(this);
    queueMicrotask(() => {
      if (mode === 'down') {
        this.onerror?.({});
        this.serverClose(1006);
        return;
      }
      this.readyState = 1;
      this.onopen?.({});
    });
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Frame;
    this.sent.push(frame);
    if (frame.t === 'hello' && FakeSocket.accept(this) === 'unauthorised') {
      queueMicrotask(() => this.serverClose(UNAUTHORISED_CLOSE));
      return;
    }
    const answer = frame.t === 'hello' ? { t: 'hello', peerId: 'p-me', id: 'p-me', userId: 'u-1' } : FakeSocket.reply(frame, this);
    if (answer) queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(answer) }));
  }

  /** The server pushes a frame. */
  push(frame: Frame): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  /** The server (or the network) closes the socket. */
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

const TOKEN = '0123456789abcdef0123456789abcdef';
const base = { signalUrl: 'wss://game.example/ws', name: 'Tester', avatar: 'lady', userId: 'user-123456', rules: DEFAULT_RULES };
const roomReply = (f: Frame): Frame | null => (f.t === 'create' || f.t === 'join' ? { t: 'room', room: 'ABC123', peers: ['p-me', 'server-1'], host: 'server-1' } : null);
const tableJoins = (ws: FakeSocket) => ws.sent.filter((f) => f.t === 'to' && (f.data as { msg?: { t?: string } }).msg?.t === 'join').map((f) => (f.data as { msg: Frame }).msg);

beforeEach(() => {
  FakeSocket.all = [];
  FakeSocket.last = null;
  FakeSocket.accept = () => 'ok';
  FakeSocket.reply = roomReply;
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
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
    expect(s.status).toBe('connected');
    // The player joins the server's table through the relay.
    const join = ws.sent.find((f) => f.t === 'to');
    expect(join).toMatchObject({ t: 'to', to: 'server-1', data: { ch: 'game', msg: { t: 'join', name: 'Tester', userId: 'user-123456' } } });
    s.close();
  });

  it('joins an existing table by code without creating one', async () => {
    const s = await createOnlineSession({ ...base, action: 'join', code: 'abc123', token: TOKEN });
    const ws = FakeSocket.last!;
    expect(ws.sent.some((f) => f.t === 'create')).toBe(false);
    expect(ws.sent.find((f) => f.t === 'join')).toEqual({ t: 'join', room: 'ABC123' });
    expect(ws.sent.find((f) => f.t === 'to')).toMatchObject({ data: { msg: { t: 'join', token: TOKEN } } });
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

  it('sends the account session token in the hello frame', async () => {
    const s = await createOnlineSession({ ...base, action: 'create', auth: async () => 'mjs_abc' });
    expect(FakeSocket.last!.sent[0]).toEqual({ t: 'hello', auth: 'mjs_abc' });
    s.close();
  });

  it('on a 4401 replaces the session token once and connects again', async () => {
    let token = 'mjs_stale';
    FakeSocket.accept = (ws) => (ws.sent[0]?.auth === 'mjs_stale' ? 'unauthorised' : 'ok');
    const onUnauthorised = vi.fn(() => {
      token = 'mjs_fresh';
    });
    const s = await createOnlineSession({ ...base, action: 'create', auth: async () => token, onUnauthorised });
    expect(onUnauthorised).toHaveBeenCalledTimes(1);
    expect(FakeSocket.all.map((w) => w.sent[0])).toEqual([
      { t: 'hello', auth: 'mjs_stale' },
      { t: 'hello', auth: 'mjs_fresh' },
    ]);
    s.close();
  });

  it('reports a refused session as unauthorised', async () => {
    FakeSocket.accept = () => 'unauthorised';
    const err = await createOnlineSession({ ...base, action: 'create', auth: async () => 'bad' }).catch((e: unknown) => e);
    expect(isUnauthorised(err)).toBe(true);
  });
});

describe('online reconnect', () => {
  const open = async (extra: Partial<Parameters<typeof createOnlineSession>[0]> = {}) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await createOnlineSession({ ...base, action: 'join', code: 'ABC123', token: TOKEN, ...extra });
    const statuses: string[] = [];
    s.onStatus((st) => statuses.push(`${st.status}:${st.attempt}`));
    return { s, statuses, first: FakeSocket.last! };
  };

  it('rejoins the same room with the saved token after the socket drops, and rebinds the same client', async () => {
    const { s, statuses, first } = await open({ auth: async () => 'mjs_tok' });
    const oldClient = s.client;
    const seen: ClientState[] = [];
    s.onChange((st) => seen.push(st));
    // The host welcomed us with a rejoin token, then the network dropped.
    first.push({ t: 'from', from: 'server-1', data: { ch: 'game', msg: { t: 'welcome', seat: 2, roomCode: 'ABC123', rules: DEFAULT_RULES, seats: [], matchId: 'm1', token: 'f'.repeat(32) } } });
    expect(seen.at(-1)?.token).toBe('f'.repeat(32));
    first.serverClose(1006);
    expect(s.status).toBe('reconnecting');
    expect(s.attempt).toBe(1);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.all).toHaveLength(2);
    const second = FakeSocket.last!;
    expect(second.sent[0]).toEqual({ t: 'hello', auth: 'mjs_tok' });
    expect(second.sent.find((f) => f.t === 'join')).toEqual({ t: 'join', room: 'ABC123' });
    expect(tableJoins(second)).toEqual([expect.objectContaining({ t: 'join', name: 'Tester', token: 'f'.repeat(32) })]);
    expect(s.status).toBe('connected');
    // One client per table: it keeps what it recorded about the deal across the reconnect.
    expect(s.client).toBe(oldClient);
    expect(statuses).toEqual(['reconnecting:1', 'connected:0']);
    second.push({ t: 'from', from: 'server-1', data: { ch: 'game', msg: { t: 'welcome', seat: 2, roomCode: 'ABC123', rules: DEFAULT_RULES, seats: [], matchId: 'm1', token: 'e'.repeat(32) } } });
    expect(seen.at(-1)?.token).toBe('e'.repeat(32));
    expect(seen.at(-1)?.disconnected).toBe(false);
    // Frames still arriving on the old socket are no longer heard.
    first.onmessage?.({ data: JSON.stringify({ t: 'from', from: 'server-1', data: { ch: 'game', msg: { t: 'chat', seat: 1, name: 'Old', text: 'stale' } } }) });
    expect(s.client.state.chat).toEqual([]);
    s.close();
    expect(second.closed).toBe(true);
  });

  it('a link that drops is reconnected; only a seat opened on another device ends the session', async () => {
    const { s, first } = await open();
    first.push({ t: 'from', from: 'server-1', data: { ch: 'game', msg: { t: 'welcome', seat: 0, roomCode: 'ABC123', rules: DEFAULT_RULES, seats: [], matchId: 'm1', token: TOKEN } } });
    first.serverClose(1006);
    expect(s.client.state.disconnected).toBe(true);
    expect(s.client.state.kicked).toBe(false);
    expect(s.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.status).toBe('connected');
    // The seat is opened elsewhere while this socket stays up: stop, without waiting for a close.
    FakeSocket.last!.push({ t: 'from', from: 'server-1', data: { ch: 'game', msg: { t: 'disconnected' } } });
    expect(s.client.state.kicked).toBe(true);
    expect(s.status).toBe('lost');
    expect(s.lostReason).toBe('ended');
    s.close();
  });

  it('backs off 1, 2, 4, 8 … seconds and is lost after ten failed attempts', async () => {
    const { s, statuses, first } = await open();
    FakeSocket.accept = () => 'down';
    first.serverClose(1006);
    const waits = [1, 2, 4, 8, 16, 32, 60, 60, 60, 60];
    for (const [i, w] of waits.entries()) {
      expect(s.status).toBe('reconnecting');
      expect(s.attempt).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(w * 1000 - 1);
      expect(FakeSocket.all).toHaveLength(1 + i);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.all).toHaveLength(2 + i);
    }
    expect(s.status).toBe('lost');
    expect(s.lostReason).toBe('exhausted');
    expect(statuses.at(-1)).toBe('lost:10');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(FakeSocket.all).toHaveLength(11);
    s.close();
  });

  it('stops at once when the server answers the rejoin with "Room not found or full", with or without a code', async () => {
    for (const reply of [{ t: 'error', message: 'Room not found or full', code: 'room_unavailable' }, { t: 'error', message: 'Room not found or full' }]) {
      FakeSocket.all = [];
      FakeSocket.reply = roomReply;
      const { s, statuses, first } = await open();
      // The table ended (or was reaped) while the phone was offline.
      FakeSocket.reply = (f) => (f.t === 'join' ? reply : null);
      first.serverClose(1006);
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.status, JSON.stringify(reply)).toBe('lost');
      expect(s.lostReason).toBe('gone');
      expect(statuses).toEqual(['reconnecting:1', 'lost:1']);
      // No further attempts, and the refused socket was closed.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(FakeSocket.all).toHaveLength(2);
      expect(FakeSocket.all[1].closed).toBe(true);
      s.close();
    }
  });

  it('"Retry now" skips the wait', async () => {
    const { s, first } = await open();
    first.serverClose(1006);
    FakeSocket.accept = () => 'down';
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.attempt).toBe(2);
    FakeSocket.accept = () => 'ok';
    s.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.status).toBe('connected');
    expect(FakeSocket.all).toHaveLength(3);
    s.close();
  });

  it('gives up at once when the server refuses the session, and asks for a fresh one', async () => {
    const onUnauthorised = vi.fn();
    const { s, first } = await open({ auth: async () => 'mjs_x', onUnauthorised });
    FakeSocket.accept = () => 'unauthorised';
    first.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.status).toBe('lost');
    expect(s.lostReason).toBe('unauthorised');
    expect(onUnauthorised).toHaveBeenCalled();
    s.close();
  });

  it('a 4401 close mid-game is lost without retrying', async () => {
    const { s, first } = await open();
    first.serverClose(UNAUTHORISED_CLOSE);
    expect(s.status).toBe('lost');
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.all).toHaveLength(1);
    s.close();
  });

  it('does not fight another device for the seat', async () => {
    const { s, first } = await open();
    first.push({ t: 'from', from: 'server-1', data: { ch: 'game', msg: { t: 'disconnected' } } });
    first.serverClose(1006);
    expect(s.status).toBe('lost');
    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.all).toHaveLength(1);
    s.close();
  });

  it('leaving stops a pending reconnect', async () => {
    const { s, first } = await open();
    first.serverClose(1006);
    s.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('leaving normally never triggers a reconnect', async () => {
    const { s, statuses } = await open();
    s.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statuses).toEqual([]);
    expect(FakeSocket.all).toHaveLength(1);
  });
});

describe('cold resume after an app restart', () => {
  /** A client record as the app saves it in ActiveSession after one verified hand at table ABC123. */
  function savedRecord(): SerializedClient {
    const hub = new LoopbackHub();
    const host = new TableHost(hub.create('host'), { roomCode: 'ABC123', rules: withRules({ handsPerMatch: 4 }), matchId: 'm-saved' });
    const c = new TableClient(transportLink(hub.create('p0'), 'host'), 'Tester', 'lady', { userId: 'user-123456' });
    c.join();
    host.start();
    let guard = 0;
    while (host.phase === 'playing' && guard++ < 4000) {
      const st = c.localState();
      if (st && legalActions(st, 0).length > 0) c.act(chooseAction(st, 0)!);
      else host.tick();
    }
    expect(c.state.audits).toHaveLength(1);
    return JSON.parse(JSON.stringify(c.serialize())) as SerializedClient;
  }

  afterEach(() => setSavedClientSource(null));

  it('restores the saved client record passed in the options', async () => {
    const saved = savedRecord();
    const s = await createOnlineSession({ ...base, action: 'join', code: 'ABC123', token: saved.state.token!, restoreClient: saved });
    expect(s.client.state.audits.map((a) => a.audit.matchId)).toEqual(['m-saved']);
    expect(s.client.serialize().handsEnded).toEqual([0]);
    expect(tableJoins(FakeSocket.last!)).toEqual([expect.objectContaining({ t: 'join', token: saved.state.token })]);
    s.close();
  });

  it('finds the saved record through the registered source, and ignores one for another seat', async () => {
    const saved = savedRecord();
    setSavedClientSource((url, room, token) => (url === base.signalUrl && room === 'ABC123' && token === saved.state.token ? saved : undefined));
    const s = await createOnlineSession({ ...base, action: 'join', code: 'ABC123', token: saved.state.token! });
    expect(s.client.state.audits).toHaveLength(1);
    s.close();
    // A record for another token is never restored onto this seat.
    const other = await createOnlineSession({ ...base, action: 'join', code: 'ABC123', token: TOKEN, restoreClient: saved });
    expect(other.client.state.audits).toEqual([]);
    other.close();
  });
});

describe('connectSignaling', () => {
  it('leaves an existing auth field alone and passes other frames through', async () => {
    const { signaling } = connectSignaling('wss://x/ws', 'mjs_a');
    await signaling.connect();
    const ws = FakeSocket.last!;
    signaling.sendTo('peer', { hi: 1 });
    expect(ws.sent).toEqual([
      { t: 'hello', auth: 'mjs_a' },
      { t: 'to', to: 'peer', data: { hi: 1 } },
    ]);
    signaling.close();
  });

  it('sends a bare hello without a token', async () => {
    const { signaling } = connectSignaling('wss://x/ws', undefined);
    await signaling.connect();
    expect(FakeSocket.last!.sent[0]).toEqual({ t: 'hello' });
    signaling.close();
  });
});

describe('createLocalSession', () => {
  it('runs the table on this device in local mode', () => {
    const s: Session = createLocalSession('Tester', 'lady', DEFAULT_RULES, { botSkill: 'beginner' });
    expect(s.mode).toBe('local');
    expect(s.host).not.toBeNull();
    expect(s.transportKind).toBe('loopback');
    expect(s.serverUrl).toBeUndefined();
    expect(s.status).toBe('connected');
    s.close();
  });

  it('forwards client state through onChange', () => {
    const s = createLocalSession('Tester', 'lady', DEFAULT_RULES);
    const seen: ClientState[] = [];
    s.onChange((st) => seen.push(st));
    s.host!.addBot();
    expect(seen.length).toBeGreaterThan(0);
    s.close();
  });
});
