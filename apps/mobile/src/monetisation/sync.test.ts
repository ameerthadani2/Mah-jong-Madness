import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import { productById } from './catalog';
import { MockStoreProvider, UnavailableStoreProvider, type PurchaseOutcome, type StoreProvider } from './providers';
import { devBuildProof } from './store-mode';
import { buyWithDiamonds, buyWithMoney, restorePurchases, waitForCredit, type WalletDeps } from './sync';
import { EMPTY_WALLET, mirrorMe, ownsCosmetic, totalDiamonds, type MeWallet } from './wallet';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');

/** A server whose /api/me answers from a list (the last answer repeats). */
function deps(answers: Array<Partial<MeWallet> | Error>, extra: Partial<WalletDeps> = {}) {
  const log: string[] = [];
  const queue = [...answers];
  const d: WalletDeps = {
    ensureUser: async () => {
      log.push('ensure');
      return 'u-1';
    },
    fetchMe: async () => {
      log.push('me');
      const a = queue.length > 1 ? queue.shift()! : queue[0];
      if (a instanceof Error) throw a;
      return { user: { id: 'u-1' }, wallet: { diamonds: 0, bonusDiamonds: 0 }, entitlements: [], serverNow: new Date(NOW).toISOString(), ...a };
    },
    spend: async (productId) => void log.push(`spend ${productId}`),
    now: () => NOW,
    sleep: async () => void log.push('sleep'),
    ...extra,
  };
  return { d, log };
}

function storeThat(outcome: PurchaseOutcome): StoreProvider & { log: string[] } {
  const log: string[] = [];
  return {
    kind: 'revenuecat',
    log,
    identify: async (id) => void log.push(`identify ${id}`),
    prices: async () => ({}),
    purchase: async (p) => {
      log.push(`purchase ${p.id}`);
      return outcome;
    },
    restore: async () => void log.push('restore'),
  };
}

describe('buying with money', () => {
  it('signs the store into the account, buys, then waits for /api/me to show the credit', async () => {
    const store = storeThat({ status: 'purchased' });
    const { d } = deps([{}, {}, { wallet: { diamonds: 600, bonusDiamonds: 0 } }]);
    const r = await buyWithMoney(productById('diamonds.600')!, EMPTY_WALLET, store, d);
    expect(store.log).toEqual(['identify u-1', 'purchase diamonds.600']);
    expect(r.status).toBe('credited');
    expect(totalDiamonds(r.wallet)).toBe(600);
  });

  it('a purchase the server has not seen yet stays pending and grants nothing on the device', async () => {
    const { d } = deps([{}]);
    const r = await buyWithMoney(productById('fourwinds.month')!, EMPTY_WALLET, storeThat({ status: 'purchased' }), d);
    expect(r.status).toBe('pending');
    expect(r.wallet.entitlements).toEqual([]);
  });

  it('with no store nothing is attempted or granted', async () => {
    const { d, log } = deps([{}]);
    const r = await buyWithMoney(productById('diamonds.60')!, EMPTY_WALLET, new UnavailableStoreProvider('no_key'), d);
    expect(r).toEqual({ status: 'unavailable', wallet: EMPTY_WALLET });
    expect(log).toEqual([]);
  });

  it('cancel and failure leave the wallet as the server has it', async () => {
    const { d } = deps([{ wallet: { diamonds: 5, bonusDiamonds: 0 } }]);
    expect((await buyWithMoney(productById('diamonds.60')!, EMPTY_WALLET, storeThat({ status: 'cancelled' }), d)).status).toBe('cancelled');
    const failed = await buyWithMoney(productById('diamonds.60')!, EMPTY_WALLET, storeThat({ status: 'failed', error: new Error('x') }), d);
    expect(failed.status).toBe('failed');
    expect(totalDiamonds(failed.wallet)).toBe(5);
  });

  it('no account (offline) means no purchase', async () => {
    const store = storeThat({ status: 'purchased' });
    const { d } = deps([{}], { ensureUser: async () => Promise.reject(new ApiError('down', 'auth_unreachable')) });
    const r = await buyWithMoney(productById('diamonds.60')!, EMPTY_WALLET, store, d);
    expect(r.status).toBe('failed');
    expect(store.log).toEqual([]);
  });

  it('the development mock grants locally', async () => {
    const { d } = deps([{}]);
    const r = await buyWithMoney(productById('theme.bamboo')!, EMPTY_WALLET, new MockStoreProvider(devBuildProof(true)!), d);
    expect(r.status).toBe('credited');
    expect(ownsCosmetic(r.wallet, 'bamboo')).toBe(true);
    expect(r.wallet.mock).toBe(true);
  });

  it('waitForCredit keeps polling through a failed read', async () => {
    const before = mirrorMe(EMPTY_WALLET, { user: { id: 'u-1' }, wallet: { diamonds: 0, bonusDiamonds: 0 }, entitlements: [], serverNow: new Date(NOW).toISOString() }, NOW);
    const { d } = deps([new Error('blip'), { cosmetics: ['jade'] }]);
    expect((await waitForCredit(before, 'theme.jade', d, [1, 1, 1])).credited).toBe(true);
  });
});

