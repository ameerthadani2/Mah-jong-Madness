/**
 * Table geometry under a tile scale (Settings → Display → Tiles). At scale 1 every number is exactly what
 * components/table/layout.ts gives; larger scales grow the hand, my melds, the ponds and the opponents' melds
 * while a full 17-tile hand still fits:
 *
 * - Portrait: the hand already wraps into two rows of nine; larger tiles wrap into a third row (never more:
 *   past three rows the tiles shrink instead).
 * - Landscape: the hand stays one row and grows only as far as the rail's width allows, so it never scrolls
 *   sideways (`scroll` stays false at every scale; the rail keeps its scroll fallback should a row ever overflow).
 * - Ponds grow too, but a side seat always keeps three tiles per row, and short landscape phones (under 420 px
 *   tall) stop at Large so the side ponds never run off the felt.
 * - A side seat in landscape has one short column for its melds, flowers and discards. `fitSideColumn` shrinks
 *   the melds first, then the pond, until they fit the column; when even the smallest sizes do not (four melds
 *   late in a hand on a small phone) the row of face-down tiles makes way, and past that the column scrolls
 *   and stays at its newest discards.
 *
 * Pure, so the fit is unit-tested at the reference viewports.
 */
import { handLayout, type HandLayout, type TableLayout } from '../components/table/layout';
import { tileDims } from '../components/tileDims';

/** Gap between hand tiles, the hand row's side padding (both sides), the extra gap before the drawn tile. */
export const HAND_GAP = 2;
export const HAND_PAD = 8;
export const DRAWN_GAP = 10;
/** The rail never wraps into more rows than this. */
export const MAX_HAND_ROWS = 3;

export interface HandFit extends HandLayout {
  /** Width of one tile in my melds. */
  meldTile: number;
  /** Landscape only: the hand row is wider than the rail and scrolls sideways. */
  scroll: boolean;
  /** Tiles per row and rows, for a full hand. */
  perRow: number;
  rows: number;
}

/** Hand slots reserved so the size never jumps between turns: a full hand (16 − 3 per meld, +1 drawn). */
export function handSlots(handCount: number, meldCount: number): number {
  return Math.max(handCount, 17 - 3 * meldCount, 2);
}

/** Rows a greedy wrap of `count` tiles takes in `room` px (the last tile carries the drawn tile's extra gap). */
export function wrapRows(count: number, tile: number, room: number): number {
  let rows = 1;
  let x = 0;
  for (let i = 0; i < count; i++) {
    const w = tile + (i === count - 1 && count > 1 ? DRAWN_GAP : 0);
    const next = x === 0 ? w : x + HAND_GAP + w;
    if (next > room && x > 0) {
      rows++;
      x = w;
    } else x = next;
  }
  return rows;
}

/** Width of one row of `count` hand tiles, including the drawn tile's gap and the row padding. */
export function rowWidth(count: number, tile: number): number {
  return count * (tile + HAND_GAP) - HAND_GAP + (count > 1 ? DRAWN_GAP : 0) + HAND_PAD;
}

/** The width the hand row actually has in portrait (the footer pads 12 px a side, the row 4 px a side). */
export function portraitRowRoom(width: number): number {
  return width - 24 - HAND_PAD;
}

export function fitHand(width: number, height: number, L: Pick<TableLayout, 'portrait' | 'tablet' | 'compact'>, handCount: number, meldTiles: number, meldCount: number, tileScale: number): HandFit {
  const base = handLayout(width, L, handCount, meldTiles, meldCount);
  const slots = handSlots(handCount, meldCount);
  const smW = tileDims('sm').w;
  const scale = Number.isFinite(tileScale) && tileScale > 1 ? tileScale : 1;

  if (L.portrait) {
    const room = portraitRowRoom(width);
    let tile = scale === 1 ? base.tile : Math.min(72, Math.round(base.tile * scale));
    while (tile > base.tile && wrapRows(slots, tile, room) > MAX_HAND_ROWS) tile--;
    const perRow = Math.max(1, Math.floor((room + HAND_GAP) / (tile + HAND_GAP)));
    // My melds sit on their own line above the hand in portrait and wrap, so they simply scale.
    return { ...base, tile, meldTile: Math.round(smW * scale), scroll: false, perRow, rows: wrapRows(slots, tile, room) };
  }

  // Landscape: the hand row and my melds share the rail. Both are measured as they are drawn (each meld has a
  // tile lying on its side), or the drawn tile at the end of the hand runs over the first meld.
  const rail = width - 24 - base.plateW;
  const used = (tile: number, meld: number) => rowWidth(slots, tile) + (meldTiles > 0 ? 10 + myMeldsWidth(meldTiles, meldCount, meld) : 0);
  // What does not fit gives way a pixel at a time, the melds before the hand, neither below its floor.
  const settle = (tile: number, meldTile: number): HandFit => {
    while (used(tile, meldTile) > rail && meldTile > MIN_MY_MELD) meldTile--;
    while (used(tile, meldTile) > rail && tile > MIN_RAIL_TILE) tile--;
    return { ...base, tile, meldTile, scroll: used(tile, meldTile) > rail, perRow: slots, rows: 1 };
  };
  if (scale === 1) return settle(base.tile, smW);
  // My melds grow only while they take under 40 % of the width, and only while the hand still fits beside
  // them at its Normal size.
  const meldRoom = Math.min(width * 0.4, rail - 10 - rowWidth(slots, base.tile));
  // A tile is 1.4× as tall as it is wide; the rail may take a fifth of the screen height.
  const heightCap = Math.floor((height * 0.2) / 1.4);
  const room = (meld: number) => rail - (meldTiles > 0 ? 10 + myMeldsWidth(meldTiles, meldCount, meld) : 0);
  let meldTile = Math.max(smW, Math.round(smW * scale));
  while (meldTile > smW && (myMeldsWidth(meldTiles, meldCount, meldTile) > meldRoom || fitRowTile(slots, room(meldTile)) < base.tile)) meldTile--;
  // The scaled row shrinks to the rail's width rather than scrolling sideways (a hidden tile is a tile the
  // player cannot see); it never goes below the Normal size unless that itself does not fit beside the melds.
  const widthCap = fitRowTile(slots, room(meldTile));
  const tile = Math.max(base.tile, Math.min(90, heightCap, widthCap, Math.round(base.tile * scale)));
  return settle(tile, meldTile);
}

