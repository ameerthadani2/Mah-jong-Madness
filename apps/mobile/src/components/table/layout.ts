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
  /**
   * Where the coach goes (see coachBarLines): portrait pins its bar under the felt, over the felt's wooden rail, above
   * the claim strip; a landscape phone gives it a bar above my hand; tablets and tall landscape screens show it in full
   * under the right seat. Never in a share of the felt, which the ponds and the claim buttons can take whole on a small
   * phone.
   */
  coach: 'pinned' | 'rail' | 'side';
  /** The "X discarded Y" pill sits in the HUD on short screens instead of under the compass. */
  statusInHud: boolean;
  /**
   * Claim and discard buttons: in landscape, in the centre column just above my pond (tablets and tall
   * landscape: floating over the empty felt above it; short landscape: a row of their own under the compass
   * and my pond), so they never cover my pond or a side opponent's; in portrait, a strip of their own between
   * the felt and my hand, so they never cover the coach or a pond.
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
    coach: portrait ? 'pinned' : height < 520 ? 'rail' : 'side',
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

/** Height the claim/discard buttons take when docked over the bottom of the centre column in landscape (50 pt buttons, 2 pt inset, 2 pt of air above). */
export const ACTION_DOCK_H = 54;
/** The 'tap a tile' pill the dock shows on my discard turn before a tile is selected. */
export const TAP_HINT_DOCK_H = 34;

/** What the action dock over the centre column shows: nothing, the tap hint pill, or claim/discard buttons. */
export type ActionDock = 'none' | 'hint' | 'buttons';

/** The lines the coach bar shows (CoachPanel.tsx CoachBar): a status line, and lines of advice. */
export interface CoachBarLines {
  status: number;
  advice: number;
}

/**
 * The coach bar's lines where it is placed. Pinned in portrait: the status over two lines of advice on a tall phone or a
 * tablet, two lines of advice alone below that (`statusLine`: portraitCoachStatus). On a landscape phone's rail, the
 * advice alone: one line in a row of its own above the hand at Normal tiles (where every pixel of the felt counts), two
 * beside my plate where Large and Extra-large tiles give the plate a row of its own (`besidePlate`). Whatever does not
 * fit ends in an ellipsis, and the bar opens the coach's sheet, which holds everything.
 */
export function coachBarLines(place: 'pinned' | 'rail', besidePlate = false, statusLine = true): CoachBarLines {
  if (place === 'pinned') return { status: statusLine ? 1 : 0, advice: 2 };
  return { status: 0, advice: besidePlate ? 2 : 1 };
}

/** Portrait: the pinned bar shows the status line too on a window at least this tall (a 390×844 phone, a tablet). */
export const PORTRAIT_COACH_STATUS_MIN_H = 800;

/** Whether the pinned portrait bar shows the status line over its advice (the felt of a shorter phone needs the room). */
export function portraitCoachStatus(height: number): boolean {
  return height >= PORTRAIT_COACH_STATUS_MIN_H;
}

/**
 * How far a coach bar under the felt is drawn up over the felt's wooden rail (the frame keeps 18 px under the felt; the
 * bar stops 2 px short of it): the landscape bar at Normal tiles and the portrait bar.
 */
export const COACH_OVER_RAIL = 16;

/**
 * The pinned coach bar's height as drawn in portrait (CoachPanel.tsx CoachBar `face`): 9 px of border and padding, then
 * the status line (17 px) over two lines of advice (15 px each), or the two lines of advice alone, grown with the OS text
 * size, and never under 44 px, so the bar is its own press on the web too and covers nothing around it.
 */
export function pinnedCoachFace(statusLine: boolean, osScale = 1): number {
  const text = (statusLine ? 17 + 2 * 15 : 2 * 15) * Math.max(1, Number.isFinite(osScale) ? osScale : 1);
  return Math.max(MIN_TOUCH, Math.ceil(9 + text));
}

/** Height the landscape action dock takes: claim/discard buttons (larger on tablets), the tap-hint pill, or nothing. */
export function dockHeight(dock: ActionDock, big: boolean): number {
  return dock === 'buttons' ? (big ? ACTION_DOCK_H + 10 : ACTION_DOCK_H) : dock === 'hint' ? TAP_HINT_DOCK_H : 0;
}

/** Short landscape: the compass shrinks to the middle row's height (`rowH`, measured) and goes when under 40 px. */
export function compactCompassSize(rowH: number, max: number): number {
  if (rowH <= 0) return max;
  const s = Math.min(max, rowH - 6);
  return s >= 40 ? s : 0;
}

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

export interface MatchOverLayout {
  /** Short landscape (under 420 px tall): the card takes its small sizes. */
  compact: boolean;
  /** The overlay's padding, and the most height the card may take: past it the card scrolls. */
  pad: number;
  maxHeight: number;
  /** Ribbon title size, trophy size, portrait size and the rank rows' vertical padding. */
  title: number;
  trophy: number;
  avatar: number;
  rowPad: number;
}

/**
 * The match-over card: four ranks, the note beside final scores this phone could not check, and the way
 * home. On a 375 px high phone the usual sizes are taller than the window, so the card takes smaller ones
 * there and, at any size, scrolls inside the window rather than running off it (a larger text setting or
 * the note can always add lines).
 */
export function matchOverLayout(height: number): MatchOverLayout {
  const compact = height < 420;
  const pad = compact ? 8 : 16;
  return { compact, pad, maxHeight: Math.max(120, height - 2 * pad), title: compact ? 22 : 28, trophy: compact ? 26 : 34, avatar: compact ? 26 : 34, rowPad: compact ? 1 : 4 };
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

/**
 * Tablets in landscape: the wall ring's size from the centre column's measured height, less the across seat
 * and my pond (and the column's gaps); 0 (the compass alone) when not even `min` fits. Unmeasured: `max`.
 */
export function landscapeWallSize(columnH: number, topH: number, pondH: number, max: number, min: number): number {
  if (columnH <= 0 || topH <= 0) return max;
  const room = Math.min(max, columnH - topH - pondH - 24);
  return room >= min ? Math.round(room) : 0;
}
