import { describe, expect, it } from 'vitest';
import { nextFadeDelay } from './fade';

describe('nextFadeDelay', () => {
  it('is null when nothing is on screen', () => {
    expect(nextFadeDelay(10_000, [{ at: [], ttl: 3500 }])).toBeNull();
  });

  it('is null when everything has already faded', () => {
    expect(nextFadeDelay(10_000, [{ at: [1000, 6000], ttl: 3500 }])).toBeNull();
  });

  it('picks the earliest expiry across groups', () => {
    // Emote at 9000 fades at 12500; chat at 5000 fades at 11000.
    expect(nextFadeDelay(10_000, [{ at: [9000], ttl: 3500 }, { at: [5000, 9500], ttl: 6000 }])).toBe(1000);
  });

  it('treats an item expiring exactly now as gone', () => {
    expect(nextFadeDelay(10_000, [{ at: [6500], ttl: 3500 }])).toBeNull();
  });
});
