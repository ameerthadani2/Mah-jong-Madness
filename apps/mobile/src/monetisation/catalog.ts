/**
 * The launch catalogue: only what ships (docs/MONETISATION.md, "Catalogue").
 *
 * Everything sold here is cosmetic, coaching or club ownership: nothing changes tile odds,
 * information or clocks at the table, and joining and playing in clubs is free. The Four Winds
 * Club (四風俱樂部) adds the right to create and run clubs on top of Coach Gold and unlimited
 * hand reviews. Diamond packs carry honest bonuses (the badge is
 * the bonus as a share of the 60-per-dollar base, rounded), and table looks are bought with
 * diamonds only (POST /api/wallet/spend).
 *
 * The server keeps the same table (apps/signal/src/catalog.ts; its test reads this file):
 * same ids, kinds, price tiers, diamonds and diamond prices. `storeId` is the identifier in
 * App Store Connect and RevenueCat for products sold for money; a Google Play subscription is
 * `coach.gold` or `fourwinds` with base plans `month` / `year`, reported as `coach.gold:month`.
 * Each plan is its own entitlement on the server (`fourwinds.month`), so refunding one plan
 * never ends another; the tier is the best plan still live.
 * `priceUsd` is the planning tier only: the Shop shows the price string the store SDK returns.
 *
 * `title` / `description` / `badge` are the English source copy; screens show
 * `productText(p, t)`, which reads `shop.products.<id with dots as underscores>.*` so every
 * language (English included) comes from the locale files.
 */
import type { Translate } from '../logic/translate';

export type ProductKind = 'diamonds' | 'cosmetic' | 'subscription';
/** Coaching tiers, lowest first; `fourwinds` is The Four Winds Club. */
export type CoachTier = 'free' | 'gold' | 'fourwinds';

export interface Product {
  id: string;
  kind: ProductKind;
  /** Identifier in the stores and RevenueCat, for products sold for money (looks are diamonds-only). */
  storeId?: string;
  title: string;
  titleZh: string;
  description: string;
  /** Planning price tier in US dollars; never shown (the store's localised price is). */
  priceUsd: number;
  /** For `diamonds`: the base amount at the 60-per-dollar rate. */
  baseDiamonds?: number;
  /** For `diamonds`: bonus diamonds on top of the base (0 for none). */
  bonusDiamonds?: number;
  /** For `diamonds`: diamonds granted, bonus included. */
  diamonds?: number;
  /** For `cosmetic`: the price in diamonds (bought through POST /api/wallet/spend). */
  diamondPrice?: number;
  /** For `cosmetic`: the table theme id unlocked (src/themes.ts). */
  unlocks?: string;
  /** For `subscription`: billing period. */
  period?: 'month' | 'year';
  /** For `subscription`: the coaching tier granted. */
  tier?: Exclude<CoachTier, 'free'>;
  badge?: string;
}

/** Diamonds per US dollar tier step (60 for the $0.99 tier). */
export const DIAMONDS_PER_DOLLAR = 60;

export const DIAMOND_PACKS: Product[] = [
  { id: 'diamonds.60', storeId: 'diamonds.60', kind: 'diamonds', title: '60 Diamonds', titleZh: '60 鑽石', description: 'A small top-up.', priceUsd: 0.99, baseDiamonds: 60, bonusDiamonds: 0, diamonds: 60 },
  { id: 'diamonds.300', storeId: 'diamonds.300', kind: 'diamonds', title: '300 Diamonds', titleZh: '300 鑽石', description: 'Enough for a table look.', priceUsd: 4.99, baseDiamonds: 300, bonusDiamonds: 0, diamonds: 300 },
  { id: 'diamonds.600', storeId: 'diamonds.600', kind: 'diamonds', title: '600 Diamonds', titleZh: '600 鑽石', description: 'Enough for two table looks.', priceUsd: 9.99, baseDiamonds: 600, bonusDiamonds: 0, diamonds: 600 },
  { id: 'diamonds.1300', storeId: 'diamonds.1300', kind: 'diamonds', title: '1,300 Diamonds', titleZh: '1,300 鑽石', description: '1,200 plus 100 bonus.', priceUsd: 19.99, baseDiamonds: 1200, bonusDiamonds: 100, diamonds: 1300, badge: '+8%' },
  { id: 'diamonds.3450', storeId: 'diamonds.3450', kind: 'diamonds', title: '3,450 Diamonds', titleZh: '3,450 鑽石', description: '3,000 plus 450 bonus.', priceUsd: 49.99, baseDiamonds: 3000, bonusDiamonds: 450, diamonds: 3450, badge: '+15%' },
  { id: 'diamonds.7500', storeId: 'diamonds.7500', kind: 'diamonds', title: '7,500 Diamonds', titleZh: '7,500 鑽石', description: '6,000 plus 1,500 bonus.', priceUsd: 99.99, baseDiamonds: 6000, bonusDiamonds: 1500, diamonds: 7500, badge: '+25%' },
];

