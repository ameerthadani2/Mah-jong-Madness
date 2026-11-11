/**
 * The server's product table: what each store product or diamond purchase grants. Entitlements
 * are decided here and nowhere else; the app only reads them back from `GET /api/me`.
 *
 * Ids match `apps/mobile/src/monetisation/catalog.ts` (test/catalog.test.ts checks every
 * product here against that file: same kind, same price tier, same diamonds, and the other way
 * round). The catalogue (docs/MONETISATION.md): diamond packs; cosmetics bought with diamonds
 * (table looks, tile backs, avatar frames, emote packs, win celebrations and bundles of them);
 * and two subscriptions, Coach Gold and The Four Winds Club. Anything not listed here is not
 * sold, so a store event or a spend for it grants nothing.
 *
 * Each subscription plan is its own entitlement (`coach.gold.month`, `coach.gold.year`,
 * `fourwinds.month`, `fourwinds.year`): refunding or expiring one plan never ends another, and the
 * player's tier is the best plan still live (`tierOfEntitlements`). Time that support grants on a
 * plan is kept apart from what the store sold (`support:<plan>`, see `supportPlanKey`).
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

export type CosmeticCategory = 'table' | 'tileback' | 'frame' | 'emotes' | 'celebration' | 'bundle';

export interface Cosmetic extends Base {
  kind: 'cosmetic';
  category: CosmeticCategory;
  /** Bought with diamonds only; the entitlement (the product id) never expires. A bundle grants its items' entitlements instead. */
  diamondPrice: number;
  entitlement: string;
  /** What the app unlocks: a table look's theme id (`jade`), otherwise the product id. Absent for a bundle. */
  unlocks?: string;
  /** For a bundle: the cosmetic product ids it grants. */
  contains?: string[];
}

export type ServerProduct = DiamondPack | Subscription | Cosmetic;

const pack = (diamonds: number, bonus: number, priceUsd: number): DiamondPack => ({ id: `diamonds.${diamonds + bonus}`, kind: 'diamonds', priceUsd, diamonds, bonus });
const sub = (id: string, tier: PaidTier, period: Subscription['period'], priceUsd: number): Subscription => ({ id, kind: 'subscription', priceUsd, entitlement: id, tier, period });
/** The price tier the app shows next to a diamond price (300 diamonds: $2.99); for reference only. */
const tierOf = (diamondPrice: number) => Math.round(diamondPrice - 1) / 100;
const look = (unlocks: string, diamondPrice: number): Cosmetic => ({ id: `theme.${unlocks}`, kind: 'cosmetic', category: 'table', priceUsd: tierOf(diamondPrice), diamondPrice, entitlement: `theme.${unlocks}`, unlocks });
const item = (category: Exclude<CosmeticCategory, 'table' | 'bundle'>) => (id: string, diamondPrice: number): Cosmetic => ({ id, kind: 'cosmetic', category, priceUsd: tierOf(diamondPrice), diamondPrice, entitlement: id, unlocks: id });
const back = item('tileback');
const frame = item('frame');
const emotes = item('emotes');
const win = item('celebration');
const bundle = (id: string, diamondPrice: number, contains: string[]): Cosmetic => ({ id, kind: 'cosmetic', category: 'bundle', priceUsd: tierOf(diamondPrice), diamondPrice, entitlement: id, contains });

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
  look('nightmarket', 300),
  look('bamboo', 300),
  look('jade', 400),
  look('imperial', 300),
  look('lantern', 450),
  look('teahouse', 400),
  look('oceanwave', 450),
  look('plumblossom', 500),
  look('cloud', 450),
  look('starlight', 500),
  look('porcelain', 550),
  look('dragonscale', 600),
  back('back.jade', 250),
  back('back.crimson', 250),
  back('back.midnight', 250),
  back('back.lotus', 300),
  back('back.bamboo', 250),
  back('back.wave', 300),
  back('back.cloud', 300),
  back('back.lattice', 300),
  back('back.sunset', 250),
  back('back.dragon', 400),
  frame('frame.bamboo', 150),
  frame('frame.jade', 200),
  frame('frame.gilded', 250),
  frame('frame.blossom', 200),
  frame('frame.wave', 200),
  frame('frame.cloud', 200),
  frame('frame.flame', 250),
  frame('frame.star', 250),
  frame('frame.lantern', 250),
  frame('frame.dragon', 350),
  frame('frame.phoenix', 350),
  frame('frame.rainbow', 300),
  emotes('emotes.teahouse', 250),
  emotes('emotes.nightmarket', 250),
  emotes('emotes.festival', 250),
  emotes('emotes.zodiac', 300),
  win('win.fireworks', 400),
  win('win.lanterns', 450),
  win('win.dragon', 600),
  win('win.petals', 400),
  bundle('bundle.nightmarket', 850, ['theme.nightmarket', 'back.midnight', 'frame.lantern', 'emotes.nightmarket']),
  bundle('bundle.festival', 1300, ['theme.lantern', 'back.crimson', 'frame.flame', 'emotes.festival', 'win.lanterns']),
  bundle('bundle.dragon', 1750, ['theme.dragonscale', 'back.dragon', 'frame.dragon', 'emotes.zodiac', 'win.dragon']),
  bundle('bundle.garden', 1100, ['theme.plumblossom', 'back.lotus', 'frame.blossom', 'win.petals']),
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

