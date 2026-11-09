import { describe, expect, it } from 'vitest';
import { allowedBotSkill, canAfford, canCreateClubs, canUse, coachRenewal, coachTier, consume, EMPTY_WALLET, hasTier, migrateWallet, mirrorMe, ownsCosmetic, showsPurchase, totalDiamonds, trustedNow, walletForUser, type MeWallet } from './wallet';

const DAY = 86400_000;
const SERVER_NOW = '2026-11-05T12:00:00.000Z';
const S = Date.parse(SERVER_NOW);

const me = (over: Partial<MeWallet> = {}): MeWallet => ({
  user: { id: 'u-1' },
  wallet: { diamonds: 300, bonusDiamonds: 40 },
  entitlements: [],
  serverNow: SERVER_NOW,
  ...over,
});

describe('wallet mirror', () => {
  it('drops another account’s mirror (tier, themes, balance) after a sign-out, a deletion or an account switch, keeping the meters', () => {
    const meters = { day: '2026-11-5', reviews: 2, rush: 1 };
    const w = mirrorMe({ ...EMPTY_WALLET, meters }, me({ entitlements: [{ entitlement: 'fourwinds', expiresAt: '2026-12-05T12:00:00.000Z' }, { entitlement: 'theme.jade', expiresAt: null }] }), S);
    expect(hasTier(w, 'gold', S)).toBe(true);
    // Signed out (no account) or deleted: nothing of u-1 stays on the device but today's meters.
    const out = walletForUser(w, null);
    expect(out).toEqual({ ...EMPTY_WALLET, meters });
    expect(hasTier(out, 'gold', S)).toBe(false);
    expect(ownsCosmetic(out, 'jade')).toBe(false);
    expect(totalDiamonds(out)).toBe(0);
    // Another account on the same phone starts empty too.
    expect(walletForUser(w, 'u-2')).toEqual({ ...EMPTY_WALLET, meters });
    // The owner keeps it, and a never-synced mirror waits for whoever syncs first.
    expect(walletForUser(w, 'u-1')).toBe(w);
    expect(walletForUser(EMPTY_WALLET, 'u-2')).toBe(EMPTY_WALLET);
  });

  it('copies balances, entitlements and cosmetics from /api/me and keeps this device’s meters', () => {
    const before = { ...EMPTY_WALLET, meters: { day: '2026-11-5', reviews: 1, rush: 0 } };
    const w = mirrorMe(
      before,
      me({ entitlements: [{ entitlement: 'coach.gold', expiresAt: '2026-12-05T12:00:00.000Z' }, { entitlement: 'theme.jade', expiresAt: null }], cosmetics: ['bamboo', 'cosmetic.imperial', 'not-a-theme'] }),
      S,
    );
    expect(w.userId).toBe('u-1');
    expect(totalDiamonds(w)).toBe(340);
    expect(w.cosmetics).toEqual(['bamboo', 'imperial', 'jade']);
    expect(coachTier(w, S)).toBe('gold');
    expect(w.meters).toEqual(before.meters);
    expect(w.syncedAt).toBe(S);
  });

  it('the server replaces whatever the cached copy claimed', () => {
    const tampered = { ...EMPTY_WALLET, diamonds: 999_999, cosmetics: ['jade'], entitlements: [{ entitlement: 'fourwinds', expiresAt: null }] };
    const w = mirrorMe(tampered, me({ wallet: { diamonds: 0, bonusDiamonds: 0 } }), S);
    expect(totalDiamonds(w)).toBe(0);
    expect(ownsCosmetic(w, 'jade')).toBe(false);
    expect(hasTier(w, 'gold', S)).toBe(false);
  });

  it('ignores junk balances and treats an unreadable expiry as expired', () => {
    const w = mirrorMe(EMPTY_WALLET, me({ wallet: { diamonds: -5, bonusDiamonds: Number.NaN }, entitlements: [{ entitlement: 'fourwinds', expiresAt: 'soon' }] }), S);
    expect(totalDiamonds(w)).toBe(0);
    expect(coachTier(w, S)).toBe('free');
  });

  it('an old device-only wallet (the mock store’s) loads with nothing granted', () => {
    const old = { diamonds: 5000, bonusDiamonds: 10, owned: ['jade'], subscription: { productId: 'coach.diamond.month', tier: 'diamond', until: Date.now() + 1e10 }, vip: null, clubTier: null, history: [], meters: { day: '2026-11-5', reviews: 1, rush: 1 } };
    const w = migrateWallet(old);
    expect(totalDiamonds(w)).toBe(0);
    expect(w.cosmetics).toEqual([]);
    expect(coachTier(w)).toBe('free');
    expect(w.meters).toEqual({ day: '2026-11-5', reviews: 1, rush: 1 });
  });

  it('a cached server copy round-trips through JSON', () => {
    const w = mirrorMe(EMPTY_WALLET, me({ entitlements: [{ entitlement: 'coach.gold', expiresAt: null }], cosmetics: ['jade'] }), S);
    expect(migrateWallet(JSON.parse(JSON.stringify(w)))).toEqual(w);
  });
});

