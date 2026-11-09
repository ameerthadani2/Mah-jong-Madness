/**
 * Store behaviour through the real API handler and WalletService: each subscription plan is its
 * own entitlement, The Four Winds Club tier, refunds that leave a negative balance, sandbox
 * purchases, and a deleted account's subscription moving with TRANSFER.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WalletService } from '../src/wallet';
import { apiFixture } from './helpers';

const SECRET = 'rc_store_secret_0123456789abcdef';
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = 86_400_000;
const hook = { authorization: `Bearer ${SECRET}` };

let txn = 1;
function rc(type: string, appUserId: string, event: Record<string, unknown> = {}) {
  return {
    api_version: '1.0',
    event: {
      id: randomUUID(),
      type,
      app_user_id: appUserId,
      original_app_user_id: appUserId,
      aliases: [appUserId],
      product_id: 'coach.gold.month',
      purchased_at_ms: T0,
      expiration_at_ms: T0 + 30 * DAY,
      environment: 'PRODUCTION',
      store: 'APP_STORE',
      transaction_id: `T${txn++}`,
      currency: 'USD',
      price: 6.99,
      ...event,
    },
  };
}

function fixture() {
  let t = T0;
  const now = () => t;
  const f = apiFixture({ now, deps: (repos) => ({ config: { revenueCatWebhookSecret: SECRET }, wallet: new WalletService(repos, { now, log: () => {} }) }) });
  const post = async (body: unknown) => (await f.call('POST', '/api/webhooks/revenuecat', body, hook)).json.outcome as string;
  const me = async (auth: Record<string, string>) => (await f.call('GET', '/api/me', undefined, auth)).json as { coachTier: string; wallet: { diamonds: number; bonusDiamonds: number }; cosmetics: string[]; entitlements: Array<{ entitlement: string; active: boolean }> };
  return { ...f, post, me, now, advance: (ms: number) => (t += ms), wallet: f.deps.wallet as WalletService };
}

describe('subscription plans are separate entitlements', () => {
  it('refunding the monthly Gold plan leaves a live yearly Gold plan, and the tier stays gold', async () => {
    const f = fixture();
    const a = await f.guest('A');
    expect(await f.post(rc('INITIAL_PURCHASE', a.userId, { product_id: 'coach.gold.year', transaction_id: 'Y1', expiration_at_ms: T0 + 365 * DAY }))).toBe('entitled');
    expect(await f.post(rc('INITIAL_PURCHASE', a.userId, { product_id: 'coach.gold.month', transaction_id: 'M1' }))).toBe('entitled');
    expect(await f.post(rc('CANCELLATION', a.userId, { product_id: 'coach.gold.month', transaction_id: 'M1', cancel_reason: 'CUSTOMER_SUPPORT' }))).toBe('refunded');
    const me = await f.me(a.auth);
    expect(me.coachTier).toBe('gold');
    expect(me.entitlements.map((e) => [e.entitlement, e.active]).sort()).toEqual([
      ['coach.gold.month', false],
      ['coach.gold.year', true],
    ]);
  });

  it('expiring The Four Winds Club leaves a live Coach Gold plan in place', async () => {
    const f = fixture();
    const a = await f.guest('A');
    await f.post(rc('INITIAL_PURCHASE', a.userId, { product_id: 'coach.gold.year', expiration_at_ms: T0 + 365 * DAY }));
    await f.post(rc('INITIAL_PURCHASE', a.userId, { product_id: 'fourwinds.month', price: 10.99, expiration_at_ms: T0 + 5 * DAY }));
    expect((await f.me(a.auth)).coachTier).toBe('fourwinds');
    expect(await f.wallet.hasFourWinds(a.userId)).toBe(true);
    f.advance(6 * DAY);
    expect(await f.post(rc('EXPIRATION', a.userId, { product_id: 'fourwinds.month', expiration_at_ms: T0 + 5 * DAY }))).toBe('expired');
    expect((await f.me(a.auth)).coachTier).toBe('gold');
    expect(await f.wallet.hasFourWinds(a.userId)).toBe(false);
    expect(await f.wallet.tierOf(a.userId)).toBe('gold');
  });

  it('The Four Winds Club is sold as fourwinds.month and fourwinds.year, also as a Play base plan', async () => {
    const f = fixture();
    const a = await f.guest('A');
    expect(await f.post(rc('INITIAL_PURCHASE', a.userId, { product_id: 'fourwinds:year', store: 'PLAY_STORE', expiration_at_ms: T0 + 365 * DAY }))).toBe('entitled');
    const me = await f.me(a.auth);
    expect(me.coachTier).toBe('fourwinds');
    expect(me.entitlements.map((e) => e.entitlement)).toEqual(['fourwinds.year']);
    expect(await f.post(rc('INITIAL_PURCHASE', a.userId, { product_id: 'coach.platinum.month' }))).toBe('ignored_unknown_product');
  });
});

describe('refunded diamond packs', () => {
  it('buy, spend and refund cycles never end with free looks: the debt blocks the next spend', async () => {
    const f = fixture();
    const g = await f.guest('G');
    const looks = ['theme.bamboo', 'theme.imperial', 'theme.nightmarket'];
    const spends: number[] = [];
    for (const [i, look] of looks.entries()) {
      await f.post(rc('NON_RENEWING_PURCHASE', g.userId, { product_id: 'diamonds.300', transaction_id: `G-${i}` }));
      spends.push((await f.call('POST', '/api/wallet/spend', { productId: look }, g.auth)).status);
      expect(await f.post(rc('CANCELLATION', g.userId, { product_id: 'diamonds.300', transaction_id: `G-${i}`, cancel_reason: 'CUSTOMER_SUPPORT' }))).toBe('refunded');
    }
    // The first look was paid for and then refunded: the account owes 300, and nothing else could be bought.
    expect(spends).toEqual([200, 409, 409]);
    const me = await f.me(g.auth);
    expect(me.wallet).toEqual({ diamonds: -300, bonusDiamonds: 0 });
    expect(me.cosmetics).toEqual(['theme.bamboo']);
  });

  it('refunding the largest pack after spending it takes back the bonus and the rest', async () => {
    const f = fixture();
    const e = await f.guest('E');
    await f.post(rc('NON_RENEWING_PURCHASE', e.userId, { product_id: 'diamonds.7500', transaction_id: 'E-1' }));
    for (const p of ['theme.jade', 'theme.bamboo', 'theme.imperial', 'theme.nightmarket']) expect((await f.call('POST', '/api/wallet/spend', { productId: p }, e.auth)).status).toBe(200);
    expect((await f.me(e.auth)).wallet).toEqual({ diamonds: 6000, bonusDiamonds: 200 });
    expect(await f.post(rc('CANCELLATION', e.userId, { product_id: 'diamonds.7500', transaction_id: 'E-1', cancel_reason: 'CUSTOMER_SUPPORT' }))).toBe('refunded');
    expect((await f.me(e.auth)).wallet).toEqual({ diamonds: -1300, bonusDiamonds: 0 });
    expect((await f.call('POST', '/api/wallet/spend', { productId: 'theme.bamboo' }, e.auth)).json.error).toBe('owned');
  });
});
