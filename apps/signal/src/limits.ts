/**
 * Rate-limiting primitives: a token bucket, and a table of buckets keyed by
 * client that evicts idle entries. The clock is injected so tests can control time.
 */
export type Clock = () => number;

/** Classic token bucket: holds at most `capacity` tokens and refills continuously at `refillPerSec`. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    readonly capacity: number,
    readonly refillPerSec: number,
    private readonly now: Clock = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  private refill(): void {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.last = t;
  }

  /** Spends `n` tokens if that many are available and returns true. Otherwise spends nothing and returns false. */
  take(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Number of tokens available right now. */
  available(): number {
    this.refill();
    return this.tokens;
  }

  /** True once the bucket has completely refilled, so it behaves exactly like a new one. */
  isFull(): boolean {
    return this.available() >= this.capacity;
  }
}

/**
 * A table holding one bucket per key, such as an IP address or a peer id.
 * Buckets that have gone unused for `idleMs` and have refilled are evicted, so
 * the table cannot grow without limit. An evicted bucket comes back full,
 * which is the same state it was in when it was dropped.
 */
export class BucketTable<K> {
  private readonly buckets = new Map<K, { bucket: TokenBucket; lastUsed: number }>();
  private readonly now: Clock;
  private readonly idleMs: number;
  private lastSweep: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    opts: { now?: Clock; idleMs?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    const refillMs = refillPerSec > 0 ? (capacity / refillPerSec) * 1000 : 60_000;
    this.idleMs = opts.idleMs ?? Math.max(60_000, refillMs);
    this.lastSweep = this.now();
  }

  /** Take `n` tokens from `key`'s bucket, creating it full on first use. Sweeps idle buckets as time passes. */
  take(key: K, n = 1): boolean {
    const t = this.now();
    if (t - this.lastSweep >= this.idleMs) this.sweep();
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.capacity, this.refillPerSec, this.now), lastUsed: t };
      this.buckets.set(key, entry);
    }
    entry.lastUsed = t;
    return entry.bucket.take(n);
  }

  /** Evict buckets that have been idle for at least `idleMs` and have refilled. Returns how many were removed. */
  sweep(): number {
    const t = this.now();
    this.lastSweep = t;
    let evicted = 0;
    for (const [key, entry] of this.buckets) {
      if (t - entry.lastUsed >= this.idleMs && entry.bucket.isFull()) {
        this.buckets.delete(key);
        evicted++;
      }
    }
    return evicted;
  }

  forget(key: K): void {
    this.buckets.delete(key);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/** The parts of an incoming HTTP request that identify the client. */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}

/**
 * Returns the client's IP address. Behind a trusted proxy this is the first hop
 * of `x-forwarded-for`. Without one, the client controls that header, so it is ignored.
 */
export function clientIp(req: RequestLike, trustProxy: boolean): string {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for'];
    const header = Array.isArray(raw) ? raw[0] : raw;
    const first = header?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
