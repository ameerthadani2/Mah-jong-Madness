/**
 * An owner or admin who closes a table mid-match: the match still counts for nothing in the
 * standings, but the club keeps a record of it (the table, who closed it, when, the hand it had
 * reached and each seat's points at that moment) that every member sees with the club.
 * (Assessment 4: closing a table in hand 2 at 0, 140, 0, -140 left no trace.)
 */
import { describe, expect, it } from 'vitest';
import type { HostEvent, SeatInfo } from '@mjm/net';
import { CLUB_LIMITS, type Club, type ClubTable } from '../src/clubs';
import { apiFixture, type Guest } from './helpers';

const clock = { now: Date.UTC(2026, 10, 12, 9) };
const seatOf = (seat: number, who?: Guest, name = `P${seat}`): SeatInfo => ({ seat, name, peerId: null, userId: who?.userId, isBot: !who, connected: true });
const event = (type: HostEvent['type'], room: string, seats: SeatInfo[], scores = [0, 0, 0, 0], handNumber = 0): HostEvent => ({ type, roomCode: room, matchId: `m-${room}`, seats, scores, handNumber, handsWon: [0, 0, 0, 0] });

async function clubWithTable() {
  const f = apiFixture({ now: () => clock.now });
  const [owner, alice, outsider] = [await f.guest('Owner'), await f.guest('Alice'), await f.guest('Outsider')];
  const club = (await f.call('POST', '/api/clubs', { name: 'League' }, owner.auth)).json as unknown as Club;
  expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, alice.auth)).json.status).toBe('joined');
  const open = async (label: string) => {
    clock.now += 60_000;
    const res = await f.call('POST', `/api/clubs/${club.code}/tables`, { label }, owner.auth);
    expect(res.status, res.body).toBe(200);
    return (res.json as unknown as ClubTable).code;
  };
  const get = async (as: Guest) => (await f.call('GET', `/api/clubs/${club.code}`, undefined, as.auth)).json as unknown as Club;
  const close = (room: string, as: Guest) => f.call('POST', `/api/clubs/${club.code}/tables/${room}/close`, {}, as.auth);
  return { f, owner, alice, outsider, club, open, get, close };
}

describe('a table closed mid-match', () => {
  it('leaves a record in the club with the scores at closure and who closed it, and still does not count', async () => {
    const t = await clubWithTable();
    const room = await t.open('Friday');
    const seats = [seatOf(0, t.owner, 'Owner'), seatOf(1, t.alice, 'Alice'), seatOf(2), seatOf(3)];
    t.f.clubs.applyRoomEvent(room, event('lobby', room, seats));
    t.f.clubs.applyRoomEvent(room, event('state', room, seats));
    t.f.clubs.applyRoomEvent(room, event('hand_over', room, seats, [0, 140, 0, -140], 1));
    t.f.clubs.applyRoomEvent(room, event('state', room, seats, [0, 140, 0, -140], 1));
    clock.now += 60_000;
    const res = await t.close(room, t.owner);
    expect(res.status).toBe(200);

    const seen = await t.get(t.alice);
    expect(seen.tables.map((x) => x.code)).not.toContain(room);
    expect(seen.closedMatches).toEqual([
      {
        table: room,
        label: 'Friday',
        closedAt: clock.now,
        closedBy: { userId: t.owner.userId, name: 'Owner' },
        handNumber: 1,
        seats: [
          { seat: 0, name: 'Owner', userId: t.owner.userId, isBot: false, points: 0 },
          { seat: 1, name: 'Alice', userId: t.alice.userId, isBot: false, points: 140 },
          { seat: 2, name: 'P2', isBot: true, points: 0 },
          { seat: 3, name: 'P3', isBot: true, points: -140 },
        ],
      },
    ]);
    // The standings are as before: the closed match counts for nobody.
    const standings = (await t.f.call('GET', `/api/clubs/${t.club.code}/standings`, undefined, t.alice.auth)).json as unknown as Array<{ matchesPlayed: number; points: number }>;
    expect(standings.every((m) => m.matchesPlayed === 0 && m.points === 0)).toBe(true);
    // Someone outside the club sees nothing of it.
    expect((await t.get(t.outsider)).closedMatches).toBeUndefined();
  });

  it('records nothing for a table closed before play began, nor for a match that finished', async () => {
    const t = await clubWithTable();
    const empty = await t.open('Empty');
    t.f.clubs.applyRoomEvent(empty, event('lobby', empty, [seatOf(0, t.owner), seatOf(1), seatOf(2), seatOf(3)]));
    expect((await t.close(empty, t.owner)).status).toBe(200);
    const done = await t.open('Done');
    const seats = [seatOf(0, t.owner), seatOf(1, t.alice), seatOf(2), seatOf(3)];
    t.f.clubs.applyRoomEvent(done, event('state', done, seats));
    t.f.clubs.applyRoomEvent(done, event('match_over', done, seats, [100, -100, 0, 0], 7));
    expect((await t.get(t.alice)).closedMatches ?? []).toEqual([]);
  });

  it(`keeps the latest ${CLUB_LIMITS.closedMatchesKept} records`, async () => {
    const t = await clubWithTable();
    for (let i = 0; i < CLUB_LIMITS.closedMatchesKept + 2; i++) {
      const room = await t.open(`T${i}`);
      t.f.clubs.applyRoomEvent(room, event('state', room, [seatOf(0, t.owner), seatOf(1), seatOf(2), seatOf(3)]));
      expect((await t.close(room, t.owner)).status).toBe(200);
    }
    const kept = (await t.get(t.alice)).closedMatches!;
    expect(kept).toHaveLength(CLUB_LIMITS.closedMatchesKept);
    expect(kept[kept.length - 1].label).toBe(`T${CLUB_LIMITS.closedMatchesKept + 1}`);
    expect(kept[0].label).toBe('T2');
  });
});
