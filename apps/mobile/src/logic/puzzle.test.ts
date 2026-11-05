import { describe, expect, it } from 'vitest';
import { discardPuzzle } from '@mjm/engine';
import { puzzleStatus } from './puzzle';

describe('puzzleStatus', () => {
  it('reads shanten 0 on a 17-tile hand as one discard from ready, not ready', () => {
    expect(puzzleStatus(0)).toBe('One discard from ready.');
    expect(puzzleStatus(0)).not.toMatch(/is ready/);
  });

  it('describes hands further away', () => {
    expect(puzzleStatus(1)).toBe('The best discard leaves you 1 from ready.');
    expect(puzzleStatus(3)).toBe('The best discard leaves you 3 from ready.');
  });

  it('handles a complete hand', () => {
    expect(puzzleStatus(-1)).toBe('The hand is already complete.');
  });

  it('agrees with the engine: a shanten-0 puzzle has a discard that leaves the hand ready', () => {
    let found = false;
    for (let i = 0; i < 200 && !found; i++) {
      const p = discardPuzzle(`status-${i}`, 3);
      if (p.currentShanten !== 0) continue;
      found = true;
      expect(p.hand.length).toBe(17);
      expect(p.bestShanten).toBe(0);
      expect(puzzleStatus(p.currentShanten)).toBe('One discard from ready.');
    }
    expect(found).toBe(true);
  });
});
