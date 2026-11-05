/**
 * Status line for a best-discard puzzle. `shanten17` is the shanten of the 17-tile
 * hand before discarding: 0 means the right discard leaves the hand ready (聽),
 * −1 means the hand is already complete.
 */
export function puzzleStatus(shanten17: number): string {
  if (shanten17 < 0) return 'The hand is already complete.';
  if (shanten17 === 0) return 'One discard from ready.';
  return `The best discard leaves you ${shanten17} from ready.`;
}
