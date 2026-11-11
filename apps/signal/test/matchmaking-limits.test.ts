/**
 * Quick-match tables stay inside the server's limits: one unfinished quick-match table per
 * account, each table charged to its players' create allowance (per account and per address),
 * and a started table closed two minutes after its last player disconnected. Ends with one
 * address trying to fill a small server through the real sockets.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { SessionService } from '../src/auth';
import { LIMITS, loadConfig } from '../src/config';
import { Matchmaker, type QueuePeer } from '../src/matchmaking';
import { createRepos } from '../src/repos';
import { KEEP_ALIVE_MS, QUICK_ABANDONED_MS, RoomRegistry, type Socket } from '../src/rooms';
import { createSignalServer, type SignalServer } from '../src/server';

type Msg = { t: string; [k: string]: unknown };
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A registry on a fake clock with the queue wired in as the server wires it. */
function registry(opts: { fillMs?: number; maxHostedTables?: number } = {}) {
  const clock = { now: 1_000_000 };
  const mm: Matchmaker = new Matchmaker({
    now: () => clock.now,
    fillMs: opts.fillMs ?? 1_000,
    check: async () => null,
    avoid: async () => [],
    openTable: (ids): string => rooms.createQuickMatchRoom(ids),
    seatedAt: (userId): string | undefined => rooms.quickTableOf(userId),
    charge: (peerIds): string[] => rooms.chargeQuickMatch(peerIds),
  });
  const rooms: RoomRegistry = new RoomRegistry({ allowHosted: true, now: () => clock.now, botDelayMs: 0, queue: mm, maxHostedTables: opts.maxHostedTables });
  let n = 0;
  const peer = (userId = `user-${++n}-${randomUUID().slice(0, 8)}`, ip?: string) => {
    const out: Msg[] = [];
    const socket: Socket = { send: (j) => out.push(JSON.parse(j) as Msg), close: () => undefined };
    const id = rooms.hello(rooms.connect(socket, ip), userId, `s-${userId}`, 'Name');
    let joined = '';
    const enter = (room: string) => {
      joined = room;
      rooms.handle(id, { t: 'join', room });
      return out[out.length - 1];
    };
    const sit = () => rooms.handle(id, { t: 'to', to: `server-${joined}`, data: { ch: 'game', msg: { t: 'join', name: 'x' } } });
    /** Leave the table on purpose, as the app does when the player walks away from it. */
    const walkAway = () => rooms.handle(id, { t: 'to', to: `server-${joined}`, data: { ch: 'game', msg: { t: 'leave' } } });
    /** Queue and wait out the fill time; returns the last queue frame. */
    const queue = async () => {
      const from = out.length;
      rooms.handle(id, { t: 'queue' });
      await flush();
      for (let i = 0; i < 4 && !out.slice(from).some((m) => m.t === 'matched' || m.t === 'queue_error'); i++) {
        clock.now += 500;
        mm.tick();
        rooms.tick();
      }
      return out.slice(from).filter((m) => m.t === 'matched' || m.t === 'queue_error').at(-1) ?? out.at(-1)!;
    };
    return { id, userId, out, enter, sit, walkAway, queue, leave: () => rooms.disconnect(id) };
  };
  /** Move the clock on in half-second ticks, as the server does. */
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 500) {
      clock.now += 500;
      mm.tick();
      rooms.tick();
    }
  };
  return { rooms, mm, clock, peer, advance };
}

/** The rejoin token the table sent this socket in its `welcome`. */
function tokenOf(out: Msg[]): string {
  const welcome = out.map((m) => (m.t === 'from' ? ((m.data as { msg?: Msg } | undefined)?.msg ?? null) : null)).find((m) => m?.t === 'welcome');
  return welcome!.token as string;
}

