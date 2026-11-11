/**
 * Decision 5: once the store is live, owning a club needs The Four Winds Club. A subscriber may own
 * up to 3 clubs; when the owner's plan lapses the club keeps working, but after a 7-day grace it may
 * have only one open table until the owner renews or passes the club on. Before the store is live
 * anyone may create clubs.
 */
import { describe, expect, it } from 'vitest';
import { CLUB_LIMITS, type Club } from '../src/clubs';
import type { Repos } from '../src/repos';
import { apiFixture } from './helpers';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 1);

const plan = (repos: Repos, userId: string, expiresAt: number, at: number) =>
  repos.wallet.setEntitlement({ userId, entitlement: 'fourwinds.month', expiresAt, source: 'store', updatedAt: at });

function liveStore() {
  let now = T0;
  const f = apiFixture({ now: () => now, deps: { config: { revenueCatWebhookSecret: 'whsec-test' } } });
  return { ...f, at: () => now, advance: (ms: number) => (now += ms) };
}

describe('creating a club while the store is live', () => {
  it('needs an active Four Winds plan (403 fourwinds_required), and a subscriber may own up to 3 clubs', async () => {
    const f = liveStore();
    const a = await f.guest('Alice');
    const res = await f.call('POST', '/api/clubs', { name: 'No plan' }, a.auth);
    expect(res.status).toBe(403);
    expect(res.json.error).toBe('fourwinds_required');
    expect(f.clubs.all()).toEqual([]);
    await plan(f.repos, a.userId, T0 + 30 * DAY, T0);
    for (let i = 0; i < CLUB_LIMITS.ownedClubsPerUser; i++) expect((await f.call('POST', '/api/clubs', { name: `Club ${i}` }, a.auth)).status).toBe(200);
    const fourth = await f.call('POST', '/api/clubs', { name: 'Fourth' }, a.auth);
    expect(fourth.status).toBe(409);
    expect(fourth.json.message).toMatch(/own at most 3/);
  });

  it('lets anyone create a club before the store is live, and joining stays free either way', async () => {
    const off = apiFixture();
    const a = await off.guest('Alice');
    expect((await off.call('POST', '/api/clubs', { name: 'Dev club' }, a.auth)).status).toBe(200);
    const f = liveStore();
    const owner = await f.guest('Owner');
    await plan(f.repos, owner.userId, T0 + 30 * DAY, T0);
    const club = (await f.call('POST', '/api/clubs', { name: 'Paid' }, owner.auth)).json as unknown as Club;
    const b = await f.guest('Bo');
    expect((await f.call('POST', `/api/clubs/${club.code}/join`, {}, b.auth)).json.status).toBe('joined');
  });
});

