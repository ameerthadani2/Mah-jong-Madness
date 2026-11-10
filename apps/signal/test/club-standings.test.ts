/**
 * Decision 5 for standings: a member who leaves a club (or is removed or banned) keeps their
 * standings on file, hidden, and gets them back on rejoining; and a match counts by the club
 * members seated when it started, so leaving before the end neither voids the others' result nor
 * spares the leaver theirs.
 */
import { describe, expect, it } from 'vitest';
import type { HostEvent, SeatInfo } from '@mjm/net';
import type { Club, ClubMember, ClubTable } from '../src/clubs';
import { apiFixture, type Guest } from './helpers';

type Fixture = ReturnType<typeof apiFixture>;
type Row = ClubMember & { seasonPoints: number; lifetimePoints: number };

async function league(opts: Parameters<typeof apiFixture>[0] = {}) {
  const f = apiFixture(opts);
  const [owner, alice, bob] = [await f.guest('Owner'), await f.guest('Alice'), await f.guest('Bob')];
  const club = (await f.call('POST', '/api/clubs', { name: 'League' }, owner.auth)).json as unknown as Club;
  for (const g of [alice, bob]) expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth)).json.status).toBe('joined');
  return { ...f, owner, alice, bob, club };
}

const seatOf = (seat: number, who?: Guest): SeatInfo => ({ seat, name: `P${seat}`, peerId: null, userId: who?.userId, isBot: !who, connected: true });
function event(type: HostEvent['type'], room: string, seats: SeatInfo[], scores = [0, 0, 0, 0], handNumber = 0, handsWon = [0, 0, 0, 0]): HostEvent {
  return { type, roomCode: room, matchId: `m-${room}`, seats, scores, handNumber, handsWon };
}
const openTable = async (f: Fixture, club: Club, by: Guest) => ((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, by.auth)).json as unknown as ClubTable).code;
const standings = async (f: Fixture, club: Club, as: Guest) => {
  const res = await f.call('GET', `/api/clubs/${club.code}/standings`, undefined, as.auth);
  return Object.fromEntries((JSON.parse(res.body) as Row[]).map((m) => [m.name, [m.seasonPoints, m.lifetimePoints, m.matchesPlayed, m.matchesWon]]));
};
const leave = (f: Fixture, club: Club, who: Guest, by: Guest = who) => f.call('DELETE', `/api/clubs/${club.code}/members/${who.userId}`, undefined, by.auth);
const join = (f: Fixture, club: Club, who: Guest) => f.call('POST', `/api/clubs/${club.code}/join`, {}, who.auth);

/** A whole match at a new table as the room reports it: lobby, first state, then the result. */
async function play(f: Awaited<ReturnType<typeof league>>, scores: number[], between?: () => Promise<unknown>) {
  const room = await openTable(f, f.club, f.alice);
  const seats = [seatOf(0, f.alice), seatOf(1, f.bob), seatOf(2), seatOf(3)];
  f.clubs.applyRoomEvent(room, event('lobby', room, seats));
  f.clubs.applyRoomEvent(room, event('state', room, seats));
  await between?.();
  return { room, seats, finish: (final: SeatInfo[] = seats) => f.clubs.applyRoomEvent(room, event('match_over', room, final, scores, 7, [0, 3, 0, 0])) };
}

