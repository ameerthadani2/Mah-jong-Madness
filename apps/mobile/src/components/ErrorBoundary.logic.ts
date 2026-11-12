/** The error boundary's one rule, kept pure so it is tested without rendering (see ./ErrorBoundary.tsx). */

/** Whether the fallback stays up: only while the screen that failed is still the one asked for. */
export function staysFailed(failed: boolean, previousKey: string, key: string): boolean {
  return failed && previousKey === key;
}
