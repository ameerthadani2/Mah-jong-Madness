import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseAction, DEFAULT_RULES, legalActions, withRules } from '@mjm/engine';
import { LoopbackHub, TableClient, TableHost, transportLink, type ClientState, type SerializedClient } from '@mjm/net';
import { connectSignaling, createLocalSession, createOnlineSession, isUnauthorised, setSavedClientSource, UNAUTHORISED_CLOSE, type Session } from './session';
import { friendlyErrorMessage } from '../logic/errors';
import { linkNotice } from '../logic/reconnect';

type Frame = Record<string, unknown>;

/** A scripted signalling server behind a fake WebSocket: records every frame and answers hello/create/join. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static last: FakeSocket | null = null;
  static reply: (frame: Frame, ws: FakeSocket) => Frame | null = () => null;
  /**
   * How the server treats a new connection: answer it, refuse the session (4401), refuse a banned
   * account (4403), be unreachable, or fail to finish checking the session before its hello timer
   * fires (1013, "try again later").
   */
  static accept: (ws: FakeSocket) => 'ok' | 'unauthorised' | 'banned' | 'down' | 'busy' = () => 'ok';
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
    if (frame.t === 'hello' && FakeSocket.accept(this) === 'banned') {
      queueMicrotask(() => this.serverClose(BANNED_CLOSE));
      return;
    }
    if (frame.t === 'hello' && FakeSocket.accept(this) === 'busy') {
      queueMicrotask(() => this.serverClose(TRY_AGAIN_LATER));
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

/** The game server's close code for a banned account (BANNED_CLOSE_CODE in apps/signal/src/rooms.ts). */
const BANNED_CLOSE = 4403;
/** The game server's close code for a hello it could not finish checking in time (apps/signal/src/sockets.ts). */
const TRY_AGAIN_LATER = 1013;
/** The game server's sentence to a watcher whose place a player needed (WATCHER_DROPPED in apps/signal/src/rooms.ts). */
const WATCHER_DROPPED = 'A player needed your place at this table; join again to sit down.';
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

  it('a first hello closed with 1013 fails as "try again", and the session token is not replaced', async () => {
    FakeSocket.accept = () => 'busy';
    const onUnauthorised = vi.fn();
    const err = await createOnlineSession({ ...base, action: 'create', auth: async () => 'mjs_good', onUnauthorised }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isUnauthorised(err)).toBe(false);
    expect(onUnauthorised).not.toHaveBeenCalled();
    // One socket: the app did not sign in again and retry as it does for a 4401.
    expect(FakeSocket.all).toHaveLength(1);
    // The player reads "cannot reach the game server … try again", not "your session was not accepted".
    expect(friendlyErrorMessage(err)).toEqual({ key: 'errors.unreachable' });
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

  const welcome = { t: 'from', from: 'server-1', data: { ch: 'game', msg: { t: 'welcome', seat: 0, roomCode: 'ABC123', rules: DEFAULT_RULES, seats: [], matchId: 'm1', token: TOKEN } } };
  const seatOpenedElsewhere = { t: 'from', from: 'server-1', data: { ch: 'game', msg: { t: 'disconnected' } } };

  it('a device whose seat was opened elsewhere never comes back by itself, however long it waits', async () => {
    const { s, statuses, first } = await open();
    first.push(welcome);
    // The same account sat down on another device: the server-hosted table tells this one.
    first.push(seatOpenedElsewhere);
    expect(s.client.state.kicked).toBe(true);
    expect(s.client.state.lastError).toBe('This seat was opened on another device.');
    expect(statuses).toEqual(['lost:0']);
    expect(s.lostReason).toBe('ended');
    // The screens say that, and not "connection lost".
    expect(linkNotice({ status: s.status, reason: s.lostReason }, s.client.state)).toBe('seatTaken');
    // The socket may drop now or much later, the player may poke at it: this device opens no new one.
    first.serverClose(1006);
    s.retryNow();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    s.retryNow();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(tableJoins(first)).toHaveLength(1);
    expect(s.status).toBe('lost');
    expect(statuses).toEqual(['lost:0']);
    s.close();
  });

  it('two devices of one account do not take the seat from each other in turns', async () => {
    // Device A is seated; device B joins with the same account and takes the seat.
    const a = await open();
    a.first.push(welcome);
    const b = await createOnlineSession({ ...base, action: 'join', code: 'ABC123' });
    const socketB = FakeSocket.last!;
    socketB.push(welcome);
    a.first.push(seatOpenedElsewhere);
    const opened = FakeSocket.all.length;
    // A stays down for good; B, which holds the seat, is not disturbed by anything A does afterwards.
    a.first.serverClose(1006);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(FakeSocket.all).toHaveLength(opened);
    expect(a.s.status).toBe('lost');
    expect(b.status).toBe('connected');
    expect(b.client.state.kicked).toBe(false);
    expect(socketB.closed).toBe(false);
    a.s.close();
    b.close();
  });

  it('a rejoin that completes after the seat was opened elsewhere is dropped, not used', async () => {
    const { s, first } = await open();
    first.push(welcome);
    // The link drops, and the server is slow to answer the rejoin: the attempt is still in the air…
    FakeSocket.reply = () => null;
    first.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    const second = FakeSocket.last!;
    expect(second).not.toBe(first);
    expect(second.sent.some((f) => f.t === 'join')).toBe(true);
    // …when the last frame of the old link says the seat now belongs to another device.
    first.push(seatOpenedElsewhere);
    expect(s.status).toBe('lost');
    // The slow answer arrives: this device must not sit down again.
    second.push({ t: 'room', room: 'ABC123', peers: ['p-me', 'server-1'], host: 'server-1' });
    await vi.advanceTimersByTimeAsync(0);
    expect(tableJoins(second)).toEqual([]);
    expect(second.closed).toBe(true);
    expect(s.status).toBe('lost');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(FakeSocket.all).toHaveLength(2);
    s.close();
  });

  it('a watcher who made way for a player is told so and does not walk back in', async () => {
    // No welcome: this device is in the room without a seat.
    const { s, statuses, first } = await open();
    first.push({ t: 'error', code: 'closed', message: WATCHER_DROPPED });
    expect(statuses).toEqual(['lost:0']);
    expect(s.lostReason).toBe('madeWay');
    expect(linkNotice({ status: s.status, reason: s.lostReason }, s.client.state)).toBe('madeWay');
    // The socket had no room left and is closed; nothing is opened in its place.
    expect(first.closed).toBe(true);
    s.retryNow();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(s.status).toBe('lost');
    s.close();
  });

  it('a room closed for any other reason is still looked for again', async () => {
    const { s, statuses, first } = await open();
    first.push(welcome);
    // The server answers the rejoin with its final word, as it does for a table a club closed.
    FakeSocket.reply = (f) => (f.t === 'join' ? { t: 'error', message: 'Room not found or full', code: 'room_unavailable' } : null);
    first.push({ t: 'error', code: 'closed', message: 'The club closed this table.' });
    expect(s.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses).toEqual(['reconnecting:1', 'lost:1']);
    expect(s.lostReason).toBe('gone');
    s.close();
  });

  it('a socket closed with 1013 mid-game is a link to win back, not a refused session', async () => {
    const onUnauthorised = vi.fn();
    const { s, statuses, first } = await open({ auth: async () => 'mjs_x', onUnauthorised });
    first.push(welcome);
    first.serverClose(TRY_AGAIN_LATER);
    expect(s.status).toBe('reconnecting');
    expect(s.attempt).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    // The same session token and the same rejoin token: nothing was thrown away.
    const second = FakeSocket.last!;
    expect(second.sent[0]).toEqual({ t: 'hello', auth: 'mjs_x' });
    expect(tableJoins(second)).toEqual([expect.objectContaining({ t: 'join', token: TOKEN })]);
    expect(statuses).toEqual(['reconnecting:1', 'connected:0']);
    expect(onUnauthorised).not.toHaveBeenCalled();
    s.close();
  });

  it('a hello the server could not check in time (1013) is tried again with backoff, and only 4401 ends the session', async () => {
    const onUnauthorised = vi.fn();
    const { s, statuses, first } = await open({ auth: async () => 'mjs_x', onUnauthorised });
    first.push(welcome);
    // The server's database is slow: every hello is closed with 1013 for a while.
    FakeSocket.accept = () => 'busy';
    first.serverClose(1006);
    for (const [i, wait] of [1, 2, 4].entries()) {
      expect(s.status).toBe('reconnecting');
      expect(s.attempt).toBe(i + 1);
      await vi.advanceTimersByTimeAsync(wait * 1000 - 1);
      expect(FakeSocket.all).toHaveLength(1 + i);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeSocket.all).toHaveLength(2 + i);
    }
    expect(statuses).toEqual(['reconnecting:1', 'reconnecting:2', 'reconnecting:3', 'reconnecting:4']);
    expect(s.lostReason).toBeNull();
    expect(onUnauthorised).not.toHaveBeenCalled();
    // The server recovers: the next attempt gets the seat back.
    FakeSocket.accept = () => 'ok';
    await vi.advanceTimersByTimeAsync(8000);
    expect(s.status).toBe('connected');
    expect(onUnauthorised).not.toHaveBeenCalled();
    // A refused session is the one close that is final.
    FakeSocket.accept = () => 'unauthorised';
    FakeSocket.last!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.status).toBe('lost');
    expect(s.lostReason).toBe('unauthorised');
    expect(onUnauthorised).toHaveBeenCalledTimes(1);
    s.close();
  });

  it('an account banned while at the table is told so, and the session never reconnects', async () => {
    const onBanned = vi.fn();
    const onUnauthorised = vi.fn();
    const { s, statuses, first } = await open({ auth: async () => 'mjs_x', onBanned, onUnauthorised });
    first.push(welcome);
    first.serverClose(BANNED_CLOSE);
    expect(statuses).toEqual(['lost:0']);
    expect(s.lostReason).toBe('banned');
    // The account layer hears of it once, and the session token is not thrown away as merely stale.
    expect(onBanned).toHaveBeenCalledTimes(1);
    expect(onUnauthorised).not.toHaveBeenCalled();
    // The table and the lobby say "banned", not "connection lost".
    expect(linkNotice({ status: s.status, reason: s.lostReason }, s.client.state)).toBe('banned');
    s.retryNow();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(s.lostReason).toBe('banned');
    s.close();
  });

  it('a ban found on the way back to the table ends the session with the same message', async () => {
    const onBanned = vi.fn();
    const { s, statuses, first } = await open({ auth: async () => 'mjs_x', onBanned });
    first.push(welcome);
    // The link drops, and the account is banned before the first attempt to come back.
    FakeSocket.accept = () => 'banned';
    first.serverClose(1006);
    expect(s.status).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1000);
    expect(statuses).toEqual(['reconnecting:1', 'lost:1']);
    expect(s.lostReason).toBe('banned');
    expect(onBanned).toHaveBeenCalledTimes(1);
    expect(linkNotice({ status: s.status, reason: s.lostReason }, s.client.state)).toBe('banned');
    // One attempt was made, and no other follows.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(FakeSocket.all).toHaveLength(2);
    s.close();
  });

  it('a ban outranks a seat opened on another device: Home could not give the seat back', async () => {
    const onBanned = vi.fn();
    const { s, first } = await open({ onBanned });
    first.push(welcome);
    first.push(seatOpenedElsewhere);
    expect(linkNotice({ status: s.status, reason: s.lostReason }, s.client.state)).toBe('seatTaken');
    first.serverClose(BANNED_CLOSE);
    expect(onBanned).toHaveBeenCalledTimes(1);
    expect(s.lostReason).toBe('banned');
    expect(linkNotice({ status: s.status, reason: s.lostReason }, s.client.state)).toBe('banned');
    await vi.advanceTimersByTimeAsync(60 * 60_000);
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