describe('standings of a member who leaves', () => {
  it('stay on file, hidden, and come back when they rejoin', async () => {
    const f = await league();
    (await play(f, [-120, 160, -20, -20])).finish();
    expect(await standings(f, f.club, f.owner)).toEqual({ Bob: [160, 160, 1, 1], Owner: [0, 0, 0, 0], Alice: [-120, -120, 1, 0] });

    const left = await leave(f, f.club, f.alice);
    expect(left.status).toBe(200);
    expect(await standings(f, f.club, f.owner)).toEqual({ Bob: [160, 160, 1, 1], Owner: [0, 0, 0, 0] });
    // Nobody is sent the file, not even the owner.
    const seen = (await f.call('GET', `/api/clubs/${f.club.code}`, undefined, f.owner.auth)).json;
    expect(seen.former).toBeUndefined();
    expect((seen.members as ClubMember[]).map((m) => m.name)).toEqual(['Owner', 'Bob']);
    expect(f.clubs.clubsForUser(f.alice.userId)).toEqual([]);

    expect((await join(f, f.club, f.alice)).json.status).toBe('joined');
    expect(await standings(f, f.club, f.owner)).toEqual({ Bob: [160, 160, 1, 1], Owner: [0, 0, 0, 0], Alice: [-120, -120, 1, 0] });
    expect(f.clubs.club(f.club.code).former).toEqual([]);
  });

  it('come back through an approval too, and after a removal or a ban that was lifted', async () => {
    const f = await league();
    (await play(f, [-120, 160, -20, -20])).finish();
    // Removed by the owner, then let back in through a join request.
    expect((await leave(f, f.club, f.alice, f.owner)).status).toBe(200);
    await f.call('PATCH', `/api/clubs/${f.club.code}`, { settings: { joinRequiresApproval: true } }, f.owner.auth);
    expect((await join(f, f.club, f.alice)).json.status).toBe('pending');
    expect((await f.call('POST', `/api/clubs/${f.club.code}/members/${f.alice.userId}/approve`, {}, f.owner.auth)).status).toBe(200);
    expect((await standings(f, f.club, f.owner)).Alice).toEqual([-120, -120, 1, 0]);
    // Banned, unbanned, approved again.
    expect((await f.call('POST', `/api/clubs/${f.club.code}/bans`, { userId: f.bob.userId }, f.owner.auth)).status).toBe(200);
    expect((await standings(f, f.club, f.owner)).Bob).toBeUndefined();
    await f.call('DELETE', `/api/clubs/${f.club.code}/bans/${f.bob.userId}`, undefined, f.owner.auth);
    await join(f, f.club, f.bob);
    await f.call('POST', `/api/clubs/${f.club.code}/members/${f.bob.userId}/approve`, {}, f.owner.auth);
    expect((await standings(f, f.club, f.owner)).Bob).toEqual([160, 160, 1, 1]);
  });

  it('return with the all-time points only when a new season started meanwhile', async () => {
    const f = await league();
    (await play(f, [-120, 160, -20, -20])).finish();
    await leave(f, f.club, f.alice);
    expect((await f.call('POST', `/api/clubs/${f.club.code}/season`, {}, f.owner.auth)).status).toBe(200);
    await join(f, f.club, f.alice);
    expect((await standings(f, f.club, f.owner)).Alice).toEqual([0, -120, 1, 0]);
  });

  it('are not kept for an account that only joined and left', async () => {
    const f = await league();
    for (let i = 0; i < 5; i++) {
      const g = await f.guest(`Passing ${i}`);
      await join(f, f.club, g);
      await leave(f, f.club, g);
    }
    expect(f.clubs.club(f.club.code).former).toEqual([]);
  });

  it('survive a restart, with the list of who started each match', async () => {
    const f = await league();
    (await play(f, [-120, 160, -20, -20])).finish();
    const live = await play(f, [0, 0, 0, 0]);
    await leave(f, f.club, f.alice);
    await f.clubs.flush();
    const stored = (await f.repos.clubs.get(f.club.code))!;
    expect(stored.former).toEqual([expect.objectContaining({ userId: f.alice.userId, points: -120, seasonPoints: -120, season: 1, matchesPlayed: 1 })]);
    expect(stored.tables.find((t) => t.code === live.room)!.startedWith).toEqual([
      { seat: 0, userId: f.alice.userId },
      { seat: 1, userId: f.bob.userId },
    ]);
  });
});

