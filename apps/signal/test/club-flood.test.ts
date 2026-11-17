/**
 * A flood of new accounts against one club. Accounts are free to make and addresses are cheap
 * enough in bulk, so fresh accounts (younger than `CLUB_LIMITS.newAccountMs`) share their own
 * hourly allowance per club and may fill a club or its request queue only up to the places kept
 * for established accounts. A player whose account is older still gets in, or still gets to ask.
 */
import { describe, expect, it } from 'vitest';
import { CLUB_LIMITS, type Club } from '../src/clubs';
import { apiFixture, type Guest } from './helpers';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);

function fixture() {
  let now = T0;
  const f = apiFixture({ now: () => now });
  const club = async (owner: Guest, name: string, approval: boolean) => (await f.call('POST', '/api/clubs', { name, settings: { joinRequiresApproval: approval } }, owner.auth)).json as unknown as Club;
  // Every call comes from a different address (the fixture's default), as a botnet's would.
  const join = (code: string, who: Guest) => f.call('POST', `/api/clubs/${code}/join`, {}, who.auth);
  return { ...f, advance: (ms: number) => (now += ms), club, join };
}

/** Send fresh accounts at a club until it stops taking them; returns how many got in or asked. */
async function flood(f: ReturnType<typeof fixture>, code: string, hours: number): Promise<number> {
  let taken = 0;
  for (let h = 0; h < hours; h++) {
    if (h > 0) f.advance(3_600_000);
    for (;;) {
      const res = await f.join(code, await f.guest(`Spam ${taken}`));
      if (res.status !== 200) break;
      taken++;
    }
  }
  return taken;
}

describe('a flood of new accounts does not lock established players out of a club', () => {
  it('a club that approves its members: the flood fills only its share of the queue and of the hourly allowance', async () => {
    const f = fixture();
    const owner = await f.guest('Owner');
    const regular = await f.guest('Regular');
    f.advance(CLUB_LIMITS.newAccountMs + DAY);
    const club = await f.club(owner, 'Private', true);

    // One hour of flood: the new accounts' allowance runs out, the established player's does not.
    expect(await flood(f, club.code, 1)).toBe(CLUB_LIMITS.joinsPerHourPerClub);
    const lateNewcomer = await f.join(club.code, await f.guest('Real newcomer'));
    expect(lateNewcomer.status).toBe(429);
    expect((await f.join(club.code, regular)).json.status).toBe('pending');

    // Hours of flood: new accounts stop at their share of the queue, the rest stays open.
    await flood(f, club.code, 6);
    const pending = f.clubs.club(club.code).pending.length;
    expect(pending).toBe(CLUB_LIMITS.membersPerClub - CLUB_LIMITS.placesKeptForEstablished);
    const refused = await f.join(club.code, await f.guest('Spam again'));
    expect(refused.status).toBe(409);
    expect(refused.json.message).toMatch(/too many pending requests/);
    const other = await f.guest('Another regular');
    f.advance(CLUB_LIMITS.newAccountMs);
    expect((await f.join(club.code, other)).json.status).toBe('pending');
  });

  it('an open club: the flood cannot take the last places or the whole hourly allowance', async () => {
    const f = fixture();
    const owner = await f.guest('Owner');
    const regulars = [await f.guest('Regular 1'), await f.guest('Regular 2')];
    f.advance(CLUB_LIMITS.newAccountMs + DAY);
    const club = await f.club(owner, 'Open', false);

    expect(await flood(f, club.code, 1)).toBe(CLUB_LIMITS.joinsPerHourPerClub);
    expect((await f.join(club.code, regulars[0])).json.status).toBe('joined');

    await flood(f, club.code, 6);
    // The owner, the first regular and the new accounts, up to the places kept for established ones.
    expect(f.clubs.club(club.code).members).toHaveLength(CLUB_LIMITS.membersPerClub - CLUB_LIMITS.placesKeptForEstablished);
    const refused = await f.join(club.code, await f.guest('Spam again'));
    expect(refused.status).toBe(409);
    expect(refused.json.message).toMatch(/no room for new accounts/);
    expect((await f.join(club.code, regulars[1])).json.status).toBe('joined');
  });
});

