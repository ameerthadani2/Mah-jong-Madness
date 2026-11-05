/**
 * The server's product table: what each store product or diamond purchase grants. Entitlements
 * are decided here and nowhere else; the app only reads them back from `GET /api/me`.
 *
 * Ids match `apps/mobile/src/monetisation/catalog.ts` (test/catalog.test.ts checks every
 * product here against that file: same kind, same price tier, same diamonds). The launch
 * catalogue is deliberately short (docs/MONETISATION.md, plan Phase 4): diamond packs, the four
 * table looks, Coach Gold and Coach Platinum. Anything else the app's file still lists (avatar
 * and emote packs, VIP cards, club tiers, Coach Diamond, Table Pass) is not sold, so a store
 * event or a spend for it grants nothing.
 *
 * Store product ids: App Store products use these ids as they are. A Google Play subscription
 * arrives as `<subscription id>:<base plan id>`; `productForStoreId` reads `coach.gold:month` as
 * `coach.gold.month`, so the Play subscription is `coach.gold` with base plans `month` and `year`.
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

export interface Subscription extends Base {
  kind: 'subscription';
  /** The entitlement granted while the subscription is live (`coach.gold`, `coach.platinum`). */
  entitlement: string;
  tier: 'gold' | 'platinum';
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
const sub = (tier: Subscription['tier'], period: Subscription['period'], priceUsd: number): Subscription => ({
  id: `coach.${tier}.${period}`,
  kind: 'subscription',
  priceUsd,
  entitlement: `coach.${tier}`,
  tier,
  period,
});
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
  sub('gold', 'month', 6.99),
  sub('gold', 'year', 49.99),
  sub('platinum', 'month', 10.99),
  sub('platinum', 'year', 79.99),
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

/** Every entitlement a subscription can grant, highest tier first. */
export const COACH_ENTITLEMENTS = ['coach.platinum', 'coach.gold'] as const;

/** Entitlement ids of the cosmetics (to list what a user owns). */
export const COSMETIC_ENTITLEMENTS: ReadonlySet<string> = new Set(SERVER_PRODUCTS.filter((p): p is Cosmetic => p.kind === 'cosmetic').map((p) => p.entitlement));

/** Fallback length of a subscription period when a store event carries no expiry. */
export const PERIOD_MS: Record<Subscription['period'], number> = { month: 31 * 86_400_000, year: 366 * 86_400_000 };