/** The smallest my melds and my hand tiles are drawn on the landscape rail when both must give way. */
export const MIN_MY_MELD = 22;
export const MIN_RAIL_TILE = 22;

/**
 * Width of my melds on the landscape rail as HandRail draws them: every tile a pixel from the next, one
 * tile of each meld lying on its side (the claimed one), and 5 px after each meld.
 */
export function myMeldsWidth(meldTiles: number, meldCount: number, tile: number): number {
  if (meldTiles <= 0 || meldCount <= 0) return 0;
  return meldTiles * tile + (meldTiles - meldCount) + meldCount * (Math.round(tile * 1.4) - tile + 5);
}

/** The widest tile that puts a row of `count` hand tiles (with the drawn tile's gap and the padding) inside `room` px. */
export function fitRowTile(count: number, room: number): number {
  if (count <= 0) return 0;
  return Math.floor((room - HAND_PAD - (count > 1 ? DRAWN_GAP : 0) + HAND_GAP) / count) - HAND_GAP;
}

export interface PoolFit {
  /** Width of one pond tile. */
  tile: number;
  centerPerRow: number;
  myPerRow: number;
  sidePerRow: number;
  /** How much the opponents' melds grow with the ponds (1 at Normal). */
  meldScale: number;
}

/** Pond tiles under a tile scale, with tiles per row recomputed by layout.ts's own rules. */
export function fitPools(L: TableLayout, tileScale: number): PoolFit {
  const base = tileDims(L.pool).w;
  const want = Number.isFinite(tileScale) && tileScale > 1 ? (L.compact ? Math.min(tileScale, 1.25) : tileScale) : 1;
  if (want === 1) return { tile: base, centerPerRow: L.centerPerRow, myPerRow: L.myPerRow, sidePerRow: L.sidePerRow, meldScale: 1 };
  // A side seat keeps at least three tiles a row and the centre at least five.
  const maxSide = Math.floor((L.sideWidth - 4) / 3) - 2;
  const maxCenter = Math.floor(L.centerW / 5) - 2;
  const tile = Math.max(base, Math.min(Math.round(base * want), maxSide, maxCenter));
  const poolW = tile + 2;
  return {
    tile,
    centerPerRow: Math.max(5, Math.min(L.portrait ? 8 : 12, Math.floor(L.centerW / poolW))),
    myPerRow: Math.max(5, Math.min(12, Math.floor((L.centerW - (L.compact ? 62 : 74) - 14) / poolW))),
    sidePerRow: Math.max(3, Math.min(7, Math.floor((L.sideWidth - 4) / poolW))),
    meldScale: tile / base,
  };
}

/** The gap between a side seat's blocks (plate, melds, pond) and between the rows of its melds and of its pond. */
export const SIDE_GAP = 6;
const MELD_ROW_GAP = 3;
const POND_GAP = 2;
/** The smallest a side seat's meld and pond tiles are drawn (px wide) before its column scrolls instead. */
export const MIN_SIDE_MELD = 14;
export const MIN_SIDE_POND = 16;

export interface SideSeatInput {
  /** Width of the side column. */
  width: number;
  /** Height the column has under the plate and the hidden hand, for melds, flowers and the pond (0: not measured yet). */
  room: number;
  /** Tiles in each exposed meld (3, or 4 for a kong). */
  melds: readonly number[];
  flowers: number;
  discards: number;
  /** The sizes to start from: meld tile width and pond tile width at the current tile scale. */
  meld: number;
  pool: number;
}

