/**
 * Tile model for Taiwanese 16-tile Mahjong (台灣十六張麻將).
 *
 * A full set is 144 tiles:
 *   - 3 suits (萬 characters, 筒 dots, 條 bamboo) × ranks 1–9 × 4 copies = 108
 *   - 4 winds (東南西北) × 4 copies = 16
 *   - 3 dragons (中發白) × 4 copies = 12
 *   - 8 bonus tiles: 4 flowers (梅蘭竹菊) + 4 seasons (春夏秋冬), 1 copy each = 8
 *
 * Two layers of identity are used throughout the engine:
 *   - `TileId` (0..143): a physical tile. Lets us track exactly which copy moved where.
 *   - `Kind` (0..41): what a tile *is*. 34 playable kinds + 8 bonus kinds.
 */

export type Suit = 'm' | 'p' | 's' | 'w' | 'd' | 'f';

/** Physical tile index 0..143 */
export type TileId = number;
/** Tile kind index 0..41 */
export type Kind = number;

export const NUM_TILES = 144;
export const NUM_PLAY_KINDS = 34;
export const NUM_KINDS = 42;

export const KIND_M1 = 0; // 萬 1..9 → 0..8
export const KIND_P1 = 9; // 筒 1..9 → 9..17
export const KIND_S1 = 18; // 條 1..9 → 18..26
export const KIND_WIND = 27; // 東南西北 → 27..30
export const KIND_DRAGON = 31; // 中發白 → 31..33
export const KIND_FLOWER = 34; // 梅蘭竹菊 → 34..37, 春夏秋冬 → 38..41

export const WINDS = ['東', '南', '西', '北'] as const;
export const WINDS_EN = ['East', 'South', 'West', 'North'] as const;
export const DRAGONS = ['中', '發', '白'] as const;
export const DRAGONS_EN = ['Red', 'Green', 'White'] as const;
export const FLOWERS = ['梅', '蘭', '竹', '菊', '春', '夏', '秋', '冬'] as const;
export const FLOWERS_EN = ['Plum', 'Orchid', 'Bamboo', 'Chrysanthemum', 'Spring', 'Summer', 'Autumn', 'Winter'] as const;
export const SUIT_ZH: Record<Suit, string> = { m: '萬', p: '筒', s: '條', w: '風', d: '元', f: '花' };
export const SUIT_EN: Record<Suit, string> = { m: 'Characters', p: 'Dots', s: 'Bamboo', w: 'Wind', d: 'Dragon', f: 'Bonus' };

export interface TileInfo {
  kind: Kind;
  suit: Suit;
  /** 1..9 for suits, 1..4 winds, 1..3 dragons, 1..8 bonus */
  rank: number;
  /** Short code such as "5m", "E", "C", "f3" */
  code: string;
  nameZh: string;
  nameEn: string;
  /** Unicode Mahjong Tiles block character (U+1F000..) */
  unicode: string;
  isHonor: boolean;
  isTerminal: boolean;
  isBonus: boolean;
}

const UNICODE_WIND = ['🀀', '🀁', '🀂', '🀃'];
const UNICODE_DRAGON = ['🀄', '🀅', '🀆'];
const UNICODE_M = ['🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏'];
const UNICODE_S = ['🀐', '🀑', '🀒', '🀓', '🀔', '🀕', '🀖', '🀗', '🀘'];
const UNICODE_P = ['🀙', '🀚', '🀛', '🀜', '🀝', '🀞', '🀟', '🀠', '🀡'];
const UNICODE_FLOWER = ['🀢', '🀣', '🀤', '🀥', '🀦', '🀧', '🀨', '🀩'];
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