/** Bought with diamonds only; owned for good once bought. */
export const COSMETICS: Product[] = [
  { id: 'theme.nightmarket', kind: 'cosmetic', title: 'Night Market table', titleZh: '夜市霓虹桌布', description: 'Neon purple felt with pink accents.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'nightmarket' },
  { id: 'theme.bamboo', kind: 'cosmetic', title: 'Bamboo Garden table', titleZh: '竹林桌布', description: 'Soft green felt, ivory tiles.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'bamboo' },
  { id: 'theme.jade', kind: 'cosmetic', title: 'Jade Parlour table', titleZh: '翡翠廳桌布', description: 'Deep jade felt, walnut rail with gold studs, ivory tiles.', priceUsd: 3.99, diamondPrice: 400, unlocks: 'jade', badge: 'New' },
  { id: 'theme.imperial', kind: 'cosmetic', title: 'Imperial Red table', titleZh: '宮廷紅桌布', description: 'Lacquer red with gold trim.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'imperial' },
];

export const SUBSCRIPTIONS: Product[] = [
  { id: 'coach.gold.month', storeId: 'coach.gold.month', kind: 'subscription', tier: 'gold', title: 'Coach Gold', titleZh: '教練 金', description: 'Pro bots and unlimited Puzzle Rush.', priceUsd: 6.99, period: 'month' },
  { id: 'coach.gold.year', storeId: 'coach.gold.year', kind: 'subscription', tier: 'gold', title: 'Coach Gold (yearly)', titleZh: '教練 金 年繳', description: 'Coach Gold for a year, billed once.', priceUsd: 49.99, period: 'year', badge: 'Yearly' },
  {
    id: 'fourwinds.month',
    storeId: 'fourwinds.month',
    kind: 'subscription',
    tier: 'fourwinds',
    title: 'The Four Winds Club',
    titleZh: '四風俱樂部',
    description: 'Everything in Coach Gold, unlimited hand reviews, and clubs of your own to create and run.',
    priceUsd: 10.99,
    period: 'month',
    badge: 'Run your own club',
  },
  { id: 'fourwinds.year', storeId: 'fourwinds.year', kind: 'subscription', tier: 'fourwinds', title: 'The Four Winds Club (yearly)', titleZh: '四風俱樂部 年繳', description: 'The Four Winds Club for a year, billed once.', priceUsd: 79.99, period: 'year', badge: 'Yearly' },
];

export const ALL_PRODUCTS: Product[] = [...DIAMOND_PACKS, ...COSMETICS, ...SUBSCRIPTIONS];

/** The launch catalogue the Shop shows (the server's test checks it sells every one). */
export const SELLABLE_PRODUCTS: Product[] = ALL_PRODUCTS;

/** Products sold for money through the store SDK (diamond packs and coaching plans). */
export const STORE_PRODUCTS: Product[] = ALL_PRODUCTS.filter((p) => !!p.storeId);

export function productById(id: string): Product | undefined {
  return ALL_PRODUCTS.find((p) => p.id === id);
}

/**
 * The catalogue product for a store identifier as the SDK reports it: the App Store id as it
 * is, or a Google Play `subscription:basePlan` (`coach.gold:month` → `coach.gold.month`).
 */
export function productByStoreId(storeId: string): Product | undefined {
  const direct = STORE_PRODUCTS.find((p) => p.storeId === storeId);
  if (direct) return direct;
  const [sub, basePlan] = storeId.split(':');
  return basePlan ? STORE_PRODUCTS.find((p) => p.storeId === `${sub}.${basePlan}`) : undefined;
}

/** The plan id prefix of each paid tier: every entitlement named `<prefix>` or `<prefix>.<plan>` grants it. */
const TIER_PREFIX: Record<Exclude<CoachTier, 'free'>, string> = { gold: 'coach.gold', fourwinds: 'fourwinds' };

/** The paid tier an entitlement name grants (`coach.gold.year` → gold, `fourwinds.month` → fourwinds), or null. */
export function tierOfEntitlement(name: string): Exclude<CoachTier, 'free'> | null {
  for (const tier of ['fourwinds', 'gold'] as const) {
    const prefix = TIER_PREFIX[tier];
    if (name === prefix || name.startsWith(`${prefix}.`)) return tier;
  }
  return null;
}

/** Daily meters for the free tier (reset at local midnight, by the server's clock when known). */
export const FREE_METERS = { reviewsPerDay: 1, rushPerDay: 1 };

/** Locale key prefix for a product: `diamonds.60` → `shop.products.diamonds_60`. */
export function productKey(p: Pick<Product, 'id'>): string {
  return `shop.products.${p.id.replace(/\./g, '_')}`;
}

/** A product's player-facing copy in the current language. */
export function productText(p: Product, t: Translate): { title: string; description: string; badge?: string } {
  const k = productKey(p);
  return { title: t(`${k}.title`), description: t(`${k}.description`), badge: p.badge ? t(`${k}.badge`) : undefined };
}
