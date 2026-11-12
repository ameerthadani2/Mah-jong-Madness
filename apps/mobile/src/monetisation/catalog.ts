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
/** Shop shelves for cosmetics; a bundle grants several cosmetics at once. */
export type CosmeticCategory = 'table' | 'tileback' | 'frame' | 'emotes' | 'celebration' | 'bundle';
export const COSMETIC_CATEGORIES: readonly CosmeticCategory[] = ['table', 'tileback', 'frame', 'emotes', 'celebration', 'bundle'];
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
  /**
   * For `cosmetic`: what it unlocks. A table look unlocks its theme id (`jade`, src/themes.ts);
   * every other cosmetic unlocks its own product id (`back.lotus`, ./cosmetics.ts). Bundles have none.
   */
  unlocks?: string;
  /** For `cosmetic`: its Shop shelf. */
  category?: CosmeticCategory;
  /** For a bundle: the product ids it grants. */
  contains?: string[];
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

/** Bought with diamonds only; owned for good once bought. The prices are diamonds. */
const item = (category: Exclude<CosmeticCategory, 'bundle'>, id: string, unlocks: string, diamondPrice: number, title: string, titleZh: string, description: string, badge?: string): Product => ({
  id,
  kind: 'cosmetic',
  category,
  title,
  titleZh,
  description,
  priceUsd: Math.round(diamondPrice - 1) / 100,
  diamondPrice,
  unlocks,
  ...(badge ? { badge } : {}),
});
const table = (theme: string, diamondPrice: number, title: string, titleZh: string, description: string, badge?: string) => item('table', `theme.${theme}`, theme, diamondPrice, title, titleZh, description, badge);
const own = (category: Exclude<CosmeticCategory, 'bundle' | 'table'>) => (id: string, diamondPrice: number, title: string, titleZh: string, description: string) => item(category, id, id, diamondPrice, title, titleZh, description);
const back = own('tileback');
const frame = own('frame');
const emotes = own('emotes');
const win = own('celebration');

export const COSMETICS: Product[] = [
  table('nightmarket', 300, 'Night Market table', '夜市霓虹桌布', 'Neon purple felt with pink accents.'),
  table('bamboo', 300, 'Bamboo Garden table', '竹林桌布', 'Soft green felt, ivory tiles.'),
  table('jade', 400, 'Jade Parlour table', '翡翠廳桌布', 'Deep jade felt, walnut rail with gold studs, ivory tiles.'),
  table('imperial', 300, 'Imperial Red table', '宮廷紅桌布', 'Lacquer red with gold trim.'),
  table('lantern', 450, 'Lantern Festival table', '元宵燈會桌布', 'Crimson felt printed with festival lanterns.', 'New'),
  table('teahouse', 400, 'Teahouse table', '老茶館桌布', 'Walnut felt with a window-lattice print.'),
  table('oceanwave', 450, 'Ocean Wave table', '海浪桌布', 'Deep blue felt with rolling wave rings.'),
  table('plumblossom', 500, 'Plum Blossom table', '梅花桌布', 'Dusky rose felt scattered with plum blossoms.'),
  table('cloud', 450, 'Lucky Clouds table', '祥雲桌布', 'Teal felt with golden cloud swirls.'),
  table('starlight', 500, 'Starlit Night table', '星夜桌布', 'Navy felt sprinkled with gold stars.'),
  table('porcelain', 550, 'Blue Porcelain table', '青花瓷桌布', 'Cobalt felt with a white key-fret print.'),
  table('dragonscale', 600, 'Dragon Scale table', '龍鱗桌布', 'Emerald felt with gold dragon scales and a walnut rail.'),
  back('back.jade', 250, 'Polished Jade tile back', '溫潤玉石牌背', 'Glossy jade green with a pale ring.'),
  back('back.crimson', 250, 'Crimson Knot tile back', '朱紅中國結牌背', 'Deep red with a golden lucky knot.'),
  back('back.midnight', 250, 'Midnight Star tile back', '午夜星辰牌背', 'Night blue with a bright gold star.'),
  back('back.lotus', 300, 'Lotus Pond tile back', '荷花池牌背', 'Rose pink with a white lotus.'),
  back('back.bamboo', 250, 'Bamboo Grove tile back', '竹影牌背', 'Fresh green with bamboo stems.'),
  back('back.wave', 300, 'Ocean Wave tile back', '浪花牌背', 'Sea blue with curling waves.'),
  back('back.cloud', 300, 'Lucky Cloud tile back', '祥雲牌背', 'Teal with a cream cloud swirl.'),
  back('back.lattice', 300, 'Teahouse Lattice tile back', '茶館窗花牌背', 'Walnut brown with a window lattice.'),
  back('back.sunset', 250, 'Sunset Rays tile back', '夕照牌背', 'Warm orange with a rising sun.'),
  back('back.dragon', 400, 'Dragon Scale tile back', '龍鱗牌背', 'Emerald with gold dragon scales.'),
  frame('frame.bamboo', 150, 'Bamboo Ring frame', '竹節框', 'A green bamboo ring around your avatar.'),
  frame('frame.jade', 200, 'Jade Bangle frame', '玉鐲框', 'A smooth jade bangle with pale beads.'),
  frame('frame.gilded', 250, 'Gilded Ring frame', '鎏金框', 'A bright gilded ring with four studs.'),
  frame('frame.blossom', 200, 'Plum Blossom frame', '梅花框', 'Pink ring dotted with plum blossoms.'),
  frame('frame.wave', 200, 'Rolling Waves frame', '浪花框', 'Blue ring with white wave crests.'),
  frame('frame.cloud', 200, 'Lucky Clouds frame', '祥雲框', 'Teal ring with cream cloud puffs.'),
  frame('frame.flame', 250, 'Hot Streak frame', '火焰框', 'Orange ring licked by flames.'),
  frame('frame.star', 250, 'Starlight frame', '星光框', 'Night-blue ring with gold stars.'),
  frame('frame.lantern', 250, 'Lantern Glow frame', '燈籠框', 'Red ring hung with little lanterns.'),
  frame('frame.dragon', 350, 'Jade Dragon frame', '玉龍框', 'Green ring with gold dragon scales.'),
  frame('frame.phoenix', 350, 'Phoenix Feather frame', '鳳羽框', 'Crimson ring with golden feathers.'),
  frame('frame.rainbow', 300, 'Rainbow Ribbon frame', '彩虹框', 'A ribbon in every colour.'),
  emotes('emotes.teahouse', 250, 'Tea House emotes', '茶館表情', 'Six emotes: tea, bun, dumpling, noodles, mooncake, tangerine.'),
  emotes('emotes.nightmarket', 250, 'Night Market emotes', '夜市表情', 'Six emotes: bubble tea, skewer, shaved ice, corn, lantern, firecracker.'),
  emotes('emotes.festival', 250, 'Festival emotes', '節慶表情', 'Six emotes: fireworks, lucky knot, drum, kite, moon, dragon boat.'),
  emotes('emotes.zodiac', 300, 'Zodiac emotes', '生肖表情', 'Six emotes: rat, ox, tiger, rabbit, dragon, rooster.'),
  win('win.fireworks', 400, 'Fireworks win', '煙火慶祝', 'Fireworks burst over the table when you win.'),
  win('win.lanterns', 450, 'Sky Lanterns win', '天燈慶祝', 'Sky lanterns rise when you win.'),
  win('win.dragon', 600, 'Dragon Dance win', '舞龍慶祝', 'A dragon dances across the table when you win.'),
  win('win.petals', 400, 'Blossom Shower win', '花瓣雨慶祝', 'Plum petals drift down when you win.'),
];