describe('one quick-match table per account', () => {
  it('an account that holds a seat at an unfinished quick-match table is not queued again and is told its table', async () => {
    const { rooms, mm, peer, advance } = registry();
    const a = peer();
    const first = await a.queue();
    expect(first).toMatchObject({ t: 'matched', humans: 1, bots: 3 });
    const room = first.room as string;
    // Matched but not seated yet: the table is waiting for it.
    expect(await a.queue()).toMatchObject({ t: 'queue_error', code: 'seated', room });
    a.enter(room);
    a.sit();
    await flush();
    expect(rooms.hostedTable(room)!.phase).not.toBe('lobby');
    advance(LIMITS.createCooldownMs + LIMITS.joinWindowMs);
    // Seated and playing, from this socket or another one of the same account: still its table.
    expect(await a.queue()).toMatchObject({ t: 'queue_error', code: 'seated', room });
    const second = peer(a.userId);
    expect(await second.queue()).toMatchObject({ t: 'queue_error', code: 'seated', room });
    expect(mm.size()).toBe(0);
    expect(rooms.stats().hostedTables).toBe(1);
    // Disconnected, the seat is still its own (a bot plays it): no second table either.
    a.leave();
    second.leave();
    advance(LIMITS.createCooldownMs + LIMITS.joinWindowMs);
    const back = peer(a.userId);
    expect(await back.queue()).toMatchObject({ t: 'queue_error', code: 'seated', room });
  });

  it('is free to queue again once its table has closed, or started without it', async () => {
    const { rooms, peer, advance } = registry();
    const a = peer();
    const b = peer();
    const [ma, mb] = await Promise.all([a.queue(), b.queue()]);
    expect(ma.room).toBe(mb.room);
    const room = ma.room as string;
    // Only b sits down; the table starts at its deadline with a bot in a's seat.
    b.enter(room);
    b.sit();
    advance(15_000);
    expect(rooms.hostedTable(room)!.phase).not.toBe('lobby');
    expect(rooms.quickTableOf(a.userId)).toBeUndefined();
    expect(rooms.quickTableOf(b.userId)).toBe(room);
    expect(await a.queue()).toMatchObject({ t: 'matched' });
    // b's table closes two minutes after b went away; then b may queue again.
    b.leave();
    advance(QUICK_ABANDONED_MS);
    expect(rooms.hasRoom(room)).toBe(false);
    expect(rooms.quickTableOf(b.userId)).toBeUndefined();
    const again = peer(b.userId);
    expect(await again.queue()).toMatchObject({ t: 'matched' });
  });
});

describe('a player who left a quick-match table on purpose', () => {
  it('may queue for another table once its create allowance allows; a dropped connection is not a leave', async () => {
    const { rooms, peer, advance } = registry();
    const a = peer();
    const b = peer();
    const [ma, mb] = await Promise.all([a.queue(), b.queue()]);
    expect(ma.room).toBe(mb.room);
    const room = ma.room as string;
    for (const p of [a, b]) {
      p.enter(room);
      p.sit();
    }
    await flush();
    expect(rooms.hostedTable(room)!.phase).not.toBe('lobby');
    // a walks away: a bot plays its seat, which stays its own to come back to, but it is no longer held to this table.
    a.walkAway();
    expect(rooms.hostedTable(room)!.seatInfo().find((s) => s.userId === a.userId)).toMatchObject({ isBot: false, left: true });
    expect(rooms.quickTableOf(a.userId)).toBeUndefined();
    // b only lost its connection: its seat is waiting for it.
    b.leave();
    expect(rooms.quickTableOf(b.userId)).toBe(room);
    // The next table is charged like the first: not within the cooldown, then yes.
    const soon = peer(a.userId);
    rooms.handle(soon.id, { t: 'queue' });
    await flush();
    advance(2_000);
    expect(soon.out.some((m) => m.t === 'matched' || m.t === 'queue_error')).toBe(false);
    advance(LIMITS.createCooldownMs);
    const next = soon.out.find((m) => m.t === 'matched');
    expect(next).toBeDefined();
    expect(next!.room).not.toBe(room);
    expect(await peer(b.userId).queue()).toMatchObject({ t: 'queue_error', code: 'seated', room });
    expect(rooms.stats().hostedTables).toBe(2);
  });
});

