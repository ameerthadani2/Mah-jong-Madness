/**
 * Store abstraction. The app talks to `StoreProvider`; today it is a mock that
 * grants purchases instantly so the flows can be built and tested. Swap in a
 * RevenueCat / expo-iap implementation behind the same interface for release.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { productById, type Product } from './catalog';

export interface Wallet {
  diamonds: number;
  owned: string[];
  subscription: { productId: string; until: number } | null;
  clubTier: { productId: string; until: number } | null;
  history: Array<{ productId: string; at: number; via: 'money' | 'diamonds' | 'grant' }>;
}

export const EMPTY_WALLET: Wallet = { diamonds: 0, owned: [], subscription: null, clubTier: null, history: [] };

export interface PurchaseResult {
  ok: boolean;
  message?: string;
  wallet: Wallet;
}

export interface StoreProvider {
  /** Localised price strings keyed by product id, when the store SDK is available. */
  prices(): Promise<Record<string, string>>;
  purchase(product: Product, wallet: Wallet): Promise<PurchaseResult>;
  restore(wallet: Wallet): Promise<Wallet>;
}

const KEY = 'mjm.wallet';

export async function loadWallet(): Promise<Wallet> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? { ...EMPTY_WALLET, ...(JSON.parse(raw) as Partial<Wallet>) } : EMPTY_WALLET;
  } catch {
    return EMPTY_WALLET;
  }
}

export async function saveWallet(w: Wallet): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    /* best effort */
  }
}

export function applyGrant(wallet: Wallet, product: Product, via: Wallet['history'][number]['via'], now = Date.now()): Wallet {
  const next: Wallet = { ...wallet, owned: [...wallet.owned], history: [...wallet.history, { productId: product.id, at: now, via }] };
  switch (product.kind) {
    case 'diamonds':
      next.diamonds += product.diamonds ?? 0;
      break;
    case 'cosmetic':
      if (product.unlocks && !next.owned.includes(product.unlocks)) next.owned.push(product.unlocks);
      break;
    case 'subscription': {
      const base = Math.max(now, wallet.subscription?.until ?? 0);
      next.subscription = { productId: product.id, until: base + (product.period === 'year' ? 365 : 30) * 86400_000 };
      break;
    }
    case 'club': {
      const base = Math.max(now, wallet.clubTier?.until ?? 0);
      next.clubTier = { productId: product.id, until: base + 30 * 86400_000 };
      break;
    }
  }
  return next;
}

/** Spend diamonds on an item that has a diamond price. */
export function buyWithDiamonds(wallet: Wallet, product: Product): PurchaseResult {
  if (!product.diamondPrice) return { ok: false, message: 'Not purchasable with diamonds', wallet };
  if (wallet.diamonds < product.diamondPrice) return { ok: false, message: `Need ${product.diamondPrice - wallet.diamonds} more diamonds`, wallet };
  const next = applyGrant({ ...wallet, diamonds: wallet.diamonds - product.diamondPrice }, product, 'diamonds');
  return { ok: true, wallet: next };
}

export function hasCoachPro(wallet: Wallet, now = Date.now()): boolean {
  return !!wallet.subscription && wallet.subscription.until > now;
}

export function ownsCosmetic(wallet: Wallet, unlockId: string): boolean {
  return wallet.owned.includes(unlockId);
}

/** Mock store: every purchase succeeds immediately. Replace for release. */
export class MockStoreProvider implements StoreProvider {
  async prices(): Promise<Record<string, string>> {
    return {};
  }
  async purchase(product: Product, wallet: Wallet): Promise<PurchaseResult> {
    await new Promise((r) => setTimeout(r, 350));
    return { ok: true, wallet: applyGrant(wallet, product, 'money') };
  }
  async restore(wallet: Wallet): Promise<Wallet> {
    return wallet;
  }
}

export const store: StoreProvider = new MockStoreProvider();

export function restoreProduct(id: string): Product | undefined {
  return productById(id);
}
