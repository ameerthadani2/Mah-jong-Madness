/**
 * The app's copy of the server wallet. The server is the source of truth (docs/API.md,
 * "Wallet"): balances, entitlements and owned cosmetics come only from `GET /api/me`
 * (`mirrorMe`), and the app keeps the last copy so it can show them offline. Editing the
 * cached copy changes nothing the server decides; the next sync overwrites it.
 *
 * Time-limited entitlements and the free-tier meters are judged by the server's clock
 * once the app has seen it: `trustedNow` is device time corrected by the last observed
 * offset, and never earlier than the latest server time seen, so winding the device clock
 * back does not revive an expired subscription or reset today's meters.
 *
 * Pure TypeScript (no React Native), so it is unit-tested directly.
 */
import type { BotSkill } from '@mjm/engine';
import { COSMETICS, FREE_METERS, productById, tierOfEntitlement, type CoachTier } from './catalog';

export interface WalletEntitlement {
  entitlement: string;
  /** Epoch ms; null means it does not expire. */
  expiresAt: number | null;
}

export interface Wallet {
  v: 2;
  /** The server account this copy belongs to (null before the first sync). */
  userId: string | null;
  /** Purchased diamonds (never expire). */
  diamonds: number;
  /** Free and bonus diamonds (separate ledger; spent first). */
  bonusDiamonds: number;
  entitlements: WalletEntitlement[];
  /** Owned cosmetic unlock ids (table theme ids). */
  cosmetics: string[];
  /** Server time minus device time at the last sync, and the latest server time seen (epoch ms). */
  clock: { offsetMs: number; floor: number };
  /** Device time of the last successful sync; null when the server has never been seen. */
  syncedAt: number | null;
  /** Free-tier usage today (counted on this device). */
  meters: { day: string; reviews: number; rush: number };
  /** Development builds' mock store only: grants made locally that the next sync replaces. */
  mock?: boolean;
}

export const EMPTY_WALLET: Wallet = {
  v: 2,
  userId: null,
  diamonds: 0,
  bonusDiamonds: 0,
  entitlements: [],
  cosmetics: [],
  clock: { offsetMs: 0, floor: 0 },
  syncedAt: null,
  meters: { day: '', reviews: 0, rush: 0 },
};

