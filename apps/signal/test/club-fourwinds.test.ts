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
    for (let i = 0; i < 3; i++) expect((await f.call('POST', `/api/clubs/${club.code}/tables`, {}, owner.auth)).status).toBe(200);
    expect(f.clubs.club(club.code).ownerLapsedAt).toBeNull();
  });
});