/**
 * A plan granted by support is kept in its own entitlement row, `support:<plan>`, beside the row
 * the store writes for the same plan: a store refund, expiry or transfer then never touches time
 * that support gave, and a support grant never hides what the store sold.
 */
export const SUPPORT_PLAN_PREFIX = 'support:';

/** The row a support grant of this plan is kept in. */
export const supportPlanKey = (plan: string): string => `${SUPPORT_PLAN_PREFIX}${plan}`;

/** The plan an entitlement row grants: the plan of a support row, otherwise the name itself. */
export function planOfEntitlement(name: string): string {
  const plan = name.startsWith(SUPPORT_PLAN_PREFIX) ? name.slice(SUPPORT_PLAN_PREFIX.length) : name;
  return plan !== name && tierOfEntitlement(plan) ? plan : name;
}

/** The best tier among these live entitlements (store rows and support rows alike). */
export function tierOfEntitlements(entitlements: Iterable<string>): CoachTier {
  let best: CoachTier = 'free';
  for (const e of entitlements) {
    const tier = tierOfEntitlement(planOfEntitlement(e));
    if (tier && TIER_RANK[tier] > TIER_RANK[best]) best = tier;
  }
  return best;
}

/** Entitlement ids of the cosmetics a player can own (bundles grant these; they are not owned themselves). */
export const COSMETIC_ENTITLEMENTS: ReadonlySet<string> = new Set(SERVER_PRODUCTS.filter((p): p is Cosmetic => p.kind === 'cosmetic' && !p.contains).map((p) => p.entitlement));

/**
 * What a bundle costs a player who already owns some of it: its price scaled by the share of its
 * items still missing, rounded up to ten and never more than buying those items one by one;
 * 0 when they own it all. The app shows the same number (apps/mobile catalog.ts `bundlePrice`).
 */
export function bundlePrice(b: Cosmetic, owns: (entitlement: string) => boolean): number {
  const items = (b.contains ?? []).map((id) => serverProduct(id)).filter((c): c is Cosmetic => c?.kind === 'cosmetic');
  const full = items.reduce((n, c) => n + c.diamondPrice, 0);
  const missing = items.filter((c) => !owns(c.entitlement)).reduce((n, c) => n + c.diamondPrice, 0);
  if (!full || !missing) return 0;
  return Math.min(missing, Math.ceil((b.diamondPrice * missing) / full / 10) * 10);
}

/** Fallback length of a subscription period when a store event carries no expiry. */
export const PERIOD_MS: Record<Subscription['period'], number> = { month: 31 * 86_400_000, year: 366 * 86_400_000 };
