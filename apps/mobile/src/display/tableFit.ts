/**
 * Table geometry under a tile scale (Settings → Display → Tiles). At scale 1 every number is exactly what
 * components/table/layout.ts gives; larger scales grow the hand, my melds, the ponds and the opponents' melds
 * while a full 17-tile hand still fits:
 *
 * - Portrait: the hand already wraps into two rows of nine; larger tiles wrap into a third row (never more:
 *   past three rows the tiles shrink instead).
 * - Landscape: the hand stays one row. When the scaled row is wider than the rail, the rail scrolls sideways
 *   (`scroll`), and the drawn tile is scrolled into view by the rail.
 * - Ponds grow too, but a side seat always keeps three tiles per row, and short landscape phones (under 420 px
 *   tall) stop at Large so the side ponds never run off the felt.
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

  if (scale === 1) return { ...base, meldTile: smW, scroll: false, perRow: slots, rows: 1 };
  // Landscape: my melds share the rail with the hand, so they grow only while they take under 40 % of the width.
  const meldCap = meldTiles > 0 ? Math.floor((width * 0.4 - meldCount * 8) / meldTiles) - 1 : smW;
  const meldTile = Math.max(smW, Math.min(Math.round(smW * scale), meldCap));
  const meldW = meldTiles * (meldTile + 1) + meldCount * 8;
  const avail = width - 24 - base.plateW - (meldW ? meldW + 10 : 0);
  // A tile is 1.4× as tall as it is wide; the rail may take a fifth of the screen height.
  const heightCap = Math.floor((height * 0.2) / 1.4);
  const tile = Math.max(base.tile, Math.min(90, heightCap, Math.round(base.tile * scale)));
  return { ...base, tile, meldTile, scroll: rowWidth(slots, tile) > avail, perRow: slots, rows: 1 };
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
