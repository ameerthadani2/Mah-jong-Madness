/**
 * Where the Shop opens when another screen sends the player to a plan: on the Plans tab, with the plan they
 * were told about first in the grid and scrolled into view (the trust line, the store notice and the tabs sit
 * above it, and on a phone held sideways they fill the first screen).
 */
import type { Product } from '../monetisation/catalog';

/** `gold`: Coach Gold (unlimited Puzzle Rush, Pro bots). `fourwinds`: The Four Winds Club (every hand reviewed, your own clubs). */
export type ShopFocus = 'gold' | 'fourwinds';

export type ShopTab = 'diamonds' | 'looks' | 'coach';

export function shopTabFor(focus: ShopFocus | undefined): ShopTab {
  return focus ? 'coach' : 'diamonds';
}

/** The plans with the focused tier's first; the catalogue's own order otherwise. */
export function plansInOrder<P extends Pick<Product, 'tier'>>(plans: readonly P[], focus: ShopFocus | undefined): P[] {
  if (!focus) return [...plans];
  return [...plans.filter((p) => p.tier === focus), ...plans.filter((p) => p.tier !== focus)];
}
