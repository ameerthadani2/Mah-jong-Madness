/**
 * Every cosmetic design, as data. Everything is drawn in code (react-native-svg), with no
 * commissioned art and no coins, chips or money imagery: table felts with a pattern
 * (themes.ts), tile backs (components/Tile.tsx), avatar frames (components/Avatars.tsx), emote
 * packs (components/EmotePacks.tsx) and win celebrations (components/Celebrations.tsx).
 *
 * The catalogue (./catalog.ts) sells each one for diamonds; this file only says how it looks.
 * Pure TypeScript, so the tests check that every item on sale has a design and the other way
 * round.
 */

/** Felt patterns a table look can carry (drawn by components/FeltPattern.tsx). */
export const FELT_PATTERNS = ['lanterns', 'lattice', 'waves', 'blossoms', 'clouds', 'stars', 'fretwork', 'scales'] as const;
export type FeltPatternId = (typeof FELT_PATTERNS)[number];

/** Motifs drawn in the middle of a tile back. */
export type BackMotif = 'jade' | 'knot' | 'star' | 'lotus' | 'bamboo' | 'wave' | 'cloud' | 'lattice' | 'sun' | 'scales';

export interface TileBackDesign {
  /** Unlock id (`back.<name>`), also the product id. */
  id: string;
  name: string;
  nameZh: string;
  /** Main colour of the back and the tile's thickness. */
  base: string;
  /** Highlight colour of the back's gradient. */
  light: string;
  motif: BackMotif;
  /** Colour of the motif. */
  ink: string;
}

export const TILE_BACKS: readonly TileBackDesign[] = [
  { id: 'back.jade', name: 'Polished Jade', nameZh: '溫潤玉石', base: '#0E7A57', light: '#5FD3A5', motif: 'jade', ink: '#E9FFF5' },
  { id: 'back.crimson', name: 'Crimson Knot', nameZh: '朱紅中國結', base: '#A3202B', light: '#F0646B', motif: 'knot', ink: '#FFE3A3' },
  { id: 'back.midnight', name: 'Midnight Star', nameZh: '午夜星辰', base: '#1C2459', light: '#4E5DC0', motif: 'star', ink: '#FFE46B' },
  { id: 'back.lotus', name: 'Lotus Pond', nameZh: '荷花池', base: '#B0507E', light: '#F3A6CB', motif: 'lotus', ink: '#FFF2F8' },
  { id: 'back.bamboo', name: 'Bamboo Grove', nameZh: '竹影', base: '#4E7A22', light: '#A6D45E', motif: 'bamboo', ink: '#F4FFE0' },
  { id: 'back.wave', name: 'Ocean Wave', nameZh: '浪花', base: '#1E5F92', light: '#62B6EE', motif: 'wave', ink: '#E6F6FF' },
  { id: 'back.cloud', name: 'Lucky Cloud', nameZh: '祥雲', base: '#16766F', light: '#5ACFC5', motif: 'cloud', ink: '#FFF4CF' },
  { id: 'back.lattice', name: 'Teahouse Lattice', nameZh: '茶館窗花', base: '#6B4226', light: '#C08A5A', motif: 'lattice', ink: '#FCE7C8' },
  { id: 'back.sunset', name: 'Sunset Rays', nameZh: '夕照', base: '#C4561E', light: '#FFB347', motif: 'sun', ink: '#FFF4D6' },
  { id: 'back.dragon', name: 'Dragon Scale', nameZh: '龍鱗', base: '#1F6B46', light: '#E9B949', motif: 'scales', ink: '#FFF0B8' },
];

/** How an avatar frame decorates the ring around the portrait. */
export type FrameStyle = 'bamboo' | 'jade' | 'gilded' | 'blossom' | 'wave' | 'cloud' | 'flame' | 'star' | 'lantern' | 'dragon' | 'phoenix' | 'rainbow';

export interface FrameDesign {
  id: string;
  name: string;
  nameZh: string;
  style: FrameStyle;
  /** Ring gradient, light to dark. */
  ring: readonly [string, string, string];
  /** Colour of the decorations on the ring. */
  accent: string;
}

