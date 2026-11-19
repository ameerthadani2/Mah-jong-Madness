/**
 * The portrait felt fits its box: nothing on it scrolls. The felt holds the three opponents (a column each side, the
 * across seat and the compass in the middle) and my pond pinned under them (the coach's bar sits under the felt, over
 * its wooden rail: TableScreen.tsx). When that is more than the felt's height, these give way, in this order, each only
 * as far as it must:
 *
 * 1. (the coach's bar keeps to two lines of advice on phones under 800 px tall, whatever the felt: layout.ts
 *    portraitCoachStatus; the sheet holds everything);
 * 2. the wall ring around the compass shrinks, then goes; the status line under the compass goes; the compass shrinks,
 *    then goes (the HUD still shows the wall count, and the seat plates' rings whose turn it is);
 * 3. the ponds' and the opponents' melds' tiles get smaller, the same size for every seat, down to MIN_POND and MIN_MELD;
 * 4. the side seats' rows of face-down tiles go (what they hold is what their melds leave of sixteen);
 * 5. each opponent's pond keeps only its newest rows, at least one, filled with its newest discards after a chip that says
 *    how many earlier ones are not shown ("+12"), so the newest discard of every seat is always on the felt, and every
 *    discard is one tap away (a tap on the seat opens the table's discards: components/table/DiscardsSheet.tsx);
 * 6. my pond keeps only its newest rows too, at least one, with the same chip;
 * 7. the opponents' melds lie flat (no tile on its side to mark the claimed one) and get smaller still, down to
 *    MIN_FLAT_MELD, so two share a row of a narrow side column (a 320 px phone with four melds at a side seat).
 *
 * If even that does not fit, `fits` is false and the table screen gives the hand the next smaller tile size, for the rest
 * of the hand (Extra-large, then Large, then Normal): the felt grows by what the hand gives up. A felt that cannot hold even
 * a middle game at those least sizes (`portraitDealFits`) gives way the same from the deal, so the hand starts at the size
 * it can keep rather than dropping a size a turn or two in; the table says when it makes the hand smaller.
 *
 * Pure: every height is measured by the felt (the plates, whose text the reader's text size grows) or worked out here
 * from the tile sizes as the components draw them, so the fit is unit-tested.
 */
import { tileDims } from '../components/tileDims';
import { SIDE_GAP, sidePondPerRow } from './tableFit';

/** The smallest pond and meld tiles the portrait felt draws (px wide) before ponds keep fewer rows instead. */
export const MIN_POND = 16;
export const MIN_MELD = 14;
/** Flat melds (the last stage, 7): no tile on its side, 3 px apart, down to this size, so two share a narrow column. */
export const MIN_FLAT_MELD = 12;
export const FLAT_MELD_GAP = 3;
/** The compass is never drawn smaller than this; below it, it goes. */
export const MIN_COMPASS = 40;
/** Between the rows of a pond, and between the rows of melds. */
export const POND_GAP = 2;
export const MELD_ROW_GAP = 3;
/** The cross of seats is padded this much at the top and the bottom (Felt.tsx portraitCross). */
export const CROSS_PAD = 3;
/** My pond, pinned under the seats: 3 px above it, 1 below (Felt.tsx pinnedPond). */
export const PINNED_POND_PAD = 4;

const tileH = (w: number) => tileDims(w).h;

export interface PortraitSeat {
  /** Tiles in each exposed meld (3, or 4 for a kong). */
  melds: readonly number[];
  flowers: number;
  discards: number;
  /** Face-down tiles in its hand (the row of backs under its plate). */
  hand: number;
}

export interface PortraitFeltInput {
  /** The felt's inner height (0: not measured yet). */
  felt: number;
  /** A side column's width and the centre column's. */
  sideW: number;
  centerW: number;
  /** The width my pond's rows have (the felt's whole inner width). */
  pondW: number;
  /** Measured plate heights: each side seat's (avatar over its tag), and the across seat's (avatar beside its tag). */
  plates: { right: number; left: number; top: number };
  /** The rows of face-down tiles as drawn (a line of their own under the plate): the across seat's height and a side seat's. */
  topHandH: number;
  sideHandH: number;
  /** The status line under the compass, measured (0: none). */
  status: number;
  right: PortraitSeat;
  across: PortraitSeat;
  left: PortraitSeat;
  /** My discards. */
  mine: number;
  /** Pond and meld tile widths at the reader's tile size. */
  pool: number;
  meld: number;
  /** The wall ring's largest size, and the compass's own. */
  wallMax: number;
  compass: number;
}

