/**
 * Quick match: fill timing on a fake clock, blocked pairs, refusals, one entry per account, the
 * table only the matched accounts may enter, starting by itself, nothing counted in any club, mutes
 * at the table; and a real-socket run against createSignalServer with three clients.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { QueueError, RelayTransport, SignalingClient, TableClient, transportLink, type QueueStatus, type WebSocketLike } from '@mjm/net';
import { SessionService } from '../src/auth';
import { ClubRegistry } from '../src/clubs';
import { loadConfig } from '../src/config';
import { blockedEitherWay, fillMsFromEnv, Matchmaker, quickMatchCheck, type QueuePeer } from '../src/matchmaking';
import { MuteList } from '../src/moderation';
import { createMemoryRepos, createRepos } from '../src/repos';
import { RoomRegistry, type Socket } from '../src/rooms';
import { createSignalServer, type SignalServer } from '../src/server';

type Msg = { t: string; [k: string]: unknown };

/** A queue with a fake clock; tables are recorded instead of opened. */
function queue(opts: { fillMs?: number; refuse?: Record<string, 'banned' | 'age_missing' | 'age_under'>; blocks?: Array<[string, string]> } = {}) {
  const clock = { now: 1_000_000 };
  const tables: string[][] = [];
  const mm = new Matchmaker({
    now: () => clock.now,
    fillMs: opts.fillMs,
    check: async (id) => opts.refuse?.[id] ?? null,
    avoid: async (id) => (opts.blocks ?? []).flatMap(([a, b]) => (a === id ? [b] : b === id ? [a] : [])),
    openTable: (ids) => {
      tables.push(ids);
      return `ROOM${tables.length}`;
    },
  });
  const peers = new Map<string, { peer: QueuePeer; out: Msg[] }>();
  let n = 0;
  const join = async (userId: string) => {
    const out: Msg[] = [];
    const peer: QueuePeer = { peerId: `p-${++n}`, userId, send: (m) => out.push(m as Msg) };
    peers.set(peer.peerId, { peer, out });
    await mm.enqueue(peer);
    return { peerId: peer.peerId, out, last: () => out[out.length - 1] };
  };
  /** Move the clock on in 500 ms ticks, as the server does. */
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 500) {
      clock.now += 500;
      mm.tick();
    }
  };
  return { mm, clock, tables, join, advance };
}

const matched = (out: Msg[]) => out.find((m) => m.t === 'matched');