describe("an owner's lapsed plan", () => {
  async function paidClub() {
    const f = liveStore();
    const owner = await f.guest('Owner');
    const member = await f.guest('Member');
    await plan(f.repos, owner.userId, T0 + 10 * DAY, T0);
    const club = (await f.call('POST', '/api/clubs', { name: 'Paid' }, owner.auth)).json as unknown as Club;
    await f.call('POST', `/api/clubs/${club.code}/join`, {}, member.auth);
    return { ...f, owner, member, club };
  }
  const openTable = (f: Awaited<ReturnType<typeof paidClub>>, who: { auth: Record<string, string> }) => f.call('POST', `/api/clubs/${f.club.code}/tables`, {}, who.auth);

  it('keeps the full cap through the 7-day grace, then allows one open table until the owner renews', async () => {
    const f = await paidClub();
    expect((await openTable(f, f.member)).status).toBe(200);
    f.advance(11 * DAY); // the plan ended a day ago
    expect((await openTable(f, f.member)).status).toBe(200);
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBe(f.at());
    f.advance(7 * DAY);
    const refused = await openTable(f, f.member);
    expect(refused.status).toBe(409);
    expect(refused.json.message).toMatch(/only 1 open table until its owner renews/);
    // The club still works for members, and the owner keeps the admin tools.
    const c = await f.guest('Carol');
    expect((await f.call('POST', `/api/clubs/${f.club.code}/join`, {}, c.auth)).json.status).toBe('joined');
    expect((await f.call('PATCH', `/api/clubs/${f.club.code}`, { description: 'Still here' }, f.owner.auth)).status).toBe(200);
    // No new club for the lapsed owner.
    expect((await f.call('POST', '/api/clubs', { name: 'Another' }, f.owner.auth)).json.error).toBe('fourwinds_required');
    // Renewing lifts the cap at the next table opened.
    await plan(f.repos, f.owner.userId, f.at() + 30 * DAY, f.at());
    expect((await openTable(f, f.member)).status).toBe(200);
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBeNull();
  });

  it('lifts the cap when the owner passes the club to a subscriber, but not when passing it to another account without a plan', async () => {
    const f = await paidClub();
    const heir = await f.guest('Heir');
    await f.call('POST', `/api/clubs/${f.club.code}/join`, {}, heir.auth);
    await openTable(f, f.member);
    f.advance(20 * DAY);
    expect((await openTable(f, f.member)).status).toBe(200); // records the lapse
    f.advance(8 * DAY);
    expect((await openTable(f, f.member)).status).toBe(409);
    // To an account without a plan: the lapse on record stands (no fresh grace).
    await f.call('POST', `/api/clubs/${f.club.code}/members/${f.member.userId}/role`, { role: 'owner' }, f.owner.auth);
    expect((await openTable(f, heir)).status).toBe(409);
    // To a subscriber: the cap is lifted at once.
    await plan(f.repos, heir.userId, f.at() + 30 * DAY, f.at());
    await f.call('POST', `/api/clubs/${f.club.code}/members/${heir.userId}/role`, { role: 'owner' }, f.member.auth);
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBeNull();
    expect((await openTable(f, heir)).status).toBe(200);
  });

  it('is noticed by the hourly check too, and the socket path then uses the same cap', async () => {
    const f = await paidClub();
    f.advance(11 * DAY);
    f.clubs.pruneFinishedTables(f.at() - DAY);
    await f.clubs.checkOwnerPlans();
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBe(f.at());
    f.advance(8 * DAY);
    f.clubs.addTable(f.club.code, f.member.userId, { code: 'ROOM01' });
    expect(() => f.clubs.assertCanOpenTable(f.club.code, f.member.userId)).toThrow(/only 1 open table/);
  });

  it('never restricts a club while the store is not live', async () => {
    let now = T0;
    const f = apiFixture({ now: () => now });
    const owner = await f.guest('Owner');
    const club = (await f.call('POST', '/api/clubs', { name: 'Dev' }, owner.auth)).json as unknown as Club;
    now += 25 * DAY;
    await f.clubs.checkOwnerPlans();
    // One table every ten seconds: opening one over the API costs the account's create allowance.
    for (let i = 0; i < 3; i++) {
      expect((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, owner.auth)).status).toBe(200);
      now += 10_000;
    }
    expect(f.clubs.club(club.code).ownerLapsedAt).toBeNull();
  });
});

