/**
 * Club table state across restarts and room events, and the size of the identity table.
 * Ported from the review probes `verify-signal/probe.ts` (stale tables after a restart),
 * `signal/finished.ts` (finished table reopened by a disconnect) and `signal/rooms.ts`
 * (credentials written for every junk userId).
 */
import { describe, expect, it } from 'vitest';
import type { HostEvent, SeatInfo } from '@mjm/net';
import { CLUB_LIMITS, ClubRegistry, type Club, type ClubData, type ClubStore } from '../src/clubs';
import { RoomRegistry, type Socket } from '../src/rooms';
import { buildRoutes } from '../src/api';

const alice = { userId: 'user-alice-1', name: 'Alice' };
const creds = (userId: string, secret = `${userId}-secret-0123456789`) => ({ userId, name: userId.slice(0, 8), secret });

/** A store that round-trips through JSON, like the file store, and counts writes. */
function memoryStore(initial: ClubData = { clubs: [], credentials: {} }) {
  let saved = JSON.parse(JSON.stringify(initial)) as ClubData;
  const store = {
    saves: 0,
    load: (): ClubData => JSON.parse(JSON.stringify(saved)) as ClubData,
    save: (d: ClubData) => {
      store.saves++;
      saved = JSON.parse(JSON.stringify(d)) as ClubData;
    },
    get data(): ClubData {
      return saved;
    },
  };
  return store satisfies ClubStore;
}

/** Call a route handler directly, the way the HTTP layer does. */
function caller(clubs: ClubRegistry, rooms = new RoomRegistry({ allowHosted: true })) {
  const routes = buildRoutes({ clubs, rooms });
  return (method: string, path: string, body: Record<string, unknown> = {}): unknown => {
    for (const r of routes) {
      const m = r.pattern.exec(path);
      if (r.method === method && m) {
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = m[i + 1]));
        return r.handler(params, body, {} as never);
      }
    }
    throw new Error(`no route ${method} ${path}`);
  };
}

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

describe('club tables across a restart', () => {
  it('finishes tables that were open or playing at shutdown, so they no longer use up the cap', () => {
    const store = memoryStore();
    const before = new ClubRegistry({ store });
    const club = before.createClub(alice, 'Club');
    for (let i = 0; i < CLUB_LIMITS.openTablesPerClub; i++) before.addTable(club.code, alice.userId, { code: `T${i}` });
    before.updateTable(club.code, 'T0', { status: 'playing', players: [{ seat: 0, name: 'Alice', userId: alice.userId, isBot: false, connected: true }], handNumber: 2 });
    expect(() => before.assertCanOpenTable(club.code, alice.userId)).toThrow(/5 open tables/);

    const after = new ClubRegistry({ store }); // the restart
    expect(after.club(club.code).tables.map((t) => t.status)).toEqual(Array(CLUB_LIMITS.openTablesPerClub).fill('finished'));
    expect(after.club(club.code).tables[0].players[0].connected).toBe(false);
    expect(() => after.assertCanOpenTable(club.code, alice.userId)).not.toThrow();
    // The cleaned-up state is written back, and a clean store is not rewritten on load.
    expect(store.data.clubs[0].tables.every((t) => t.status === 'finished')).toBe(true);
    const saves = store.saves;
    new ClubRegistry({ store });
    expect(store.saves).toBe(saves);
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
    const rooms = new RoomRegistry({ allowHosted: true });
    const clubs = new ClubRegistry();
    rooms.onRoomEvent(({ room, event: ev }) => clubs.applyRoomEvent(room, ev));
    const call = caller(clubs, rooms);
    const club = call('POST', '/api/clubs', { user: creds(alice.userId), name: 'Live' }) as Club;
    const table = call('POST', `/api/clubs/${club.code}/tables`, { user: creds(alice.userId) }) as { code: string };
    const out: Array<{ t: string; host?: string }> = [];
    const socket: Socket = { send: (j) => out.push(JSON.parse(j) as { t: string }), close: () => undefined };
    const id = rooms.handle(rooms.connect(socket), { t: 'hello' });
    rooms.handle(id, { t: 'join', room: table.code });
    const host = out.find((m) => m.t === 'room')!.host!;
    rooms.handle(id, { t: 'to', to: host, data: { ch: 'game', msg: { t: 'join', name: 'Alice', userId: alice.userId } } });
    const listed = clubs.club(club.code).tables[0];
    expect(listed.status).toBe('open');
    expect(listed.players.some((p) => !p.isBot && p.connected)).toBe(true);
    rooms.closeRoomByCode(table.code);
    expect(clubs.club(club.code).tables).toHaveLength(0);
  });
});

