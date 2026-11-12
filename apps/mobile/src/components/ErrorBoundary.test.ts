import { describe, expect, it } from 'vitest';
import { staysFailed } from './ErrorBoundary.logic';

describe('the screen error boundary', () => {
  it('keeps the fallback while the failed screen is still the one shown', () => {
    expect(staysFailed(true, 'club:AB12', 'club:AB12')).toBe(true);
  });

  it('tries again once the player moves to another screen', () => {
    expect(staysFailed(true, 'club:AB12', 'home')).toBe(false);
    expect(staysFailed(false, 'home', 'home')).toBe(false);
  });
});
