import { describe, expect, it } from 'vitest';
import { rollingAccuracy } from './accuracy';

describe('rollingAccuracy', () => {
  it('is null before any review', () => {
    expect(rollingAccuracy([])).toBeNull();
  });

  it('averages and rounds the saved accuracies', () => {
    expect(rollingAccuracy([90, 80, 75])).toBe(82);
    expect(rollingAccuracy([100])).toBe(100);
  });

  it('skips corrupt entries', () => {
    expect(rollingAccuracy([80, Number.NaN, 60])).toBe(70);
    expect(rollingAccuracy([Number.NaN])).toBeNull();
  });
});
