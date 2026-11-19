/**
 * Home's sizes that depend on the window. A phone held sideways is about 390 pt tall, and the four mode cards
 * with their buttons and the links under them must end above the bottom edge (and the home indicator), so the
 * card art shrinks there and the blurbs are left out.
 */
import { MIN_TOUCH } from '../components/table/layout';

export interface HomeWindow {
  /** Wide enough for the cards side by side. */
  wide: boolean;
  tablet: boolean;
  height: number;
}

/** Below this height the side-by-side layout has no room for blurbs or full-height art. */
export const SHORT_HOME_HEIGHT = 420;

export function isShortHome(w: HomeWindow): boolean {
  return w.wide && !w.tablet && w.height < SHORT_HOME_HEIGHT;
}

/** Height of the picture at the top of the Play card (the other cards use it too when side by side). */
export function homeWindowHeight(w: HomeWindow): number {
  if (w.tablet) return Math.min(250, Math.round(w.height * 0.28));
  if (!w.wide) return 104;
  if (isShortHome(w)) return Math.max(44, Math.round(w.height * 0.12));
  return Math.max(70, Math.min(150, Math.round(w.height * 0.22)));
}

/**
 * Height of the picture on the three small cards. Side by side they match the Play card; stacked under it on a
 * portrait phone they are 100 pt, less on a short phone (360x740) so that the whole of Home, with its rules line
 * and profile line shown in full, still fits without scrolling.
 */
export function homeSmallWindowHeight(w: HomeWindow): number {
  if (w.tablet || w.wide) return homeWindowHeight(w);
  return w.height < 780 ? 80 : 100;
}

/**
 * Width of the picture beside the Play card's text on an upright phone, where the card is a row. Under 360 pt it gives
 * the text more of the row, so the card's button keeps its whole label ("開始打牌" with its icon is about 106 pt and the
 * button was 86 pt on a 320 pt phone).
 */
export function homePlayArtWidth(width: number): number {
  return width < 360 ? 112 : 156;
}

/** The drawn height of a text link under a card; with LINK_SLOP it reaches the 44 pt touch target. */
export const LINK_HEIGHT = 20;
/** The gap between a card's buttons and the text link under them (HomeScreen's card foot). */
export const LINK_GAP = 8;
/**
 * A text link's press beyond its drawn line, to 44 pt: up 2 px short of the button above it (its edge can fall between
 * pixels), so a tap on that button's bottom edge stays the button's; the rest below, and some to the sides. A phone takes
 * it as hitSlop; the web, which ignores hitSlop, as padding with an equal negative margin (HomeScreen `linkWebPress`).
 */
export const LINK_SLOP = { top: LINK_GAP - 2, bottom: MIN_TOUCH - LINK_HEIGHT - (LINK_GAP - 2), left: 12, right: 12 } as const;
