/**
 * House rules (decision 1) and honest standings (probes `rules/pF_club_override.cjs` and
 * `online-challenge/probeI.ts`): a member's club table always plays the club's rules with the club's
 * bots; owners and admins may open variant tables, which never count; and only matches with two or
 * more human members move the standings.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, type RuleSet } from '@mjm/engine';
import type { HostEvent, SeatInfo } from '@mjm/net';
import { ClubRegistry, clubGate, countsForStandings, type Club, type ClubTable } from '../src/clubs';
import { RoomRegistry, type Socket } from '../src/rooms';
import { apiFixture } from './helpers';

const HOUSE = { passRule: true, multipleWinners: false, maxTai: 8, basePoints: 100, taiPoints: 20 };
const WILD = { passRule: false, multipleWinners: true, maxTai: 0, basePoints: 5000, taiPoints: 2000, heavenlyTai: 64 };

const pick = (r: RuleSet) => ({ passRule: r.passRule, multipleWinners: r.multipleWinners, maxTai: r.maxTai, basePoints: r.basePoints, taiPoints: r.taiPoints, heavenlyTai: r.heavenlyTai });

describe('club house rules on the API path', () => {
  it('ignores the rules a plain member asks for and opens the table under the house rules', async () => {
    const { call, guest, rooms } = apiFixture();
    const owner = await guest('Owner');
    const member = await guest('Member');
    const club = (await call('POST', '/api/clubs', { name: 'Purist House', rules: HOUSE }, owner.auth)).json as unknown as Club;
    await call('POST', `/api/clubs/${club.code}/join`, {}, member.auth);
    const res = await call('POST', `/api/clubs/${club.code}/tables`, { label: 'mine', rules: WILD }, member.auth);
    expect(res.status).toBe(200);
    const table = res.json as unknown as ClubTable;
    expect(pick(table.rules)).toEqual(pick(club.rules));
    expect(table.variant).toBe(false);
    // The room itself deals with the house rules, not just the listing.
    expect(pick(rooms.hostedTable(table.code)!.rules)).toEqual(pick(club.rules));
  });

  it('lets an owner or admin open a variant table, marked as such, and keeps an unchanged one a house table', async () => {
    const { call, guest, rooms } = apiFixture();
    const owner = await guest('Owner');
    const admin = await guest('Ada');
    const club = (await call('POST', '/api/clubs', { name: 'House', rules: HOUSE }, owner.auth)).json as unknown as Club;
    await call('POST', `/api/clubs/${club.code}/join`, {}, admin.auth);
    await call('POST', `/api/clubs/${club.code}/members/${admin.userId}/role`, { role: 'admin' }, owner.auth);
    const variant = (await call('POST', `/api/clubs/${club.code}/tables`, { rules: WILD }, admin.auth)).json as unknown as ClubTable;
    expect(variant.variant).toBe(true);
    expect(pick(variant.rules)).toEqual({ ...WILD });
    expect(rooms.hostedTable(variant.code)!.rules.basePoints).toBe(5000);
    const same = (await call('POST', `/api/clubs/${club.code}/tables`, { rules: { ...HOUSE } }, owner.auth)).json as unknown as ClubTable;
    expect(same.variant).toBe(false);
    // The listing keeps the flag.
    const listed = ((await call('GET', `/api/clubs/${club.code}`, undefined, owner.auth)).json as unknown as Club).tables;
    expect(listed.map((t) => [t.code, t.variant])).toEqual([
      [variant.code, true],
      [same.code, false],
    ]);
  });

  it("plays every club table with the club's bot skill, whatever the opener asks for", async () => {
    let now = Date.UTC(2026, 10, 11);
    const { call, guest, rooms } = apiFixture({ now: () => now });
    const owner = await guest('Owner');
    const club = (await call('POST', '/api/clubs', { name: 'Pros', settings: { botSkill: 'pro' } }, owner.auth)).json as unknown as Club;
    expect(club.settings.botSkill).toBe('pro');
    const t = (await call('POST', `/api/clubs/${club.code}/tables`, { botSkill: 'beginner' }, owner.auth)).json as unknown as ClubTable;
    expect(rooms.hostedTable(t.code)!.serialize().botSkill).toBe('pro');
    // An unknown skill is still a 400, and a club that never chose one plays Club bots.
    expect((await call('POST', `/api/clubs/${club.code}/tables`, { botSkill: 'godlike' }, owner.auth)).status).toBe(400);
    const plain = (await call('POST', '/api/clubs', { name: 'Plain' }, owner.auth)).json as unknown as Club;
    now += 10_000; // the owner's next table, ten seconds after the last
    const t2 = (await call('POST', `/api/clubs/${plain.code}/tables`, { botSkill: 'beginner' }, owner.auth)).json as unknown as ClubTable;
    expect(rooms.hostedTable(t2.code)!.serialize().botSkill).toBe('club');
  });
});

describe('club house rules on the socket path', () => {
  function peerAs(rooms: RoomRegistry, userId: string) {
    const out: Array<{ t: string; room?: string; message?: string }> = [];
    const socket: Socket = { send: (j) => out.push(JSON.parse(j) as { t: string }), close: () => undefined };
    const id = rooms.hello(rooms.connect(socket), userId);
    return { id, out };
  }

  it("opens a member's socket-created club table under the house rules and the club's bots; an owner's may differ", () => {
    const clubs = new ClubRegistry();
    const rooms = new RoomRegistry({ allowHosted: true, clubs: clubGate(clubs), botDelayMs: 0 });
    const club = clubs.createClub({ userId: 'user-owner-1', name: 'Owner' }, 'House', HOUSE, { botSkill: 'beginner' });
    clubs.joinClub(club.code, { userId: 'user-member-2', name: 'Member' });
    const member = peerAs(rooms, 'user-member-2');
    rooms.handle(member.id, { t: 'create', club: club.code, rules: WILD, botSkill: 'pro' });
    const room = member.out.find((m) => m.t === 'room')!.room!;
    expect(pick(rooms.hostedTable(room)!.rules)).toEqual(pick(club.rules));
    expect(rooms.hostedTable(room)!.serialize().botSkill).toBe('beginner');
    expect(clubs.club(club.code).tables[0]).toMatchObject({ code: room, variant: false });

    const owner = peerAs(rooms, 'user-owner-1');
    rooms.handle(owner.id, { t: 'create', club: club.code, rules: WILD });
    const room2 = owner.out.find((m) => m.t === 'room')!.room!;
    expect(rooms.hostedTable(room2)!.rules.basePoints).toBe(5000);
    expect(clubs.club(club.code).tables.find((t) => t.code === room2)!.variant).toBe(true);
  });
});

const seat = (n: number, userId: string | undefined, isBot = !userId): SeatInfo => ({ seat: n, name: `P${n}`, peerId: null, userId, isBot, connected: true });
const over = (seats: SeatInfo[]): HostEvent => ({ type: 'match_over', roomCode: 'ROOM01', matchId: 'm1', seats, scores: [300, -100, -100, -100], handNumber: 4, handsWon: [2, 1, 1, 0] });

describe('club standings count only real club games', () => {
  const A = { userId: 'user-alice-1', name: 'Alice' };
  const B = { userId: 'user-bob-22', name: 'Bob' };
  const setup = () => {
    const clubs = new ClubRegistry();
    const club = clubs.createClub(A, 'Ladder');
    clubs.joinClub(club.code, B);
    return { clubs, club };
  };
  const played = (clubs: ClubRegistry, code: string) => clubs.standings(code).map((m) => [m.name, m.matchesPlayed, m.seasonPoints]);

  it('does not move the standings for a member alone against bots', () => {
    const { clubs, club } = setup();
    clubs.addTable(club.code, B.userId, { code: 'ROOM01' });
    clubs.applyRoomEvent('ROOM01', over([seat(0, B.userId), seat(1, undefined), seat(2, undefined), seat(3, undefined)]));
    expect(played(clubs, club.code)).toEqual([
      ['Alice', 0, 0],
      ['Bob', 0, 0],
    ]);
    expect(clubs.club(club.code).tables[0].status).toBe('finished');
  });

  it('does not count a member with a non-member: two humans, one of them outside the club', () => {
    const { clubs, club } = setup();
    clubs.addTable(club.code, A.userId, { code: 'ROOM01' });
    clubs.applyRoomEvent('ROOM01', over([seat(0, A.userId), seat(1, 'user-outsider-9'), seat(2, undefined), seat(3, undefined)]));
    expect(clubs.standings(club.code).every((m) => m.matchesPlayed === 0)).toBe(true);
  });

  it('never counts a match where one account held two seats', () => {
    const { clubs, club } = setup();
    clubs.addTable(club.code, A.userId, { code: 'ROOM01' });
    clubs.applyRoomEvent('ROOM01', over([seat(0, A.userId), seat(1, A.userId), seat(2, B.userId), seat(3, undefined)]));
    expect(clubs.standings(club.code).every((m) => m.matchesPlayed === 0)).toBe(true);
  });

  it('never counts a variant table, and counts a house table with two members', () => {
    const { clubs, club } = setup();
    clubs.addTable(club.code, A.userId, { code: 'VAR001', rules: { ...DEFAULT_RULES, basePoints: 999 } });
    expect(clubs.club(club.code).tables[0].variant).toBe(true);
    const twoMembers = [seat(0, A.userId), seat(1, B.userId), seat(2, undefined), seat(3, undefined)];
    clubs.applyRoomEvent('VAR001', { ...over(twoMembers), roomCode: 'VAR001' });
    expect(clubs.standings(club.code).every((m) => m.matchesPlayed === 0)).toBe(true);
    clubs.addTable(club.code, A.userId, { code: 'HOUSE1' });
    clubs.applyRoomEvent('HOUSE1', { ...over(twoMembers), roomCode: 'HOUSE1' });
    expect(played(clubs, club.code)).toEqual([
      ['Alice', 1, 300],
      ['Bob', 1, -100],
    ]);
  });

  it('countsForStandings reads only the human seats', () => {
    const { clubs, club } = setup();
    const t = clubs.addTable(club.code, A.userId, { code: 'ROOM01' });
    const c = clubs.club(club.code);
    expect(countsForStandings(c, t, [seat(0, A.userId), seat(1, B.userId, true)])).toBe(false);
    expect(countsForStandings(c, t, [seat(0, A.userId), seat(1, B.userId)])).toBe(true);
  });
});