/** `GET /api/me` as the wallet reads it (the extra `cosmetics` list is optional). */
export interface MeWallet {
  user: { id: string };
  wallet: { diamonds: number; bonusDiamonds: number };
  entitlements: Array<{ entitlement: string; expiresAt: string | null }>;
  cosmetics?: unknown;
  serverNow: string;
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

const COSMETIC_UNLOCKS = new Set(COSMETICS.map((p) => p.unlocks).filter((u): u is string => !!u));

/**
 * The cosmetic a server name refers to: a theme id (`jade`), its product id (`theme.jade`),
 * or either with a `cosmetic.` prefix. Unknown names are ignored.
 */
export function cosmeticFor(name: string): string | null {
  const bare = name.startsWith('cosmetic.') ? name.slice('cosmetic.'.length) : name;
  if (COSMETIC_UNLOCKS.has(bare)) return bare;
  const p = productById(bare);
  return p?.kind === 'cosmetic' && p.unlocks ? p.unlocks : null;
}

function parseTime(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Replace everything the server decides with what `/api/me` says; keep this device's meters. */
export function mirrorMe(wallet: Wallet, me: MeWallet, deviceNow: number): Wallet {
  const serverMs = parseTime(me.serverNow);
  const clock = serverMs === null ? wallet.clock : { offsetMs: serverMs - deviceNow, floor: Math.max(wallet.clock.floor, serverMs) };
  const entitlements: WalletEntitlement[] = [];
  for (const e of Array.isArray(me.entitlements) ? me.entitlements : []) {
    if (!e || typeof e.entitlement !== 'string' || !e.entitlement) continue;
    if (e.expiresAt === null) entitlements.push({ entitlement: e.entitlement, expiresAt: null });
    else {
      const at = parseTime(e.expiresAt);
      // An unreadable expiry is treated as already expired rather than as forever.
      if (at !== null) entitlements.push({ entitlement: e.entitlement, expiresAt: at });
    }
  }
  const now = Math.max(deviceNow + clock.offsetMs, clock.floor);
  const cosmetics = new Set<string>();
  for (const c of Array.isArray(me.cosmetics) ? me.cosmetics : []) {
    const id = typeof c === 'string' ? cosmeticFor(c) : null;
    if (id) cosmetics.add(id);
  }
  for (const e of entitlements) {
    const id = cosmeticFor(e.entitlement);
    if (id && (e.expiresAt === null || e.expiresAt > now)) cosmetics.add(id);
  }
  return {
    v: 2,
    userId: typeof me.user?.id === 'string' ? me.user.id : wallet.userId,
    diamonds: count(me.wallet?.diamonds),
    bonusDiamonds: count(me.wallet?.bonusDiamonds),
    entitlements,
    cosmetics: [...cosmetics].sort(),
    clock,
    syncedAt: deviceNow,
    meters: wallet.meters,
  };
}

/**
 * The wallet for whoever is signed in now. A mirror that belongs to another account, or to an
 * account this device no longer has (sign-out, deletion), must not lend its tier, themes or
 * balance to the next player: everything the server decides is dropped and only today's meters
 * stay. A mirror that was never synced (`userId` null) is kept for whoever syncs it first.
 */
export function walletForUser(wallet: Wallet, userId: string | null): Wallet {
  if (wallet.userId === null || wallet.userId === userId) return wallet;
  return { ...EMPTY_WALLET, meters: wallet.meters };
}

/**
 * Read a cached copy. Anything that is not a version-2 server mirror (the old device-only
 * mock wallet, a hand-edited value) keeps only today's meters: balances and entitlements
 * wait for the next sync.
 */
export function migrateWallet(raw: unknown): Wallet {
  if (!raw || typeof raw !== 'object') return EMPTY_WALLET;
  const r = raw as Partial<Wallet> & Record<string, unknown>;
  const m = r.meters as Partial<Wallet['meters']> | undefined;
  const meters = m && typeof m.day === 'string' ? { day: m.day, reviews: count(m.reviews), rush: count(m.rush) } : EMPTY_WALLET.meters;
  if (r.v !== 2) return { ...EMPTY_WALLET, meters };
  const entitlements = Array.isArray(r.entitlements)
    ? r.entitlements.filter((e): e is WalletEntitlement => !!e && typeof e.entitlement === 'string' && (e.expiresAt === null || (typeof e.expiresAt === 'number' && Number.isFinite(e.expiresAt))))
    : [];
  const cosmetics = Array.isArray(r.cosmetics) ? r.cosmetics.filter((c): c is string => typeof c === 'string' && COSMETIC_UNLOCKS.has(c)) : [];
  const offsetMs = typeof r.clock?.offsetMs === 'number' && Number.isFinite(r.clock.offsetMs) ? r.clock.offsetMs : 0;
  const floor = count(r.clock?.floor);
  return {
    v: 2,
    userId: typeof r.userId === 'string' ? r.userId : null,
    diamonds: count(r.diamonds),
    bonusDiamonds: count(r.bonusDiamonds),
    entitlements,
    cosmetics,
    clock: { offsetMs, floor },
    syncedAt: typeof r.syncedAt === 'number' ? r.syncedAt : null,
    meters,
    ...(r.mock ? { mock: true } : {}),
  };
}

/** Device time corrected by the server clock; never earlier than the latest server time seen. */
export function trustedNow(wallet: Wallet, deviceNow: number = Date.now()): number {
  if (wallet.syncedAt === null) return deviceNow;
  return Math.max(deviceNow + wallet.clock.offsetMs, wallet.clock.floor);
}

function active(wallet: Wallet, now: number): string[] {
  return wallet.entitlements.filter((e) => e.expiresAt === null || e.expiresAt > now).map((e) => e.entitlement);
}

function grants(name: string, tier: Exclude<CoachTier, 'free'>): boolean {
  return tierOfEntitlement(name) === tier;
}

/** The best tier among the live plans (each plan is its own entitlement). */
export function coachTier(wallet: Wallet, now: number = trustedNow(wallet)): CoachTier {
  const names = active(wallet, now);
  if (names.some((n) => grants(n, 'fourwinds'))) return 'fourwinds';
  if (names.some((n) => grants(n, 'gold'))) return 'gold';
  return 'free';
}

/** The latest expiry of the active coaching entitlement (null: none, or it never expires). */
export function coachRenewal(wallet: Wallet, now: number = trustedNow(wallet)): number | null {
  const tier = coachTier(wallet, now);
  if (tier === 'free') return null;
  const ends = wallet.entitlements.filter((e) => grants(e.entitlement, tier) && (e.expiresAt === null || e.expiresAt > now)).map((e) => e.expiresAt);
  return ends.includes(null) ? null : Math.max(...(ends as number[]));
}

const TIER_RANK: Record<CoachTier, number> = { free: 0, gold: 1, fourwinds: 2 };

export function hasTier(wallet: Wallet, tier: CoachTier, now: number = trustedNow(wallet)): boolean {
  return TIER_RANK[coachTier(wallet, now)] >= TIER_RANK[tier];
}

/** Creating and running clubs comes with The Four Winds Club (joining clubs is free); the server checks it again. */
export function canCreateClubs(wallet: Wallet, now: number = trustedNow(wallet)): boolean {
  return hasTier(wallet, 'fourwinds', now);
}

/** Pro bots come with Coach Gold: a saved 'pro' choice without it (lapsed, or from an old mock grant) plays as 'club'. */
export function allowedBotSkill(skill: BotSkill, wallet: Wallet, now: number = trustedNow(wallet)): BotSkill {
  return skill === 'pro' && !hasTier(wallet, 'gold', now) ? 'club' : skill;
}

export function ownsCosmetic(wallet: Wallet, unlockId: string): boolean {
  return wallet.cosmetics.includes(unlockId);
}

/** True when the player owns this cosmetic product; for a bundle, every item in it. */
export function ownsProduct(wallet: Wallet, productId: string): boolean {
  const p = productById(productId);
  if (!p || p.kind !== 'cosmetic') return false;
  if (p.contains) return p.contains.every((id) => ownsProduct(wallet, id));
  return !!p.unlocks && ownsCosmetic(wallet, p.unlocks);
}

export function totalDiamonds(wallet: Wallet): number {
  return wallet.diamonds + wallet.bonusDiamonds;
}

/** Whether the cached balance covers a diamond price (the server has the final word). */
export function canAfford(wallet: Wallet, diamondPrice: number): { ok: boolean; short: number } {
  const short = Math.max(0, diamondPrice - totalDiamonds(wallet));
  return { ok: short === 0, short };
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function metersFor(wallet: Wallet, now: Date): Wallet['meters'] {
  const day = localDayKey(now);
  return wallet.meters.day === day ? wallet.meters : { day, reviews: 0, rush: 0 };
}

/** Free-tier meters (full product, limited count, reset at local midnight by the trusted clock). */
export function canUse(wallet: Wallet, meter: 'reviews' | 'rush', now: Date = new Date(trustedNow(wallet))): { ok: boolean; left: number; limit: number | null } {
  if (meter === 'reviews' && hasTier(wallet, 'fourwinds', now.getTime())) return { ok: true, left: Infinity, limit: null };
  if (meter === 'rush' && hasTier(wallet, 'gold', now.getTime())) return { ok: true, left: Infinity, limit: null };
  const limit = meter === 'reviews' ? FREE_METERS.reviewsPerDay : FREE_METERS.rushPerDay;
  const used = metersFor(wallet, now)[meter];
  return { ok: used < limit, left: Math.max(0, limit - used), limit };
}

export function consume(wallet: Wallet, meter: 'reviews' | 'rush', now: Date = new Date(trustedNow(wallet))): Wallet {
  const m = metersFor(wallet, now);
  return { ...wallet, meters: { ...m, [meter]: m[meter] + 1 } };
}

/** True once `/api/me` shows the purchase: more diamonds, the cosmetic, or the tier. */
export function showsPurchase(before: Wallet, after: Wallet, productId: string): boolean {
  const p = productById(productId);
  if (!p) return false;
  if (p.kind === 'diamonds') return totalDiamonds(after) > totalDiamonds(before);
  if (p.kind === 'cosmetic') return ownsProduct(after, p.id);
  if (!p.tier || !hasTier(after, p.tier)) return false;
  // A renewal or an upgrade also counts: the tier is new, or its expiry moved.
  return !hasTier(before, p.tier) || coachRenewal(after) !== coachRenewal(before);
}