describe('a match counts by the members seated when it started', () => {
  it("still counts when a member leaves the club before the end, and the leaver is charged their result", async () => {
    const f = await league();
    const match = await play(f, [-200, 240, -20, -20], () => leave(f, f.club, f.alice));
    match.finish();
    // Bob's win stands although only one member was left at the end.
    expect(await standings(f, f.club, f.owner)).toEqual({ Bob: [240, 240, 1, 1], Owner: [0, 0, 0, 0] });
    // Alice had nothing on file before; her loss is waiting for her.
    await join(f, f.club, f.alice);
    expect((await standings(f, f.club, f.owner)).Alice).toEqual([-200, -200, 1, 0]);
  });

  it('charges a member who was taken off the table, though a bot finished in their seat', async () => {
    const f = await league();
    const match = await play(f, [-200, 240, -20, -20], () => leave(f, f.club, f.alice, f.owner));
    // The eviction wiped the account from the seat (rooms.evictFromTable): the seat reports no user at the end.
    match.finish([{ ...seatOf(0), isBot: false }, seatOf(1, f.bob), seatOf(2), seatOf(3)]);
    expect((await standings(f, f.club, f.owner)).Bob).toEqual([240, 240, 1, 1]);
    await join(f, f.club, f.alice);
    expect((await standings(f, f.club, f.owner)).Alice).toEqual([-200, -200, 1, 0]);
  });

  it('charges a member who left and came back before the end once, on their member row', async () => {
    const f = await league();
    (await play(f, [-120, 160, -20, -20])).finish();
    const match = await play(f, [-200, 240, -20, -20], async () => {
      await leave(f, f.club, f.alice);
      await join(f, f.club, f.alice);
    });
    match.finish();
    expect(await standings(f, f.club, f.owner)).toEqual({ Bob: [400, 400, 2, 2], Owner: [0, 0, 0, 0], Alice: [-320, -320, 2, 0] });
    expect(f.clubs.club(f.club.code).former).toEqual([]);
  });

  it('does not count a match that started with one member, and counts one result once', async () => {
    const f = await league();
    const room = await openTable(f, f.club, f.alice);
    const solo = [seatOf(0, f.alice), seatOf(1), seatOf(2), seatOf(3)];
    f.clubs.applyRoomEvent(room, event('state', room, solo));
    f.clubs.applyRoomEvent(room, event('match_over', room, solo, [300, -100, -100, -100], 7));
    expect((await standings(f, f.club, f.owner)).Alice).toEqual([0, 0, 0, 0]);
    const match = await play(f, [-200, 240, -20, -20]);
    match.finish();
    match.finish();
    expect((await standings(f, f.club, f.owner)).Bob).toEqual([240, 240, 1, 1]);
  });

  it('counts a table whose start was never noted by the members seated, or gone since it opened', async () => {
    // A match already under way when the server was updated has no list of who started it.
    const f = await league();
    (await play(f, [-120, 160, -20, -20])).finish();
    const room = await openTable(f, f.club, f.alice);
    await leave(f, f.club, f.alice);
    const seats = [seatOf(0, f.alice), seatOf(1, f.bob), seatOf(2), seatOf(3)];
    f.clubs.applyRoomEvent(room, event('match_over', room, seats, [-200, 240, -20, -20], 7));
    expect((await standings(f, f.club, f.owner)).Bob).toEqual([400, 400, 2, 2]);
    await join(f, f.club, f.alice);
    expect((await standings(f, f.club, f.owner)).Alice).toEqual([-320, -320, 2, 0]);
  });
});

describe('standings on file and an account merge', () => {
  it('return to the account when a fresh guest that joined the club is merged into it', async () => {
    const f = await league();
    (await play(f, [-120, 160, -20, -20])).finish();
    await leave(f, f.club, f.alice);
    // Alice makes a new guest account, joins with a clean sheet, then links it to her old account.
    const fresh = await f.guest('Alice again');
    await join(f, f.club, fresh);
    expect(f.clubs.moveMemberships(fresh.userId, { userId: f.alice.userId, name: 'Alice' })).toEqual([f.club.code]);
    expect((await standings(f, f.club, f.owner)).Alice).toEqual([-120, -120, 1, 0]);
    expect(f.clubs.club(f.club.code).former).toEqual([]);
  });

  it('follow a departed guest into the account it is merged into', async () => {
    const f = await league();
    (await play(f, [-120, 160, -20, -20])).finish();
    await leave(f, f.club, f.alice);
    const account = await f.guest('Account');
    expect(f.clubs.moveMemberships(f.alice.userId, { userId: account.userId, name: 'Account' })).toEqual([f.club.code]);
    expect(f.clubs.club(f.club.code).former!.map((x) => [x.userId, x.points])).toEqual([[account.userId, -120]]);
    await join(f, f.club, account);
    expect((await standings(f, f.club, f.owner)).Account).toEqual([-120, -120, 1, 0]);
  });
});