export const FRAMES: readonly FrameDesign[] = [
  { id: 'frame.bamboo', name: 'Bamboo Ring', nameZh: '竹節框', style: 'bamboo', ring: ['#D7F09A', '#7FB33A', '#3F6A16'], accent: '#2E5210' },
  { id: 'frame.jade', name: 'Jade Bangle', nameZh: '玉鐲框', style: 'jade', ring: ['#C9FFE8', '#3FBF8C', '#0E6A48'], accent: '#E9FFF5' },
  { id: 'frame.gilded', name: 'Gilded Ring', nameZh: '鎏金框', style: 'gilded', ring: ['#FFF4C2', '#F4C24A', '#A86E14'], accent: '#FFFFFF' },
  { id: 'frame.blossom', name: 'Plum Blossom', nameZh: '梅花框', style: 'blossom', ring: ['#FFE0EE', '#E87BAA', '#9C2F5E'], accent: '#FFFFFF' },
  { id: 'frame.wave', name: 'Rolling Waves', nameZh: '浪花框', style: 'wave', ring: ['#D6F1FF', '#4BA6E0', '#1A5A8C'], accent: '#FFFFFF' },
  { id: 'frame.cloud', name: 'Lucky Clouds', nameZh: '祥雲框', style: 'cloud', ring: ['#D5FFF8', '#4CC7BB', '#14706A'], accent: '#FFF4CF' },
  { id: 'frame.flame', name: 'Hot Streak', nameZh: '火焰框', style: 'flame', ring: ['#FFE6A0', '#FF8A2B', '#C2321B'], accent: '#FFE46B' },
  { id: 'frame.star', name: 'Starlight', nameZh: '星光框', style: 'star', ring: ['#E2E6FF', '#7A86E8', '#2B3270'], accent: '#FFE46B' },
  { id: 'frame.lantern', name: 'Lantern Glow', nameZh: '燈籠框', style: 'lantern', ring: ['#FFD9A8', '#E5482F', '#8A1A12'], accent: '#FFD34D' },
  { id: 'frame.dragon', name: 'Jade Dragon', nameZh: '玉龍框', style: 'dragon', ring: ['#FFF0B8', '#2FA66A', '#0B4A2C'], accent: '#F4C04E' },
  { id: 'frame.phoenix', name: 'Phoenix Feather', nameZh: '鳳羽框', style: 'phoenix', ring: ['#FFE3C2', '#F05A5A', '#7A1E5C'], accent: '#FFD34D' },
  { id: 'frame.rainbow', name: 'Rainbow Ribbon', nameZh: '彩虹框', style: 'rainbow', ring: ['#FF6B6B', '#FFD34D', '#4BA6E0'], accent: '#FFFFFF' },
];

/**
 * Emote packs: six emotes each. Ids travel over the network next to the free emotes
 * (themes.ts `EMOTES`), so each is at most 16 characters and starts with its pack's code.
 */
export const EMOTE_PACKS = {
  'emotes.teahouse': ['th.tea', 'th.bun', 'th.dumpling', 'th.noodles', 'th.mooncake', 'th.tangerine'],
  'emotes.nightmarket': ['nm.boba', 'nm.skewer', 'nm.shavedice', 'nm.corn', 'nm.lantern', 'nm.firecracker'],
  'emotes.festival': ['fs.firework', 'fs.knot', 'fs.drum', 'fs.kite', 'fs.moon', 'fs.dragonboat'],
  'emotes.zodiac': ['zd.rat', 'zd.ox', 'zd.tiger', 'zd.rabbit', 'zd.dragon', 'zd.rooster'],
} as const satisfies Record<string, readonly string[]>;
export type EmotePackId = keyof typeof EMOTE_PACKS;
export type PackEmoteId = (typeof EMOTE_PACKS)[EmotePackId][number];

export const PACK_EMOTE_IDS: readonly PackEmoteId[] = Object.values(EMOTE_PACKS).flat();

export function isPackEmoteId(id: string): id is PackEmoteId {
  return (PACK_EMOTE_IDS as readonly string[]).includes(id);
}

/** The pack an emote belongs to, or null for a free emote or an unknown id. */
export function packOfEmote(id: string): EmotePackId | null {
  for (const [pack, ids] of Object.entries(EMOTE_PACKS) as Array<[EmotePackId, readonly string[]]>) if (ids.includes(id)) return pack;
  return null;
}

/** Win celebrations (components/Celebrations.tsx). */
export const CELEBRATIONS = ['win.fireworks', 'win.lanterns', 'win.dragon', 'win.petals'] as const;
export type CelebrationId = (typeof CELEBRATIONS)[number];

export function tileBackById(id: string | null | undefined): TileBackDesign | null {
  return (id && TILE_BACKS.find((b) => b.id === id)) || null;
}

export function frameById(id: string | null | undefined): FrameDesign | null {
  return (id && FRAMES.find((f) => f.id === id)) || null;
}