describe('the quick-match queue', () => {
  it('seats four humans at once, in arrival order, with no bots', async () => {
    const q = queue();
    const ps = [];
    for (const id of ['a', 'b', 'c']) ps.push(await q.join(id));
    expect(q.tables).toEqual([]);
    expect(ps[2].last()).toMatchObject({ t: 'queue_status', position: 3, humans: 3, waitedMs: 0, fillMs: 20_000 });
    ps.push(await q.join('d'));
    expect(q.tables).toEqual([['a', 'b', 'c', 'd']]);
    for (const p of ps) expect(matched(p.out)).toEqual({ t: 'matched', room: 'ROOM1', humans: 4, bots: 0 });
    expect(q.mm.size()).toBe(0);
  });

  it('gives one human three Club bots at 20 s, with a status every 2 s meanwhile', async () => {
    const q = queue();
    const a = await q.join('a');
    q.advance(19_500);
    expect(q.tables).toEqual([]);
    const statuses = a.out.filter((m) => m.t === 'queue_status') as unknown as QueueStatus[];
    // One at once, then one every 2 s.
    expect(statuses.length).toBe(1 + Math.floor(19_500 / 2000));
    expect(statuses.map((s) => s.waitedMs)).toEqual([0, 2000, 4000, 6000, 8000, 10_000, 12_000, 14_000, 16_000, 18_000]);
    expect(statuses.every((s) => s.position === 1 && s.humans === 1)).toBe(true);
    q.advance(500);
    expect(q.tables).toEqual([['a']]);
    expect(matched(a.out)).toEqual({ t: 'matched', room: 'ROOM1', humans: 1, bots: 3 });
  });

  it('seats two humans who arrived 10 s apart together, with two bots, 20 s after the first', async () => {
    const q = queue();
    const a = await q.join('a');
    q.advance(10_000);
    const b = await q.join('b');
    expect(b.last()).toMatchObject({ t: 'queue_status', position: 2, humans: 2, waitedMs: 0 });
    q.advance(9_500);
    expect(q.tables).toEqual([]);
    q.advance(500);
    expect(q.tables).toEqual([['a', 'b']]);
    expect(matched(a.out)).toMatchObject({ humans: 2, bots: 2 });
    expect(matched(b.out)).toMatchObject({ room: 'ROOM1', humans: 2, bots: 2 });
  });

  it('never puts a blocked pair in one group, whichever of them blocked', async () => {
    const q = queue({ blocks: [['b', 'a']] });
    for (const id of ['a', 'b', 'c', 'd']) await q.join(id);
    expect(q.tables).toEqual([]);
    const e = await q.join('e');
    expect(q.tables).toEqual([['a', 'c', 'd', 'e']]);
    expect(matched(e.out)).toMatchObject({ humans: 4 });
    expect(q.mm.waiting()).toEqual(['b']);
    q.advance(20_000);
    expect(q.tables).toEqual([['a', 'c', 'd', 'e'], ['b']]);
  });

  it('a block made while waiting splits the group from then on', async () => {
    const blocks: Array<[string, string]> = [];
    const q = queue({ blocks });
    await q.join('a');
    await q.join('b');
    blocks.push(['a', 'b']);
    q.mm.blocksChanged('a');
    await Promise.resolve();
    q.advance(20_000);
    expect(q.tables).toEqual([['a'], ['b']]);
  });

  it('refuses banned and under-age accounts with their codes', async () => {
    const q = queue({ refuse: { cheat: 'banned', kid: 'age_under', unknown: 'age_missing' } });
    const cheat = await q.join('cheat');
    const kid = await q.join('kid');
    const unknown = await q.join('unknown');
    expect(cheat.out).toEqual([{ t: 'queue_error', code: 'banned', message: expect.any(String) }]);
    expect(kid.out).toEqual([{ t: 'queue_error', code: 'age_under', message: expect.any(String) }]);
    expect(unknown.out).toEqual([{ t: 'queue_error', code: 'age_missing', message: expect.any(String) }]);
    expect(q.mm.size()).toBe(0);
  });

  it('keeps one entry per account: a second socket replaces the first and keeps its place', async () => {
    const q = queue();
    const first = await q.join('a');
    q.advance(4_000);
    await q.join('b');
    const second = await q.join('a');
    expect(first.last()).toMatchObject({ t: 'queue_error', code: 'replaced' });
    expect(q.mm.waiting()).toEqual(['a', 'b']);
    expect(second.last()).toMatchObject({ t: 'queue_status', position: 1, waitedMs: 4_000, humans: 2 });
    q.advance(16_000);
    expect(q.tables).toEqual([['a', 'b']]);
    expect(matched(first.out)).toBeUndefined();
    expect(matched(second.out)).toMatchObject({ humans: 2 });
  });

  it('leaving takes a player out; a leave while the checks run cancels the request', async () => {
    const q = queue();
    const a = await q.join('a');
    q.mm.leave(a.peerId);
    expect(a.last()).toEqual({ t: 'queue_left' });
    expect(q.mm.size()).toBe(0);
    const out: Msg[] = [];
    const pending = q.mm.enqueue({ peerId: 'p-x', userId: 'x', send: (m) => out.push(m as Msg) });
    q.mm.leave('p-x');
    await pending;
    expect(q.mm.size()).toBe(0);
    q.mm.removeUser('nobody');
  });

  it('reads QUICK_MATCH_FILL_MS, falling back to 20 s', () => {
    expect(fillMsFromEnv({})).toBe(20_000);
    expect(fillMsFromEnv({ QUICK_MATCH_FILL_MS: '5000' })).toBe(5000);
    expect(fillMsFromEnv({ QUICK_MATCH_FILL_MS: 'soon' })).toBe(20_000);
    expect(fillMsFromEnv({ QUICK_MATCH_FILL_MS: '-1' })).toBe(20_000);
  });
});