export interface PortraitFeltFit {
  pool: number;
  meld: number;
  sidePerRow: number;
  centerPerRow: number;
  myPerRow: number;
  /** The side seats' and the across seat's rows of face-down tiles are drawn. */
  hands: boolean;
  /** The opponents' melds lie flat (stage 7): no tile on its side, FLAT_MELD_GAP apart. */
  flat: boolean;
  /** Rows of each pond drawn, newest kept (Infinity: all of them). */
  keep: { right: number; across: number; left: number; mine: number };
  /** The wall ring's size (0: no ring) and the compass's (0: no compass), and whether the status line is drawn. */
  wall: number;
  compass: number;
  status: boolean;
  /** Everything above fits the felt. When false, even the least of it does not: the hand should give way. */
  fits: boolean;
}

/**
 * Which of a pond's tiles are drawn when it keeps only its newest `keepRows` rows (the portrait felt, fitPortraitFelt below):
 * the kept rows are filled with the newest discards, a chip in the first place saying how many earlier ones are not drawn,
 * so the newest discard is always drawn and the rows show as many as they hold (the whole pond is one tap away, in the
 * table's discards sheet). A pond that keeps all its rows lays them out from its first discard.
 */
export function pondRowsShown<T>(tiles: readonly T[], perRow: number, keepRows?: number): { rows: T[][]; earlier: number } {
  const n = Math.max(1, perRow);
  const rows: T[][] = [];
  for (let i = 0; i < tiles.length; i += n) rows.push(tiles.slice(i, i + n));
  const keep = keepRows !== undefined && Number.isFinite(keepRows) ? Math.max(1, Math.floor(keepRows)) : rows.length;
  if (keep >= rows.length) return { rows, earlier: 0 };
  // The chip takes the first place: the rows hold the newest keep × n − 1 discards (at least the newest one).
  const shown = tiles.slice(tiles.length - Math.max(1, keep * n - 1));
  const first = Math.max(1, n - 1);
  const kept: T[][] = [shown.slice(0, first)];
  for (let i = first; i < shown.length; i += n) kept.push(shown.slice(i, i + n));
  return { rows: kept, earlier: tiles.length - shown.length };
}

/** Rows of `count` tiles at `perRow` a row. */
export function pondRows(count: number, perRow: number): number {
  return count > 0 ? Math.ceil(count / Math.max(1, perRow)) : 0;
}

/** Height of `rows` rows of pond tiles `tile` px wide. */
export function pondHeight(rows: number, tile: number): number {
  return rows > 0 ? rows * tileH(tile) + (rows - 1) * POND_GAP : 0;
}

/**
 * Width of one meld as MeldView draws it: tiles a pixel apart, the claimed one lying on its side, 5 px after it; or flat
 * (no tile on its side), FLAT_MELD_GAP after it.
 */
function meldW(tiles: number, w: number, flat = false): number {
  return flat ? tiles * w + (tiles - 1) + FLAT_MELD_GAP : tiles * w + (tiles - 1) + (tileH(w) - w) + 5;
}

/** Height of a seat's melds and flowers wrapped into `width` (MeldsAndFlowers, flowers at the meld size). */
export function meldsHeight(width: number, melds: readonly number[], flowers: number, w: number, flat = false): number {
  let rows = 0;
  let x = 0;
  for (const n of melds) {
    // The gap after a meld counts where its row wraps (a flex item's margin is part of what must fit the line).
    const mw = meldW(n, w, flat);
    if (rows === 0 || x + mw > width) {
      rows++;
      x = mw;
    } else x += mw;
  }
  if (flowers > 0) {
    const fw = flowers * (w + 1) - 1;
    if (rows === 0 || x + fw > width) rows += Math.ceil(flowers / Math.max(1, Math.floor((width + 1) / (w + 1))));
  }
  return rows > 0 ? rows * tileH(w) + (rows - 1) * MELD_ROW_GAP : 0;
}

