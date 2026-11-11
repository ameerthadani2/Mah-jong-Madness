/**
 * Rate-limiting primitives: a token bucket, and a table of buckets keyed by
 * client that evicts idle entries. The clock is injected so tests can control time.
 * Also `cleanField`, the size limit applied to every piece of free text a player sends.
 */
import { isIP } from 'node:net';
import { cleanText, type CleanTextOptions } from '@mjm/net';

export type Clock = () => number;

/**
 * Free text from a player, cleaned with `cleanText` (controls including NUL, bidi overrides and
 * invisible characters removed, whitespace tidied) and cut to at most `max` characters that also
 * fit in `max` UTF-16 code units, so neither a later `slice(0, max)` nor a database length check
 * can split an emoji or turn the text away. The result may be empty; callers choose a fallback.
 */
export function cleanField(value: unknown, max: number, opts: CleanTextOptions = {}): string {
  let s = cleanText(value, max, opts);
  let n = max;
  while (s.length > max && n > 1) {
    n = Math.max(1, Math.min(n - 1, Math.floor((n * max) / s.length)));
    s = cleanText(s, n, opts);
  }
  return s.length <= max ? s : '';
}

export const DAY_MS = 86_400_000;

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

  /** Whether `key`'s bucket holds `n` tokens right now. Nothing is taken and no bucket is created. */
  has(key: K, n = 1): boolean {
    const entry = this.buckets.get(key);
    return entry ? entry.bucket.available() >= n : this.capacity >= n;
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

/** The eight 16-bit groups of an IPv6 address `isIP` accepted (`::` expanded, a dotted tail read as two groups). */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const bytes = tail.split('.').map(Number);
    if (bytes.length !== 4 || bytes.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) return null;
    text = `${text.slice(0, lastColon + 1)}${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill('0'), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The key every per-address limit uses for a client address: an IPv4 address as it is, and an
 * IPv6 address cut to its /64 prefix (`2001:db8:1:2::/64`), because one IPv6 customer is handed
 * a whole /64 (2^64 addresses) and a key per address would give each of them a fresh allowance.
 * An IPv4 address written as IPv6 (`::ffff:203.0.113.7`, as a dual-stack socket reports it) is
 * that IPv4 address. Brackets, a port after them and a zone id are dropped. Anything that is not
 * an address is returned unchanged, so it still keys one bucket.
 */
export function addressKey(address: string): string {
  let a = address.trim();
  const bracketed = /^\[([^\]]*)\](?::\d+)?$/.exec(a);
  if (bracketed) a = bracketed[1];
  const zone = a.indexOf('%');
  if (zone >= 0) a = a.slice(0, zone);
  const family = isIP(a);
  if (family === 4) return a;
  if (family !== 6) return address;
  const g = ipv6Groups(a.toLowerCase());
  if (!g) return address;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  return `${g[0].toString(16)}:${g[1].toString(16)}:${g[2].toString(16)}:${g[3].toString(16)}::/64`;
}

/**
 * Returns the client's address as every per-address limit keys it (see `addressKey`: an IPv4
 * address, or the /64 prefix of an IPv6 one). It is used for limits only, never to reach the client.
 *
 * `trustProxy` is the number of reverse proxies you run in front of the server
 * (0 or `false`: none). Each proxy appends the address it received the request
 * from to `x-forwarded-for`, so the entries a client writes itself are always on
 * the left and only the rightmost `trustProxy` entries can be trusted. The client
 * address is therefore the `trustProxy`-th entry from the right: with one proxy,
 * the rightmost entry. Taking the leftmost entry would let a client choose its own
 * address and escape every per-IP limit.
 *
 * Without a trusted proxy the client controls that header, so it is ignored. When
 * the header holds fewer entries than expected, the leftmost one is used.
 */
export function clientIp(req: RequestLike, trustProxy: number | boolean): string {
  const hops = trustProxy === true ? 1 : trustProxy === false ? 0 : Math.max(0, Math.floor(trustProxy));
  if (hops > 0) {
    const raw = req.headers['x-forwarded-for'];
    const header = Array.isArray(raw) ? raw.join(',') : raw;
    const entries = (header ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (entries.length > 0) return addressKey(entries[Math.max(0, entries.length - hops)]);
  }
  return addressKey(req.socket?.remoteAddress ?? 'unknown');
}