describe('who may queue (the repositories)', () => {
  it('banned first, then a birth year that makes the player at least 17; guests are fine', async () => {
    const repos = createMemoryRepos();
    const now = Date.UTC(2026, 10, 9);
    const mk = async (birthYear: number | null, kind: 'guest' | 'account' = 'guest') => (await repos.users.create({ id: randomUUID(), kind, birthYear, createdAt: 0 })).id;
    const adult = await mk(1990);
    const seventeen = await mk(2008);
    const sixteen = await mk(2009);
    const unknown = await mk(null);
    const banned = await mk(1990, 'account');
    await repos.moderation.ban(banned, now, 'cheating');
    expect(await quickMatchCheck(repos, adult, now)).toBeNull();
    expect(await quickMatchCheck(repos, seventeen, now)).toBeNull();
    // Too young is one answer, no year on file another: only the second is something the app can fix.
    expect(await quickMatchCheck(repos, sixteen, now)).toBe('age_under');
    expect(await quickMatchCheck(repos, unknown, now)).toBe('age_missing');
    expect(await quickMatchCheck(repos, banned, now)).toBe('banned');
    await expect(quickMatchCheck(repos, randomUUID(), now)).rejects.toThrow();
    await repos.blocks.add(adult, sixteen, 1);
    await repos.blocks.add(unknown, adult, 2);
    expect((await blockedEitherWay(repos, adult)).sort()).toEqual([sixteen, unknown].sort());
  });
});

// ---------------------------------------------------------------------------------------------

function fakeSocket(): Socket & { out: Msg[] } {
  const out: Msg[] = [];
  return { out, send: (j) => out.push(JSON.parse(j) as Msg), close: () => undefined };
}