describe('identity binding', () => {
  it('stores nothing for requests that fail or create no membership (probe: 1000 failed joins)', () => {
    const store = memoryStore();
    const clubs = new ClubRegistry({ store });
    const call = caller(clubs);
    for (let i = 0; i < 1000; i++) expect(() => call('POST', '/api/clubs/NOPE00/join', { user: creds(`junkuser${i}`) })).toThrow(/Club not found/);
    expect(store.saves).toBe(0);
    expect(clubs.credentialCount()).toBe(0);
    // A refused create (bad name) binds nothing either.
    expect(() => call('POST', '/api/clubs', { user: creds('user-nobody'), name: '' })).toThrow(/required/);
    expect(clubs.credentialCount()).toBe(0);
    // A request that succeeds but leaves the user in no club (leaving a club you never joined) binds nothing.
    const club = clubs.createClub(alice, 'Somewhere');
    for (let i = 0; i < 20; i++) call('DELETE', `/api/clubs/${club.code}/members/junkuser${i}`, { user: creds(`junkuser${i}`) });
    expect(clubs.credentialCount()).toBe(0);
  });

  it('binds on a successful create or join, then rejects a different secret for that user', () => {
    const store = memoryStore();
    const clubs = new ClubRegistry({ store });
    const call = caller(clubs);
    const club = call('POST', '/api/clubs', { user: creds(alice.userId), name: 'Bound' }) as Club;
    call('POST', `/api/clubs/${club.code}/join`, { user: creds('user-bob-22') });
    expect(Object.keys(store.data.credentials).sort()).toEqual([alice.userId, 'user-bob-22']);
    expect(() => call('POST', `/api/clubs/${club.code}/join`, { user: creds('user-bob-22', 'not-bobs-secret-0123') })).toThrow(/Identity check/);
    expect(() => call('PATCH', `/api/clubs/${club.code}`, { user: creds(alice.userId, 'not-alices-secret-01'), name: 'Mine' })).toThrow(/Identity check/);
    // A pending request also binds, so a stranger cannot cancel it with another secret.
    call('PATCH', `/api/clubs/${club.code}`, { user: creds(alice.userId), settings: { joinRequiresApproval: true } });
    expect((call('POST', `/api/clubs/${club.code}/join`, { user: creds('user-carol-3') }) as { status: string }).status).toBe('pending');
    expect(() => call('DELETE', `/api/clubs/${club.code}/members/user-carol-3`, { user: creds('user-carol-3', 'stranger-secret-0123') })).toThrow(/Identity check/);
  });

  it('caps the identity table, evicting the least recently used identity that holds no membership', () => {
    const store = memoryStore();
    const clubs = new ClubRegistry({ store, maxCredentials: 3 });
    const call = caller(clubs);
    const club = call('POST', '/api/clubs', { user: creds(alice.userId), name: 'Small' }) as Club;
    call('POST', `/api/clubs/${club.code}/join`, { user: creds('user-bob-22') });
    call('POST', `/api/clubs/${club.code}/join`, { user: creds('user-carol-3') });
    call('DELETE', `/api/clubs/${club.code}/members/user-carol-3`, { user: creds('user-carol-3') }); // Carol leaves
    call('POST', `/api/clubs/${club.code}/join`, { user: creds('user-dave-44') });
    expect(clubs.credentialCount()).toBe(3);
    expect(Object.keys(store.data.credentials).sort()).toEqual([alice.userId, 'user-bob-22', 'user-dave-44']);
    // Members are never evicted: with everyone still in the club the table may exceed the cap.
    call('POST', `/api/clubs/${club.code}/join`, { user: creds('user-erin-55') });
    expect(clubs.credentialCount()).toBe(4);
    expect(() => call('PATCH', `/api/clubs/${club.code}`, { user: creds(alice.userId, 'not-alices-secret-01'), name: 'X' })).toThrow(/Identity check/);
  });

  it('defaults to a cap of 50,000 identities', () => {
    expect(CLUB_LIMITS.identities).toBe(50_000);
  });
});