function buildKinds(): TileInfo[] {
  const out: TileInfo[] = [];
  const suits: Array<[Suit, number, string[]]> = [
    ['m', KIND_M1, UNICODE_M],
    ['p', KIND_P1, UNICODE_P],
    ['s', KIND_S1, UNICODE_S],
  ];
  for (const [suit, base, uni] of suits) {
    for (let r = 1; r <= 9; r++) {
      out[base + r - 1] = {
        kind: base + r - 1,
        suit,
        rank: r,
        code: `${r}${suit}`,
        nameZh: `${CN_NUM[r - 1]}${SUIT_ZH[suit]}`,
        nameEn: `${r} ${SUIT_EN[suit]}`,
        unicode: uni[r - 1],
        isHonor: false,
        isTerminal: r === 1 || r === 9,
        isBonus: false,
      };
    }
  }
  const windCodes = ['E', 'S', 'W', 'N'];
  for (let i = 0; i < 4; i++) {
    out[KIND_WIND + i] = {
      kind: KIND_WIND + i,
      suit: 'w',
      rank: i + 1,
      code: windCodes[i],
      nameZh: WINDS[i],
      nameEn: `${WINDS_EN[i]} Wind`,
      unicode: UNICODE_WIND[i],
      isHonor: true,
      isTerminal: false,
      isBonus: false,
    };
  }
  const dragonCodes = ['C', 'F', 'B'];
  for (let i = 0; i < 3; i++) {
    out[KIND_DRAGON + i] = {
      kind: KIND_DRAGON + i,
      suit: 'd',
      rank: i + 1,
      code: dragonCodes[i],
      nameZh: DRAGONS[i],
      nameEn: `${DRAGONS_EN[i]} Dragon`,
      unicode: UNICODE_DRAGON[i],
      isHonor: true,
      isTerminal: false,
      isBonus: false,
    };
  }
  for (let i = 0; i < 8; i++) {
    out[KIND_FLOWER + i] = {
      kind: KIND_FLOWER + i,
      suit: 'f',
      rank: i + 1,
      code: `f${i + 1}`,
      nameZh: FLOWERS[i],
      nameEn: FLOWERS_EN[i],
      unicode: UNICODE_FLOWER[i],
      isHonor: false,
      isTerminal: false,
      isBonus: true,
    };
  }
  return out;
}

export const KINDS: readonly TileInfo[] = buildKinds();

/** Physical tile → kind. Tiles 0..135 are the 34 playable kinds × 4; 136..143 are the 8 bonus tiles. */
export function kindOf(tile: TileId): Kind {
  return tile < 136 ? (tile >> 2) : KIND_FLOWER + (tile - 136);
}

export function infoOf(tile: TileId): TileInfo {
  return KINDS[kindOf(tile)];
}

export function kindInfo(kind: Kind): TileInfo {
  return KINDS[kind];
}

export function isBonusTile(tile: TileId): boolean {
  return tile >= 136;
}

export function isSuited(kind: Kind): boolean {
  return kind < KIND_WIND;
}

export function isHonorKind(kind: Kind): boolean {
  return kind >= KIND_WIND && kind < KIND_FLOWER;
}

export function isWindKind(kind: Kind): boolean {
  return kind >= KIND_WIND && kind < KIND_DRAGON;
}

export function isDragonKind(kind: Kind): boolean {
  return kind >= KIND_DRAGON && kind < KIND_FLOWER;
}

export function suitOfKind(kind: Kind): Suit {
  return KINDS[kind].suit;
}

export function rankOfKind(kind: Kind): number {
  return KINDS[kind].rank;
}

/** Parse a short code like "5m", "E", "C", "f3" into a kind. Throws on invalid input. */
export function kindFromCode(code: string): Kind {
  const k = KINDS.find((t) => t.code === code);
  if (!k) throw new Error(`Unknown tile code: ${code}`);
  return k.kind;
}

/** Parse a compact hand string like "123m 456p EEE f1" into kinds (space-separated groups). */
export function kindsFromString(s: string): Kind[] {
  const out: Kind[] = [];
  for (const group of s.trim().split(/\s+/)) {
    if (!group) continue;
    const m = /^([1-9]+)([mps])$/.exec(group);
    if (m) {
      for (const ch of m[1]) out.push(kindFromCode(`${ch}${m[2]}`));
      continue;
    }
    if (/^[ESWNCFB]+$/.test(group)) {
      for (const ch of group) out.push(kindFromCode(ch));
      continue;
    }
    if (/^f[1-8]$/.test(group)) {
      out.push(kindFromCode(group));
      continue;
    }
    throw new Error(`Cannot parse tile group: ${group}`);
  }
  return out;
}

export function kindsToString(kinds: readonly Kind[]): string {
  return [...kinds]
    .sort((a, b) => a - b)
    .map((k) => KINDS[k].code)
    .join(' ');
}

/** Build a fresh unshuffled set of 144 physical tiles. */
export function fullSet(): TileId[] {
  const tiles: TileId[] = new Array(NUM_TILES);
  for (let i = 0; i < NUM_TILES; i++) tiles[i] = i;
  return tiles;
}

/** Count kinds in a list of tile ids (play kinds only; bonus tiles are skipped). */
export function countKinds(tiles: readonly TileId[]): number[] {
  const counts = new Array<number>(NUM_PLAY_KINDS).fill(0);
  for (const t of tiles) {
    const k = kindOf(t);
    if (k < NUM_PLAY_KINDS) counts[k]++;
  }
  return counts;
}

/** Sort tiles by kind then id for stable display. */
export function sortTiles(tiles: readonly TileId[]): TileId[] {
  return [...tiles].sort((a, b) => kindOf(a) - kindOf(b) || a - b);
}
