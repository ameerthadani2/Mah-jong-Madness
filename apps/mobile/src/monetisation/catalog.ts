/**
 * In-app purchase catalog. Everything sold here is cosmetic, coaching or club
 * capacity — nothing changes tile odds, information or clocks at the table.
 * Pricing follows docs/MONETISATION.md: a PokerBros-style Diamond ladder
 * (~60 per USD) and chess.com-style coaching tiers. Store SDKs supply the
 * localised price strings at runtime; USD here are tier placeholders.
 */
export type ProductKind = 'diamonds' | 'cosmetic' | 'subscription' | 'club' | 'vip';
export type CoachTier = 'free' | 'gold' | 'platinum' | 'diamond';

export interface Product {
  id: string;
  kind: ProductKind;
  title: string;
  titleZh: string;
  description: string;
  priceUsd: number;
  /** For `diamonds`: diamonds granted including bonus. */
  diamonds?: number;
  /** Items purchasable with diamonds instead of money. */
  diamondPrice?: number;
  /** For `cosmetic`: theme/avatar/emote pack id unlocked. */
  unlocks?: string;
  /** For `subscription` / `club`: billing period. */
  period?: 'month' | 'year';
  /** For `subscription`: the coaching tier granted. */
  tier?: CoachTier;
  /** For `vip`: days of VIP. */
  days?: number;
  /** For `club`: member capacity. */
  capacity?: number;
  badge?: string;
}

export const DIAMOND_PACKS: Product[] = [
  { id: 'diamonds.60', kind: 'diamonds', title: '60 Diamonds', titleZh: '60 鑽石', description: 'Enough for an emote pack.', priceUsd: 0.99, diamonds: 60 },
  { id: 'diamonds.300', kind: 'diamonds', title: '300 Diamonds', titleZh: '300 鑽石', description: 'A table look, or a Bronze VIP month.', priceUsd: 4.99, diamonds: 300 },
  { id: 'diamonds.600', kind: 'diamonds', title: '600 Diamonds', titleZh: '600 鑽石', description: 'Most popular.', priceUsd: 9.99, diamonds: 600, badge: 'Popular' },
  { id: 'diamonds.1300', kind: 'diamonds', title: '1,300 Diamonds', titleZh: '1,300 鑽石', description: 'Runs a 100-member club for a month.', priceUsd: 19.99, diamonds: 1300, badge: 'Clubs' },
  { id: 'diamonds.3000', kind: 'diamonds', title: '3,000 Diamonds', titleZh: '3,000 鑽石', description: '+15% bonus.', priceUsd: 49.99, diamonds: 3000, badge: '+15%' },
  { id: 'diamonds.6500', kind: 'diamonds', title: '6,500 Diamonds', titleZh: '6,500 鑽石', description: '+25% bonus. Club owners’ pick.', priceUsd: 99.99, diamonds: 6500, badge: '+25%' },
];

