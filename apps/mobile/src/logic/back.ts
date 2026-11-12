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
