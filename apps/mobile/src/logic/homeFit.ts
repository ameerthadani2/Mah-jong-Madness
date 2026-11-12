/**
 * Home's sizes that depend on the window. A phone held sideways is about 390 pt tall, and the four mode cards
 * with their buttons and the links under them must end above the bottom edge (and the home indicator), so the
 * card art shrinks there and the blurbs are left out.
 */
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

/** The drawn height of a text link under a card; with `slopFor` it reaches the 44 pt touch target. */
export const LINK_HEIGHT = 20;