export const COSMETICS: Product[] = [
  { id: 'theme.nightmarket', kind: 'cosmetic', title: 'Night Market table', titleZh: '夜市霓虹桌布', description: 'Neon purple felt with pink accents.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'nightmarket' },
  { id: 'theme.bamboo', kind: 'cosmetic', title: 'Bamboo Garden table', titleZh: '竹林桌布', description: 'Soft green felt, ivory tiles.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'bamboo' },
  { id: 'theme.imperial', kind: 'cosmetic', title: 'Imperial Red table', titleZh: '宮廷紅桌布', description: 'Lacquer red with gold trim.', priceUsd: 2.99, diamondPrice: 300, unlocks: 'imperial' },
  { id: 'avatars.zodiac', kind: 'cosmetic', title: 'Zodiac avatar pack', titleZh: '生肖頭像包', description: 'Twelve zodiac avatars with gold frames.', priceUsd: 4.99, diamondPrice: 500, unlocks: 'avatars.zodiac' },
  { id: 'emotes.taiwan', kind: 'cosmetic', title: 'Taiwan emote pack', titleZh: '台味表情包', description: '珍奶, 雞排 and friends.', priceUsd: 1.99, diamondPrice: 200, unlocks: 'emotes.taiwan' },
];

export const SUBSCRIPTIONS: Product[] = [
  { id: 'coach.gold.month', kind: 'subscription', tier: 'gold', title: 'Coach Gold', titleZh: '教練 金', description: 'All lessons, unlimited Puzzle Rush, Pro bots, review history.', priceUsd: 6.99, period: 'month' },
  { id: 'coach.gold.year', kind: 'subscription', tier: 'gold', title: 'Coach Gold (yearly)', titleZh: '教練 金 年繳', description: 'Save 40%.', priceUsd: 49.99, period: 'year', badge: 'Save 40%' },
  { id: 'coach.platinum.month', kind: 'subscription', tier: 'platinum', title: 'Coach Platinum', titleZh: '教練 白金', description: 'Gold + unlimited hand reviews, puzzle battles, luck dashboard.', priceUsd: 10.99, period: 'month', badge: 'Best for improvers' },
  { id: 'coach.platinum.year', kind: 'subscription', tier: 'platinum', title: 'Coach Platinum (yearly)', titleZh: '教練 白金 年繳', description: 'Save 39%.', priceUsd: 79.99, period: 'year' },
  { id: 'coach.diamond.month', kind: 'subscription', tier: 'diamond', title: 'Coach Diamond', titleZh: '教練 鑽石', description: 'Platinum + move-by-move explanations, insights, club-table discounts.', priceUsd: 16.99, period: 'month' },
  { id: 'coach.diamond.year', kind: 'subscription', tier: 'diamond', title: 'Coach Diamond (yearly)', titleZh: '教練 鑽石 年繳', description: 'Save 41%.', priceUsd: 119.99, period: 'year' },
  { id: 'coach.tablepass.year', kind: 'subscription', tier: 'diamond', title: 'Table Pass (6 seats)', titleZh: '牌桌通行證（6人）', description: 'Coach Diamond for six club members. One bill for the whole table.', priceUsd: 199.99, period: 'year', badge: '6 seats' },
];

export const VIP_CARDS: Product[] = [
  { id: 'vip.bronze.30', kind: 'vip', days: 30, title: 'Bronze VIP · 30 days', titleZh: '銅卡 30天', description: 'All table looks, 50 emotes, +1 club slot, +1 review/day.', priceUsd: 4.99, diamondPrice: 300 },
  { id: 'vip.silver.90', kind: 'vip', days: 90, title: 'Silver VIP · 90 days', titleZh: '銀卡 90天', description: 'Bronze perks for three months.', priceUsd: 12.99, diamondPrice: 800 },
  { id: 'vip.gold.365', kind: 'vip', days: 365, title: 'Gold VIP · 365 days', titleZh: '金卡 365天', description: 'Bronze perks all year plus a yearly exclusive look.', priceUsd: 39.99, diamondPrice: 2500, badge: 'Best value' },
];

export const CLUB_PRODUCTS: Product[] = [
  { id: 'club.100', kind: 'club', capacity: 100, title: 'Club 100', titleZh: '俱樂部 100 人', description: '30 days · up to 100 members, 3 live tables, 5 admins.', priceUsd: 19.99, diamondPrice: 1300, period: 'month' },
  { id: 'club.300', kind: 'club', capacity: 300, title: 'Club 300', titleZh: '俱樂部 300 人', description: '30 days · 300 members, 10 live tables, approval queue, neutral host.', priceUsd: 49.99, diamondPrice: 3000, period: 'month' },
  { id: 'club.1000', kind: 'club', capacity: 1000, title: 'Club 1,000', titleZh: '俱樂部 1000 人', description: '30 days · 1,000 members, unlimited tables, unions, exports.', priceUsd: 129.99, diamondPrice: 8000, period: 'month' },
];

export const ALL_PRODUCTS: Product[] = [...DIAMOND_PACKS, ...COSMETICS, ...SUBSCRIPTIONS, ...VIP_CARDS, ...CLUB_PRODUCTS];

export function productById(id: string): Product | undefined {
  return ALL_PRODUCTS.find((p) => p.id === id);
}

/** Free club tier: what you get without paying. */
export const FREE_CLUB_LIMITS = { members: 30, managers: 2, concurrentTables: 1 };

/** Daily meters for the free tier (reset at local midnight). */
export const FREE_METERS = { reviewsPerDay: 1, rushPerDay: 1 };
