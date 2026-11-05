/**
 * Table geometry, as pure functions of the usable window size, so the layout rules are testable and the
 * components only draw. Every number here was checked against the five reference viewports in
 * e2e/screens.cjs (390×844, 844×390, 667×375, 360×740, 1024×768).
 */
import { tileDims, type TileSize } from '../tileDims';

export interface TableLayout {
  portrait: boolean;
  tablet: boolean;
  /** Short landscape phones (under 420 px tall): every vertical pixel counts. */
  compact: boolean;
  /** Where the coach bubble goes: beside the compass, under the right seat, or under the cross (portrait). */
  coach: 'center' | 'side' | 'below';
  /** The "X discarded Y" pill sits in the HUD on short screens instead of under the compass. */
  statusInHud: boolean;
  /**
   * Claim and discard buttons: docked over the bottom of the centre column (my own pond, which no claim
   * decision needs) in landscape, so they never cover a side opponent's pond; in portrait, a strip of their
   * own between the felt and my hand, so they never cover the coach or a pond.
   */
  actions: 'center' | 'strip';
  sideWidth: number;
  plate: number;
  pool: TileSize;
  rail: number;
  centerW: number;
  centerPerRow: number;
  /** My pond's tiles per row on short landscape, where it shares the middle with the compass. */
  myPerRow: number;
  sidePerRow: number;
  /** Live wall drawn around the compass (only where there is room). */
  showWall: boolean;
  wallSize: number;
  compassSize: number;
}

export function tableLayout(width: number, height: number): TableLayout {
  const portrait = height > width;
  const tablet = Math.min(width, height) >= 680;
  const compact = height < 420;
  const sideWidth = portrait ? Math.max(84, Math.min(110, Math.floor(width * 0.24))) : width >= 1000 ? 214 : width >= 760 ? 150 : 128;
  const plate = tablet ? 50 : portrait ? 34 : 32;
  const pool: TileSize = tablet ? 'sm' : 'xs';
  const poolW = tileDims(pool).w + 2;
  const rail = tablet ? 15 : 11;
  const feltInnerW = width - 16 - (rail + 3) * 2;
  const centerW = feltInnerW - sideWidth * 2 - 16;
  const centerPerRow = Math.max(5, Math.min(portrait ? 8 : 12, Math.floor(centerW / poolW)));
  const myPerRow = Math.max(5, Math.min(12, Math.floor((centerW - (compact ? 62 : 74) - 14) / poolW)));
  const sidePerRow = Math.max(3, Math.min(7, Math.floor((sideWidth - 4) / poolW)));
  const showWall = tablet || portrait;
  const wallSize = tablet ? Math.min(centerW - 24, 300) : Math.max(120, Math.min(centerW - 4, 220));
  const compassSize = tablet ? 96 : portrait ? Math.min(66, Math.round(wallSize * 0.42)) : compact ? 62 : 74;
  return {
    portrait,
    tablet,
    compact,
    coach: portrait ? 'below' : height < 520 ? 'center' : 'side',
    statusInHud: !portrait && !tablet && compact,
    actions: portrait ? 'strip' : 'center',
    sideWidth,
    plate,
    pool,
    rail,
    centerW,
    centerPerRow,
    myPerRow,
    sidePerRow,
    showWall,
    wallSize,
    compassSize,
  };
}

/** Height of the portrait action strip (claim buttons are 50 pt plus their shelf). */
export const ACTION_STRIP_H = 60;

export interface HandLayout {
  /** Width of one hand tile. */
  tile: number;
  /** Width reserved for my plate on the left (landscape only). */
  plateW: number;
}

/** Hand tile size: a full hand (16 − 3 per meld, +1 drawn) always fits, so the size never jumps between turns. */
export function handLayout(width: number, l: Pick<TableLayout, 'portrait' | 'tablet' | 'compact'>, handCount: number, meldTiles: number, meldCount: number): HandLayout {
  const smW = tileDims('sm').w;
  const meldW = meldTiles * (smW + 1) + meldCount * 8;
  const plateW = l.portrait ? 0 : l.tablet ? 124 : 82;
  const slots = Math.max(handCount, 17 - 3 * meldCount, 2);
  const room = width - 24 - plateW - (l.portrait ? 0 : meldW + (meldW ? 10 : 0)) - 12;
  // Portrait: the hand wraps into two rows of nine.
  const tile = l.portrait ? Math.max(28, Math.min(48, Math.floor((room - 4) / 9.4))) : Math.max(24, Math.min(l.compact ? 42 : l.tablet ? 60 : 50, Math.floor((room - 10) / slots) - 2));
  return { tile, plateW };
}

export interface ResultLayout {
  /** Short landscape: results on the left, scores and buttons on the right. */
  twoCol: boolean;
  /** Score chips two per row (short screens), so the buttons stay on screen. */
  scoreCols: 1 | 2 | 4;
  /** Narrow portrait: buttons stacked full width, the two secondary ones sharing a row. */
  stackButtons: boolean;
}

export function resultLayout(width: number, height: number): ResultLayout {
  const twoCol = width > height && height < 560;
  return { twoCol, scoreCols: twoCol ? (height < 420 ? 2 : 1) : width < 480 ? 2 : 4, stackButtons: !twoCol && width < 480 };
}

/** Largest tile width (≤ max) that puts `count` tiles with `gap` px between them inside `room` px. */
export function fitTile(room: number, count: number, max: number, gap = 2, min = 18): number {
  if (count <= 0) return max;
  return Math.max(min, Math.min(max, Math.floor((room - gap * (count - 1)) / count)));
}

/** Smallest effective touch target, in points, for anything pressable. */
export const MIN_TOUCH = 44;

/** hitSlop that grows a `size`-point control to at least MIN_TOUCH. */
export function slopFor(size: number, atLeast = 0): number {
  return Math.max(atLeast, Math.ceil((MIN_TOUCH - size) / 2));
}
