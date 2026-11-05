/** Arrival timestamps (ms) of items that disappear `ttl` ms after they arrive. */
export interface FadeGroup {
  at: readonly number[];
  ttl: number;
}

/**
 * Milliseconds until the next visible item fades, or null when nothing on screen
 * will fade. Lets a screen schedule one timeout instead of re-rendering every second.
 */
export function nextFadeDelay(now: number, groups: readonly FadeGroup[]): number | null {
  let next: number | null = null;
  for (const g of groups) {
    for (const at of g.at) {
      const expires = at + g.ttl;
      if (expires > now && (next === null || expires < next)) next = expires;
    }
  }
  return next === null ? null : next - now;
}