describe('server clock', () => {
  it('judges expiry by the server time, not a wound-back device clock', () => {
    const w = mirrorMe(EMPTY_WALLET, me({ entitlements: [{ entitlement: 'fourwinds', expiresAt: '2026-11-04T00:00:00.000Z' }] }), S);
    const deviceAYearAgo = S - 365 * DAY;
    // Device time a year behind: the latest server time seen still wins.
    expect(trustedNow(w, deviceAYearAgo)).toBe(S);
    expect(coachTier(w, trustedNow(w, deviceAYearAgo))).toBe('free');
    expect(hasTier(w, 'gold', trustedNow(w, deviceAYearAgo))).toBe(false);
  });

  it('corrects a device clock that runs ahead or behind by the observed offset', () => {
    const deviceAtSync = S - 3 * 3600_000; // the device is three hours slow
    const w = mirrorMe(EMPTY_WALLET, me(), deviceAtSync);
    expect(trustedNow(w, deviceAtSync + 60_000)).toBe(S + 60_000);
  });

  it('uses the device clock before the server has ever been seen', () => {
    expect(trustedNow(EMPTY_WALLET, 12345)).toBe(12345);
  });

  it('daily meters follow the trusted day: a new day refills them, winding the device back does not', () => {
    const synced = mirrorMe(EMPTY_WALLET, me(), S);
    const used = consume(synced, 'rush', new Date(trustedNow(synced, S)));
    expect(canUse(used, 'rush', new Date(trustedNow(used, S))).ok).toBe(false);
    // A real new day (offset 0 here, so the trusted clock follows the device) refills them...
    const tomorrow = S + DAY;
    expect(canUse(used, 'rush', new Date(tomorrow)).ok).toBe(true);
    // ...whereas winding the device back to yesterday never refills today's use.
    expect(canUse(used, 'rush', new Date(trustedNow(used, S - DAY))).ok).toBe(false);
  });

  it('subscriptions lift the meters: Gold for Puzzle Rush, The Four Winds Club for reviews', () => {
    const gold = mirrorMe(EMPTY_WALLET, me({ entitlements: [{ entitlement: 'coach.gold', expiresAt: null }] }), S);
    expect(canUse(gold, 'rush', new Date(S))).toEqual({ ok: true, left: Infinity, limit: null });
    expect(canUse(gold, 'reviews', new Date(S)).limit).toBe(1);
    const plat = mirrorMe(EMPTY_WALLET, me({ entitlements: [{ entitlement: 'fourwinds.month', expiresAt: '2026-12-01T00:00:00.000Z' }] }), S);
    expect(canUse(plat, 'reviews', new Date(S)).ok).toBe(true);
    expect(hasTier(plat, 'gold', S)).toBe(true);
    expect(coachRenewal(plat, S)).toBe(Date.parse('2026-12-01T00:00:00.000Z'));
  });
});

