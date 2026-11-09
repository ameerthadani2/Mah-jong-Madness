/**
 * POST /api/webhooks/revenuecat through the real API handler, with payloads shaped like the ones
 * RevenueCat sends (v1, `{ api_version, event }`), plus the routes that read the result:
 * GET /api/me (wallet, entitlements, cosmetics, storeEnabled), POST /api/wallet/spend and
 * GET /api/config.storeEnabled.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { apiFixture } from './helpers';

const SECRET = 'rc_webhook_secret_0123456789';
const T0 = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;
const hook = { authorization: `Bearer ${SECRET}` };

/** A RevenueCat v1 webhook body, as recorded from the dashboard's sample events. */
function rc(type: string, appUserId: string, event: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      id: randomUUID().toUpperCase(),
      type,
      app_id: 'app1a2b3c4',
      app_user_id: appUserId,
      original_app_user_id: appUserId,
      aliases: [appUserId],
      event_timestamp_ms: T0,
      product_id: 'coach.gold.month',
      entitlement_ids: ['gold'],
      period_type: 'NORMAL',
      purchased_at_ms: T0,
      expiration_at_ms: T0 + 30 * DAY,
      environment: 'SANDBOX',
      store: 'APP_STORE',
      transaction_id: String(2_000_000_000_000_000 + Math.floor(Math.random() * 1e9)),
      original_transaction_id: '2000000000000001',
      is_family_share: false,
      country_code: 'TW',
      currency: 'TWD',
      price: 6.99,
      price_in_purchased_currency: 210,
      takehome_percentage: 0.7,
      ...event,
    },
  };
}

function fixture(secret: string | null = SECRET) {
  let t = T0;
  const f = apiFixture({ now: () => t, deps: { config: { revenueCatWebhookSecret: secret } } });
  const post = (body: unknown, headers: Record<string, string> = hook) => f.call('POST', '/api/webhooks/revenuecat', body, headers);
  const me = async (auth: Record<string, string>) => (await f.call('GET', '/api/me', undefined, auth)).json as Record<string, unknown>;
  return { ...f, post, me, advance: (ms: number) => (t += ms), now: () => t };
}