describe('a quick-match table is charged like a table its players opened', () => {
  it("spends each matched account's create allowance: a second table within the cooldown is refused", async () => {
    const { rooms, peer, advance } = registry();
    const a = peer();
    const m = await a.queue();
    expect(m).toMatchObject({ t: 'matched' });
    // Nobody came: the table closes at its start deadline, 15 s later, and the allowance has refilled by then.
    advance(15_000);
    expect(rooms.hasRoom(m.room as string)).toBe(false);
    expect(await a.queue()).toMatchObject({ t: 'matched' });
    // The account's own create is refused while the charge is fresh.
    rooms.handle(a.id, { t: 'create', hosted: true });
    expect(a.out.at(-1)).toMatchObject({ t: 'error', message: expect.stringContaining('wait') });
  });

  it('spends the address allowance once per table, however many of its players share the address', async () => {
    const { rooms } = registry();
    const out: Msg[] = [];
    const socket: Socket = { send: (j) => out.push(JSON.parse(j) as Msg), close: () => undefined };
    const ids = [0, 1, 2, 3].map((i) => rooms.hello(rooms.connect(socket, '203.0.113.9'), `user-shared-${i}`));
    expect(rooms.chargeQuickMatch(ids)).toEqual([]);
    // Five more tables from that address use up its six a minute; the seventh is refused for everyone on it.
    for (let i = 0; i < LIMITS.createsPerIpPerMinute - 1; i++) {
      const id = rooms.hello(rooms.connect(socket, '203.0.113.9'), `user-more-${i}`);
      expect(rooms.chargeQuickMatch([id])).toEqual([]);
    }
    const late = rooms.hello(rooms.connect(socket, '203.0.113.9'), 'user-late-1');
    const elsewhere = rooms.hello(rooms.connect(socket, '198.51.100.7'), 'user-elsewhere-1');
    expect(rooms.chargeQuickMatch([late, elsewhere])).toEqual([late]);
  });

  it('keeps a player with no allowance left waiting, seats the rest of the group, and seats that player once it can pay', async () => {
    const clock = { now: 0 };
    const tables: string[][] = [];
    let broke = true;
    const mm = new Matchmaker({
      now: () => clock.now,
      fillMs: 1_000,
      check: async () => null,
      avoid: async () => [],
      openTable: (ids) => (tables.push(ids), `ROOM${tables.length}`),
      charge: (peerIds) => peerIds.filter((id) => broke && id === 'p-broke'),
    });
    const outs = new Map<string, Msg[]>();
    const join = async (peerId: string, userId: string) => {
      const out: Msg[] = [];
      outs.set(peerId, out);
      const p: QueuePeer = { peerId, userId, send: (m) => out.push(m as Msg) };
      await mm.enqueue(p);
    };
    await join('p-broke', 'u1');
    await join('p-ok-1', 'u2');
    await join('p-ok-2', 'u3');
    clock.now += 1_000;
    mm.tick();
    expect(tables).toEqual([['u2', 'u3']]);
    expect(outs.get('p-ok-1')!.at(-1)).toMatchObject({ t: 'matched', room: 'ROOM1', humans: 2, bots: 2 });
    // Still in the queue, in its place, with no table opened for it and no error.
    expect(mm.waiting()).toEqual(['u1']);
    expect(outs.get('p-broke')!.some((m) => m.t === 'queue_error' || m.t === 'matched')).toBe(false);
    clock.now += 5_000;
    mm.tick();
    expect(tables).toHaveLength(1);
    broke = false;
    clock.now += 500;
    mm.tick();
    expect(tables).toEqual([['u2', 'u3'], ['u1']]);
    expect(outs.get('p-broke')!.at(-1)).toMatchObject({ t: 'matched', room: 'ROOM2', humans: 1, bots: 3 });
    expect(mm.size()).toBe(0);
  });
});