describe('the three-club cap on every way of coming to own a club', () => {
  const transfer = (f: ReturnType<typeof liveStore>, code: string, to: { userId: string }, by: { auth: Record<string, string> }) =>
    f.call('POST', `/api/clubs/${code}/members/${to.userId}/role`, { role: 'owner' }, by.auth);
  async function subscriberWithThree(f: ReturnType<typeof liveStore>) {
    const sub = await f.guest('Subscriber');
    await plan(f.repos, sub.userId, T0 + 365 * DAY, T0);
    const own: string[] = [];
    for (let i = 0; i < CLUB_LIMITS.ownedClubsPerUser; i++) {
      own.push((await f.call('POST', '/api/clubs', { name: `Sub ${i}` }, sub.auth)).json.code as string);
      f.advance(1000);
    }
    return { sub, own };
  }

  it('refuses a transfer to a member who already owns 3 clubs (409 limit), with the store live or not', async () => {
    for (const f of [liveStore(), { ...apiFixture(), advance: () => 0 } as unknown as ReturnType<typeof liveStore>]) {
      const { sub } = await subscriberWithThree(f);
      const other = await f.guest('Other');
      await plan(f.repos, other.userId, T0 + 365 * DAY, T0);
      const club = (await f.call('POST', '/api/clubs', { name: 'Fourth' }, other.auth)).json as unknown as Club;
      await f.call('POST', `/api/clubs/${club.code}/join`, {}, sub.auth);
      const res = await transfer(f, club.code, sub, other);
      expect(res.status).toBe(409);
      expect(res.json.error).toBe('limit');
      expect(res.json.message).toMatch(/already owns 3 clubs/);
      expect(f.clubs.club(club.code).ownerId).toBe(other.userId);
      expect(f.clubs.club(club.code).members.map((m) => m.role)).toEqual(['owner', 'member']);
      expect(f.clubs.ownedBy(sub.userId)).toHaveLength(3);
    }
  });

  it('hands a deleted owner\'s club to the next admin or member who is under the cap', async () => {
    const f = liveStore();
    const { sub } = await subscriberWithThree(f);
    const owner = await f.guest('Owner');
    await plan(f.repos, owner.userId, T0 + 365 * DAY, T0);
    const club = (await f.call('POST', '/api/clubs', { name: 'Handover' }, owner.auth)).json as unknown as Club;
    const later = await f.guest('Later member');
    for (const g of [sub, later]) {
      await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth);
      f.advance(1000);
    }
    // The senior admin is at the cap: the club goes to the next in line instead.
    await f.call('POST', `/api/clubs/${club.code}/members/${sub.userId}/role`, { role: 'admin' }, owner.auth);
    expect((await f.call('DELETE', '/api/me', undefined, owner.auth)).status).toBe(204);
    expect(f.clubs.club(club.code).ownerId).toBe(later.userId);
    expect(f.clubs.ownedBy(sub.userId)).toHaveLength(3);
    await f.clubs.flush();
    expect((await f.repos.clubs.get(club.code))!.ownerId).toBe(later.userId);
  });

  it('lets the senior member take a deleted owner\'s club when everyone is at the cap, but as a lapsed club', async () => {
    const f = liveStore();
    const { sub, own } = await subscriberWithThree(f);
    const owner = await f.guest('Owner');
    await plan(f.repos, owner.userId, T0 + 365 * DAY, T0);
    const club = (await f.call('POST', '/api/clubs', { name: 'Nobody under the cap' }, owner.auth)).json as unknown as Club;
    await f.call('POST', `/api/clubs/${club.code}/join`, {}, sub.auth);
    expect((await f.call('DELETE', '/api/me', undefined, owner.auth)).status).toBe(204);
    await f.clubs.checkOwnerPlans();
    const fourth = f.clubs.club(club.code);
    expect(fourth.ownerId).toBe(sub.userId);
    // The plan covers the subscriber's first three clubs; this one starts its 7-day grace now.
    expect(own.map((code) => f.clubs.club(code).ownerLapsedAt)).toEqual([null, null, null]);
    expect(fourth.ownerLapsedAt).toBe(f.at());
    f.advance(8 * DAY);
    expect((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, sub.auth)).status).toBe(200);
    expect((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, sub.auth)).status).toBe(409);
    expect(f.clubs.ownerRestricted(fourth)).toBe(true);
    expect(f.clubs.ownerRestricted(f.clubs.club(own[0]))).toBe(false);
    // Deleting one of the three makes room: the plan covers this club again.
    expect((await f.call('DELETE', `/api/clubs/${own[1]}`, { confirm: own[1] }, sub.auth)).status).toBe(204);
    f.advance(10_000); // the account's next table, ten seconds after its last
    expect((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, sub.auth)).status).toBe(200);
    expect(fourth.ownerLapsedAt).toBeNull();
  });

  it('gives a merged account every club of the guest it absorbed, with the plan covering only three', async () => {
    const f = liveStore();
    const { sub, own } = await subscriberWithThree(f);
    const guest = await f.guest('Guest self');
    await plan(f.repos, guest.userId, T0 + 365 * DAY, T0);
    const extra = (await f.call('POST', '/api/clubs', { name: 'Made as a guest' }, guest.auth)).json as unknown as Club;
    // The account merge (POST /api/auth/link) moves the guest's clubs in the registry like this.
    expect(f.clubs.moveMemberships(guest.userId, { userId: sub.userId, name: 'Subscriber' })).toEqual([extra.code]);
    await f.clubs.checkOwnerPlans();
    expect(f.clubs.ownedBy(sub.userId)).toHaveLength(4);
    expect(own.map((code) => f.clubs.club(code).ownerLapsedAt)).toEqual([null, null, null]);
    expect(f.clubs.club(extra.code).ownerLapsedAt).toBe(f.at());
    expect((await f.call('POST', '/api/clubs', { name: 'Fifth' }, sub.auth)).status).toBe(409);
  });
});

