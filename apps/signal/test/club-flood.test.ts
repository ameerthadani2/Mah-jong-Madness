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
