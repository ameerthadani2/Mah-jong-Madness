/**
 * The three lines a screen that both polls and acts can show, kept apart so that one never wipes another:
 * `loadError` belongs to the background refresh (a later good refresh clears it), `actionError` to the last
 * thing the player pressed (only the next press, a tab change or the player clears it), and `notice` to an
 * action that worked (it goes after a few seconds, or with the next press or tab change).
 */
export interface ScreenMessages {
  loadError: string | null;
  actionError: string | null;
  notice: string | null;
}

export type ScreenMessageEvent =
  | { type: 'loaded' }
  | { type: 'loadFailed'; text: string }
  | { type: 'actionStarted' }
  | { type: 'actionFailed'; text: string }
  | { type: 'actionDone'; notice?: string | null }
  | { type: 'moved' }
  | { type: 'noticeExpired' }
  | { type: 'dismissed' };

export const NO_MESSAGES: ScreenMessages = { loadError: null, actionError: null, notice: null };

/** How long a success notice stays on screen. */
export const NOTICE_MS = 6000;

export function messagesAfter(m: ScreenMessages, e: ScreenMessageEvent): ScreenMessages {
  switch (e.type) {
    case 'loaded':
      return m.loadError === null ? m : { ...m, loadError: null };
    case 'loadFailed':
      return m.loadError === e.text ? m : { ...m, loadError: e.text };
    case 'actionStarted':
    case 'moved':
    case 'dismissed':
      return m.actionError === null && m.notice === null ? m : { ...m, actionError: null, notice: null };
    case 'actionFailed':
      return { ...m, actionError: e.text, notice: null };
    case 'actionDone':
      return { ...m, actionError: null, notice: e.notice ?? null };
    case 'noticeExpired':
      return m.notice === null ? m : { ...m, notice: null };
  }
}

/** The one error line to show: what the player just did comes before a failed background refresh. */
export function shownError(m: ScreenMessages): string | null {
  return m.actionError ?? m.loadError;
}