/** A registry with a fake clock and the queue wired in, plus signed-in peers. */
function registry(opts: { mutes?: MuteList } = {}) {
  const clock = { now: 1_000_000 };
  const mm: Matchmaker = new Matchmaker({ now: () => clock.now, check: async () => null, avoid: async () => [], openTable: (ids): string => rooms.createQuickMatchRoom(ids) });
  const rooms: RoomRegistry = new RoomRegistry({ allowHosted: true, now: () => clock.now, botDelayMs: 0, queue: mm, isMuted: (id) => opts.mutes?.isMuted(id) ?? false });
  let n = 0;
  const peer = (userId = `user-${++n}-${randomUUID().slice(0, 8)}`) => {
    const socket = fakeSocket();
    const id = rooms.hello(rooms.connect(socket), userId, `s-${userId}`, `Name${n}`);
    const table = (msg: Record<string, unknown>) => rooms.handle(id, { t: 'to', to: `server-${code()}`, data: { ch: 'game', msg } });
    let joined = '';
    const code = () => joined;
    const enter = (room: string) => {
      joined = room;
      rooms.handle(id, { t: 'join', room });
      return socket.out[socket.out.length - 1];
    };
    return { id, userId, socket, table, enter, sit: () => table({ t: 'join', name: 'x' }) };
  };
  return { rooms, mm, clock, peer };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('quick-match tables', () => {
  it('only the matched accounts may enter; nobody else, not even to watch, and no player cap is spent', async () => {
    const { rooms, peer } = registry();
    const a = peer();
    const b = peer();
    const stranger = peer();
    const room = rooms.createQuickMatchRoom([a.userId, b.userId]);
    expect(stranger.enter(room)).toMatchObject({ t: 'error', code: 'room_unavailable' });
    expect(a.enter(room)).toMatchObject({ t: 'room', room });
    expect(rooms.openTablesOf(a.userId)).toBe(0);
    expect(rooms.clubOf(room)).toBeUndefined();
    expect(rooms.createdByOf(room)).toBeUndefined();
    expect(rooms.isQuickMatch(room)).toBe(true);
    expect(rooms.quickPlayersOf(room)).toEqual([a.userId, b.userId]);
  });

  it('starts by itself once every matched player has sat down; players cannot start it or add bots', async () => {
    const { rooms, peer } = registry();
    const a = peer();
    const b = peer();
    const room = rooms.createQuickMatchRoom([a.userId, b.userId]);
    a.enter(room);
    a.sit();
    a.table({ t: 'start' });
    a.table({ t: 'add_bot' });
    await flush();
    const host = rooms.hostedTable(room)!;
    expect(host.phase).toBe('lobby');
    expect(host.seatInfo().filter((s) => s.isBot)).toEqual([]);
    b.enter(room);
    b.sit();
    await flush();
    expect(host.phase).toBe('commit');
    expect(host.seatInfo().filter((s) => s.isBot).length).toBe(2);
  });

  it('starts after 15 s with bots in the seats of matched players who never came, and closes if nobody came', async () => {
    const { rooms, clock, peer } = registry();
    const a = peer();
    const b = peer();
    const room = rooms.createQuickMatchRoom([a.userId, b.userId]);
    a.enter(room);
    a.sit();
    await flush();
    clock.now += 14_500;
    rooms.tick();
    expect(rooms.hostedTable(room)!.phase).toBe('lobby');
    clock.now += 500;
    rooms.tick();
    const host = rooms.hostedTable(room)!;
    expect(host.phase).toBe('commit');
    expect(host.seatInfo().filter((s) => s.isBot).length).toBe(3);

    const empty = rooms.createQuickMatchRoom([peer().userId]);
    clock.now += 15_000;
    rooms.tick();
    expect(rooms.hasRoom(empty)).toBe(false);
  });

  it('the queue runs over the socket frames: queue, status, matched, and the matched room is enterable', async () => {
    const { rooms, mm, clock, peer } = registry();
    const ps = [peer(), peer(), peer(), peer()];
    for (const p of ps.slice(0, 3)) rooms.handle(p.id, { t: 'queue' });
    await flush();
    expect(mm.size()).toBe(3);
    expect(ps[0].socket.out.at(-1)).toMatchObject({ t: 'queue_status', position: 1 });
    rooms.handle(ps[3].id, { t: 'queue' });
    await flush();
    const m = ps[3].socket.out.find((x) => x.t === 'matched') as unknown as { room: string };
    expect(m).toMatchObject({ humans: 4, bots: 0 });
    for (const p of ps) expect(p.enter(m.room)).toMatchObject({ t: 'room', room: m.room });
    // Leaving and disconnecting take a waiting player out.
    const late = peer();
    rooms.handle(late.id, { t: 'queue' });
    await flush();
    rooms.handle(late.id, { t: 'leave_queue' });
    expect(mm.size()).toBe(0);
    const gone = peer();
    rooms.handle(gone.id, { t: 'queue' });
    await flush();
    rooms.disconnect(gone.id);
    expect(mm.size()).toBe(0);
    // The join allowance applies to the queue too.
    const eager = peer();
    for (let i = 0; i < 6; i++) rooms.handle(eager.id, { t: 'queue' });
    expect(eager.socket.out.some((x) => x.t === 'queue_error' && x.code === 'rate_limited')).toBe(true);
    clock.now += 1;
  });

  it('a socket without an account cannot queue', () => {
    const { rooms } = registry();
    const socket = fakeSocket();
    const id = rooms.handle(rooms.connect(socket), { t: 'hello' });
    rooms.handle(id, { t: 'queue' });
    expect(socket.out.at(-1)).toMatchObject({ t: 'queue_error', code: 'sign_in' });
  });

  it("drops a muted account's chat lines and emotes at the table", async () => {
    const mutes = new MuteList();
    const { rooms, peer } = registry({ mutes });
    const a = peer();
    const b = peer();
    const room = rooms.createQuickMatchRoom([a.userId, b.userId]);
    a.enter(room);
    a.sit();
    b.enter(room);
    b.sit();
    const heard = () => b.socket.out.filter((m) => m.t === 'from' && ['chat', 'emote'].includes(((m.data as { msg: { t: string } }).msg ?? {}).t)).length;
    a.table({ t: 'chat', text: 'gg' });
    expect(heard()).toBe(1);
    mutes.set(a.userId, Date.now() + 60_000);
    a.table({ t: 'chat', text: 'nice' });
    a.table({ t: 'emote', emote: 'lol' });
    expect(heard()).toBe(1);
  });

  it('a finished quick-match game counts in no club standings', async () => {
    const repos = createMemoryRepos();
    const clubs = new ClubRegistry({ store: repos.clubs });
    const { rooms, peer } = registry();
    const a = peer();
    const club = clubs.createClub({ userId: a.userId, name: 'Owner' }, 'Tea House', {}, {});
    const room = rooms.createQuickMatchRoom([a.userId]);
    a.enter(room);
    a.sit();
    const host = rooms.hostedTable(room)!;
    clubs.applyRoomEvent(room, { type: 'match_over', roomCode: room, matchId: host.matchId, seats: host.seatInfo(), scores: [100, 0, 0, -100], handNumber: 4, handsWon: [1, 0, 0, 0] });
    expect(clubs.club(club.code).members.every((m) => m.points === 0 && m.matchesPlayed === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------

const servers: SignalServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('quick match over real sockets', () => {
  it('three players queue, are matched with one bot, join by code and the table starts by itself; a stranger is kept out', async () => {
    const repos = createRepos();
    const sessions = new SessionService(repos.repos, { pepper: 'quick-pepper-0123456789abcdef' });
    const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions, providers: {}, config: loadConfig({}), botDelayMs: 0, persistDebounceMs: 20, log: () => undefined, quickMatchFillMs: 400 });
    servers.push(server);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const guest = async (name: string, birthYear: number | null = 1990) => {
      const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: { id: randomUUID(), platform: 'ios' }, displayName: name }) });
      const json = (await res.json()) as { userId: string; session: { token: string } };
      if (birthYear !== null) await fetch(`${base}/api/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${json.session.token}` }, body: JSON.stringify({ birthYear }) });
      return json;
    };
    const client = (token: string) =>
      new SignalingClient(`ws://127.0.0.1:${port}`, {
        auth: token,
        webSocket: (u) => {
          const ws = new WebSocket(u);
          sockets.push(ws);
          return ws as unknown as WebSocketLike;
        },
      });

    // No birth year on the server: refused with age_missing.
    const young = await guest('Young', null);
    const yc = client(young.session.token);
    await yc.connect();
    await expect(yc.findMatch().match).rejects.toMatchObject({ code: 'age_missing' });
    expect(QueueError).toBeDefined();

    const players = await Promise.all(['Mei', 'Kai', 'Lee'].map((n) => guest(n)));
    const clients = players.map((p) => client(p.session.token));
    await Promise.all(clients.map((c) => c.connect()));
    const statuses: QueueStatus[] = [];
    const rooms = await Promise.all(clients.map((c, i) => c.findMatch((s) => i === 0 && statuses.push(s)).match));
    expect(new Set(rooms).size).toBe(1);
    expect(statuses[0]).toMatchObject({ position: 1, fillMs: 400 });
    const room = rooms[0];

    const stranger = await guest('Stranger');
    const sc = client(stranger.session.token);
    await sc.connect();
    await expect(sc.joinRoom(room)).rejects.toMatchObject({ code: 'room_unavailable' });

    const tables = await Promise.all(
      clients.map(async (c, i) => {
        const info = await c.joinRoom(room);
        const t = new TableClient(transportLink(new RelayTransport(c), info.host), ['Mei', 'Kai', 'Lee'][i]);
        t.join();
        return t;
      }),
    );
    expect(tables.length).toBe(3);
    const host = server.rooms.hostedTable(room)!;
    const deadline = Date.now() + 10_000;
    while (host.phase === 'lobby' && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(host.phase).not.toBe('lobby');
    expect(host.seatInfo().filter((s) => s.isBot).length).toBe(1);
    expect(host.seatInfo().filter((s) => !s.isBot).map((s) => s.userId).sort()).toEqual(players.map((p) => p.userId).sort());
    expect(server.rooms.clubOf(room)).toBeUndefined();
  });
});

