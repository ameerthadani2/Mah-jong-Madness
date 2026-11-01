/**
 * Store abstraction. The app talks to `StoreProvider`; today it is a mock that
 * grants purchases instantly so the flows can be built and tested. Swap in a
 * RevenueCat / expo-iap implementation behind the same interface for release.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { FREE_METERS, productById, type CoachTier, type Product } from './catalog';

export interface Wallet {
  /** Purchased diamonds never expire (store policy). */
  diamonds: number;
  /** Free/bonus diamonds live on a separate ledger that may expire. */
  bonusDiamonds: number;
  owned: string[];
  subscription: { productId: string; tier: CoachTier; until: number } | null;
  vip: { productId: string; until: number } | null;
  clubTier: { productId: string; capacity: number; until: number } | null;
  history: Array<{ productId: string; at: number; via: 'money' | 'diamonds' | 'grant' }>;
  /** Daily meters for the free tier. */
  meters: { day: string; reviews: number; rush: number };
}

export const EMPTY_WALLET: Wallet = { diamonds: 0, bonusDiamonds: 0, owned: [], subscription: null, vip: null, clubTier: null, history: [], meters: { day: '', reviews: 0, rush: 0 } };

export interface PurchaseResult {
  ok: boolean;
  message?: string;
  wallet: Wallet;
}

export interface StoreProvider {
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

const DAY = 86400_000;

export function applyGrant(wallet: Wallet, product: Product, via: Wallet['history'][number]['via'], now = Date.now()): Wallet {
  const next: Wallet = { ...wallet, owned: [...wallet.owned], history: [...wallet.history, { productId: product.id, at: now, via }] };
  switch (product.kind) {
    case 'diamonds':
      if (via === 'grant') next.bonusDiamonds += product.diamonds ?? 0;
      else next.diamonds += product.diamonds ?? 0;
      break;
    case 'cosmetic':
      if (product.unlocks && !next.owned.includes(product.unlocks)) next.owned.push(product.unlocks);
      break;
    case 'subscription': {
      const base = Math.max(now, wallet.subscription?.until ?? 0);
      next.subscription = { productId: product.id, tier: product.tier ?? 'gold', until: base + (product.period === 'year' ? 365 : 30) * DAY };
      break;
    }
    case 'vip': {
      const base = Math.max(now, wallet.vip?.until ?? 0);
      next.vip = { productId: product.id, until: base + (product.days ?? 30) * DAY };
      break;
    }
    case 'club': {
      const base = Math.max(now, wallet.clubTier?.until ?? 0);
      next.clubTier = { productId: product.id, capacity: product.capacity ?? 100, until: base + 30 * DAY };
      break;
    }
  }
  return next;
}

/** Spend diamonds (bonus ledger first) on an item that has a diamond price. */
export function buyWithDiamonds(wallet: Wallet, product: Product): PurchaseResult {
  if (!product.diamondPrice) return { ok: false, message: 'Not purchasable with diamonds', wallet };
  const total = wallet.diamonds + wallet.bonusDiamonds;
  if (total < product.diamondPrice) return { ok: false, message: `Need ${product.diamondPrice - total} more diamonds`, wallet };
  const fromBonus = Math.min(wallet.bonusDiamonds, product.diamondPrice);
  const next = applyGrant({ ...wallet, bonusDiamonds: wallet.bonusDiamonds - fromBonus, diamonds: wallet.diamonds - (product.diamondPrice - fromBonus) }, product, 'diamonds');
  return { ok: true, wallet: next };
}

export function coachTier(wallet: Wallet, now = Date.now()): CoachTier {
  return wallet.subscription && wallet.subscription.until > now ? wallet.subscription.tier : 'free';
}

const TIER_RANK: Record<CoachTier, number> = { free: 0, gold: 1, platinum: 2, diamond: 3 };

export function hasTier(wallet: Wallet, tier: CoachTier, now = Date.now()): boolean {
  return TIER_RANK[coachTier(wallet, now)] >= TIER_RANK[tier];
}

export function hasVip(wallet: Wallet, now = Date.now()): boolean {
  return !!wallet.vip && wallet.vip.until > now;
}

export function ownsCosmetic(wallet: Wallet, unlockId: string, now = Date.now()): boolean {
  return wallet.owned.includes(unlockId) || (unlockId.startsWith('nightmarket') || unlockId.startsWith('bamboo') || unlockId.startsWith('imperial') ? hasVip(wallet, now) : false);
}

export function totalDiamonds(wallet: Wallet): number {
  return wallet.diamonds + wallet.bonusDiamonds;
}

function localDayKey(d = new Date()): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function metersFor(wallet: Wallet, now = new Date()): Wallet['meters'] {
  const day = localDayKey(now);
  return wallet.meters.day === day ? wallet.meters : { day, reviews: 0, rush: 0 };
}

/** Free-tier meters (chess.com style: full product, limited count, reset at local midnight). */
export function canUse(wallet: Wallet, meter: 'reviews' | 'rush', now = new Date()): { ok: boolean; left: number; limit: number | null } {
  if (meter === 'reviews' && hasTier(wallet, 'platinum', now.getTime())) return { ok: true, left: Infinity, limit: null };
  if (meter === 'rush' && hasTier(wallet, 'gold', now.getTime())) return { ok: true, left: Infinity, limit: null };
  const limit = (meter === 'reviews' ? FREE_METERS.reviewsPerDay : FREE_METERS.rushPerDay) + (meter === 'reviews' && hasVip(wallet, now.getTime()) ? 1 : 0);
  const m = metersFor(wallet, now);
  const used = m[meter];
  return { ok: used < limit, left: Math.max(0, limit - used), limit };
}

export function consume(wallet: Wallet, meter: 'reviews' | 'rush', now = new Date()): Wallet {
  const m = metersFor(wallet, now);
  return { ...wallet, meters: { ...m, [meter]: m[meter] + 1 } };
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