/** Tiles the centre column's pond (the across seat's) puts in a row: as many as fit, three to eight. */
export function centerPondPerRow(centerW: number, w: number): number {
  return Math.max(3, Math.min(8, Math.floor((centerW + POND_GAP) / (w + POND_GAP))));
}

/** Tiles my pinned pond puts in a row: as many as its width holds, at most twelve. */
export function myPondPerRow(pondW: number, w: number): number {
  return Math.max(5, Math.min(12, Math.floor((pondW + POND_GAP) / (w + POND_GAP))));
}

/** Height of a stack of blocks with SIDE_GAP between those that are drawn (a 0 is not drawn). */
function stack(...blocks: number[]): number {
  const drawn = blocks.filter((b) => b > 0);
  return drawn.reduce((s, b) => s + b, 0) + Math.max(0, drawn.length - 1) * SIDE_GAP;
}

/** The compass's height as drawn: its wind badges stand out by half their size above and below it. */
export function compassHeight(size: number): number {
  return size > 0 ? size + Math.round(size * 0.32) : 0;
}

/**
 * Whether the felt holds a middle game at the least sizes: each side seat's plate over a row of flat melds (two pongs share
 * one) and a row of its pond, the across seat's plate over a row of its pond, and a row of my pond, at MIN_POND and
 * MIN_FLAT_MELD. Where it cannot (a 320x568 phone at Large and Extra-large tiles: its first discards already overflow the
 * felt), the felt is short from the deal. Unmeasured: true.
 */
export function portraitDealFits(input: Pick<PortraitFeltInput, 'felt' | 'sideW' | 'plates'>): boolean {
  const { felt, sideW, plates } = input;
  if (felt <= 0 || plates.right <= 0 || plates.left <= 0 || plates.top <= 0) return true;
  const row = pondHeight(1, MIN_POND);
  const room = felt - 2 * CROSS_PAD - PINNED_POND_PAD - row;
  const side = (plate: number) => stack(plate, meldsHeight(sideW, [3, 3], 0, MIN_FLAT_MELD, true), row);
  return side(plates.right) <= room && side(plates.left) <= room && stack(plates.top, row) <= room;
}