describe('an abandoned quick-match table', () => {
  it('closes two minutes after its last player disconnected, while the bots are still playing', async () => {
    const { rooms, peer, advance } = registry();
    const a = peer();
    const m = await a.queue();
    const room = m.room as string;
    a.enter(room);
    a.sit();
    await flush();
    a.leave();
    advance(QUICK_ABANDONED_MS - 1_000);
    expect(rooms.hasRoom(room)).toBe(true);
    advance(1_000);
    expect(rooms.hasRoom(room)).toBe(false);
    expect(rooms.stats().hostedTables).toBe(0);
  });

  it('stays while a player is connected, and a player who comes back within two minutes restarts the wait', async () => {
    const { rooms, peer, advance } = registry();
    const a = peer();
    const room = (await a.queue()).room as string;
    a.enter(room);
    a.sit();
    await flush();
    advance(QUICK_ABANDONED_MS * 2);
    expect(rooms.hasRoom(room)).toBe(true);
    a.leave();
    advance(QUICK_ABANDONED_MS - 5_000);
    const back = peer(a.userId);
    expect(back.enter(room)).toMatchObject({ t: 'room', room });
    advance(QUICK_ABANDONED_MS);
    expect(rooms.hasRoom(room)).toBe(true);
    back.leave();
    advance(QUICK_ABANDONED_MS);
    expect(rooms.hasRoom(room)).toBe(false);
  });

  it('closes at once when every player walked away on purpose, and waits for one whose connection dropped', async () => {
    const { rooms, peer, advance } = registry();
    const a = peer();
    const b = peer();
    const [ma] = await Promise.all([a.queue(), b.queue()]);
    const room = ma.room as string;
    for (const p of [a, b]) {
      p.enter(room);
      p.sit();
    }
    await flush();
    // a walks away and b's connection drops: the table waits for b.
    a.walkAway();
    a.leave();
    b.leave();
    advance(5_000);
    expect(rooms.hasRoom(room)).toBe(true);
    // b comes back only to walk away too: nobody is coming back now.
    const back = peer(b.userId);
    back.enter(room);
    rooms.handle(back.id, { t: 'to', to: `server-${room}`, data: { ch: 'game', msg: { t: 'join', name: 'x', token: tokenOf(b.out) } } });
    expect(rooms.hostedTable(room)!.seatInfo().find((s) => s.userId === b.userId)).toMatchObject({ connected: true });
    back.walkAway();
    expect(rooms.hasRoom(room)).toBe(true);
    back.leave();
    advance(500);
    expect(rooms.hasRoom(room)).toBe(false);
    expect(rooms.stats().hostedTables).toBe(0);
  });

  it('a table a player opened for friends still waits fifteen minutes', async () => {
    const { rooms, peer, advance } = registry();
    const a = peer();
    rooms.handle(a.id, { t: 'create', hosted: true });
    const room = a.out.at(-1)!.room as string;
    const say = (msg: Record<string, unknown>) => rooms.handle(a.id, { t: 'to', to: `server-${room}`, data: { ch: 'game', msg } });
    say({ t: 'join', name: 'x' });
    say({ t: 'start' });
    expect(rooms.hostedTable(room)!.phase).not.toBe('lobby');
    a.leave();
    advance(QUICK_ABANDONED_MS * 2);
    expect(rooms.hasRoom(room)).toBe(true);
    advance(KEEP_ALIVE_MS);
    expect(rooms.hasRoom(room)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------

const servers: SignalServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe('one address against a small server', () => {
  it('cannot fill the table cap through quick match: a seated account is sent back to its table and another player still gets a game', async () => {
    const repos = createRepos();
    const sessions = new SessionService(repos.repos, { pepper: 'cap-pepper-0123456789abcdef' });
    const server = await createSignalServer({
      port: 0,
      host: '127.0.0.1',
      repos,
      sessions,
      providers: {},
      config: loadConfig({ MAX_HOSTED_TABLES: '4' }),
      botDelayMs: 0,
      persistDebounceMs: 20,
      log: () => undefined,
      quickMatchFillMs: 100,
    });
    servers.push(server);
    const port = server.address().port;
    const guest = async (name: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/guest`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device: { id: randomUUID(), platform: 'ios' }, displayName: name }) });
      const json = (await res.json()) as { userId: string; session: { token: string } };
      await fetch(`http://127.0.0.1:${port}/api/me`, { method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${json.session.token}` }, body: JSON.stringify({ birthYear: 1990 }) });
      return json;
    };
    /** A raw socket: every frame it gets, and a wait for the next one that matches. */
    const open = async (token: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      sockets.push(ws);
      const got: Msg[] = [];
      ws.on('message', (raw) => got.push(JSON.parse(String(raw)) as Msg));
      await new Promise<void>((r) => ws.on('open', () => r()));
      const send = (m: unknown) => ws.send(JSON.stringify(m));
      const next = async (ok: (m: Msg) => boolean, from = 0) => {
        const end = Date.now() + 5_000;
        for (;;) {
          const hit = got.slice(from).find(ok);
          if (hit) return hit;
          if (Date.now() > end) throw new Error(`no such frame; got ${JSON.stringify(got.slice(from))}`);
          await new Promise((r) => setTimeout(r, 10));
        }
      };
      send({ t: 'hello', auth: token });
      await next((m) => m.t === 'hello');
      const queue = async () => {
        const from = got.length;
        send({ t: 'queue' });
        return next((m) => m.t === 'matched' || m.t === 'queue_error', from);
      };
      return { ws, got, send, next, queue };
    };

    const farmer = await guest('Farmer');
    const f = await open(farmer.session.token);
    const first = await f.queue();
    expect(first).toMatchObject({ t: 'matched' });
    const room = first.room as string;
    f.send({ t: 'join', room });
    await f.next((m) => m.t === 'room');
    f.send({ t: 'to', to: `server-${room}`, data: { ch: 'game', msg: { t: 'join', name: 'Farmer' } } });
    await f.next((m) => m.t === 'from');
    // Queue again and again, as the table-farming client did: always sent back to the one table.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 30));
      const again = await f.queue();
      if (again.code === 'rate_limited') continue;
      expect(again).toMatchObject({ t: 'queue_error', code: 'seated', room });
    }
    expect(server.rooms.stats().hostedTables).toBe(1);
    // Someone else still gets a table.
    const victim = await guest('Victim');
    const v = await open(victim.session.token);
    expect(await v.queue()).toMatchObject({ t: 'matched' });
    expect(server.rooms.stats().hostedTables).toBe(2);
  });
});