const bundle = (id: string, diamondPrice: number, contains: string[], title: string, titleZh: string, description: string): Product => ({
  id,
  kind: 'cosmetic',
  category: 'bundle',
  title,
  titleZh,
  description,
  priceUsd: Math.round(diamondPrice - 1) / 100,
  diamondPrice,
  contains,
  badge: 'Set',
});

/** Sets of cosmetics at about a fifth off; an item already owned comes off the price (`bundlePrice`). */
export const BUNDLES: Product[] = [
  bundle('bundle.nightmarket', 850, ['theme.nightmarket', 'back.midnight', 'frame.lantern', 'emotes.nightmarket'], 'Night Market set', '夜市套組', 'Night Market table, Midnight Star back, Lantern Glow frame and the Night Market emotes.'),
  bundle('bundle.festival', 1300, ['theme.lantern', 'back.crimson', 'frame.flame', 'emotes.festival', 'win.lanterns'], 'Lantern Festival set', '元宵套組', 'Lantern Festival table, Crimson Knot back, Hot Streak frame, Festival emotes and Sky Lanterns win.'),
  bundle('bundle.dragon', 1750, ['theme.dragonscale', 'back.dragon', 'frame.dragon', 'emotes.zodiac', 'win.dragon'], 'Dragon set', '龍騰套組', 'Dragon Scale table and back, Jade Dragon frame, Zodiac emotes and Dragon Dance win.'),
  bundle('bundle.garden', 1100, ['theme.plumblossom', 'back.lotus', 'frame.blossom', 'win.petals'], 'Blossom Garden set', '花園套組', 'Plum Blossom table, Lotus Pond back, Plum Blossom frame and Blossom Shower win.'),
];

/**
 * What a bundle costs this player: its price scaled by the share of its items they do not own
 * yet, rounded up to ten and never more than buying those items one by one. The server
 * (apps/signal/src/catalog.ts `bundlePrice`) charges the same.
 */
export function bundlePrice(b: Pick<Product, 'diamondPrice' | 'contains'>, owns: (productId: string) => boolean): number {
  const items = (b.contains ?? []).map((id) => COSMETICS.find((c) => c.id === id)).filter((c): c is Product => !!c);
  const full = items.reduce((n, c) => n + (c.diamondPrice ?? 0), 0);
  const missing = items.filter((c) => !owns(c.id)).reduce((n, c) => n + (c.diamondPrice ?? 0), 0);
  if (!full || !missing) return 0;
  return Math.min(missing, Math.ceil(((b.diamondPrice ?? 0) * missing) / full / 10) * 10);
}

export const SUBSCRIPTIONS: Product[] = [
  { id: 'coach.gold.month', storeId: 'coach.gold.month', kind: 'subscription', tier: 'gold', title: 'Coach Gold', titleZh: '黃金教練', description: 'Pro bots and unlimited Puzzle Rush.', priceUsd: 6.99, period: 'month' },
  { id: 'coach.gold.year', storeId: 'coach.gold.year', kind: 'subscription', tier: 'gold', title: 'Coach Gold (yearly)', titleZh: '黃金教練 年繳', description: 'Coach Gold, billed once a year. Renews every year until cancelled.', priceUsd: 49.99, period: 'year', badge: 'Yearly' },
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
  { id: 'fourwinds.year', storeId: 'fourwinds.year', kind: 'subscription', tier: 'fourwinds', title: 'The Four Winds Club (yearly)', titleZh: '四風俱樂部 年繳', description: 'The Four Winds Club, billed once a year. Renews every year until cancelled.', priceUsd: 79.99, period: 'year', badge: 'Yearly' },
];

export const ALL_PRODUCTS: Product[] = [...DIAMOND_PACKS, ...COSMETICS, ...BUNDLES, ...SUBSCRIPTIONS];

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