describe('a ban over real sockets', () => {
  it("closes the banned account's socket with 4403 and refuses its next hello with 4403", async () => {
    const repos = createRepos();
    const sessions = new SessionService(repos.repos, { pepper: 'ban-pepper-0123456789abcdef' });
    const token = 'moderator-token-0123456789';
    const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions, providers: {}, config: loadConfig({}), botDelayMs: 0, log: () => undefined, adminToken: token });
    servers.push(server);
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const res = await fetch(`${base}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: { id: randomUUID(), platform: 'ios' }, displayName: 'Cheat' }) });
    const g = (await res.json()) as { userId: string; session: { token: string } };
    const open = (): Promise<{ ws: WebSocket; closed: Promise<number> }> =>
      new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`);
        sockets.push(ws);
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
        ws.on('open', () => {
          ws.send(JSON.stringify({ t: 'hello', auth: g.session.token }));
          resolve({ ws, closed });
        });
      });
    const first = await open();
    await new Promise<void>((r) => first.ws.once('message', () => r()));
    const ban = await fetch(`${base}/api/admin/users/${g.userId}/ban`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}' });
    expect(ban.status).toBe(200);
    expect(await first.closed).toBe(4403);
    const second = await open();
    expect(await second.closed).toBe(4403);
  });
});