export interface SideSeatFit {
  /** Width of a meld tile, a flower tile and a pond tile. */
  meld: number;
  pool: number;
  perRow: number;
  /** Height the melds, flowers and pond take at these sizes. */
  height: number;
  /** They do not fit even at the smallest sizes: the column scrolls. */
  scroll: boolean;
}

const tileH = (w: number) => Math.round(w * 1.4);

/** Width of one meld as TableParts draws it: the tiles a pixel apart, the claimed one lying on its side, 5 px after it. */
export function meldWidth(tiles: number, w: number): number {
  return tiles * w + (tiles - 1) + (tileH(w) - w) + 5;
}

/** Tiles a side pond puts in a row (layout.ts's rule): three at least, seven at most. */
export function sidePondPerRow(width: number, w: number): number {
  return Math.max(3, Math.min(7, Math.floor((width - 4) / (w + POND_GAP))));
}

/** Height of a side seat's melds, flowers and pond at the given tile widths, wrapped into `width`. */
export function sideSeatHeight(input: Pick<SideSeatInput, 'width' | 'melds' | 'flowers' | 'discards'>, meld: number, pool: number): number {
  const { width, melds, flowers, discards } = input;
  let rows = 0;
  let x = 0;
  for (const n of melds) {
    const w = meldWidth(n, meld);
    if (rows === 0 || x + w > width) {
      rows++;
      x = w;
    } else x += w;
  }
  if (flowers > 0) {
    const flowersW = flowers * (meld + 1) - 1;
    // The flowers follow the last meld on its line when they all fit there; otherwise they wrap on lines of their own.
    if (rows === 0 || x + flowersW > width) rows += Math.ceil(flowers / Math.max(1, Math.floor((width + 1) / (meld + 1))));
  }
  const meldsH = rows > 0 ? rows * tileH(meld) + (rows - 1) * MELD_ROW_GAP : 0;
  const pondRows = Math.ceil(discards / sidePondPerRow(width, pool));
  const pondH = pondRows > 0 ? pondRows * tileH(pool) + (pondRows - 1) * POND_GAP : 0;
  return meldsH + (meldsH > 0 && pondH > 0 ? SIDE_GAP : 0) + pondH;
}

/**
 * Sizes for a side seat's melds and pond in landscape so that both stay on the felt: the sizes given while
 * they fit `room`, then smaller melds (the discards are what a player reads to judge what is safe, so the
 * pond keeps its size longest), then a smaller pond. Never below MIN_SIDE_MELD and MIN_SIDE_POND: past
 * that the column scrolls (`scroll`), which the felt keeps at the newest discards.
 */
export function fitSideSeat(input: SideSeatInput): SideSeatFit {
  const at = (meld: number, pool: number, scroll = false): SideSeatFit => ({ meld, pool, perRow: sidePondPerRow(input.width, pool), height: sideSeatHeight(input, meld, pool), scroll });
  const start = at(input.meld, input.pool);
  if (input.room <= 0 || start.height <= input.room) return start;
  const minMeld = Math.min(input.meld, MIN_SIDE_MELD);
  const minPool = Math.min(input.pool, MIN_SIDE_POND);
  for (let meld = input.meld - 1; meld >= minMeld; meld--) {
    const fit = at(meld, input.pool);
    if (fit.height <= input.room) return fit;
  }
  for (let pool = input.pool - 1; pool >= minPool; pool--) {
    const fit = at(minMeld, pool);
    if (fit.height <= input.room) return fit;
  }
  return at(minMeld, minPool, true);
}

export interface SideColumnInput extends Omit<SideSeatInput, 'room'> {
  /** Measured height of the whole side column and of the plate at its top (0: not measured yet). */
  column: number;
  plate: number;
  /** Height of the row of face-down tiles under the plate (0 when the seat holds none). */
  hand: number;
}

export interface SideColumnFit extends SideSeatFit {
  /** The row of face-down tiles is drawn. It makes way when the melds and the pond would not fit under it. */
  showHand: boolean;
}

/**
 * A side seat's whole column in landscape: the plate, the row of face-down tiles, then the melds and the pond
 * fitted into what is left (`fitSideSeat`). When they do not fit even at the smallest sizes, the face-down row
 * goes first (how many tiles the seat holds is what its melds leave of sixteen), and only then does the
 * column scroll.
 */
export function fitSideColumn(input: SideColumnInput): SideColumnFit {
  const { column, plate, hand, ...seat } = input;
  const measured = column > 0 && plate > 0;
  const under = measured ? Math.max(1, column - plate - SIDE_GAP) : 0;
  const withHand = fitSideSeat({ ...seat, room: measured ? Math.max(1, under - (hand > 0 ? hand + SIDE_GAP : 0)) : 0 });
  if (!withHand.scroll || hand <= 0) return { ...withHand, showHand: true };
  return { ...fitSideSeat({ ...seat, room: under }), showHand: false };
}
