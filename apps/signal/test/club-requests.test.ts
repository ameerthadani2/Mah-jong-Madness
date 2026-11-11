/**
 * Join requests under pressure: throwaway accounts are free, so a new member or request is charged
 * to the client address and to the club, a request nobody answers expires after 30 days, and the
 * owner and admins can turn down a whole queue at once.
 */
import { describe, expect, it } from 'vitest';
import { CLUB_LIMITS, ClubRegistry, type Club } from '../src/clubs';
import { createMemoryRepos } from '../src/repos';
import { apiFixture, type Guest } from './helpers';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);

function fixture() {
  let now = T0;
  const f = apiFixture({ now: () => now });
  const club = async (owner: Guest, name: string, approval: boolean) => (await f.call('POST', '/api/clubs', { name, settings: { joinRequiresApproval: approval } }, owner.auth)).json as unknown as Club;
  const join = (code: string, who: Guest, ip?: string) => f.call('POST', `/api/clubs/${code}/join`, {}, who.auth, ip);
  return { ...f, at: () => now, advance: (ms: number) => (now += ms), club, join };
}

describe('joining clubs is rate-limited', () => {
  it('per address: 10 new memberships or requests an hour across all clubs, then 429 until it refills', async () => {
    const f = fixture();
    const ip = '203.0.113.7';
    const clubs: Club[] = [];
    for (let i = 0; i < 4; i++) {
      const owner = await f.guest(`Owner ${i}`);
      for (let j = 0; j < 3; j++) clubs.push(await f.club(owner, `Club ${i}.${j}`, j === 0));
    }
    // Throwaway accounts from one address, one club each.
    const accounts: Guest[] = [];
    for (let i = 0; i < CLUB_LIMITS.joinsPerHourPerIp; i++) {
      accounts.push(await f.guest(`Throwaway ${i}`));
      expect((await f.join(clubs[i].code, accounts[i], ip)).status).toBe(200);
    }
    const refused = await f.join(clubs[10].code, await f.guest('One more'), ip);
    expect(refused.status).toBe(429);
    expect(refused.json.error).toBe('rate_limited');
    expect(f.clubs.club(clubs[10].code).members).toHaveLength(1);
    expect(f.clubs.club(clubs[10].code).pending).toHaveLength(0);
    // Asking again where you are already in, or already waiting, costs nothing; another address is not affected.
    expect((await f.join(clubs[1].code, accounts[1], ip)).json.status).toBe('already');
    expect((await f.join(clubs[0].code, accounts[0], ip)).json.status).toBe('pending');
    expect((await f.join(clubs[10].code, await f.guest('Elsewhere'), '198.51.100.9')).status).toBe(200);
    // The allowance comes back over the hour.
    f.advance(HOUR / 2);
    expect((await f.join(clubs[11].code, accounts[2], ip)).status).toBe(200);
  });

  it('per club: 60 an hour from any number of addresses, so a queue cannot be filled in one go', async () => {
    const f = fixture();
    const owner = await f.guest('Owner');
    const club = await f.club(owner, 'Private', true);
    const open = await f.club(owner, 'Open', false);
    for (let i = 0; i < CLUB_LIMITS.joinsPerHourPerClub; i++) expect((await f.join(club.code, await f.guest(`Spam ${i}`))).json.status).toBe('pending');
    const friend = await f.guest('Real friend');
    const refused = await f.join(club.code, friend);
    expect(refused.status).toBe(429);
    expect(refused.json.message).toMatch(/a lot of join requests/);
    expect(f.clubs.club(club.code).pending).toHaveLength(CLUB_LIMITS.joinsPerHourPerClub);
    // The owner's other club is not affected, and this one takes requests again as the hour passes.
    expect((await f.join(open.code, friend)).json.status).toBe('joined');
    f.advance(60_000);
    expect((await f.join(club.code, friend)).json.status).toBe('pending');
    // Clearing the queue reopens the door at once: the owner is not locked out by the flood.
    const another = await f.guest('Another friend');
    expect((await f.join(club.code, another)).status).toBe(429);
    expect((await f.call('POST', `/api/clubs/${club.code}/pending/reject-all`, {}, owner.auth)).json.rejected).toBe(CLUB_LIMITS.joinsPerHourPerClub + 1);
    expect((await f.join(club.code, another)).json.status).toBe('pending');
  });
});

