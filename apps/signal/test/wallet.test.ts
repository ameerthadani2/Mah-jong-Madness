/**
 * WalletService over the memory repositories: credits, diamond spends (atomic debit and grant,
 * bonus first, 409 insufficient / owned), and store events applied exactly once.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMemoryRepos, type Repos } from '../src/repos';
import { WalletError, WalletService, type StoreEvent } from '../src/wallet';

const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;

async function setup() {
  let t = T0;
  const repos = createMemoryRepos();
  const events: Array<{ id: string; event: string; props?: Record<string, unknown> }> = [];
  const wallet = new WalletService(repos, {
    now: () => t,
    log: () => {},
    analytics: { enabled: true, capture: (id, event, props) => events.push({ id, event, props }), shutdown: async () => {} },
  });
  const user = async () => (await repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: T0 })).id;
  return { repos, wallet, user, events, advance: (ms: number) => (t += ms), now: () => t };
}

function storeEvent(userId: string, type: string, extra: Partial<StoreEvent> = {}): StoreEvent {
  return {
    vendor: 'revenuecat',
    eventId: randomUUID(),
    type,
    userIds: [userId],
    storeProductId: null,
    transactionId: randomUUID(),
    expiresAt: null,
    purchasedAt: T0,
    price: 4.99,
    currency: 'USD',
    store: 'app_store',
    environment: 'PRODUCTION',
    cancelReason: null,
    transferredFrom: [],
    transferredTo: [],
    raw: { event: { type } },
    ...extra,
  };
}

const balance = async (repos: Repos, userId: string) => {
  const w = await repos.wallet.get(userId);
  return [w.diamonds, w.bonusDiamonds];
};

describe('credit', () => {
  it('adds purchased and bonus diamonds with a ledger entry, and refuses nonsense amounts', async () => {
    const { repos, wallet, user } = await setup();
    const u = await user();
    expect(await wallet.credit(u, 100, 'grant', 'ref-1', 20)).toMatchObject({ diamonds: 100, bonusDiamonds: 20 });
    expect((await repos.wallet.listLedger(u)).map((l) => [l.delta, l.bonus, l.reason, l.ref])).toEqual([[100, 20, 'grant', 'ref-1']]);
    for (const bad of [0, -5, 1.5, Number.NaN]) await expect(wallet.credit(u, bad, 'grant')).rejects.toBeInstanceOf(WalletError);
  });
});

describe('spend', () => {
  it('debits bonus diamonds first, grants a permanent cosmetic, and shows it in the summary', async () => {
    const { repos, wallet, user } = await setup();
    const u = await user();
    await wallet.credit(u, 400, 'grant', null, 100);
    const res = await wallet.spend(u, 'theme.jade');
    expect(res).toMatchObject({ entitlement: 'theme.jade', spent: 400, wallet: { diamonds: 100, bonusDiamonds: 0 } });
    expect((await repos.wallet.getEntitlements(u))[0]).toMatchObject({ entitlement: 'theme.jade', expiresAt: null, source: 'diamonds' });
    expect((await repos.wallet.listLedger(u)).at(-1)).toMatchObject({ delta: -300, bonus: -100, reason: 'spend', ref: 'theme.jade' });
    expect(await wallet.summary(u)).toMatchObject({ cosmetics: ['theme.jade'], coachTier: 'free', wallet: { diamonds: 100, bonusDiamonds: 0 } });
  });

  it('answers 409 insufficient without changing anything', async () => {
    const { repos, wallet, user } = await setup();
    const u = await user();
    await wallet.credit(u, 250, 'grant', null, 40);
    const err = await wallet.spend(u, 'theme.bamboo').catch((e: WalletError) => e);
    expect(err).toMatchObject({ code: 'insufficient', status: 409 });
    expect(await balance(repos, u)).toEqual([250, 40]);
    expect(await repos.wallet.getEntitlements(u)).toEqual([]);
  });

  it('answers 409 owned for a second purchase, even when two spends race', async () => {
    const { repos, wallet, user } = await setup();
    const u = await user();
    await wallet.credit(u, 1000, 'grant');
    const results = await Promise.allSettled([wallet.spend(u, 'theme.imperial'), wallet.spend(u, 'theme.imperial')]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'owned', status: 409 });
    expect(await balance(repos, u)).toEqual([700, 0]);
  });

  it('a bundle grants its missing items for the share of the price still missing, and is owned once complete', async () => {
    const { repos, wallet, user } = await setup();
    const u = await user();
    await wallet.credit(u, 3000, 'grant');
    await wallet.spend(u, 'theme.nightmarket');
    // 850 for all four (1,050 alone); the 300 table is owned, so 750 of 1,050 is missing: 850 × 750 / 1050 = 607.1 → 610.
    const res = await wallet.spend(u, 'bundle.nightmarket');
    expect(res).toMatchObject({ spent: 610, granted: ['back.midnight', 'frame.lantern', 'emotes.nightmarket'] });
    expect((await wallet.summary(u)).cosmetics).toEqual(['back.midnight', 'emotes.nightmarket', 'frame.lantern', 'theme.nightmarket']);
    await expect(wallet.spend(u, 'bundle.nightmarket')).rejects.toMatchObject({ code: 'owned' });
    expect(await balance(repos, u)).toEqual([3000 - 300 - 610, 0]);
    expect((await repos.wallet.listLedger(u)).at(-1)).toMatchObject({ reason: 'spend', ref: 'bundle.nightmarket', delta: -610 });
  });

  it('refuses products that are not sold for diamonds (404)', async () => {
    const { wallet, user } = await setup();
    const u = await user();
    await wallet.credit(u, 5000, 'grant');
    for (const id of ['coach.gold.month', 'diamonds.60', 'avatars.zodiac', 'nope', 42, undefined]) {
      await expect(wallet.spend(u, id)).rejects.toMatchObject({ code: 'not_for_sale', status: 404 });
    }
  });
});

describe('store events', () => {
  it('credits a diamond pack (base plus bonus) once per event id and once per transaction', async () => {
    const { repos, wallet, user, events } = await setup();
    const u = await user();
    await repos.users.setAnalyticsConsent(u, true);
    const e = storeEvent(u, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.3450', price: 49.99 });
    expect(await wallet.applyStoreEvent(e)).toEqual({ outcome: 'credited', userId: u, duplicate: false });
    expect(await balance(repos, u)).toEqual([3000, 450]);
    expect(await wallet.applyStoreEvent(e)).toEqual({ outcome: 'duplicate', userId: u, duplicate: true });
    // The same store transaction under a new event id is still credited only once.
    expect((await wallet.applyStoreEvent({ ...e, eventId: randomUUID() })).outcome).toBe('duplicate');
    expect(await balance(repos, u)).toEqual([3000, 450]);
    expect((await repos.wallet.listPurchases(u)).map((p) => [p.productId, p.price, p.currency])).toEqual([['diamonds.3450', 49.99, 'USD']]);
    expect(events).toEqual([{ id: u, event: 'purchase_credited', props: expect.objectContaining({ productId: 'diamonds.3450', diamonds: 3450 }) }]);
  });

  it('sends purchase analytics only for players who allowed analytics in the app', async () => {
    const { repos, wallet, user, events } = await setup();
    const [unknown, no, yes] = [await user(), await user(), await user()];
    await repos.users.setAnalyticsConsent(no, false);
    await repos.users.setAnalyticsConsent(yes, true);
    for (const u of [unknown, no, yes]) await wallet.applyStoreEvent(storeEvent(u, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.60' }));
    await wallet.applyStoreEvent(storeEvent(no, 'INITIAL_PURCHASE', { storeProductId: 'coach.gold.month', expiresAt: T0 + 30 * DAY }));
    await new Promise((r) => setTimeout(r, 0));
    expect(events.map((e) => e.id)).toEqual([yes]);
    expect(await balance(repos, unknown)).toEqual([60, 0]);
  });

  it('a refunded pack takes back everything it credited: spent diamonds leave a negative balance that blocks spends', async () => {
    const { repos, wallet, user } = await setup();
    const u = await user();
    const buy = storeEvent(u, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.1300' });
    await wallet.applyStoreEvent(buy);
    await wallet.spend(u, 'theme.jade'); // 100 bonus + 300 purchased
    const refund = storeEvent(u, 'CANCELLATION', { storeProductId: 'diamonds.1300', transactionId: buy.transactionId, cancelReason: 'CUSTOMER_SUPPORT' });
    expect((await wallet.applyStoreEvent(refund)).outcome).toBe('refunded');
    expect(await balance(repos, u)).toEqual([-400, 0]);
    expect((await wallet.applyStoreEvent({ ...refund, eventId: randomUUID() })).outcome).toBe('duplicate');
    expect(await balance(repos, u)).toEqual([-400, 0]);
    // A later purchase is credited on top of the debt; spends wait until the balance is above zero.
    await wallet.credit(u, 0, 'grant', null, 500);
    await expect(wallet.spend(u, 'theme.bamboo')).rejects.toMatchObject({ code: 'insufficient' });
    await wallet.applyStoreEvent(storeEvent(u, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.600' }));
    expect(await balance(repos, u)).toEqual([200, 500]);
    expect((await wallet.spend(u, 'theme.bamboo')).wallet).toMatchObject({ diamonds: 200, bonusDiamonds: 200 });
  });

  it('grants, extends, refunds and expires a subscription, ignoring stale events', async () => {
    const { repos, wallet, user, advance, now } = await setup();
    const u = await user();
    const ent = async () => (await repos.wallet.getEntitlements(u)).find((e) => e.entitlement === 'coach.gold.month');
    const month = T0 + 30 * DAY;
    expect((await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { storeProductId: 'coach.gold.month', transactionId: 's1', expiresAt: month }))).outcome).toBe('entitled');
    expect(await ent()).toMatchObject({ expiresAt: month, source: 'store' });
    expect((await wallet.summary(u)).coachTier).toBe('gold');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'RENEWAL', { storeProductId: 'coach.gold.month', transactionId: 's2', expiresAt: month + 30 * DAY }))).outcome).toBe('extended');
    // A late, older event (the first purchase delivered again under a new event id) does not shorten it; nor does an EXPIRATION for the earlier period.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { storeProductId: 'coach.gold.month', transactionId: 's1', expiresAt: month }))).outcome).toBe('ignored_stale');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'EXPIRATION', { storeProductId: 'coach.gold.month', expiresAt: month }))).outcome).toBe('ignored_stale');
    expect((await ent())?.expiresAt).toBe(month + 30 * DAY);
    // Turning off auto-renew changes nothing now.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { storeProductId: 'coach.gold.month', transactionId: 's2', cancelReason: 'UNSUBSCRIBE' }))).outcome).toBe('recorded');
    expect((await ent())?.expiresAt).toBe(month + 30 * DAY);
    // A refund takes back the period it names: refunding the renewal leaves the first month, which
    // is still paid for, and refunding that one too ends the plan at once.
    advance(DAY);
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { storeProductId: 'coach.gold.month', transactionId: 's2', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect((await ent())?.expiresAt).toBe(month);
    expect((await wallet.summary(u)).coachTier).toBe('gold');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { storeProductId: 'coach.gold.month', transactionId: 's1', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect((await ent())?.expiresAt).toBe(now());
    expect((await wallet.summary(u)).coachTier).toBe('free');
  });

  it('a refund that names no transaction ends the plan now, whatever else is on record', async () => {
    const { repos, wallet, user, advance, now } = await setup();
    const u = await user();
    const month = T0 + 30 * DAY;
    await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { storeProductId: 'coach.gold.month', transactionId: 'n1', expiresAt: month }));
    await wallet.applyStoreEvent(storeEvent(u, 'RENEWAL', { storeProductId: 'coach.gold.month', transactionId: 'n2', expiresAt: month + 30 * DAY }));
    advance(DAY);
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { storeProductId: 'coach.gold.month', transactionId: null, cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect((await repos.wallet.getEntitlements(u)).find((e) => e.entitlement === 'coach.gold.month')?.expiresAt).toBe(now());
    expect((await wallet.summary(u)).coachTier).toBe('free');
    // A purchase event with no transaction id records no period, so it can never hold a refunded plan up.
    const v = await user();
    await wallet.applyStoreEvent(storeEvent(v, 'INITIAL_PURCHASE', { storeProductId: 'coach.gold.month', transactionId: null, expiresAt: month }));
    expect((await repos.wallet.listPurchases(v)).map((p) => p.periodEndsAt)).toEqual([null]);
  });

  it('a refund that arrives before the event it undoes is remembered, so the late purchase or renewal grants nothing', async () => {
    const { repos, wallet, user, advance, now } = await setup();
    const u = await user();
    const month = T0 + 30 * DAY;
    // A diamond pack: refund first, purchase later.
    const pack = storeEvent(u, 'CANCELLATION', { storeProductId: 'diamonds.7500', transactionId: 'GPA.1', cancelReason: 'CUSTOMER_SUPPORT' });
    expect((await wallet.applyStoreEvent(pack)).outcome).toBe('refunded');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.7500', transactionId: 'GPA.1' }))).outcome).toBe('refunded');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { storeProductId: 'diamonds.7500', transactionId: 'GPA.1' }))).outcome).toBe('duplicate');
    expect(await balance(repos, u)).toEqual([0, 0]);
    expect((await repos.wallet.listPurchases(u)).map((p) => p.transactionId)).toEqual(['GPA.1']);
    // A subscription: the first period refunded before its INITIAL_PURCHASE was delivered.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { storeProductId: 'fourwinds.year', transactionId: 'tZ1', cancelReason: 'CUSTOMER_SUPPORT' }))).outcome).toBe('refunded');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { storeProductId: 'fourwinds.year', transactionId: 'tZ1', expiresAt: T0 + 365 * DAY }))).outcome).toBe('refunded');
    expect((await wallet.summary(u)).coachTier).toBe('free');
    // A renewal refunded while the retry of its RENEWAL event was still on its way.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { storeProductId: 'coach.gold.month', transactionId: 'tA1', expiresAt: month }))).outcome).toBe('entitled');
    advance(31 * DAY);
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { storeProductId: 'coach.gold.month', transactionId: 'tA2', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'RENEWAL', { storeProductId: 'coach.gold.month', transactionId: 'tA2', expiresAt: month + 30 * DAY }))).outcome).toBe('refunded');
    expect((await wallet.summary(u)).coachTier).toBe('free');
    // A refund of a period that was granted still ends it, and only once.
    const r2 = storeEvent(u, 'CANCELLATION', { storeProductId: 'coach.gold.month', transactionId: 'tA1', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() });
    expect((await wallet.applyStoreEvent(r2)).outcome).toBe('refunded');
    expect((await wallet.applyStoreEvent({ ...r2, eventId: randomUUID() })).outcome).toBe('refunded');
  });

  it('a refund takes back its own period only: last month\'s refund leaves the month now paid for', async () => {
    const { repos, wallet, user, advance, now } = await setup();
    const u = await user();
    const ent = async () => (await repos.wallet.getEntitlements(u)).find((e) => e.entitlement === 'fourwinds.month')?.expiresAt;
    const plan = { storeProductId: 'fourwinds.month' };
    const [m1, m2] = [T0 + 30 * DAY, T0 + 60 * DAY];
    expect((await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { ...plan, transactionId: 'p1', expiresAt: m1 }))).outcome).toBe('entitled');
    advance(29 * DAY);
    expect((await wallet.applyStoreEvent(storeEvent(u, 'RENEWAL', { ...plan, transactionId: 'p2', purchasedAt: m1, expiresAt: m2 }))).outcome).toBe('extended');
    expect((await repos.wallet.listPurchases(u)).map((p) => [p.transactionId, p.periodEndsAt])).toEqual([['p1', m1], ['p2', m2]]);
    advance(2 * DAY); // day 31: the first month is over, the second is running
    // The store refunds the first month's charge (it reports that period's own expiry).
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { ...plan, transactionId: 'p1', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: m1 }))).outcome).toBe('refunded');
    expect(await ent()).toBe(m2);
    expect((await wallet.summary(u)).coachTier).toBe('fourwinds');
    expect(await wallet.hasFourWinds(u)).toBe(true);
    // A redelivery under a new event id changes nothing either.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { ...plan, transactionId: 'p1', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: m1 }))).outcome).toBe('refunded');
    expect(await ent()).toBe(m2);
    // Refunding the running month ends it now: the refunded first month does not hold it up.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { ...plan, transactionId: 'p2', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: m2 }))).outcome).toBe('refunded');
    expect(await ent()).toBe(now());
    expect((await wallet.summary(u)).coachTier).toBe('free');
  });

  it('a renewal charged early and then refunded leaves the rest of the month already paid for, and nothing more', async () => {
    const { repos, wallet, user, advance, now } = await setup();
    const u = await user();
    const ent = async () => (await repos.wallet.getEntitlements(u)).find((e) => e.entitlement === 'coach.gold.month')?.expiresAt;
    const plan = { storeProductId: 'coach.gold.month' };
    const [m1, m2] = [T0 + 30 * DAY, T0 + 60 * DAY];
    await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { ...plan, transactionId: 'e1', expiresAt: m1 }));
    advance(29 * DAY);
    await wallet.applyStoreEvent(storeEvent(u, 'RENEWAL', { ...plan, transactionId: 'e2', purchasedAt: m1, expiresAt: m2 }));
    expect(await ent()).toBe(m2);
    // Refunded the same day (the store reports the refund time as the new expiry).
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { ...plan, transactionId: 'e2', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect(await ent()).toBe(m1);
    expect((await wallet.summary(u)).coachTier).toBe('gold');
    advance(2 * DAY);
    expect((await wallet.summary(u)).coachTier).toBe('free');
    // The late retry of the refunded renewal grants nothing.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'RENEWAL', { ...plan, transactionId: 'e2', purchasedAt: m1, expiresAt: m2 }))).outcome).toBe('refunded');
    expect(await ent()).toBe(m1);

    // The same when the refund of the renewal gets here before the renewal itself does.
    const v = await user();
    const entV = async () => (await repos.wallet.getEntitlements(v)).find((e) => e.entitlement === 'coach.gold.month')?.expiresAt;
    const [v1, v2] = [now() + 30 * DAY, now() + 60 * DAY];
    await wallet.applyStoreEvent(storeEvent(v, 'INITIAL_PURCHASE', { ...plan, transactionId: 'q1', purchasedAt: now(), expiresAt: v1 }));
    advance(29 * DAY);
    expect((await wallet.applyStoreEvent(storeEvent(v, 'CANCELLATION', { ...plan, transactionId: 'q2', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect(await entV()).toBe(v1);
    expect((await wallet.applyStoreEvent(storeEvent(v, 'RENEWAL', { ...plan, transactionId: 'q2', purchasedAt: v1, expiresAt: v2 }))).outcome).toBe('refunded');
    expect(await entV()).toBe(v1);
  });

  it('judges a refund by the periods paid for, not by the order the store\'s events arrived in', async () => {
    const { repos, wallet, user, advance, now } = await setup();
    const plan = { storeProductId: 'coach.gold.year' };
    const [y1, y2] = [T0 + 365 * DAY, T0 + 730 * DAY];
    const ent = async (id: string) => (await repos.wallet.getEntitlements(id)).find((e) => e.entitlement === 'coach.gold.year')?.expiresAt;
    // The renewal is processed before the (retried) first purchase.
    const late = await user();
    advance(364 * DAY);
    expect((await wallet.applyStoreEvent(storeEvent(late, 'RENEWAL', { ...plan, transactionId: 'o2', purchasedAt: y1, expiresAt: y2 }))).outcome).toBe('entitled');
    expect((await wallet.applyStoreEvent(storeEvent(late, 'INITIAL_PURCHASE', { ...plan, transactionId: 'o1', expiresAt: y1 }))).outcome).toBe('ignored_stale');
    // Refunding the renewal falls back to the first year, which is paid and has a day left...
    expect((await wallet.applyStoreEvent(storeEvent(late, 'CANCELLATION', { ...plan, transactionId: 'o2', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect(await ent(late)).toBe(y1);
    // ...and a refund of that first year then ends the plan now.
    expect((await wallet.applyStoreEvent(storeEvent(late, 'CANCELLATION', { ...plan, transactionId: 'o1', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: y1 }))).outcome).toBe('refunded');
    expect(await ent(late)).toBe(now());

    // Another plan's paid period never holds up a refunded one, and a pack is not a period.
    const mixed = await user();
    await wallet.applyStoreEvent(storeEvent(mixed, 'INITIAL_PURCHASE', { storeProductId: 'coach.gold.month', transactionId: 'x-month', expiresAt: now() + 30 * DAY }));
    await wallet.applyStoreEvent(storeEvent(mixed, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.300', transactionId: 'x-pack' }));
    await wallet.applyStoreEvent(storeEvent(mixed, 'INITIAL_PURCHASE', { ...plan, transactionId: 'x-year', expiresAt: now() + 365 * DAY }));
    expect((await wallet.applyStoreEvent(storeEvent(mixed, 'CANCELLATION', { ...plan, transactionId: 'x-year', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect(await ent(mixed)).toBe(now());
    expect((await wallet.summary(mixed)).coachTier).toBe('gold'); // the monthly plan is its own purchase

    // A purchase on record with no period end (written before the column existed) proves nothing: the refund ends the plan.
    const old = await user();
    await repos.wallet.recordPurchase({ userId: old, store: 'app_store', transactionId: 'old-2', productId: 'coach.gold.year', price: null, currency: null, eventId: null, raw: {}, createdAt: now() });
    await wallet.applyStoreEvent(storeEvent(old, 'INITIAL_PURCHASE', { ...plan, transactionId: 'old-3', expiresAt: now() + 365 * DAY }));
    expect((await wallet.applyStoreEvent(storeEvent(old, 'CANCELLATION', { ...plan, transactionId: 'old-3', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect(await ent(old)).toBe(now());
  });

  it('a purchase event that races the guest\'s merge credits the account the guest merged into', async () => {
    const { repos, wallet, user } = await setup();
    const { SessionService, link } = await import('../src/auth');
    const sessions = new SessionService(repos, { pepper: 'merge-race-pepper-0123' });
    const account = await user();
    const guest = await user();
    await link(repos, account, { provider: 'google', subject: 'g-race' }, { sessions });
    for (let ticks = 0; ticks < 6; ticks++) {
      const g = ticks === 0 ? guest : await user();
      const credit = wallet.applyStoreEvent(storeEvent(g, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.600', transactionId: `race-${ticks}` }));
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      // The API runs the merge under the wallet's lock, as api.ts does.
      const merge = wallet.exclusive([g], () => link(repos, g, { provider: 'google', subject: 'g-race' }, { sessions }));
      const [res, m] = await Promise.all([credit, merge]);
      expect(m.merged).toBe(true);
      expect(res.outcome).toBe('credited');
      expect(await balance(repos, g)).toEqual([0, 0]);
    }
    expect(await balance(repos, account)).toEqual([6 * 600, 0]);
  });

  it('records events for unknown users and products, and test events, with no effect', async () => {
    const { repos, wallet, user } = await setup();
    const u = await user();
    expect((await wallet.applyStoreEvent(storeEvent('$RCAnonymousID:abc', 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.60' }))).outcome).toBe('ignored_unknown_user');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'NON_RENEWING_PURCHASE', { storeProductId: 'vip.gold.365' }))).outcome).toBe('ignored_unknown_product');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'TEST'))).outcome).toBe('test');
    expect(await balance(repos, u)).toEqual([0, 0]);
  });

  it('grants a merged guest\'s purchase to the account it was merged into', async () => {
    const { repos, wallet, user } = await setup();
    const account = await user();
    const guest = await user();
    await repos.users.update(guest, { deletedAt: T0, mergedInto: account });
    expect((await wallet.applyStoreEvent(storeEvent(guest, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.60' }))).userId).toBe(account);
    expect(await balance(repos, account)).toEqual([60, 0]);
  });

  it('forgets an event whose processing failed (memory), so the retry applies it', async () => {
    const { repos, wallet, user } = await setup();
    const u = await user();
    const e = storeEvent(u, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.60' });
    const apply = repos.wallet.apply;
    repos.wallet.apply = async () => {
      throw new Error('database away');
    };
    await expect(wallet.applyStoreEvent(e)).rejects.toThrow('database away');
    repos.wallet.apply = apply;
    expect(await repos.storeEvents.get(e.eventId)).toBeNull();
    expect(await repos.wallet.listPurchases(u)).toEqual([]);
    expect(await wallet.applyStoreEvent(e)).toMatchObject({ outcome: 'credited', duplicate: false });
    expect(await balance(repos, u)).toEqual([60, 0]);
  });
});