describe('webhook authentication', () => {
  it('answers 503 when REVENUECAT_WEBHOOK_SECRET is unset, and the store is reported off', async () => {
    const f = fixture(null);
    const g = await f.guest();
    const res = await f.post(rc('INITIAL_PURCHASE', g.userId));
    expect(res.status).toBe(503);
    expect(res.json.error).toBe('unavailable');
    expect((await f.call('GET', '/api/config')).json.storeEnabled).toBe(false);
    expect((await f.me(g.auth)).storeEnabled).toBe(false);
  });

  it('answers 401 for a missing or wrong secret, and changes nothing', async () => {
    const f = fixture();
    const g = await f.guest();
    expect((await f.post(rc('INITIAL_PURCHASE', g.userId), {})).status).toBe(401);
    expect((await f.post(rc('INITIAL_PURCHASE', g.userId), { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await f.post(rc('INITIAL_PURCHASE', g.userId), { authorization: SECRET })).status).toBe(401);
    expect((await f.me(g.auth)).entitlements).toEqual([]);
    expect((await f.call('GET', '/api/config')).json.storeEnabled).toBe(true);
  });

  it('answers 400 for a body that is not a webhook event', async () => {
    const f = fixture();
    expect((await f.post({ hello: 'world' })).status).toBe(400);
    expect((await f.post({ api_version: '1.0', event: { type: 'RENEWAL' } })).status).toBe(400);
  });
});

describe('webhook events', () => {
  it('INITIAL_PURCHASE grants Coach Gold until the store expiry; a replay is a no-op', async () => {
    const f = fixture();
    const g = await f.guest();
    const body = rc('INITIAL_PURCHASE', g.userId);
    const first = await f.post(body);
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ ok: true, outcome: 'entitled', duplicate: false });
    const replay = await f.post(body);
    expect(replay.json).toEqual({ ok: true, outcome: 'duplicate', duplicate: true });
    const me = await f.me(g.auth);
    expect(me.entitlements).toEqual([{ entitlement: 'coach.gold.month', expiresAt: new Date(T0 + 30 * DAY).toISOString(), active: true }]);
    expect(me.coachTier).toBe('gold');
    expect(me.storeEnabled).toBe(true);
    const purchases = await f.repos.wallet.listPurchases(g.userId);
    expect(purchases.map((p) => [p.productId, p.price, p.currency, p.store])).toEqual([['coach.gold.month', 210, 'TWD', 'app_store']]);
    // The raw payload is kept.
    expect((await f.repos.storeEvents.get(body.event.id))?.raw).toEqual(body);
  });

  it('a refund delivered before the purchase or renewal it undoes leaves nothing granted when that event arrives late', async () => {
    const f = fixture();
    const refund = (userId: string, product: string, transactionId: string) => rc('CANCELLATION', userId, { product_id: product, transaction_id: transactionId, cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: f.now() });
    // INITIAL_PURCHASE of a subscription.
    const a = await f.guest();
    expect((await f.post(refund(a.userId, 'fourwinds.year', 'tx-init'))).json.outcome).toBe('refunded');
    expect((await f.post(rc('INITIAL_PURCHASE', a.userId, { product_id: 'fourwinds.year', transaction_id: 'tx-init', expiration_at_ms: T0 + 365 * DAY }))).json.outcome).toBe('refunded');
    expect((await f.me(a.auth)).coachTier).toBe('free');
    // RENEWAL of a live subscription: the first period stays, the refunded second one is never granted.
    const b = await f.guest();
    expect((await f.post(rc('INITIAL_PURCHASE', b.userId, { transaction_id: 'tx-b1' }))).json.outcome).toBe('entitled');
    f.advance(25 * DAY);
    expect((await f.me(b.auth)).coachTier).toBe('gold'); // (and the session slides for another 30 days)
    f.advance(6 * DAY);
    expect((await f.post(refund(b.userId, 'coach.gold.month', 'tx-b2'))).json.outcome).toBe('refunded');
    expect((await f.post(rc('RENEWAL', b.userId, { transaction_id: 'tx-b2', purchased_at_ms: T0 + 30 * DAY, expiration_at_ms: T0 + 60 * DAY }))).json.outcome).toBe('refunded');
    const me = await f.me(b.auth);
    expect(me.coachTier).toBe('free');
    expect(me.entitlements).toEqual([{ entitlement: 'coach.gold.month', expiresAt: new Date(T0 + 30 * DAY).toISOString(), active: false }]);
    // NON_RENEWING_PURCHASE of a diamond pack.
    const c = await f.guest();
    expect((await f.post(refund(c.userId, 'diamonds.7500', 'GPA.7500'))).json.outcome).toBe('refunded');
    expect((await f.post(rc('NON_RENEWING_PURCHASE', c.userId, { product_id: 'diamonds.7500', transaction_id: 'GPA.7500' }))).json.outcome).toBe('refunded');
    expect((await f.me(c.auth)).wallet).toEqual({ diamonds: 0, bonusDiamonds: 0 });
  });

  it('RENEWAL extends; PRODUCT_CHANGE and BILLING_ISSUE record only; EXPIRATION ends it', async () => {
    const f = fixture();
    const g = await f.guest();
    await f.post(rc('INITIAL_PURCHASE', g.userId));
    expect((await f.post(rc('RENEWAL', g.userId, { expiration_at_ms: T0 + 60 * DAY, purchased_at_ms: T0 + 30 * DAY }))).json.outcome).toBe('extended');
    expect((await f.post(rc('PRODUCT_CHANGE', g.userId, { new_product_id: 'fourwinds.month' }))).json.outcome).toBe('recorded');
    expect((await f.post(rc('BILLING_ISSUE', g.userId, { grace_period_expiration_at_ms: T0 + 63 * DAY }))).json.outcome).toBe('recorded');
    expect(((await f.me(g.auth)).entitlements as Array<{ expiresAt: string }>)[0].expiresAt).toBe(new Date(T0 + 60 * DAY).toISOString());
    f.advance(25 * DAY); // (sessions slide for 30 days)
    expect((await f.post(rc('EXPIRATION', g.userId, { expiration_at_ms: T0 + 60 * DAY, expiration_reason: 'BILLING_ERROR' }))).json.outcome).toBe('expired');
    const me = await f.me(g.auth);
    expect(me.coachTier).toBe('free');
    expect((me.entitlements as Array<{ active: boolean }>)[0].active).toBe(false);
  });

  it('CANCELLATION keeps access to the period end; UNCANCELLATION and SUBSCRIPTION_EXTENDED carry on; a refund ends it', async () => {
    const f = fixture();
    const g = await f.guest();
    await f.post(rc('INITIAL_PURCHASE', g.userId, { product_id: 'fourwinds:month' }));
    expect((await f.post(rc('CANCELLATION', g.userId, { product_id: 'fourwinds:month', cancel_reason: 'UNSUBSCRIBE' }))).json.outcome).toBe('recorded');
    expect((await f.me(g.auth)).coachTier).toBe('fourwinds');
    expect((await f.post(rc('UNCANCELLATION', g.userId, { product_id: 'fourwinds:month' }))).json.outcome).toBe('ignored_stale');
    expect((await f.post(rc('SUBSCRIPTION_EXTENDED', g.userId, { product_id: 'fourwinds:month', expiration_at_ms: T0 + 37 * DAY }))).json.outcome).toBe('extended');
    expect((await f.post(rc('SUBSCRIPTION_PAUSED', g.userId, { product_id: 'fourwinds:month', auto_resume_at_ms: T0 + 60 * DAY }))).json.outcome).toBe('recorded');
    f.advance(DAY);
    expect((await f.post(rc('CANCELLATION', g.userId, { product_id: 'fourwinds:month', cancel_reason: 'CUSTOMER_SUPPORT', expiration_at_ms: f.now() }))).json.outcome).toBe('refunded');
    expect((await f.me(g.auth)).coachTier).toBe('free');
  });

  it('NON_RENEWING_PURCHASE credits a diamond pack once; the diamonds buy a table look through /api/wallet/spend', async () => {
    const f = fixture();
    const g = await f.guest();
    const body = rc('NON_RENEWING_PURCHASE', g.userId, { product_id: 'diamonds.300', expiration_at_ms: null, entitlement_ids: null, price: 4.99, price_in_purchased_currency: 150 });
    expect((await f.post(body)).json.outcome).toBe('credited');
    expect((await f.post(body)).json.outcome).toBe('duplicate');
    expect((await f.me(g.auth)).wallet).toEqual({ diamonds: 300, bonusDiamonds: 0 });

    const spend = await f.call('POST', '/api/wallet/spend', { productId: 'theme.nightmarket' }, g.auth);
    expect(spend.status).toBe(200);
    expect(spend.json).toEqual({ spent: 300, entitlement: 'theme.nightmarket', wallet: { diamonds: 0, bonusDiamonds: 0 }, cosmetics: ['theme.nightmarket'] });
    expect((await f.me(g.auth)).cosmetics).toEqual(['theme.nightmarket']);

    const again = await f.call('POST', '/api/wallet/spend', { productId: 'theme.nightmarket' }, g.auth);
    expect([again.status, again.json.error]).toEqual([409, 'owned']);
    const broke = await f.call('POST', '/api/wallet/spend', { productId: 'theme.bamboo' }, g.auth);
    expect([broke.status, broke.json.error]).toEqual([409, 'insufficient']);
    const notSold = await f.call('POST', '/api/wallet/spend', { productId: 'vip.gold.365' }, g.auth);
    expect([notSold.status, notSold.json.error]).toEqual([404, 'not_for_sale']);
    expect((await f.call('POST', '/api/wallet/spend', { productId: 'theme.bamboo' })).status).toBe(401);
  });

  it('TRANSFER moves store entitlements to the account the purchases now belong to', async () => {
    const f = fixture();
    const a = await f.guest();
    const b = await f.guest();
    await f.post(rc('INITIAL_PURCHASE', a.userId));
    const res = await f.post(rc('TRANSFER', '', { app_user_id: undefined, transferred_from: [a.userId], transferred_to: [b.userId], product_id: undefined }));
    expect(res.json.outcome).toBe('transferred');
    expect((await f.me(a.auth)).coachTier).toBe('free');
    expect((await f.me(b.auth)).coachTier).toBe('gold');
  });

  it('TEST, unknown users and unknown products are acknowledged (200) and stored, with no effect', async () => {
    const f = fixture();
    const g = await f.guest();
    expect((await f.post(rc('TEST', g.userId))).json.outcome).toBe('test');
    expect((await f.post(rc('INITIAL_PURCHASE', '$RCAnonymousID:8f2b1c'))).json.outcome).toBe('ignored_unknown_user');
    expect((await f.post(rc('INITIAL_PURCHASE', g.userId, { product_id: 'coach.diamond.month' }))).json.outcome).toBe('ignored_unknown_product');
    expect((await f.post(rc('SOMETHING_NEW', g.userId))).json.outcome).toBe('ignored_type');
    const me = await f.me(g.auth);
    expect([me.entitlements, me.wallet]).toEqual([[], { diamonds: 0, bonusDiamonds: 0 }]);
  });

  it('replaying a whole recorded sequence changes nothing the second time', async () => {
    const f = fixture();
    const g = await f.guest();
    const sequence = [
      rc('INITIAL_PURCHASE', g.userId, { product_id: 'coach.gold.year', expiration_at_ms: T0 + 365 * DAY }),
      rc('NON_RENEWING_PURCHASE', g.userId, { product_id: 'diamonds.7500', expiration_at_ms: null }),
      rc('NON_RENEWING_PURCHASE', g.userId, { product_id: 'diamonds.60', expiration_at_ms: null }),
      rc('CANCELLATION', g.userId, { product_id: 'coach.gold.year', cancel_reason: 'UNSUBSCRIBE' }),
    ];
    for (const body of sequence) expect((await f.post(body)).json.duplicate).toBe(false);
    const after = await f.me(g.auth);
    for (const body of sequence) expect((await f.post(body)).json).toMatchObject({ ok: true, duplicate: true });
    const replayed = await f.me(g.auth);
    expect(replayed.wallet).toEqual({ diamonds: 6060, bonusDiamonds: 1500 });
    expect([replayed.wallet, replayed.entitlements]).toEqual([after.wallet, after.entitlements]);
    expect(await f.repos.wallet.listLedger(g.userId)).toHaveLength(2);
  });
});