describe('pending join requests expire', () => {
  it('after 30 days, at the hourly prune and when the next person asks to join', async () => {
    const f = fixture();
    const owner = await f.guest('Owner');
    const club = await f.club(owner, 'Private', true);
    // A full queue (the registry is driven directly here: the API would take hours to let these in).
    for (let i = 0; i < CLUB_LIMITS.membersPerClub; i++) f.clubs.joinClub(club.code, { userId: `spam-user-${i}`, name: `Spam ${i}` });
    const early = await f.guest('Too early');
    expect((await f.join(club.code, early)).status).toBe(409);
    expect(f.clubs.club(club.code).pending.every((p) => p.requestedAt === T0)).toBe(true);

    f.advance(29 * DAY);
    expect(f.clubs.expirePending()).toBe(0);
    f.advance(2 * DAY);
    // The queue clears itself when someone asks, without waiting for the hourly prune.
    f.clubs.joinClub(club.code, { userId: 'real-friend-1', name: 'Real friend' });
    expect(f.clubs.club(club.code).pending.map((p) => [p.name, p.requestedAt])).toEqual([['Real friend', f.at()]]);
    await f.clubs.flush();
    expect((await f.repos.clubs.get(club.code))!.pending).toHaveLength(1);

    f.advance(30 * DAY + 1);
    expect(f.clubs.expirePending()).toBe(1);
    expect(f.clubs.club(club.code).pending).toEqual([]);
    // An expired request is not a refusal: the same account may ask again.
    expect(f.clubs.joinClub(club.code, { userId: 'real-friend-1', name: 'Real friend' }).status).toBe('pending');
  });

  it('counts a request stored before requests carried a date from the day the server loads it', async () => {
    let now = T0;
    const store = createMemoryRepos().clubs;
    const before = new ClubRegistry({ store, now: () => now });
    const club = before.createClub({ userId: 'user-owner-1', name: 'Owner' }, 'Old', {}, { joinRequiresApproval: true });
    before.joinClub(club.code, { userId: 'user-asker-1', name: 'Asker' });
    await before.flush();
    const old = (await store.get(club.code))!;
    delete old.pending[0].requestedAt;
    await store.save(old);

    now += 400 * DAY;
    const after = new ClubRegistry({ store, now: () => now });
    await after.load();
    expect(after.expirePending()).toBe(0);
    expect(after.club(club.code).pending[0].requestedAt).toBe(now);
    now += 31 * DAY;
    expect(after.expirePending()).toBe(1);
  });
});

describe('rejecting join requests in bulk', () => {
  async function queue() {
    const f = fixture();
    const [owner, admin, member] = [await f.guest('Owner'), await f.guest('Ada'), await f.guest('Mem')];
    const club = await f.club(owner, 'Private', false);
    for (const g of [admin, member]) await f.join(club.code, g);
    await f.call('POST', `/api/clubs/${club.code}/members/${admin.userId}/role`, { role: 'admin' }, owner.auth);
    await f.call('PATCH', `/api/clubs/${club.code}`, { settings: { joinRequiresApproval: true } }, owner.auth);
    const askers: Guest[] = [];
    for (let i = 0; i < 5; i++) {
      askers.push(await f.guest(`Asker ${i}`));
      expect((await f.join(club.code, askers[i])).json.status).toBe('pending');
    }
    const rejectAll = (by: Guest, body: unknown = {}) => f.call('POST', `/api/clubs/${club.code}/pending/reject-all`, body, by.auth);
    return { ...f, owner, admin, member, club, askers, rejectAll };
  }

  it('lets the owner or an admin turn down the whole queue, and only them', async () => {
    const f = await queue();
    for (const who of [f.member, f.askers[0], await f.guest('Stranger')]) expect((await f.rejectAll(who)).status).toBe(403);
    expect(f.clubs.club(f.club.code).pending).toHaveLength(5);
    const res = await f.rejectAll(f.admin);
    expect(res.status).toBe(200);
    expect(res.json.rejected).toBe(5);
    expect((res.json.club as Club).pending).toEqual([]);
    expect((res.json.club as Club).members).toHaveLength(3);
    // Nothing left: the call is harmless, and writes nothing.
    await f.clubs.flush();
    const writes = f.clubs.writeCount;
    expect((await f.rejectAll(f.owner)).json.rejected).toBe(0);
    expect(f.clubs.writeCount).toBe(writes);
    // A rejected account may ask again.
    expect((await f.join(f.club.code, f.askers[0])).json.status).toBe('pending');
    await f.clubs.flush();
    expect((await f.repos.clubs.get(f.club.code))!.pending.map((p) => p.name)).toEqual(['Asker 0']);
  });

  it('rejects only the requests named, so one that arrived meanwhile is kept', async () => {
    const f = await queue();
    const seen = f.askers.slice(0, 4).map((a) => a.userId);
    const res = await f.rejectAll(f.owner, { userIds: [...seen, 'not-a-request'] });
    expect(res.json.rejected).toBe(4);
    expect((res.json.club as Club).pending.map((p) => p.name)).toEqual(['Asker 4']);
    for (const bad of [{ userIds: 'all' }, { userIds: [1, 2] }, { userIds: Array.from({ length: 201 }, (_, i) => `id-${i}`) }]) {
      const refused = await f.rejectAll(f.owner, bad);
      expect(refused.status).toBe(400);
      expect(refused.json.error).toBe('invalid');
    }
    expect(f.clubs.club(f.club.code).pending).toHaveLength(1);
    expect((await f.rejectAll(f.owner, { userIds: [] })).json.rejected).toBe(0);
    expect((await f.call('POST', '/api/clubs/NOSUCH/pending/reject-all', {}, f.owner.auth)).status).toBe(404);
  });
});
