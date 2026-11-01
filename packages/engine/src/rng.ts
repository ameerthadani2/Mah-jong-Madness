/**
 * Deterministic PRNG (xoshiro128**) seeded from an arbitrary string.
 * Every peer in a P2P table seeds the engine with the same string, so
 * the shuffled wall is identical everywhere and can be audited afterwards.
 */

export interface Rng {
  /** Uniform float in [0, 1) */
  next(): number;
  /** Uniform integer in [0, n) */
  int(n: number): number;
  /** Serialisable internal state */
  state(): [number, number, number, number];
}

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
}

/** FNV-1a 32-bit hash of a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function createRng(seed: string | number): Rng {
  const seedNum = typeof seed === 'number' ? seed >>> 0 : hashString(seed);
  const sm = splitmix32(seedNum);
  let s0 = sm();
  let s1 = sm();
  let s2 = sm();
  let s3 = sm();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const nextU32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };

  return {
    next: () => nextU32() / 4294967296,
    int: (n: number) => {
      if (n <= 0) throw new Error('int(n) requires n > 0');
      // Rejection sampling to avoid modulo bias.
      const limit = 4294967296 - (4294967296 % n);
      let x = nextU32();
      while (x >= limit) x = nextU32();
      return x % n;
    },
    state: () => [s0, s1, s2, s3],
  };
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** In-place Fisher–Yates shuffle driven by the given RNG. Returns the same array. */
export function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}
