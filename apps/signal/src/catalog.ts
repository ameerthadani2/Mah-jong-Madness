/**
 * The server's product table: what each store product or diamond purchase grants. Entitlements
 * are decided here and nowhere else; the app only reads them back from `GET /api/me`.
 *
 * Ids match `apps/mobile/src/monetisation/catalog.ts` (test/catalog.test.ts checks every
 * product here against that file: same kind, same price tier, same diamonds, and the other way
 * round). The catalogue (docs/MONETISATION.md): diamond packs, cosmetics bought with diamonds,
 * and two subscriptions, Coach Gold and The Four Winds Club. Anything not listed here is not
 * sold, so a store event or a spend for it grants nothing.
 *
 * Each subscription plan is its own entitlement (`coach.gold.month`, `coach.gold.year`,
 * `fourwinds.month`, `fourwinds.year`): refunding or expiring one plan never ends another, and the
 * player's tier is the best plan still live (`tierOfEntitlements`).
 *
 * Store product ids: App Store products use these ids as they are. A Google Play subscription
 * arrives as `<subscription id>:<base plan id>`; `productForStoreId` reads `coach.gold:month` as
 * `coach.gold.month`, so the Play subscriptions are `coach.gold` and `fourwinds`, each with base
 * plans `month` and `year`.
 */

export type ServerProductKind = 'diamonds' | 'subscription' | 'cosmetic';

interface Base {
  id: string;
  kind: ServerProductKind;
  /** Price tier in US dollars (the stores localise it); for cosmetics, the tier the app shows next to the diamond price. */
  priceUsd: number;
}

export interface DiamondPack extends Base {
  kind: 'diamonds';
  /** Diamonds credited as purchased currency. */
  diamonds: number;
  /** Extra diamonds credited as bonus (shown as "+N%"); they never expire either. */
  bonus: number;
}

/** Coaching and club tiers, lowest first. */
export type CoachTier = 'free' | 'gold' | 'fourwinds';
export type PaidTier = Exclude<CoachTier, 'free'>;

export interface Subscription extends Base {
  kind: 'subscription';
  /** The entitlement granted while this plan is live: the plan's own id, so each plan stands alone. */
  entitlement: string;
  tier: PaidTier;
  period: 'month' | 'year';
}

export interface Cosmetic extends Base {
  kind: 'cosmetic';
  /** Bought with diamonds only; the entitlement (the product id) never expires. */
  diamondPrice: number;
  entitlement: string;
  /** The look the app unlocks (`themes.ts` id). */
  unlocks: string;
}

export type ServerProduct = DiamondPack | Subscription | Cosmetic;

const pack = (diamonds: number, bonus: number, priceUsd: number): DiamondPack => ({ id: `diamonds.${diamonds + bonus}`, kind: 'diamonds', priceUsd, diamonds, bonus });
const sub = (id: string, tier: PaidTier, period: Subscription['period'], priceUsd: number): Subscription => ({ id, kind: 'subscription', priceUsd, entitlement: id, tier, period });
const look = (unlocks: string, diamondPrice: number, priceUsd: number): Cosmetic => ({
  id: `theme.${unlocks}`,
  kind: 'cosmetic',
  priceUsd,
  diamondPrice,
  entitlement: `theme.${unlocks}`,
  unlocks,
});

export const SERVER_PRODUCTS: readonly ServerProduct[] = [
  pack(60, 0, 0.99),
  pack(300, 0, 4.99),
  pack(600, 0, 9.99),
  pack(1200, 100, 19.99),
  pack(3000, 450, 49.99),
  pack(6000, 1500, 99.99),
  sub('coach.gold.month', 'gold', 'month', 6.99),
  sub('coach.gold.year', 'gold', 'year', 49.99),
  sub('fourwinds.month', 'fourwinds', 'month', 10.99),
  sub('fourwinds.year', 'fourwinds', 'year', 79.99),
  look('nightmarket', 300, 2.99),
  look('bamboo', 300, 2.99),
  look('jade', 400, 3.99),
  look('imperial', 300, 2.99),
];

const BY_ID = new Map(SERVER_PRODUCTS.map((p) => [p.id, p]));

export function serverProduct(id: unknown): ServerProduct | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

/** The product behind a store's product id (App Store id as is, Play `subscription:basePlan`), or undefined. */
export function productForStoreId(storeId: unknown): ServerProduct | undefined {
  if (typeof storeId !== 'string' || !storeId) return undefined;
  const direct = BY_ID.get(storeId);
  if (direct) return direct;
  const [subscription, basePlan] = storeId.split(':');
  return basePlan ? BY_ID.get(`${subscription}.${basePlan}`) : undefined;
}

/** Rank of each tier: a higher tier includes everything below it. */
export const TIER_RANK: Record<CoachTier, number> = { free: 0, gold: 1, fourwinds: 2 };

const TIER_BY_ENTITLEMENT = new Map(SERVER_PRODUCTS.filter((p): p is Subscription => p.kind === 'subscription').map((p) => [p.entitlement, p.tier]));

/** The tier a subscription entitlement grants, or null for anything else. */
export function tierOfEntitlement(entitlement: string): PaidTier | null {
  return TIER_BY_ENTITLEMENT.get(entitlement) ?? null;
}

/** The best tier among these live entitlements. */
export function tierOfEntitlements(entitlements: Iterable<string>): CoachTier {
  let best: CoachTier = 'free';
  for (const e of entitlements) {
    const tier = tierOfEntitlement(e);
    if (tier && TIER_RANK[tier] > TIER_RANK[best]) best = tier;
  }
  return best;
}

/** Entitlement ids of the cosmetics (to list what a user owns). */
export const COSMETIC_ENTITLEMENTS: ReadonlySet<string> = new Set(SERVER_PRODUCTS.filter((p): p is Cosmetic => p.kind === 'cosmetic').map((p) => p.entitlement));

/** Fallback length of a subscription period when a store event carries no expiry. */
export const PERIOD_MS: Record<Subscription['period'], number> = { month: 31 * 86_400_000, year: 366 * 86_400_000 };
