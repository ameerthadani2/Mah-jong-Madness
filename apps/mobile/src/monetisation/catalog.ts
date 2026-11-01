/**
 * In-app purchase catalog. Everything sold here is cosmetic, convenience or
 * club capacity — nothing changes tile odds or information at the table.
 * Prices are App Store / Play tier placeholders; see docs/MONETISATION.md for
 * the pricing rationale and the PokerBros/chess.com comparison.
 */
export type ProductKind = 'diamonds' | 'cosmetic' | 'subscription' | 'club';

export interface Product {
  id: string;
  kind: ProductKind;
  title: string;
  titleZh: string;
  description: string;
  /** Store price in USD (placeholder tier); the store SDK supplies the localised string at runtime. */
  priceUsd: number;
  /** For `diamonds`: how many diamonds the pack grants (incl. bonus). */
  diamonds?: number;
  /** For items purchasable with diamonds instead of money. */
  diamondPrice?: number;
  /** For `cosmetic`: the theme/avatar id unlocked. */
  unlocks?: string;
  /** For `subscription`: billing period. */
  period?: 'month' | 'year';
  badge?: string;
}

export const DIAMOND_PACKS: Product[] = [
  { id: 'diamonds.100', kind: 'diamonds', title: '100 Diamonds', titleZh: '100 鑽石', description: 'A handful for a table look or an emote pack.', priceUsd: 0.99, diamonds: 100 },
  { id: 'diamonds.550', kind: 'diamonds', title: '550 Diamonds', titleZh: '550 鑽石', description: '10% bonus.', priceUsd: 4.99, diamonds: 550, badge: '+10%' },
  { id: 'diamonds.1200', kind: 'diamonds', title: '1,200 Diamonds', titleZh: '1,200 鑽石', description: '20% bonus. Most popular.', priceUsd: 9.99, diamonds: 1200, badge: 'Popular' },
  { id: 'diamonds.2600', kind: 'diamonds', title: '2,600 Diamonds', titleZh: '2,600 鑽石', description: '30% bonus.', priceUsd: 19.99, diamonds: 2600, badge: '+30%' },
  { id: 'diamonds.7000', kind: 'diamonds', title: '7,000 Diamonds', titleZh: '7,000 鑽石', description: '40% bonus. Club owners’ pick.', priceUsd: 49.99, diamonds: 7000, badge: '+40%' },
];

export const COSMETICS: Product[] = [
  { id: 'theme.nightmarket', kind: 'cosmetic', title: 'Night Market table', titleZh: '夜市霓虹桌布', description: 'Neon purple felt with pink accents.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'nightmarket' },
  { id: 'theme.bamboo', kind: 'cosmetic', title: 'Bamboo Garden table', titleZh: '竹林桌布', description: 'Soft green felt, ivory tiles.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'bamboo' },
  { id: 'theme.imperial', kind: 'cosmetic', title: 'Imperial Red table', titleZh: '宮廷紅桌布', description: 'Lacquer red with gold trim.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'imperial' },
  { id: 'avatars.zodiac', kind: 'cosmetic', title: 'Zodiac avatar pack', titleZh: '生肖頭像包', description: 'Twelve animated zodiac avatars.', priceUsd: 4.99, diamondPrice: 500, unlocks: 'avatars.zodiac' },
  { id: 'emotes.taiwan', kind: 'cosmetic', title: 'Taiwan emote pack', titleZh: '台味表情包', description: '珍奶, 雞排 and friends.', priceUsd: 1.99, diamondPrice: 200, unlocks: 'emotes.taiwan' },
];

export const SUBSCRIPTIONS: Product[] = [
  { id: 'coach.pro.month', kind: 'subscription', title: 'Coach Pro', titleZh: '教練 Pro', description: 'Unlimited hand reviews, every lesson, Puzzle Rush stats, pro bots.', priceUsd: 6.99, period: 'month' },
  { id: 'coach.pro.year', kind: 'subscription', title: 'Coach Pro (yearly)', titleZh: '教練 Pro 年繳', description: 'Two months free.', priceUsd: 59.99, period: 'year', badge: 'Save 28%' },
];

export const CLUB_PRODUCTS: Product[] = [
  { id: 'club.tier.50', kind: 'club', title: 'Club up to 50 members', titleZh: '俱樂部 50 人', description: 'Monthly. Members, tables and standings for a regular group.', priceUsd: 9.99, diamondPrice: 1000, period: 'month' },
  { id: 'club.tier.200', kind: 'club', title: 'Club up to 200 members', titleZh: '俱樂部 200 人', description: 'Monthly. Multiple tables, admins, approval queue, neutral host.', priceUsd: 29.99, diamondPrice: 3000, period: 'month' },
  { id: 'club.tier.1000', kind: 'club', title: 'Club up to 1,000 members', titleZh: '俱樂部 1000 人', description: 'Monthly. Unions of clubs, exports, priority hosting.', priceUsd: 99.99, diamondPrice: 10000, period: 'month' },
];

export const ALL_PRODUCTS: Product[] = [...DIAMOND_PACKS, ...COSMETICS, ...SUBSCRIPTIONS, ...CLUB_PRODUCTS];

export function productById(id: string): Product | undefined {
  return ALL_PRODUCTS.find((p) => p.id === id);
}

/** Free club tier: what you get without paying. */
export const FREE_CLUB_LIMITS = { members: 12, concurrentTables: 1 };
