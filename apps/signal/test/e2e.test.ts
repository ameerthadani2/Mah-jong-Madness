/**
 * The whole game server over real sockets on port 0: guest accounts over HTTP, two players on
 * real WebSockets through SignalingClient, a hosted table played hand by hand, a dropped socket
 * rejoining with its rejoin token, the club table gate, the flood limit, and a restart that
 * restores the table from the same repositories mid-hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { chooseAction, legalActions } from '@mjm/engine';
import { RelayTransport, SignalingClient, TableClient, transportLink, type AuditStatus, type WebSocketLike } from '@mjm/net';
import { SessionService } from '../src/auth';
import { LIMITS, loadConfig } from '../src/config';
import { createRepos, type RepoHandle } from '../src/repos';
import { createSignalServer, type SignalServer, type SignalServerOptions } from '../src/server';

const PEPPER = 'e2e-pepper-0123456789abcdef';
/** A provider configured with no keys: it shows up in /api/config, and every token for it fails. */
const PROVIDERS = { apple: { clientIds: ['com.example.mahjong'], jwks: { keys: [] } } };

const servers: SignalServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  vi.restoreAllMocks();
});

async function start(repos: RepoHandle = createRepos(), sessions = new SessionService(repos.repos, { pepper: PEPPER }), extra: Partial<SignalServerOptions> = {}) {
  const server = await createSignalServer({
    port: 0,
    host: '127.0.0.1',
    repos,
    sessions,
    providers: PROVIDERS,
    config: loadConfig({}),
    botDelayMs: 0,
    persistDebounceMs: 20,
    log: () => undefined,
    ...extra,
  });
  servers.push(server);
  const port = server.address().port;
  return { server, repos, sessions, base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` };
}

async function api(base: string, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

async function guest(base: string, displayName: string): Promise<{ userId: string; token: string }> {
  const res = await api(base, 'POST', '/api/auth/guest', { device: { id: crypto.randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' }, displayName });
  expect(res.status).toBe(201);
  return { userId: res.json.userId as string, token: (res.json.session as { token: string }).token };
}

/** A SignalingClient on a real `ws` socket; `drop()` cuts the connection the way a phone losing signal does. */
function signaling(wsUrl: string, token: string) {
  let current: WebSocket | null = null;
  const client = new SignalingClient(wsUrl, {
    auth: token,
    webSocket: (u) => {
      current = new WebSocket(u);
      sockets.push(current);
      return current as unknown as WebSocketLike;
    },
  });
  return { client, drop: () => current?.terminate() };
}

async function until(what: string, pred: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A seated player that plays every legal move it is offered (chooseAction) and confirms each next hand. */
function autoplay(c: TableClient) {
  let paused = false;
  let acted: string | null = null;
  let readied = -1;
  const step = () => {
    if (paused || c.state.disconnected) return;
    const s = c.localState();
    const seat = c.state.seat;
    const audit = c.state.lastAudit;
    if (audit && audit.handNumber > readied && c.state.view?.phase === 'ended') {
      readied = audit.handNumber;
      c.ready();
      return;
    }
    if (!s || seat === null || legalActions(s, seat).length === 0) return;
    if (c.state.stateHash === acted) return;
    acted = c.state.stateHash;
    const a = chooseAction(s, seat, { seed: `e2e-${seat}` });
    if (a) c.act(a);
  };
  const off = c.onChange(() => setImmediate(step));
  // The table may already be waiting for this seat.
  setImmediate(step);
  return {
    pause: () => (paused = true),
    resume: () => {
      paused = false;
      setImmediate(step);
    },
    stop: off,
  };
}

async function sit(sig: SignalingClient, room: { host: string }, name: string, token?: string) {
  const client = new TableClient(transportLink(new RelayTransport(sig), room.host), name, undefined, { token });
  client.join();
  await until(`${name} to be seated`, () => client.state.seat !== null);
  return client;
}

const statuses = (c: TableClient): AuditStatus[] => c.state.audits.map((a) => a.status);

describe('game server end to end', () => {
  it('plays hands over real sockets, survives a dropped socket and a restart, and restores the table mid-hand', async () => {
    const first = await start();
    expect((await api(first.base, 'GET', '/api/config')).json.authProviders).toEqual(['apple']);
    const alice = await guest(first.base, 'Alice');
    const bob = await guest(first.base, 'Bob');

    const a = signaling(first.wsUrl, alice.token);
    const b = signaling(first.wsUrl, bob.token);
    await a.client.connect();
    await b.client.connect();
    expect(a.client.userId).toBe(alice.userId);
    expect(b.client.userId).toBe(bob.userId);

    const room = await a.client.createHostedRoom({ handsPerMatch: 4 }, 'club');
    expect((await b.client.joinRoom(room.room)).host).toBe(room.host);
    const ca = await sit(a.client, room, 'Alice');
    const cb = await sit(b.client, room, 'Bob');
    const host = first.server.rooms.hostedTable(room.room)!;
    // The table bound the accounts the sessions proved.
    expect(host.seatInfo().slice(0, 2).map((s) => s.userId)).toEqual([alice.userId, bob.userId]);

    // Hand 1: both play it through and both audits verify.
    const pa = autoplay(ca);
    let pb = autoplay(cb);
    ca.requestStart();
    await until('the first hand to end', () => ca.state.audits.length >= 1 && cb.state.audits.length >= 1);
    expect(statuses(ca)).toEqual(['ok']);
    expect(statuses(cb)).toEqual(['ok']);

    // Hand 2: Bob's socket drops mid-hand. Alice waits; a bot plays for Bob until he rejoins with his token.
    await until('the second hand to be dealt', () => host.phase === 'playing' && host.audits.length === 1);
    pa.pause();
    const bobToken = cb.state.token!;
    pb.stop();
    b.drop();
    await until('the table to see Bob leave', () => !host.seatInfo()[1].connected);
    const b2 = signaling(first.wsUrl, bob.token);
    await b2.client.connect();
    await b2.client.joinRoom(room.room);
    const cb2 = await sit(b2.client, room, 'Bob', bobToken);
    expect(cb2.state.seat).toBe(1);
    pb = autoplay(cb2);
    pa.resume();
    await until('the second hand to end', () => ca.state.audits.length >= 2 && cb2.state.audits.length >= 1);
    expect(statuses(ca)).toEqual(['ok', 'ok']);
    // Bob's share was not used for the hand he rejoined, so it verifies as partial, never failed.
    expect(statuses(cb2)).toEqual(['partial']);
    expect(cb2.state.auditFailures).toEqual([]);

    // Hand 3 starts: the table carried on. Stop the server mid-hand.
    await until('the third hand to be dealt', () => host.phase === 'playing' && host.audits.length === 2);
    pa.pause();
    pb.pause();
    const aliceToken = ca.state.token!;
    const bobToken2 = cb2.state.token!;
    const midHand = host.serialize();
    expect(midHand.phase).toBe('playing');
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);

    // The restart: a new server over the same repositories restores the table from its snapshot.
    const second = await start(first.repos, first.sessions);
    expect(second.server.rooms.hasRoom(room.room)).toBe(true);
    const restored = second.server.rooms.hostedTable(room.room)!;
    expect(restored.phase).toBe('playing');
    expect(restored.audits).toHaveLength(2);
    expect(restored.game?.actionLog).toEqual(midHand.game?.actionLog);

    // Both rejoin with their rejoin tokens and finish the hand.
    const a3 = signaling(second.wsUrl, alice.token);
    const b3 = signaling(second.wsUrl, bob.token);
    await a3.client.connect();
    await b3.client.connect();
    await a3.client.joinRoom(room.room);
    await b3.client.joinRoom(room.room);
    const ca3 = await sit(a3.client, room, 'Alice', aliceToken);
    const cb3 = await sit(b3.client, room, 'Bob', bobToken2);
    expect([ca3.state.seat, cb3.state.seat]).toEqual([0, 1]);
    autoplay(ca3);
    autoplay(cb3);
    await until('the restored hand to end', () => ca3.state.audits.length >= 1 && cb3.state.audits.length >= 1);
    expect(ca3.state.lastAudit!.handNumber).toBe(midHand.snapshot.handNumber);
    for (const c of [ca3, cb3]) {
      expect(c.state.auditFailures).toEqual([]);
      expect(c.state.auditStatus).not.toBe('failed');
    }
  }, 60_000);

  it('keeps non-members out of club tables, over the socket and the API', async () => {
    // The owner opens two tables in a row; each costs the account's create allowance (one per 10 s), so the server's clock moves on between them.
    let ahead = 0;
    const { base, wsUrl, server } = await start(undefined, undefined, { now: () => Date.now() + ahead });
    const owner = await guest(base, 'Owner');
    const outsider = await guest(base, 'Outsider');
    const club = (await api(base, 'POST', '/api/clubs', { name: 'Members only' }, owner.token)).json as { code: string };

    const o = signaling(wsUrl, owner.token);
    const x = signaling(wsUrl, outsider.token);
    await o.client.connect();
    await x.client.connect();
    await expect(x.client.createHostedRoom({}, 'club', { club: club.code })).rejects.toThrow('Join the club first');
    const table = await o.client.createHostedRoom({}, 'club', { club: club.code });
    expect(server.rooms.clubOf(table.room)).toBe(club.code);
    await expect(x.client.joinRoom(table.room)).rejects.toThrow('Join the club first');
    // A table opened through the API is gated the same way, and listed in the club.
    ahead += 10_000;
    const apiTable = (await api(base, 'POST', `/api/clubs/${club.code}/tables`, {}, owner.token)).json as { code: string };
    await expect(x.client.joinRoom(apiTable.code)).rejects.toThrow('Join the club first');
    const listed = (await api(base, 'GET', `/api/clubs/${club.code}`, undefined, owner.token)).json as { tables: Array<{ code: string }> };
    expect(listed.tables.map((t) => t.code).sort()).toEqual([table.room, apiTable.code].sort());
    // After joining the club the outsider may sit down.
    expect((await api(base, 'POST', `/api/clubs/${club.code}/join`, {}, outsider.token)).json.status).toBe('joined');
    await expect(x.client.joinRoom(apiTable.code)).resolves.toMatchObject({ room: apiTable.code });
  });

  it('closes a socket without a valid session with 4401, and one that floods with 1008', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { base, wsUrl } = await start();
    const closeCode = (frames: unknown[]) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(wsUrl);
        sockets.push(ws);
        ws.on('error', () => undefined);
        ws.on('open', () => {
          for (const f of frames) ws.send(JSON.stringify(f));
        });
        ws.on('close', (code) => resolve(code));
      });
    expect(await closeCode([{ t: 'hello' }])).toBe(4401);
    expect(await closeCode([{ t: 'hello', auth: `mjs_${'0'.repeat(64)}` }])).toBe(4401);
    expect(await closeCode([{ t: 'join', room: 'ABCDEF' }])).toBe(4401);
    const bad = signaling(wsUrl, `mjs_${'1'.repeat(64)}`);
    await expect(bad.client.connect()).rejects.toThrow(/^Unauthorised/);

    const user = await guest(base, 'Flood');
    const flood = Array.from({ length: 200 }, () => ({ t: 'to', to: 'nobody', data: 'x' }));
    expect(await closeCode([{ t: 'hello', auth: user.token }, ...flood])).toBe(1008);
  });

  it('ends a verified socket with 4401 once its session ends: on logout, on account deletion, and at a create or join once a quiet revocation is noticed', async () => {
    // A socket's session check stands for a short while (5 s in production; 150 ms here).
    const { base, wsUrl, server, sessions } = await start(undefined, undefined, { socketLimits: { ...LIMITS, sessionRecheckMs: 150 } });
    /** A raw socket that says hello with `token`, collecting frames and the close code. */
    const open = async (token: string) => {
      const ws = new WebSocket(wsUrl);
      sockets.push(ws);
      ws.on('error', () => undefined);
      const frames: Array<Record<string, unknown>> = [];
      ws.on('message', (raw) => frames.push(JSON.parse(String(raw)) as Record<string, unknown>));
      const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
      await new Promise<void>((resolve) => ws.once('open', () => resolve()));
      ws.send(JSON.stringify({ t: 'hello', auth: token }));
      await until('the hello reply', () => frames.some((f) => f.t === 'hello'));
      const send = (frame: unknown) => ws.send(JSON.stringify(frame));
      const last = () => frames[frames.length - 1];
      return { ws, frames, closed, send, last };
    };

    // Logout: the socket this session opened is closed at once, with the account's other socket untouched.
    const alice = await guest(base, 'Alice');
    const a = await open(alice.token);
    a.send({ t: 'create', hosted: true });
    await until('a room', () => a.last().t === 'room');
    const room = a.last().room as string;
    expect(server.rooms.peerUser(a.frames[0].id as string)).toBe(alice.userId);
    expect((await api(base, 'POST', '/api/auth/logout', undefined, alice.token)).status).toBe(204);
    expect(await a.closed).toBe(4401);
    await until('the peer to be forgotten', () => server.rooms.peerUser(a.frames[0].id as string) === undefined);

    // Account deletion: every socket of the account goes.
    const carol = await guest(base, 'Carol');
    const c1 = await open(carol.token);
    const c2 = await open(carol.token);
    expect((await api(base, 'DELETE', '/api/me', undefined, carol.token)).status).toBe(204);
    expect(await Promise.all([c1.closed, c2.closed])).toEqual([4401, 4401]);

    // A session that ended without the API knowing a socket was open (here: revoked straight in
    // the store, as an expiry would): once the last check is too old to stand, the next join is
    // refused, nothing is joined, the socket closes.
    const bob = await guest(base, 'Bob');
    const b = await open(bob.token);
    await sessions.revoke((await sessions.verify(bob.token)).sessionId);
    await new Promise((r) => setTimeout(r, 200));
    b.send({ t: 'join', room });
    expect(await b.closed).toBe(4401);
    expect(b.frames.map((f) => f.t)).toEqual(['hello']);
    await until('every peer to be gone', () => server.rooms.stats().peers === 0);
  });
});