describe('spending diamonds', () => {
  it('the server debits and grants; the app mirrors /api/me', async () => {
    const { d, log } = deps([{ wallet: { diamonds: 120, bonusDiamonds: 0 }, cosmetics: ['jade'] }]);
    const r = await buyWithDiamonds(productById('theme.jade')!, EMPTY_WALLET, d);
    expect(log).toEqual(['ensure', 'spend theme.jade', 'me']);
    expect(r.status).toBe('credited');
    expect(ownsCosmetic(r.wallet, 'jade')).toBe(true);
  });

  it('too few diamonds on the server says how many more are needed', async () => {
    const { d } = deps([{ wallet: { diamonds: 100, bonusDiamonds: 20 } }], { spend: async () => Promise.reject(new ApiError('Not enough diamonds', 'insufficient', 409)) });
    const r = await buyWithDiamonds(productById('theme.jade')!, EMPTY_WALLET, d);
    expect(r.status === 'need_diamonds' && r.short).toBe(280);
  });

  it('a product with no diamond price is refused without a request', async () => {
    const { d, log } = deps([{}]);
    expect((await buyWithDiamonds(productById('coach.gold.month')!, EMPTY_WALLET, d)).status).toBe('failed');
    expect(log).toEqual([]);
  });
});

describe('restore purchases', () => {
  it('asks the store, then re-reads the server', async () => {
    const store = storeThat({ status: 'purchased' });
    const { d } = deps([{ entitlements: [{ entitlement: 'coach.gold', expiresAt: '2027-01-01T00:00:00.000Z' }] }]);
    const r = await restorePurchases(EMPTY_WALLET, store, d);
    expect(store.log).toEqual(['identify u-1', 'restore']);
    expect(r.ok && r.wallet.entitlements.map((e) => e.entitlement)).toEqual(['coach.gold']);
  });

  it('asks the server to read the store for anything a webhook missed, and still restores if that fails', async () => {
    const store = storeThat({ status: 'purchased' });
    const synced: string[] = [];
    const { d } = deps([{ wallet: { diamonds: 300, bonusDiamonds: 0 } }], { syncStore: async () => void synced.push('sync') });
    const r = await restorePurchases(EMPTY_WALLET, store, d);
    expect(synced).toEqual(['sync']);
    expect(r.ok && totalDiamonds(r.wallet)).toBe(300);
    const failing = deps([{}], { syncStore: async () => Promise.reject(new Error('502')) });
    expect((await restorePurchases(EMPTY_WALLET, store, failing.d)).ok).toBe(true);
  });

  it('reports a store that cannot restore', async () => {
    const { d } = deps([{}]);
    expect((await restorePurchases(EMPTY_WALLET, new UnavailableStoreProvider('no_key'), d)).ok).toBe(false);
  });
});
