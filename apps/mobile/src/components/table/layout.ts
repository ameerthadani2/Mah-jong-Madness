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

/** Height the claim/discard buttons take when docked over the bottom of the centre column in landscape (50 pt buttons, 2 pt inset, 2 pt of air above). */
export const ACTION_DOCK_H = 54;
/** The 'tap a tile' pill the dock shows on my discard turn before a tile is selected. */
export const TAP_HINT_DOCK_H = 34;

/** What the action dock over the centre column shows: nothing, the tap hint pill, or claim/discard buttons. */
export type ActionDock = 'none' | 'hint' | 'buttons';

/** The compact coach bubble's type: the status line and the advice lines (see CoachPanel), plus its padding and border. */
export const COACH_STATUS_LINE_H = 17;
export const COACH_ADVICE_LINE_H = 15;
export const COACH_BUBBLE_CHROME_H = 16;
/** The text-only bubble's padding and border (it sits over the compass and my pond, so it is kept slim). */
export const COACH_SLIM_CHROME_H = 12;
/** Advice lines the compact bubble shows when nothing constrains it. */
export const COACH_MAX_ADVICE_LINES = 4;

export interface CoachBudget {
  /** Lines for the status (0 hides it: a claim decision needs the reason more than the shanten count). */
  statusLines: number;
  /** Advice lines on screen at once (more scroll inside the bubble, never cut); 0 hides the bubble rather than a sliver. */
  lines: number;
  /** Cap on the bubble's height, so it ends above my pond; null while the column is unmeasured. */
  maxHeight: number | null;
  /** Text only (no owl, no waits), with slim padding, so the words get the whole width when space is short. */
  textOnly: boolean;
}

/**
 * How much of the compact middle row's right-hand column (`columnH` px, measured: between the across seat's
 * pond and the action dock, which now has a row of its own) the coach bubble may take above my pond (`pondH`,
 * measured; one row before it is). It never covers my pond or the compass beside it. While claim or discard
 * buttons are up the status gives way to the advice and the bubble goes text-only; under the tap-hint pill the
 * status keeps one line. Advice longer than the lines that fit scrolls inside the bubble instead of being cut.
 * Before the column has been measured (0) the bubble is unconstrained.
 */
export function coachBudget(columnH: number, dock: ActionDock, pondH = 0): CoachBudget {
  if (columnH <= 0) return { statusLines: 2, lines: COACH_MAX_ADVICE_LINES, maxHeight: null, textOnly: false };
  const pond = Math.max(pondH, tileDims('xs').h + 2) + 4;
  const avail = Math.max(0, columnH - pond);
  if (dock === 'buttons') {
    const lines = Math.max(0, Math.min(COACH_MAX_ADVICE_LINES, Math.floor((avail - COACH_SLIM_CHROME_H) / COACH_ADVICE_LINE_H)));
    return { statusLines: 0, lines, maxHeight: avail, textOnly: true };
  }
  const statusLines = dock === 'hint' ? 1 : 2;
  const forAdvice = avail - COACH_BUBBLE_CHROME_H - statusLines * COACH_STATUS_LINE_H;
  const lines = Math.max(0, Math.min(COACH_MAX_ADVICE_LINES, Math.floor(forAdvice / COACH_ADVICE_LINE_H)));
  if (lines === 0) {
    // No room beside the owl: fall back to the slim text-only bubble before hiding it.
    const slim = Math.max(0, Math.min(COACH_MAX_ADVICE_LINES, Math.floor((avail - COACH_SLIM_CHROME_H) / COACH_ADVICE_LINE_H)));
    return { statusLines: 0, lines: slim, maxHeight: avail, textOnly: true };
  }
  return { statusLines, lines, maxHeight: avail, textOnly: false };
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

/**
 * Portrait: the wall ring around the compass is the felt's one stretchable piece. Given the ring's current size
 * and the felt's measured content and viewport heights, the size that makes the content fit (it grows back
 * when there is room again, never past `max`); below `min` the ring is dropped and the compass stands alone
 * (returns 0), so my pond is never scrolled out of the felt late in a hand.
 */
export function fitWallSize(current: number, contentH: number, viewH: number, max: number, min: number): number {
  if (contentH <= 0 || viewH <= 0) return current;
  // Without the ring, bring it back only when there is room for the whole of it (no flicker at the edge).
  if (current <= 0) return viewH - contentH >= min ? min : 0;
  const next = Math.min(max, current - (contentH - viewH));
  return next >= min ? Math.round(next) : 0;
}

/**
 * Lines a coach sentence needs at `textWidth` px: bold 12 pt Latin averages just over half an em, a CJK
 * character a full em. An estimate for the layout tests, not a text measurer.
 */
export function coachTextLines(text: string, textWidth: number, fontSize = 12): number {
  let w = 0;
  for (const ch of text) w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fontSize : fontSize * 0.56;
  return Math.max(1, Math.ceil(w / Math.max(1, textWidth)));
}

/** Height of the compact bubble drawn to `budget`. */
export function coachBubbleHeight(b: Pick<CoachBudget, 'statusLines' | 'lines' | 'textOnly'>): number {
  return (b.textOnly ? COACH_SLIM_CHROME_H : COACH_BUBBLE_CHROME_H) + b.statusLines * COACH_STATUS_LINE_H + b.lines * COACH_ADVICE_LINE_H;
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
