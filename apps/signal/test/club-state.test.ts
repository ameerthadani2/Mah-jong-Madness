/**
 * Club table state across restarts and room events, and the membership gate on club tables.
 * Ported from the review probes `verify-signal/probe.ts` (stale tables after a restart) and
 * `signal/finished.ts` (finished table reopened by a disconnect).
 */
import { describe, expect, it } from 'vitest';
import type { HostEvent, SeatInfo } from '@mjm/net';
import { CLUB_LIMITS, ClubRegistry, clubGate } from '../src/clubs';
import { createMemoryRepos } from '../src/repos';
import { CLUB_MEMBERS_ONLY, RoomRegistry, type Socket } from '../src/rooms';

const alice = { userId: 'user-alice-1', name: 'Alice' };
const bob = { userId: 'user-bob-22', name: 'Bob' };

const seat = (n: number, connected = true): SeatInfo => ({ seat: n, name: `P${n}`, peerId: null, userId: n === 0 ? alice.userId : undefined, isBot: n !== 0, connected });
const event = (type: HostEvent['type'], handNumber: number, connected = true): HostEvent => ({
  type,
  roomCode: 'ROOM01',
  matchId: 'm1',
  seats: [0, 1, 2, 3].map((n) => seat(n, connected)),
  scores: [300, -100, -100, -100],
  handNumber,
  handsWon: [1, 0, 0, 0],
});

type Out = { t: string; host?: string; room?: string; message?: string };

/** A peer that has said hello as `userId` (as the socket layer does after verifying a session). */
function peerAs(rooms: RoomRegistry, userId?: string) {
  const out: Out[] = [];
  const socket: Socket = { send: (j) => out.push(JSON.parse(j) as Out), close: () => undefined };
  const id = rooms.hello(rooms.connect(socket), userId);
  return { id, out, last: () => out[out.length - 1] };
}

describe('club tables across a restart', () => {
  it('keeps listings whose table was restored, clears ghost listings, and prunes old finished ones', async () => {
    let now = 10 * 86_400_000;
    const store = createMemoryRepos().clubs;
    const before = new ClubRegistry({ store, now: () => now });
    const club = before.createClub(alice, 'Club');
    for (let i = 0; i < CLUB_LIMITS.openTablesPerClub; i++) before.addTable(club.code, alice.userId, { code: `T${i}` });
    before.updateTable(club.code, 'T0', { status: 'playing', players: [{ seat: 0, name: 'Alice', userId: alice.userId, isBot: false, connected: true }], handNumber: 2 });
    expect(() => before.assertCanOpenTable(club.code, alice.userId)).toThrow(/5 open tables/);
    before.updateTable(club.code, 'T4', { status: 'finished' });
    await before.flush();

    // The restart: T0 came back from its snapshot, T1-T3 did not (ghosts), T4 finished earlier.
    const after = new ClubRegistry({ store, now: () => now });
    await after.load();
    after.reconcileTables((code) => code === 'T0');
    const tables = after.club(club.code).tables;
    expect(tables.map((t) => [t.code, t.status])).toEqual([
      ['T0', 'playing'],
      ['T4', 'finished'],
    ]);
    expect(tables[0].players[0].connected).toBe(false);
    expect(() => after.assertCanOpenTable(club.code, alice.userId)).not.toThrow();
    // The cleaned-up state is written back, and a clean registry is not rewritten.
    await after.flush();
    expect((await store.get(club.code))!.tables.map((t) => t.code)).toEqual(['T0', 'T4']);
    const writes = after.writeCount;
    after.reconcileTables((code) => code === 'T0');
    expect(after.writeCount).toBe(writes);
    // A day later the finished listing goes.
    now += 86_400_000 + 1;
    after.pruneFinishedTables(now - CLUB_LIMITS.finishedTableMs);
    expect(after.club(club.code).tables.map((t) => t.code)).toEqual(['T0']);
  });
});

