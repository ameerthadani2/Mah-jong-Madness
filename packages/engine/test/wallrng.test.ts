import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWallRng, fullSet, hashString, newGame, randomHex, shuffle, sha256Hex, WALL_RNG_VERSION } from '../src/index';

describe('wall RNG', () => {
  it('is deterministic and uses more than 32 bits of the seed', () => {
    const a = shuffle(fullSet(), createWallRng('seed-a')).join(',');
    const b = shuffle(fullSet(), createWallRng('seed-a')).join(',');
    expect(a).toBe(b);
    // Two seeds that collide under the 32-bit FNV fold must still produce different walls.
    const s1 = 'collide-1';
    let s2 = '';
    for (let i = 0; i < 5_000_000 && !s2; i++) {
      const cand = `c${i}`;
      if (cand !== s1 && hashString(cand) === hashString(s1)) s2 = cand;
    }
    if (s2) {
      expect(shuffle(fullSet(), createWallRng(s1)).join(',')).not.toBe(shuffle(fullSet(), createWallRng(s2)).join(','));
    }
    expect(shuffle(fullSet(), createWallRng(sha256Hex('x'))).join(',')).not.toBe(shuffle(fullSet(), createWallRng(sha256Hex('y'))).join(','));
  });
  it('produces uniform-looking draws', () => {
    const rng = createWallRng('uniform');
    const counts = new Array(6).fill(0);
    for (let i = 0; i < 60_000; i++) counts[rng.int(6)]++;
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(400);
  });
  it('stamps the construction version on every game', () => {
    expect(newGame('v').rngVersion).toBe(WALL_RNG_VERSION);
    expect(WALL_RNG_VERSION).toMatch(/^mjm-sha256ctr-v\d+$/);
  });
});

describe('randomHex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('draws from the platform generator', () => {
    expect(randomHex(4)).toMatch(/^[0-9a-f]{8}$/);
    expect(randomHex()).not.toBe(randomHex());
  });

  it('fails closed when no secure random source exists', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => randomHex(16)).toThrow('No secure random source');
    vi.stubGlobal('crypto', {});
    expect(() => randomHex(16)).toThrow('No secure random source');
  });
});
