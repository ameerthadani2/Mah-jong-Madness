/**
 * TablePersister over the memory repositories with fake timers: debounced writes, immediate
 * writes at the end of a hand, the final flush, restoring at boot, finished snapshots and pruning.
 * Also the boot path of createSignalServer for club tables (restored listings stay open).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chooseAction, legalActions } from '@mjm/engine';
import { TableClient, type HostMessage, type Link, type SerializedHost, type TableHost } from '@mjm/net';
import { SessionService } from '../src/auth';
import { ClubRegistry } from '../src/clubs';
import { loadConfig } from '../src/config';
import { TablePersister, tableStatus } from '../src/persist';
import { createMemoryRepos, createRepos, type TableSnapshotsRepo } from '../src/repos';
import { RoomRegistry, type Socket } from '../src/rooms';
import { createSignalServer } from '../src/server';

type Out = { t: string; room?: string; host?: string; from?: string; data?: { ch?: string; msg?: unknown } };

/** Every club table is open to everyone here; the gate itself is tested in club-state.test.ts. */
const openGate = { openTable: (_c: string, _u: string | undefined, rules: unknown) => ({ rules: rules as never }), tableOpened: () => undefined, mayJoin: () => true };

function setup(repo: TableSnapshotsRepo = createMemoryRepos().tableSnapshots, now = () => Date.now()) {
  const rooms = new RoomRegistry({ allowHosted: true, botDelayMs: 0, now, clubs: openGate });
  const persister = new TablePersister(rooms, repo, { now, log: () => undefined });
  persister.start();
  return { rooms, persister, repo };
}

/** A TableClient seated at a hosted table through the registry, as the socket layer would do it. */
function seat(rooms: RoomRegistry, code: string, token?: string) {
  const handlers = new Set<(m: HostMessage) => void>();
  const socket: Socket = {
    send: (j) => {
      const m = JSON.parse(j) as Out;
      if (m.t === 'from' && m.data?.ch === 'game') for (const h of handlers) h(m.data.msg as HostMessage);
    },
    close: () => undefined,
  };
  const id = rooms.hello(rooms.connect(socket), 'user-alice-1');
  rooms.handle(id, { t: 'join', room: code });
  const hostId = `server-${code}`;
  const link: Link = {
    send: (msg) => rooms.handle(id, { t: 'to', to: hostId, data: { ch: 'game', msg } }),
    onMessage: (cb) => (handlers.add(cb), () => handlers.delete(cb)),
    close: () => rooms.disconnect(id),
  };
  const client = new TableClient(link, 'Alice', undefined, { token });
  client.join();
  return client;
}

/** Play the human seat's moves until the hand ends (bots answer at once). */
function playHand(host: TableHost, c: TableClient): void {
  let guard = 0;
  while (host.phase === 'playing' && guard++ < 1000) {
    const s = c.localState();
    if (!s || c.state.seat === null || legalActions(s, c.state.seat).length === 0) break;
    c.act(chooseAction(s, c.state.seat)!);
  }
}

describe('TablePersister', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces writes per table by 500 ms and writes the end of a hand at once', async () => {
    const { rooms, persister, repo } = setup();
    const code = rooms.createHostedRoom({ rules: { handsPerMatch: 2 } });
    const alice = seat(rooms, code);
    expect(persister.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(499);
    expect(persister.writes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(persister.writes).toBe(1);
    const lobby = (await repo.get(code))!;
    expect(lobby).toMatchObject({ roomCode: code, clubCode: null, status: 'open' });
    expect((lobby.snapshot as SerializedHost).seats[0].name).toBe('Alice');

    // Play the hand out: many changes, but the hand_over is written without waiting.
    const host = rooms.hostedTable(code)!;
    host.start();
    playHand(host, alice);
    expect(host.phase).toBe('hand_over');
    const before = persister.writes;
    await vi.advanceTimersByTimeAsync(0);
    expect(persister.writes).toBeGreaterThan(before);
    const saved = (await repo.get(code))!;
    expect(saved.status).toBe('playing');
    expect((saved.snapshot as SerializedHost).phase).toBe('hand_over');
    expect(tableStatus(host)).toBe('playing');
  });

  it('flushes every table on demand, and marks a closed room finished so it is never restored', async () => {
    const { rooms, persister, repo } = setup();
    const a = rooms.createHostedRoom();
    const b = rooms.createHostedRoom();
    await persister.flush();
    expect((await repo.listActive()).map((s) => s.roomCode).sort()).toEqual([a, b].sort());
    rooms.closeRoomByCode(a);
    await vi.advanceTimersByTimeAsync(0);
    expect((await repo.get(a))!.status).toBe('finished');
    expect((await repo.listActive()).map((s) => s.roomCode)).toEqual([b]);
  });

  it('restores every unfinished table at boot under its own code, and gives up on a broken snapshot', async () => {
    const first = setup();
    const code = first.rooms.createHostedRoom({ rules: { handsPerMatch: 3 }, clubCode: 'CLUB22' });
    const p = seat(first.rooms, code);
    const token = p.state.token!;
    first.rooms.hostedTable(code)!.start();
    p.act(chooseAction(p.localState()!, 0)!);
    await first.persister.flush();
    first.persister.stop();
    first.rooms.shutdown();
    await first.repo.save({ roomCode: 'BROKEN', clubCode: null, status: 'playing', snapshot: { version: 99, roomCode: 'BROKEN' }, updatedAt: Date.now() });

    const second = setup(first.repo);
    const restored = await second.persister.restore();
    expect(restored).toEqual([code]);
    expect(second.rooms.clubOf(code)).toBe('CLUB22');
    expect((await first.repo.get('BROKEN'))!.status).toBe('finished');
    const host = second.rooms.hostedTable(code)!;
    expect(host.phase).toBe('playing');
    // The restored room waits 15 minutes for its players, who reclaim their seats with their tokens.
    expect(second.rooms.keepAliveUntil(code)).toBeGreaterThan(Date.now() + 14 * 60_000);
    const back = seat(second.rooms, code, token);
    expect(back.state.seat).toBe(0);
    expect(host.seatInfo()[0]).toMatchObject({ name: 'Alice', connected: true, userId: 'user-alice-1' });
    playHand(host, back);
    expect(host.phase).toBe('hand_over');
    expect(back.state.auditFailures).toEqual([]);
  });

  it('prunes finished snapshots after a day', async () => {
    let now = Date.UTC(2026, 10, 5);
    const repo = createMemoryRepos().tableSnapshots;
    const { persister } = setup(repo, () => now);
    await repo.save({ roomCode: 'OLD001', clubCode: null, status: 'finished', snapshot: {}, updatedAt: now - 25 * 3_600_000 });
    await repo.save({ roomCode: 'NEW001', clubCode: null, status: 'finished', snapshot: {}, updatedAt: now - 3_600_000 });
    expect(await persister.prune()).toBe(1);
    expect(await repo.get('OLD001')).toBeNull();
    now += 24 * 3_600_000;
    expect(await persister.prune()).toBe(1);
  });
});

