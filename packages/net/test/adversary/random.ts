/**
 * Every random choice of a run comes from its seed, so a run replays exactly: the scenario generator draws from `Rng`,
 * and the secrets, tokens and device ids the table and the phone make come from `crypto.getRandomValues`, which
 * `withSeededCrypto` replaces for the length of a run with the stream the repository's tests use (`seededDeals`).
 */

/** A small seeded generator (mulberry32). */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 0x9e3779b9;
  }
  /** A number in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** An integer in [lo, hi]. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)];
  }
  /** One of `items`, each as likely as its weight. */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [x, w] of items) {
      r -= w;
      if (r < 0) return x;
    }
    return items[items.length - 1][0];
  }
}

/** A 32-bit hash of the seed and some words: a draw that does not depend on how many draws came before it. */
export function hashOf(seed: number, ...words: Array<string | number>): number {
  let h = (2166136261 ^ seed) >>> 0;
  for (const w of words) {
    const s = String(w);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ 0x2f, 16777619) >>> 0;
  }
  return h >>> 0;
}

/** Run `fn` with `crypto.getRandomValues` drawing from a stream seeded by `seed` (xorshift32, as `seededDeals`). */
export function withSeededCrypto<T>(seed: number, fn: () => T): T {
  const c = globalThis.crypto as typeof globalThis.crypto & { getRandomValues: (buf: Uint8Array) => Uint8Array };
  const own = Object.prototype.hasOwnProperty.call(c, 'getRandomValues');
  const prev = c.getRandomValues;
  let state = seed >>> 0 || 1;
  const seeded = (buf: Uint8Array) => {
    for (let i = 0; i < buf.length; i++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      buf[i] = (state >>> 0) & 0xff;
    }
    return buf;
  };
  Object.defineProperty(c, 'getRandomValues', { value: seeded, configurable: true, writable: true });
  try {
    return fn();
  } finally {
    if (own) Object.defineProperty(c, 'getRandomValues', { value: prev, configurable: true, writable: true });
    else delete (c as { getRandomValues?: unknown }).getRandomValues;
  }
}
