import { describe, expect, it } from 'vitest';
import { productById } from './catalog';
import { isStoreCancel, mockGrant, RevenueCatStoreProvider, StoreError, UnavailableStoreProvider, type PurchasesLike, type StoreProductLike } from './providers';
import { EMPTY_WALLET, hasTier, ownsCosmetic, totalDiamonds } from './wallet';

function fakeSdk(catalogue: StoreProductLike[], opts: { purchaseError?: unknown } = {}) {
  const calls: string[] = [];
  const sdk: PurchasesLike = {
    configure: (o) => void calls.push(`configure ${o.apiKey} ${o.appUserID ?? 'anon'}`),
    logIn: async (id) => void calls.push(`logIn ${id}`),
    getProducts: async (ids, category) => {
      calls.push(`getProducts ${category} ${ids.length}`);
      return catalogue.filter((p) => ids.includes(p.identifier.split(':')[0]));
    },
    purchaseStoreProduct: async (p) => {
      calls.push(`purchase ${p.identifier}`);
      if (opts.purchaseError) throw opts.purchaseError;
    },
    restorePurchases: async () => void calls.push('restore'),
  };
  return { sdk, calls };
}

const STORE: StoreProductLike[] = [
  { identifier: 'diamonds.600', priceString: 'NT$330' },
  // Google Play reports a subscription with its base plan.
  { identifier: 'coach.gold:month', priceString: 'NT$230' },
  { identifier: 'coach.platinum.year', priceString: 'NT$2,690' },
  { identifier: 'someone.elses.product', priceString: '$1' },
];

describe('RevenueCat store provider', () => {
  it('configures with the key and the server user id, and logs in when the account changes', async () => {
    const { sdk, calls } = fakeSdk(STORE);
    const store = new RevenueCatStoreProvider(sdk, 'appl_key');
    await store.identify('u-1');
    await store.identify('u-1');
    await store.identify('u-2');
    expect(calls).toEqual(['configure appl_key u-1', 'logIn u-2']);
  });

  it('prices come only from the store, keyed by catalogue id, for subscriptions and one-off products', async () => {
    const { sdk, calls } = fakeSdk(STORE);
    const store = new RevenueCatStoreProvider(sdk, 'k');
    expect(await store.prices()).toEqual({ 'diamonds.600': 'NT$330', 'coach.gold.month': 'NT$230', 'coach.platinum.year': 'NT$2,690' });
    expect(calls).toEqual(['configure k anon', 'getProducts SUBSCRIPTION 6', 'getProducts NON_SUBSCRIPTION 6']);
    // Logged in afterwards: the anonymous configure is followed by logIn, so purchases reach the account.
    await store.identify('u-1');
    expect(calls.at(-1)).toBe('logIn u-1');
  });

  it('will not sell before the account is known, so a webhook can always credit it', async () => {
    const { sdk, calls } = fakeSdk(STORE);
    const store = new RevenueCatStoreProvider(sdk, 'k');
    const r = await store.purchase(productById('diamonds.600')!);
    expect(r.status).toBe('failed');
    expect(r.status === 'failed' && r.error instanceof StoreError && r.error.code).toBe('store_not_signed_in');
    expect(calls.filter((c) => c.startsWith('purchase'))).toEqual([]);
  });

  it('buys the store product and grants nothing itself', async () => {
    const { sdk, calls } = fakeSdk(STORE);
    const store = new RevenueCatStoreProvider(sdk, 'k');
    await store.identify('u-1');
    const r = await store.purchase(productById('coach.gold.month')!);
    expect(r).toEqual({ status: 'purchased' });
    expect(calls).toContain('purchase coach.gold:month');
  });

  it('a product the store does not sell is reported, not bought', async () => {
    const { sdk } = fakeSdk(STORE);
    const store = new RevenueCatStoreProvider(sdk, 'k');
    await store.identify('u-1');
    const r = await store.purchase(productById('diamonds.60')!);
    expect(r.status === 'failed' && (r.error as StoreError).code).toBe('store_product_missing');
  });

  it('a cancelled sheet is a cancel, any other failure a failure', async () => {
    const cancel = new RevenueCatStoreProvider(fakeSdk(STORE, { purchaseError: { code: '1', userCancelled: true } }).sdk, 'k');
    await cancel.identify('u');
    expect(await cancel.purchase(productById('diamonds.600')!)).toEqual({ status: 'cancelled' });
    const broken = new RevenueCatStoreProvider(fakeSdk(STORE, { purchaseError: { code: '2', message: 'store problem' } }).sdk, 'k');
    await broken.identify('u');
    expect((await broken.purchase(productById('diamonds.600')!)).status).toBe('failed');
    expect(isStoreCancel({ code: 1 })).toBe(true);
    expect(isStoreCancel(new Error('x'))).toBe(false);
  });

  it('restore asks the store to re-send purchases for the signed-in account', async () => {
    const { sdk, calls } = fakeSdk(STORE);
    const store = new RevenueCatStoreProvider(sdk, 'k');
    await expect(store.restore()).rejects.toBeInstanceOf(StoreError);
    await store.identify('u-1');
    await store.restore();
    expect(calls.at(-1)).toBe('restore');
  });
});

describe('unavailable store', () => {
  it('sells nothing and grants nothing', async () => {
    const store = new UnavailableStoreProvider('no_key');
    expect(await store.prices()).toEqual({});
    expect(await store.purchase()).toEqual({ status: 'unavailable' });
    await expect(store.restore()).rejects.toBeInstanceOf(StoreError);
  });
});

describe('mock grant (development builds)', () => {
  it('grants locally and marks the copy as mock', () => {
    const w1 = mockGrant(EMPTY_WALLET, productById('diamonds.300')!);
    expect(totalDiamonds(w1)).toBe(300);
    expect(w1.mock).toBe(true);
    expect(ownsCosmetic(mockGrant(w1, productById('theme.bamboo')!), 'bamboo')).toBe(true);
    expect(hasTier(mockGrant(w1, productById('coach.platinum.month')!), 'platinum', Date.now())).toBe(true);
  });
});