describe('purchase detection and affordability', () => {
  it('recognises each kind of purchase in a fresh /api/me', () => {
    const before = mirrorMe(EMPTY_WALLET, me(), S);
    expect(showsPurchase(before, mirrorMe(before, me({ wallet: { diamonds: 900, bonusDiamonds: 40 } }), S), 'diamonds.600')).toBe(true);
    expect(showsPurchase(before, before, 'diamonds.600')).toBe(false);
    expect(showsPurchase(before, mirrorMe(before, me({ cosmetics: ['jade'] }), S), 'theme.jade')).toBe(true);
    const gold = mirrorMe(before, me({ entitlements: [{ entitlement: 'coach.gold', expiresAt: '2026-12-05T12:00:00.000Z' }] }), S);
    expect(showsPurchase(before, gold, 'coach.gold.month')).toBe(true);
    const renewed = mirrorMe(gold, me({ entitlements: [{ entitlement: 'coach.gold', expiresAt: '2027-11-05T12:00:00.000Z' }] }), S);
    expect(showsPurchase(gold, renewed, 'coach.gold.year')).toBe(true);
    expect(showsPurchase(gold, gold, 'coach.gold.year')).toBe(false);
    expect(showsPurchase(before, before, 'no.such.product')).toBe(false);
  });

  it('counts bonus diamonds towards a price', () => {
    const w = mirrorMe(EMPTY_WALLET, me({ wallet: { diamonds: 150, bonusDiamonds: 30 } }), S);
    expect(canAfford(w, 180)).toEqual({ ok: true, short: 0 });
    expect(canAfford(w, 240)).toEqual({ ok: false, short: 60 });
  });
});

describe('Pro bots', () => {
  it('a saved Pro choice plays as Club without Coach Gold, and as Pro with it', () => {
    const free = mirrorMe(EMPTY_WALLET, me(), S);
    expect(allowedBotSkill('pro', free, S)).toBe('club');
    expect(allowedBotSkill('beginner', free, S)).toBe('beginner');
    const gold = mirrorMe(EMPTY_WALLET, me({ entitlements: [{ entitlement: 'coach.gold', expiresAt: '2026-12-01T00:00:00.000Z' }] }), S);
    expect(allowedBotSkill('pro', gold, S)).toBe('pro');
    expect(allowedBotSkill('pro', gold, Date.parse('2027-01-01T00:00:00.000Z'))).toBe('club');
  });
});

describe('The Four Winds Club', () => {
  it('each plan is its own entitlement and the tier is the best live one: a refunded monthly Gold leaves the yearly in force', () => {
    const w = mirrorMe(EMPTY_WALLET, me({ entitlements: [{ entitlement: 'coach.gold.month', expiresAt: '2026-11-01T00:00:00.000Z' }, { entitlement: 'coach.gold.year', expiresAt: '2027-11-01T00:00:00.000Z' }] }), S);
    expect(coachTier(w, S)).toBe('gold');
    expect(canCreateClubs(w, S)).toBe(false);
  });

  it('includes everything in Coach Gold, unlimited reviews and creating clubs', () => {
    const w = mirrorMe(EMPTY_WALLET, me({ entitlements: [{ entitlement: 'fourwinds.year', expiresAt: '2027-11-01T00:00:00.000Z' }] }), S);
    expect(coachTier(w, S)).toBe('fourwinds');
    expect(hasTier(w, 'gold', S)).toBe(true);
    expect(canUse(w, 'reviews', new Date(S)).limit).toBeNull();
    expect(allowedBotSkill('pro', w, S)).toBe('pro');
    expect(canCreateClubs(w, S)).toBe(true);
  });
});