describe('pre-aged accounts are counted per address and per device for each club', () => {
  /** A guest whose app reports install `install` (several accounts on one phone share it). */
  async function guestOn(f: ReturnType<typeof fixture>, name: string, install: string): Promise<Guest> {
    const res = await f.call('POST', '/api/auth/guest', { device: { id: install, platform: 'ios', appBuild: '1', locale: 'en' }, displayName: name });
    expect(res.status).toBe(201);
    const token = (res.json.session as { token: string }).token;
    return { userId: res.json.userId as string, guestSecret: res.json.guestSecret as string, token, auth: { authorization: `Bearer ${token}` } };
  }
  const joinFrom = (f: ReturnType<typeof fixture>, code: string, who: Guest, ip: string) => f.call('POST', `/api/clubs/${code}/join`, {}, who.auth, ip);

  it('one address (an IPv6 /64 counts as one) adds only a few accounts a day to a club, however old they are', async () => {
    const f = fixture();
    const owner = await f.guest('Owner');
    const aged: Guest[] = [];
    for (let i = 0; i < CLUB_LIMITS.joinsPerDayPerClubAddress + 2; i++) aged.push(await f.guest(`Aged ${i}`));
    const friend = await f.guest('Friend');
    f.advance(CLUB_LIMITS.newAccountMs + DAY);
    const open = await f.club(owner, 'Open', false);
    const asks = await f.club(owner, 'Asks', true);

    // Every address differs, but all sit in one /64.
    for (let i = 0; i < CLUB_LIMITS.joinsPerDayPerClubAddress; i++) expect((await joinFrom(f, open.code, aged[i], `2001:db8:7:9::${i + 1}`)).json.status).toBe('joined');
    const refused = await joinFrom(f, open.code, aged[CLUB_LIMITS.joinsPerDayPerClubAddress], '2001:db8:7:9:abcd::1');
    expect(refused.status).toBe(429);
    expect(refused.json.message).toMatch(/from this connection/);
    // Another club, and another address for this one, are not affected.
    expect((await joinFrom(f, asks.code, aged[CLUB_LIMITS.joinsPerDayPerClubAddress], '2001:db8:7:9::99')).json.status).toBe('pending');
    expect((await joinFrom(f, open.code, friend, '2001:db8:7:10::1')).json.status).toBe('joined');
    // A day later the address has its allowance back.
    f.advance(DAY);
    expect((await joinFrom(f, open.code, aged[CLUB_LIMITS.joinsPerDayPerClubAddress + 1], '2001:db8:7:9::5')).json.status).toBe('joined');
  });

  it('one phone adds only a couple of accounts a day to a club, whatever address it uses', async () => {
    const f = fixture();
    const owner = await f.guest('Owner');
    const install = '7d6c2a8e-1f3b-4c5d-9e8f-0a1b2c3d4e5f';
    const sameInstall: Guest[] = [];
    for (let i = 0; i < CLUB_LIMITS.joinsPerDayPerClubDevice + 1; i++) sameInstall.push(await guestOn(f, `Phone ${i}`, install));
    f.advance(CLUB_LIMITS.newAccountMs + DAY);
    const club = await f.club(owner, 'Asks', true);
    for (let i = 0; i < CLUB_LIMITS.joinsPerDayPerClubDevice; i++) expect((await joinFrom(f, club.code, sameInstall[i], `10.9.0.${i + 1}`)).json.status).toBe('pending');
    const refused = await joinFrom(f, club.code, sameInstall[CLUB_LIMITS.joinsPerDayPerClubDevice], '10.9.1.1');
    expect(refused.status).toBe(429);
    expect(refused.json.message).toMatch(/from this device/);
    expect(f.clubs.club(club.code).pending).toHaveLength(CLUB_LIMITS.joinsPerDayPerClubDevice);
  });
});
