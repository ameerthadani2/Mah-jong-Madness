import { describe, expect, it } from 'vitest';
import { rushOutcome } from './rush';

describe('rushOutcome', () => {
  it('reports a new personal best against the best from before the run', () => {
    expect(rushOutcome(5, 6)).toEqual({ kind: 'best', title: 'New personal best!' });
    expect(rushOutcome(0, 1).kind).toBe('best');
  });

  it('reports a matched best', () => {
    expect(rushOutcome(6, 6)).toEqual({ kind: 'matched', title: 'Matched your best' });
  });

  it('reports a plain finish below the best or with no score', () => {
    expect(rushOutcome(6, 5).kind).toBe('over');
    expect(rushOutcome(0, 0).kind).toBe('over');
  });

  it('would never report a best if compared with the already-updated best (why prevBest is captured at run start)', () => {
    const prevBest = 5;
    const score = 8;
    const savedAfterRun = Math.max(prevBest, score);
    expect(rushOutcome(savedAfterRun, score).kind).toBe('matched');
    expect(rushOutcome(prevBest, score).kind).toBe('best');
  });
});