export function fitPortraitFelt(input: PortraitFeltInput): PortraitFeltFit {
  const { sideW, centerW, pondW, plates } = input;
  const startPool = Math.max(MIN_POND, input.pool);
  const startMeld = Math.max(MIN_MELD, input.meld);
  const all = { right: Infinity, across: Infinity, left: Infinity, mine: Infinity };
  // One state, changed a step at a time in the order the module comment gives.
  const s = { pool: startPool, meld: startMeld, hands: true, flat: false, keep: { ...all } };

  const myRows = (pool: number) => Math.min(s.keep.mine, pondRows(input.mine, myPondPerRow(pondW, pool)));
  const myPondH = () => {
    const rows = myRows(s.pool);
    return PINNED_POND_PAD + pondHeight(rows, s.pool);
  };
  const room = () => input.felt - 2 * CROSS_PAD - myPondH();
  const sideRows = (seat: PortraitSeat, keep: number) => Math.min(keep, pondRows(seat.discards, sidePondPerRow(sideW, s.pool)));
  const sideNeed = (seat: PortraitSeat, plate: number, keep: number) =>
    stack(plate, s.hands && seat.hand > 0 ? input.sideHandH : 0, meldsHeight(sideW, seat.melds, seat.flowers, s.meld, s.flat), pondHeight(sideRows(seat, keep), s.pool));
  const topRows = (keep: number) => Math.min(keep, pondRows(input.across.discards, centerPondPerRow(centerW, s.pool)));
  // The across seat (its plate, row of face-down tiles, melds and pond), without the compass under it.
  const topNeed = (keep: number) =>
    stack(plates.top, s.hands && input.across.hand > 0 ? input.topHandH : 0, meldsHeight(centerW, input.across.melds, input.across.flowers, s.meld, s.flat), pondHeight(topRows(keep), s.pool));
  // What the middle (ring or compass, and the status line) takes of what the across seat leaves.
  const middle = (left: number) => {
    const status = input.status > 0 ? input.status + SIDE_GAP : 0;
    // Under the across seat, with a gap, the ring with the compass in it, or the compass alone, then the status line.
    const roomFor = left - SIDE_GAP;
    const ringMin = input.compass + 16;
    const ring = Math.min(input.wallMax, roomFor - status);
    if (input.wallMax >= ringMin && ring >= ringMin) return { wall: Math.round(ring), compass: input.compass, status: input.status > 0, h: SIDE_GAP + Math.round(ring) + status };
    if (compassHeight(input.compass) + status <= roomFor) return { wall: 0, compass: input.compass, status: input.status > 0, h: SIDE_GAP + compassHeight(input.compass) + status };
    // The status line goes before the compass gets smaller.
    for (let c = input.compass; c >= MIN_COMPASS; c--) if (compassHeight(c) <= roomFor) return { wall: 0, compass: c, status: false, h: SIDE_GAP + compassHeight(c) };
    return { wall: 0, compass: 0, status: false, h: 0 };
  };
  const columnsFit = () => {
    const r = room();
    return sideNeed(input.right, plates.right, s.keep.right) <= r && sideNeed(input.left, plates.left, s.keep.left) <= r && topNeed(s.keep.across) <= r;
  };
  const result = (fits: boolean): PortraitFeltFit => {
    const mid = middle(room() - topNeed(s.keep.across));
    return {
      pool: s.pool,
      meld: s.meld,
      sidePerRow: sidePondPerRow(sideW, s.pool),
      centerPerRow: centerPondPerRow(centerW, s.pool),
      myPerRow: myPondPerRow(pondW, s.pool),
      hands: s.hands,
      flat: s.flat,
      keep: { ...s.keep },
      wall: mid.wall,
      compass: mid.compass,
      status: mid.status,
      fits,
    };
  };

  // Not measured yet: everything at the reader's sizes.
  if (input.felt <= 0 || plates.right <= 0 || plates.left <= 0 || plates.top <= 0) return result(true);
  if (columnsFit()) return result(true);
  // 2. The middle gives way inside `middle` (it takes only what the across seat leaves). 3. Smaller tiles, together.
  while (!columnsFit() && (s.pool > MIN_POND || s.meld > MIN_MELD)) {
    s.pool = Math.max(MIN_POND, s.pool - 1);
    s.meld = Math.max(MIN_MELD, s.meld - 1);
  }
  if (columnsFit()) return result(true);
  // 4. The rows of face-down tiles.
  s.hands = false;
  if (columnsFit()) return result(true);
  // 5. Each opponent's pond keeps its newest rows that fit, at least one.
  const r0 = room();
  const keepFor = (rows: number, fitsWith: (keep: number) => boolean) => {
    for (let k = rows; k >= 1; k--) if (fitsWith(k)) return k === rows ? Infinity : k;
    return 1;
  };
  const shrinkOpponents = (r: number) => {
    s.keep.right = keepFor(sideRows(input.right, Infinity), (k) => sideNeed(input.right, plates.right, k) <= r);
    s.keep.left = keepFor(sideRows(input.left, Infinity), (k) => sideNeed(input.left, plates.left, k) <= r);
    s.keep.across = keepFor(topRows(Infinity), (k) => topNeed(k) <= r);
  };
  shrinkOpponents(r0);
  if (columnsFit()) return result(true);
  // 6. My pond keeps its newest rows too, which gives the opponents that much more.
  const mineRows = myRows(s.pool);
  for (let k = mineRows - 1; k >= 1 && !columnsFit(); k--) {
    s.keep.mine = k;
    shrinkOpponents(room());
  }
  if (columnsFit()) return result(true);
  // 7. The opponents' melds lie flat, and get smaller still.
  s.flat = true;
  shrinkOpponents(room());
  while (!columnsFit() && s.meld > MIN_FLAT_MELD) {
    s.meld--;
    shrinkOpponents(room());
  }
  return result(columnsFit());
}
