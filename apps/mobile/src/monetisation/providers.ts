/**
 * Store providers behind one interface. The provider only talks to the platform store:
 * it never decides what the player owns. After a purchase the server hears from the store
 * (RevenueCat webhook) and the app reads the result from `GET /api/me` (see ./sync.ts).
 *
 * Pure TypeScript: the RevenueCat SDK is injected as `PurchasesLike`, so the provider is
 * tested with a fake (./revenuecat-native.ts adapts the real `react-native-purchases`).
 */
import { ALL_PRODUCTS, productByStoreId, type Product } from './catalog';
import type { DevBuildProof, UnavailableReason } from './store-mode';
import type { Wallet } from './wallet';

export type PurchaseOutcome =
  | { status: 'purchased'; /** Mock store only: the local grant to apply. */ grant?: (w: Wallet) => Wallet }
  | { status: 'cancelled' }
  | { status: 'failed'; error: unknown }
  | { status: 'unavailable' };

export interface StoreProvider {
  readonly kind: 'revenuecat' | 'mock' | 'unavailable';
  /** Why there is no store (only for `unavailable`). */
  readonly reason?: UnavailableReason;
  /** Tie store purchases to the server account (RevenueCat `logIn`), so webhooks credit it. */
  identify(userId: string): Promise<void>;
  /** Localised price strings keyed by catalogue product id; products the store lacks are absent. */
  prices(): Promise<Record<string, string>>;
  purchase(product: Product): Promise<PurchaseOutcome>;
  /** Ask the platform store to re-send this account's purchases (the server re-grants them). */
  restore(): Promise<void>;
}

/** A store failure with a code the Shop translates. */
export class StoreError extends Error {
  constructor(
    readonly code: 'store_not_signed_in' | 'store_product_missing' | 'store_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

/** No store on this build: nothing is sold and nothing is granted. */
export class UnavailableStoreProvider implements StoreProvider {
  readonly kind = 'unavailable' as const;
  constructor(readonly reason: UnavailableReason) {}
  async identify(): Promise<void> {}
  async prices(): Promise<Record<string, string>> {
    return {};
  }
  async purchase(): Promise<PurchaseOutcome> {
    return { status: 'unavailable' };
  }
  async restore(): Promise<void> {
    throw new StoreError('store_unavailable', 'The store is not available on this build');
  }
}

/** Grants a mock purchase into the local copy (development builds only; the next sync replaces it). */
export function mockGrant(wallet: Wallet, product: Product): Wallet {
  const next: Wallet = { ...wallet, mock: true, cosmetics: [...wallet.cosmetics], entitlements: [...wallet.entitlements] };
  if (product.kind === 'diamonds') next.diamonds += product.diamonds ?? 0;
  else if (product.kind === 'cosmetic' && product.unlocks && !next.cosmetics.includes(product.unlocks)) next.cosmetics.push(product.unlocks);
  else if (product.kind === 'subscription' && product.tier) {
    const days = product.period === 'year' ? 365 : 30;
    next.entitlements.push({ entitlement: `coach.${product.tier}`, expiresAt: Date.now() + days * 86400_000 });
  }
  return next;
}

/** Development builds only (see ./store-mode.ts): every purchase succeeds at once, free. */
export class MockStoreProvider implements StoreProvider {
  readonly kind = 'mock' as const;
  constructor(_proof: DevBuildProof) {}
  async identify(): Promise<void> {}
  async prices(): Promise<Record<string, string>> {
    return Object.fromEntries(ALL_PRODUCTS.map((p) => [p.id, `$${p.priceUsd.toFixed(2)}`]));
  }
  async purchase(product: Product): Promise<PurchaseOutcome> {
    await new Promise((r) => setTimeout(r, 250));
    return { status: 'purchased', grant: (w) => mockGrant(w, product) };
  }
  async restore(): Promise<void> {}
}

/** The slice of `react-native-purchases` the app uses. */
export interface StoreProductLike {
  identifier: string;
  priceString: string;
}

export interface PurchasesLike {
  configure(options: { apiKey: string; appUserID?: string | null }): void;
  logIn(appUserID: string): Promise<unknown>;
  getProducts(ids: string[], category: 'SUBSCRIPTION' | 'NON_SUBSCRIPTION'): Promise<StoreProductLike[]>;
  purchaseStoreProduct(product: StoreProductLike): Promise<unknown>;
  restorePurchases(): Promise<unknown>;
}

/** RevenueCat reports a cancelled sheet with `userCancelled` or error code "1". */
export function isStoreCancel(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const r = e as { userCancelled?: unknown; code?: unknown };
  return r.userCancelled === true || r.code === '1' || r.code === 1;
}

export class RevenueCatStoreProvider implements StoreProvider {
  readonly kind = 'revenuecat' as const;
  private configured = false;
  private userId: string | null = null;
  private products = new Map<string, StoreProductLike>();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly sdk: PurchasesLike,
    private readonly apiKey: string,
  ) {}

  private configure(userId: string | null): void {
    if (this.configured) return;
    this.sdk.configure({ apiKey: this.apiKey, appUserID: userId });
    this.configured = true;
    this.userId = userId;
  }

  async identify(userId: string): Promise<void> {
    if (!this.configured) return this.configure(userId);
    if (this.userId === userId) return;
    await this.sdk.logIn(userId);
    this.userId = userId;
  }

  private load(): Promise<void> {
    this.loading ??= (async () => {
      this.configure(this.userId);
      const subs = ALL_PRODUCTS.filter((p) => p.kind === 'subscription').map((p) => p.storeId);
      const other = ALL_PRODUCTS.filter((p) => p.kind !== 'subscription').map((p) => p.storeId);
      const found = await Promise.all([this.sdk.getProducts(subs, 'SUBSCRIPTION'), this.sdk.getProducts(other, 'NON_SUBSCRIPTION')]);
      for (const sp of found.flat()) {
        const p = productByStoreId(sp.identifier);
        if (p && typeof sp.priceString === 'string' && sp.priceString) this.products.set(p.id, sp);
      }
    })().catch((e) => {
      this.loading = null;
      throw e;
    });
    return this.loading;
  }

  async prices(): Promise<Record<string, string>> {
    await this.load();
    return Object.fromEntries([...this.products].map(([id, sp]) => [id, sp.priceString]));
  }

  async purchase(product: Product): Promise<PurchaseOutcome> {
    if (!this.userId) return { status: 'failed', error: new StoreError('store_not_signed_in', 'Sign in before buying so the purchase reaches your account') };
    try {
      await this.load();
    } catch (e) {
      return { status: 'failed', error: e };
    }
    const sp = this.products.get(product.id);
    if (!sp) return { status: 'failed', error: new StoreError('store_product_missing', `${product.storeId} is not on sale in this store`) };
    try {
      await this.sdk.purchaseStoreProduct(sp);
      return { status: 'purchased' };
    } catch (e) {
      return isStoreCancel(e) ? { status: 'cancelled' } : { status: 'failed', error: e };
    }
  }

  async restore(): Promise<void> {
    if (!this.userId) throw new StoreError('store_not_signed_in', 'Sign in before restoring purchases');
    await this.sdk.restorePurchases();
  }
}
