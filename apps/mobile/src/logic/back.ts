/**
 * What the Android hardware Back key does, as data (the provider in app-state.tsx carries it out).
 *
 * Back never walks away from a live table unseen. At the table it asks the table screen, which opens the
 * exit sheet (or leaves, once the match is over); in a table's lobby it asks the lobby, which does what
 * its own Back arrow does. Everywhere else it pops one screen, and on the first screen it is left to
 * the system (the app goes to the background).
 */
export type BackPlan = 'ask' | 'pop' | 'system';

export function hardwareBackPlan(stack: readonly { name: string }[], hasSession: boolean): BackPlan {
  const top = stack[stack.length - 1]?.name;
  if (hasSession && (top === 'table' || top === 'lobby')) return 'ask';
  return stack.length > 1 ? 'pop' : 'system';
}

/** The saved or live table a new match against bots would replace, if any: Home asks before it does. */
export function replacesTable(saved: unknown | null, live: { client: { state: { matchOver?: unknown } } } | null): boolean {
  if (live && !live.client.state.matchOver) return true;
  return saved !== null && saved !== undefined;
}

/** Screens a player opens over the table between two hands. */
const OVER_TABLE: ReadonlySet<string> = new Set(['review', 'fairness']);

/** A hand is over and the next has not been dealt: the result sheet's time, when Review and Fair play are read. */
export function betweenHands(state: { lastResult: unknown | null; matchOver?: unknown }): boolean {
  return state.lastResult !== null && state.lastResult !== undefined && !state.matchOver;
}

/**
 * The next hand was dealt while the player was reading Review or Fair play: the stack with those screens
 * taken off and the table marked with the moment (`returnedAt`), so the table can say why it is back.
 * An online table deals by itself a few seconds after a hand, and the player's turn clock and time bank
 * would otherwise run out behind the screen they are reading. Any other stack comes back unchanged.
 */
export function backToDealtTable<S extends { name: string }>(stack: readonly S[], now: number): readonly (S | { name: 'table'; returnedAt: number })[] {
  const top = stack[stack.length - 1];
  if (!top || !OVER_TABLE.has(top.name)) return stack;
  let at = stack.length - 1;
  while (at >= 0 && OVER_TABLE.has(stack[at].name)) at--;
  if (at < 0 || stack[at].name !== 'table') return stack;
  return [...stack.slice(0, at), { name: 'table', returnedAt: now }];
}

/** How long the table says "The next hand has started" after it brought the player back. */
export const RETURNED_NOTICE_MS = 4000;

/** Whether the table was just brought back by `backToDealtTable` (it says so for a few seconds). */
export function justReturned(screen: { name: string; returnedAt?: number }, now: number): boolean {
  return screen.name === 'table' && typeof screen.returnedAt === 'number' && now - screen.returnedAt >= 0 && now - screen.returnedAt < RETURNED_NOTICE_MS;
}
