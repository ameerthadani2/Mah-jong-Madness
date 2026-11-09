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
    expect((await wallet.applyStoreEvent(storeEvent(u, 'INITIAL_PURCHASE', { storeProductId: 'coach.gold.month', expiresAt: month }))).outcome).toBe('entitled');
    expect(await ent()).toMatchObject({ expiresAt: month, source: 'store' });
    expect((await wallet.summary(u)).coachTier).toBe('gold');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'RENEWAL', { storeProductId: 'coach.gold.month', expiresAt: month + 30 * DAY }))).outcome).toBe('extended');
    // A late, older event does not shorten it; nor does an EXPIRATION for the earlier period.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'RENEWAL', { storeProductId: 'coach.gold.month', expiresAt: month }))).outcome).toBe('ignored_stale');
    expect((await wallet.applyStoreEvent(storeEvent(u, 'EXPIRATION', { storeProductId: 'coach.gold.month', expiresAt: month }))).outcome).toBe('ignored_stale');
    expect((await ent())?.expiresAt).toBe(month + 30 * DAY);
    // Turning off auto-renew changes nothing now; a refund ends it at once.
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { storeProductId: 'coach.gold.month', cancelReason: 'UNSUBSCRIBE' }))).outcome).toBe('recorded');
    expect((await ent())?.expiresAt).toBe(month + 30 * DAY);
    advance(DAY);
    expect((await wallet.applyStoreEvent(storeEvent(u, 'CANCELLATION', { storeProductId: 'coach.gold.month', cancelReason: 'CUSTOMER_SUPPORT', expiresAt: now() }))).outcome).toBe('refunded');
    expect((await ent())?.expiresAt).toBe(now());
    expect((await wallet.summary(u)).coachTier).toBe('free');
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