describe('club table status from room events', () => {
  it('keeps a finished table finished when a player disconnects afterwards, and counts the match once', () => {
    const clubs = new ClubRegistry();
    const club = clubs.createClub(alice, 'C');
    clubs.addTable(club.code, alice.userId, { code: 'ROOM01' });
    clubs.applyRoomEvent('ROOM01', event('lobby', 0));
    expect(clubs.club(club.code).tables[0].status).toBe('open');
    clubs.applyRoomEvent('ROOM01', event('state', 1));
    expect(clubs.club(club.code).tables[0].status).toBe('playing');
    clubs.applyRoomEvent('ROOM01', event('match_over', 1));
    expect(clubs.club(club.code).tables[0].status).toBe('finished');
    // The player leaves after the match: the host reports a state with the seat disconnected.
    clubs.applyRoomEvent('ROOM01', event('state', 1, false));
    clubs.applyRoomEvent('ROOM01', event('lobby', 1, false));
    expect(clubs.club(club.code).tables[0].status).toBe('finished');
    // So it no longer counts against the cap.
    for (let i = 1; i < CLUB_LIMITS.openTablesPerClub + 1; i++) clubs.addTable(club.code, alice.userId, { code: `T${i}` });
    // A repeated match_over neither reopens the table nor counts the match twice.
    clubs.applyRoomEvent('ROOM01', event('match_over', 1));
    const me = clubs.standings(club.code).find((m) => m.userId === alice.userId)!;
    expect(me.matchesPlayed).toBe(1);
    expect(me.points).toBe(300);
    // The room closing removes the listing as before.
    clubs.applyRoomEvent('ROOM01', event('match_over', -1));
    expect(clubs.club(club.code).tables.some((t) => t.code === 'ROOM01')).toBe(false);
  });

  it('refuses any status change away from finished in updateTable', () => {
    const clubs = new ClubRegistry();
    const club = clubs.createClub(alice, 'C');
    clubs.addTable(club.code, alice.userId, { code: 'T1' });
    clubs.updateTable(club.code, 'T1', { status: 'finished', scores: [1, 2, 3, 4] });
    clubs.updateTable(club.code, 'T1', { status: 'playing', handNumber: 3 });
    clubs.updateTable(club.code, 'T1', { status: 'open' });
    const t = clubs.club(club.code).tables[0];
    expect(t.status).toBe('finished');
    expect(t.handNumber).toBe(0);
  });

  it('tracks a real hosted club table from the room registry', () => {
    const clubs = new ClubRegistry();
    const rooms = new RoomRegistry({ allowHosted: true, clubs: clubGate(clubs) });
    rooms.onRoomEvent(({ room, event: ev }) => clubs.applyRoomEvent(room, ev));
    const club = clubs.createClub(alice, 'Live');
    const a = peerAs(rooms, alice.userId);
    rooms.handle(a.id, { t: 'create', hosted: true, club: club.code.toLowerCase() });
    const room = a.out.find((m) => m.t === 'room')!;
    expect(rooms.clubOf(room.room!)).toBe(club.code);
    // The client claims to be someone else; the table binds the verified user.
    rooms.handle(a.id, { t: 'to', to: room.host!, data: { ch: 'game', msg: { t: 'join', name: 'Alice', userId: 'user-mallory-9' } } });
    const listed = clubs.club(club.code).tables[0];
    expect(listed.code).toBe(room.room);
    expect(listed.status).toBe('open');
    expect(listed.players.find((p) => !p.isBot && p.connected)?.userId).toBe(alice.userId);
    expect(rooms.hostedTable(room.room!)!.seatInfo()[0].userId).toBe(alice.userId);
    rooms.closeRoomByCode(room.room!);
    expect(clubs.club(club.code).tables).toHaveLength(0);
  });
});

describe('the club table gate', () => {
  it('lets only full members open or join a club table', () => {
    const clubs = new ClubRegistry();
    const rooms = new RoomRegistry({ allowHosted: true, clubs: clubGate(clubs) });
    const club = clubs.createClub(alice, 'Members');
    clubs.update(club.code, alice.userId, { settings: { joinRequiresApproval: true } });
    clubs.joinClub(club.code, bob); // pending
    const a = peerAs(rooms, alice.userId);
    const b = peerAs(rooms, bob.userId);
    const stranger = peerAs(rooms, 'user-stranger-1');
    const anonymous = peerAs(rooms);
    for (const p of [b, stranger, anonymous]) {
      rooms.handle(p.id, { t: 'create', hosted: true, club: club.code });
      expect(p.last()).toEqual({ t: 'error', message: CLUB_MEMBERS_ONLY });
    }
    // Unknown clubs are refused too, and a refusal does not start the create cooldown.
    rooms.handle(a.id, { t: 'create', hosted: true, club: 'NOPE99' });
    expect(a.last()).toEqual({ t: 'error', message: 'Club not found' });
    rooms.handle(a.id, { t: 'create', club: club.code });
    const code = a.out.find((m) => m.t === 'room')!.room!;
    for (const p of [b, stranger, anonymous]) {
      rooms.handle(p.id, { t: 'join', room: code });
      expect(p.last()).toEqual({ t: 'error', message: CLUB_MEMBERS_ONLY });
    }
    expect(rooms.roomPeers(code)).toEqual([a.id]);
    // Once approved, Bob may join.
    clubs.approve(club.code, alice.userId, bob.userId);
    rooms.handle(b.id, { t: 'join', room: code });
    expect(b.last()!.t).toBe('room');
    // A table opened through the API is gated the same way.
    const apiRoom = rooms.createHostedRoom({ clubCode: club.code });
    rooms.handle(stranger.id, { t: 'join', room: apiRoom });
    expect(stranger.last()).toEqual({ t: 'error', message: CLUB_MEMBERS_ONLY });
  });

  it('closes the new room again when the club refuses to list it', () => {
    const gate = {
      openTable: () => ({ rules: {} as never }),
      mayJoin: () => true,
      tableOpened: () => {
        throw new Error('This club already has 5 open tables; finish one first');
      },
    };
    const rooms = new RoomRegistry({ allowHosted: true, clubs: gate });
    const a = peerAs(rooms, alice.userId);
    rooms.handle(a.id, { t: 'create', club: 'CLUB01' });
    expect(a.last()).toEqual({ t: 'error', message: 'This club already has 5 open tables; finish one first' });
    expect(rooms.stats().rooms).toBe(0);
  });
});
