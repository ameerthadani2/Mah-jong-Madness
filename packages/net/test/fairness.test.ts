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
    const a = deriveSeed('m:0', five);
    const b = deriveSeed('m:0', [...five].reverse());
    expect(a).toBe(b);
    expect(deriveSeed('m:1', five)).not.toBe(a);
    // The seed is bound to the versioned, seat-labelled formula.
    expect(a).toBe(sha256Hex(`mjm-seed-v2:m:0:${five.map((r) => `${r.seat}=${r.secret}`).join('|')}`));
  });

  it('binds each secret to its seat', () => {
    const swapped = five.map((r) => (r.seat === 0 ? { ...r, secret: five[1].secret } : r.seat === 1 ? { ...r, secret: five[0].secret } : r));
    expect(deriveSeed('m:0', swapped)).not.toBe(deriveSeed('m:0', five));
  });

  it('takes exactly one share per seat 0–4 and rejects extras, duplicates, gaps and non-hex secrets', () => {
    // Port of ceremony/p1_extra_reveal.ts and verify-ceremony/probe.test.ts: a sixth share the host
    // picks after seeing every reveal must never move the seed.
    const extra = 'ab'.repeat(32);
    expect(() => deriveSeed('m:0', [...five, { seat: 9, secret: extra }])).toThrow(/exactly 5 shares/);
    expect(() => deriveSeed('m:0', [...five, { seat: 0, secret: extra }])).toThrow(/exactly 5 shares/);
    expect(() => deriveSeed('m:0', [...five, { seat: 4, secret: extra }])).toThrow(/exactly 5 shares/);
    expect(() => deriveSeed('m:0', five.slice(0, 4))).toThrow(/exactly 5 shares/);
    expect(() => deriveSeed('m:0', [...five.slice(0, 4), { seat: 0, secret: extra }])).toThrow(/Two shares for seat 0/);
    expect(() => deriveSeed('m:0', [...five.slice(0, 4), { seat: 5, secret: extra }])).toThrow(/out of range/);
    expect(() => deriveSeed('m:0', [...five.slice(0, 4), { seat: 4, secret: 'x|5=y' }])).toThrow(/not a hex secret/);
  });

  it('verifyReveals wants exactly one matching reveal per commitment and nothing else', () => {
    const commits = five.map((r) => ({ seat: r.seat, hash: commitFor(r.secret) }));
    expect(verifyReveals(commits, five)).toEqual({ ok: true, badSeats: [] });
    expect(verifyReveals(commits, [...five, { seat: 9, secret: 'ab' }])).toEqual({ ok: false, badSeats: [9] });
    expect(verifyReveals(commits, [...five, { seat: 4, secret: 'ab' }])).toEqual({ ok: false, badSeats: [4] });
    expect(verifyReveals(commits, five.slice(1))).toEqual({ ok: false, badSeats: [0] });
  });
});

/** Five hex shares, one per seat 0–4. */
const five = [0, 1, 2, 3, 4].map((seat) => ({ seat, secret: sha256Hex(`share-${seat}`) }));
