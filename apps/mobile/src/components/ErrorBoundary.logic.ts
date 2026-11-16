/** The error boundary's rules, kept pure so it is tested without rendering (see ./ErrorBoundary.tsx). */

/** Whether the fallback stays up: only while the screen that failed is still the one asked for. */
export function staysFailed(failed: boolean, previousKey: string, key: string): boolean {
  return failed && previousKey === key;
}

/**
 * What the fallback offers, in order. Going Home is not enough by itself: when the saved table is what
 * breaks the screen, Home fails again, so the second action clears that table first.
 */
export const ERROR_SCREEN_ACTIONS = [
  { id: 'home', testID: 'screen-error-home', label: 'common.crash.home', clearsSavedTable: false },
  { id: 'clear', testID: 'screen-error-clear', label: 'common.crash.clear', clearsSavedTable: true },
] as const;