describe('a lapse belongs to the account that had it', () => {
  async function lapsedClub() {
    const f = liveStore();
    const owner = await f.guest('Lapsed owner');
    const member = await f.guest('Member');
    const sub = await f.guest('Subscriber');
    await plan(f.repos, owner.userId, T0 + 1 * DAY, T0);
    await plan(f.repos, sub.userId, T0 + 365 * DAY, T0);
    const club = (await f.call('POST', '/api/clubs', { name: 'Lapsing' }, owner.auth)).json as unknown as Club;
    for (const g of [member, sub]) await f.call('POST', `/api/clubs/${club.code}/join`, {}, g.auth);
    f.advance(2 * DAY);
    const open = () => f.call('POST', `/api/clubs/${club.code}/tables`, {}, member.auth);
    const pass = (to: { userId: string }, by: { auth: Record<string, string> }) => f.call('POST', `/api/clubs/${club.code}/members/${to.userId}/role`, { role: 'owner' }, by.auth);
    expect((await open()).status).toBe(200); // the lapse is noticed here
    const lapsedAt = f.at();
    f.advance(8 * DAY);
    expect((await open()).status).toBe(409);
    return { ...f, owner, member, sub, club, open, pass, lapsedAt };
  }

  it('does not restart the 7-day grace when the club goes to a subscriber and straight back', async () => {
    const f = await lapsedClub();
    expect((await f.pass(f.sub, f.owner)).status).toBe(200);
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBeNull();
    const back = await f.pass(f.owner, f.sub);
    expect(back.status).toBe(200);
    // The file is the server's own record: it is never sent to the app.
    expect(back.json.ownerLapses).toBeUndefined();
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBe(f.lapsedAt);
    expect((await f.open()).status).toBe(409);
    // It is the same months later (the sessions have ended by then, so straight on the registry).
    f.advance(90 * DAY);
    const code = f.club.code;
    f.clubs.setRole(code, f.owner.userId, f.sub.userId, 'owner');
    await f.clubs.refreshOwnerPlan(code);
    expect(f.clubs.club(code).ownerLapsedAt).toBeNull();
    f.clubs.setRole(code, f.sub.userId, f.owner.userId, 'owner');
    await f.clubs.refreshOwnerPlan(code);
    expect(f.clubs.club(code).ownerLapsedAt).toBe(f.lapsedAt);
    // Renewing clears the account's record: a later lapse is a new one, with its own grace.
    await plan(f.repos, f.owner.userId, f.at() + 10 * DAY, f.at());
    await f.clubs.checkOwnerPlans();
    expect(f.clubs.club(code).ownerLapsedAt).toBeNull();
    expect(f.clubs.club(code).ownerLapses!.map((l) => l.userId)).not.toContain(f.owner.userId);
    f.advance(11 * DAY);
    await f.clubs.checkOwnerPlans();
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBe(f.at());
  });

  it('continues the lapse for another account without a plan that takes the club over through a subscriber', async () => {
    const f = await lapsedClub();
    const fresh = await f.guest('Fresh account');
    await f.call('POST', `/api/clubs/${f.club.code}/join`, {}, fresh.auth);
    await f.pass(f.sub, f.owner);
    f.advance(DAY);
    expect((await f.pass(fresh, f.sub)).status).toBe(200);
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBe(f.lapsedAt);
    expect((await f.open()).status).toBe(409);
  });

  it('still gives a subscriber who took the club over a grace of their own if their plan ends later', async () => {
    const f = await lapsedClub();
    await f.pass(f.sub, f.owner);
    expect((await f.open()).status).toBe(200);
    await plan(f.repos, f.sub.userId, f.at() + DAY, f.at());
    f.advance(2 * DAY);
    await f.clubs.checkOwnerPlans();
    expect(f.clubs.club(f.club.code).ownerLapsedAt).toBe(f.at());
    f.advance(6 * DAY);
    expect((await f.open()).status).toBe(200);
    // The file survives a restart.
    await f.clubs.flush();
    const stored = (await f.repos.clubs.get(f.club.code))!;
    expect(stored.ownerLapses!.map((l) => l.userId).sort()).toEqual([f.owner.userId, f.sub.userId].sort());
  });
});
