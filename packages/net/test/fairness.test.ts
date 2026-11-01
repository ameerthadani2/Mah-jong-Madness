import { describe, expect, it } from 'vitest';
import { commitFor, deriveSeed, sha256Hex, verifyReveals } from '../src/index';

describe('sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('The quick brown fox jumps over the lazy dog')).toBe('d7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592');
    // > 55 bytes forces a second block
    expect(sha256Hex('a'.repeat(100))).toBe('2816597888e4a0d3a36b82b83316ab32680eb8f00f8cd3b904d681246d285a0e');
  });
});

describe('commit-reveal', () => {
  it('verifies honest reveals and rejects a swapped secret', () => {
    const secrets = ['s0', 's1', 's2', 's3'];
    const commits = secrets.map((s, seat) => ({ seat, hash: commitFor(s) }));
    const reveals = secrets.map((s, seat) => ({ seat, secret: s }));
    expect(verifyReveals(commits, reveals).ok).toBe(true);
    const bad = reveals.map((r) => (r.seat === 2 ? { ...r, secret: 'cheat' } : r));
    expect(verifyReveals(commits, bad)).toEqual({ ok: false, badSeats: [2] });
  });
  it('derives the same seed regardless of reveal order', () => {
    const a = deriveSeed('m:0', [{ seat: 0, secret: 'x' }, { seat: 1, secret: 'y' }]);
    const b = deriveSeed('m:0', [{ seat: 1, secret: 'y' }, { seat: 0, secret: 'x' }]);
    expect(a).toBe(b);
    expect(deriveSeed('m:1', [{ seat: 0, secret: 'x' }, { seat: 1, secret: 'y' }])).not.toBe(a);
  });
});