describe('createSignalServer shutdown', () => {
  it('stops taking moves before the final write, so nothing acknowledged is missing from the restored table', async () => {
    const repos = createRepos();
    const snaps = repos.repos.tableSnapshots;
    let slow = 0;
    const save = snaps.save.bind(snaps);
    snaps.save = async (s) => {
      if (slow) await new Promise((r) => setTimeout(r, slow));
      return save(s);
    };
    const sessions = new SessionService(repos.repos, { pepper: 'stop-pepper-0123456789' });
    const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions, providers: {}, config: loadConfig({}), log: () => undefined, botDelayMs: 0 });
    const code = server.rooms.createHostedRoom({ rules: { handsPerMatch: 4 } });
    const alice = seat(server.rooms, code);
    alice.requestStart();
    const host = server.rooms.hostedTable(code)!;
    await vi.waitFor(() => expect(host.phase === 'playing' && legalActions(alice.localState()!, 0).length > 0).toBe(true));
    await server.persister.flush();
    // SIGTERM: the final write takes 50 ms; a move arrives 10 ms into it.
    slow = 50;
    const closing = server.close();
    await new Promise((r) => setTimeout(r, 10));
    const before = host.serialize().game!.actionLog.length;
    alice.act(chooseAction(alice.localState()!, 0)!);
    await closing;
    const saved = ((await snaps.get(code))!.snapshot as SerializedHost).game!.actionLog.length;
    // The move was dropped, not acknowledged: the live table and the snapshot agree.
    expect(host.serialize().game!.actionLog.length).toBe(before);
    expect(saved).toBe(before);
  });
});

describe('createSignalServer boot', () => {
  it('reopens club tables whose rooms were restored and clears ghost listings', async () => {
    const repos = createRepos();
    const sessions = new SessionService(repos.repos, { pepper: 'boot-pepper-0123456789' });
    const config = loadConfig({});
    // A previous process left a club with three listings: one restored, one ghost, one finished.
    const before = new ClubRegistry({ store: repos.repos.clubs });
    const club = before.createClub({ userId: 'user-owner-1', name: 'Owner' }, 'Boot club');
    const rooms = new RoomRegistry({ allowHosted: true });
    const live = rooms.createHostedRoom({ clubCode: club.code });
    for (const code of [live, 'GHOST1', 'DONE01']) before.addTable(club.code, 'user-owner-1', { code });
    before.updateTable(club.code, live, { status: 'playing' });
    before.updateTable(club.code, 'DONE01', { status: 'finished' });
    await before.flush();
    const host = rooms.hostedTable(live)!;
    await repos.repos.tableSnapshots.save({ roomCode: live, clubCode: club.code, status: 'playing', snapshot: host.serialize(), updatedAt: Date.now() });

    const server = await createSignalServer({ port: 0, host: '127.0.0.1', repos, sessions, providers: {}, config, log: () => undefined });
    try {
      expect(server.rooms.hasRoom(live)).toBe(true);
      expect(server.rooms.clubOf(live)).toBe(club.code);
      expect(server.clubs.club(club.code).tables.map((t) => [t.code, t.status])).toEqual([
        [live, 'playing'],
        ['DONE01', 'finished'],
      ]);
    } finally {
      await server.close();
    }
  });
});
