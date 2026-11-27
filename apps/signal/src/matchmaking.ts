/**
 * Quick match (plan decision 3): instant seating with strangers.
 *
 * A signed-in socket (guests too) sends `{t:'queue'}`. The server checks the account (not banned,
 * a birth year on file that makes it 18 or older: `age_missing` without one, `age_under` when it
 * is too young; the year is write-once, see `PATCH /api/me`) and loads who it must never sit with (players it
 * blocked and players who blocked it), then answers `{t:'queue_status', position, waitedMs,
 * humans, fillMs, cooldownMs?}` at once and every `statusEveryMs` (2 s) while it waits. Players are grouped
 * four to a table by their quick-match rating (src/tableRating.ts): when more players are waiting
 * than one table holds, the four closest ratings sit together first, and a full table is seated as
 * soon as its spread of ratings is within what its longest-waiting player accepts (200 points at
 * once, widening to 1,000 by the fill time, `ratingSpreadFor`). Nobody waits past the fill time for
 * a closer table: a player whose wait is up is seated then with the waiting players closest to its
 * rating, and bots in the empty seats. Never two at one table where either blocked the other, and never
 * two accounts from one IPv6 /64 (as `addressKey` keys it) or one device (the install the session
 * was made on) at one table: each of them is seated with others, or with bots once its wait is up.
 * One IPv4 address is only a preference, because a mobile carrier puts many strangers behind one
 * shared address: accounts behind one IPv4 address are grouped apart while other humans are
 * waiting, and a group whose wait is up takes in a waiting account from its own IPv4 address (with
 * no block or shared device or /64) rather than seat bots in that place. The matchmaker also
 * counts how often each pair of accounts sat together and at how many of those tables they shared
 * an IPv4 address (`pairStore`: the repositories, so the database on Postgres and the counts survive
 * a restart; shown to moderators). A pair that shared an IPv4 address at three tables in one UTC day
 * (`KEEP_APART_SHARED_PER_DAY`) is kept apart for the rest of that day, as a block keeps two accounts
 * apart: a second account behind one home address cannot keep sitting with the first. The next day
 * the pair may sit together again, and its count starts again from nothing. The table is opened
 * with the pairs of its players that queued from one address key or one device (`linkedPairs`):
 * neither account of such a pair is rated at that table, and every other human is (src/tableRating.ts). A group
 * of four within the rating spread is seated at once; any group is seated, with Club bots in the
 * empty seats, once its first player has waited `fillMs` (QUICK_MATCH_FILL_MS, default 20 s), so a
 * solo player always gets a game. Each player of a seated group gets `{t:'matched', room, humans, bots}` and
 * joins the table by its code as usual (rooms.ts restricts it to them and starts it by itself).
 * `{t:'leave_queue'}` or closing the socket leaves; a second socket of the same account replaces
 * the first (`{t:'queue_error', code:'replaced'}` to the old one) and keeps its place.
 *
 * Quick-match tables stay inside the server's limits: an account that is still at an unfinished
 * quick-match table (it holds a seat there that it has not left on purpose, or the table is
 * waiting for it to sit down) cannot queue again and is told which table
 * (`{t:'queue_error', code:'seated', room}`), so the app can go back to it; and opening a table is charged to each matched player's create allowance and
 * once to each address they came from, exactly as creating a table is. A player with no
 * allowance left keeps its place in the queue until it has some, and the rest of the group is
 * seated without it; nothing is charged to a player who is refused. This is on purpose (a player
 * cannot churn tables by leaving and queueing again), so a player who left a table moments ago
 * waits up to `createCooldownMs` (10 s) to be seated again, and players who share an address wait
 * for its allowance too (`createsPerIpPerMinute`, one more table every 10 s once it is spent); its
 * `queue_status` says how long (`cooldownMs`) and whose allowance it waits for (`cooldownBy`:
 * `account` or `address`), and the app shows it.
 *
 * Refusals are `{t:'queue_error', code, message}` with code `banned`, `age_missing`, `age_under`,
 * `rate_limited`, `sign_in`, `unavailable`, `replaced` or `seated` (which also carries `room`).
 */

import { isIP } from 'node:net';
import { addressKey } from './limits';
import { KEEP_APART_SHARED_PER_DAY } from './repos/types';

/** Default for `MatchmakerOptions.fillMs` (QUICK_MATCH_FILL_MS). */
export const DEFAULT_QUICK_MATCH_FILL_MS = 20_000;
/** Longest QUICK_MATCH_FILL_MS accepted (10 minutes). */
const MAX_FILL_MS = 600_000;
const DAY_MS = 86_400_000;

/** QUICK_MATCH_FILL_MS: a whole number of milliseconds from 1 to 600,000, else the default. */
export function fillMsFromEnv(env: Record<string, string | undefined>): number {
  const v = (env.QUICK_MATCH_FILL_MS ?? '').trim();
  const n = Number(v);
  return v && Number.isInteger(n) && n > 0 && n <= MAX_FILL_MS ? n : DEFAULT_QUICK_MATCH_FILL_MS;
}

/** How often a waiting player hears how the search is going. */
export const QUEUE_STATUS_MS = 2_000;
/** The age a quick-match account must be, as the app's age gate counts it (src/legal/age.ts). */
export const QUICK_MATCH_MIN_AGE = 18;
export const TABLE_SIZE = 4;

export type QueueRefusal = 'banned' | 'age_missing' | 'age_under' | 'rate_limited' | 'sign_in' | 'unavailable' | 'replaced' | 'seated';
/** What the account check can answer. */
export type AccountRefusal = 'banned' | 'age_missing' | 'age_under';

export const QUEUE_MESSAGES: Record<QueueRefusal, string> = {
  banned: 'This account has been banned',
  age_missing: 'Quick match needs your birth year',
  age_under: `Quick match is for players aged ${QUICK_MATCH_MIN_AGE} or older`,
  rate_limited: 'Too many quick-match requests; please wait a few seconds',
  sign_in: 'Sign in to use quick match',
  unavailable: 'Quick match is not available right now; please try again',
  replaced: 'You joined quick match from another device',
  seated: 'You are still at a quick-match table; go back to it, or wait for it to finish',
};

/** A socket asking to be matched (the room registry passes these in). */
export interface QueuePeer {
  peerId: string;
  userId: string;
  /** The client address (keyed as every per-address limit keys it: see `addressKey`), when known. */
  address?: string;
  /** The session the socket proved, so the queue can look up the device it was made on. */
  sessionId?: string;
  send(msg: unknown): void;
}

/** How often a pair of accounts sat together at quick-match tables (`Matchmaker.frequentPairs`). */
export interface QuickMatchPair {
  a: string;
  b: string;
  tables: number;
  /** Of those tables, how many the two accounts joined from one IPv4 address. */
  sharedAddress: number;
  lastAt: number;
}

/** Most account pairs the matchmaker remembers; past it, the pair seen together least recently is forgotten. */
export const MAX_TRACKED_PAIRS = 20_000;

/** What the room registry calls (see `RoomRegistryOptions.queue`). */
export interface QueueGate {
  enqueue(peer: QueuePeer): void;
  leave(peerId: string): void;
}

export interface MatchmakerOptions {
  now?: () => number;
  /** How long a group short of four waits before bots fill its empty seats (default 20 s). */
  fillMs?: number;
  /** How often a waiting player is sent `queue_status` (default 2 s). */
  statusEveryMs?: number;
  /** Whether the account may queue: null, or why not. A throw answers `unavailable`. */
  check(userId: string): Promise<AccountRefusal | null>;
  /** The accounts this one must never share a table with (it blocked them, or they blocked it). */
  avoid(userId: string): Promise<Iterable<string>>;
  /**
   * The device the socket's session was made on (the install the app reports, or the device
   * record), or null when unknown. Two accounts on one device never share a table. A throw reads as unknown.
   */
  device?(peer: QueuePeer): Promise<string | null>;
  /**
   * The account's quick-match rating (src/tableRating.ts), read when it queues: tables prefer
   * close ratings. Absent, or a throw: `UNRATED`.
   */
  rating?(userId: string): Promise<number>;
  /** Open the table for a group, in seat order; returns its room code. A throw answers `unavailable`. */
  openTable(userIds: string[], linked: Array<[string, string]>): string;
  /**
   * The unfinished quick-match table this account is still at (it holds a seat there, or the
   * table is waiting for it to sit down), if any: such an account is not queued again.
   */
  seatedAt?(userId: string): string | undefined;
  /**
   * Charge opening a table to these sockets (the create allowance of each account, and of each
   * address once). Returns the peer ids with no allowance left: they stay in the queue, keeping
   * their place, and the others are seated without them.
   */
  charge?(peerIds: string[]): string[];
  /**
   * How long (ms) until opening a table can be charged to this socket again (`charge`): 0 when it
   * can now; and which allowance holds it back, its account's or its address's. A player waiting on
   * it is told both (`queue_status.cooldownMs`, `cooldownBy`).
   */
  cooldown?(peerId: string): { ms: number; by: 'account' | 'address' };
  /**
   * Where the pair counts are kept (the repositories' `quickMatchPairs`: the database on Postgres,
   * so they survive a restart and the admin view reads them there). Without it they are kept in
   * this process (`frequentPairs`).
   */
  pairStore?: { record(pairs: Array<{ a: string; b: string; shared: boolean }>, at: number, max: number): Promise<void>; keptApart(userId: string, at: number): Promise<string[]> };
  log?: (line: string) => void;
}

interface Entry {
  peer: QueuePeer;
  joinedAt: number;
  /** Arrival order among entries that joined in the same millisecond. */
  seq: number;
  avoid: Set<string>;
  /** Accounts kept apart from this one today for sharing an IPv4 address too often (`KEEP_APART_SHARED_PER_DAY`). */
  apart: Set<string>;
  /**
   * The address key and device: no two entries that share a device or an IPv6 /64 sit at one
   * table; two that share an IPv4 address do only when the alternative is bots (`groups`).
   */
  address: string | null;
  device: string | null;
  /** The account's quick-match rating when it queued (src/tableRating.ts). */
  rating: number;
  lastStatusAt: number;
  /** The last status it was sent carried a `cooldownMs`: it knows it waits for a table allowance. */
  toldCooldown: boolean;
}

/** The rating an account without one (or whose rating could not be read) is matched at. */
export const UNRATED = 1500;
/** The widest spread of ratings a full table is seated with at once, and how far it widens by the fill time. */
export const RATING_SPREAD_AT_ONCE = 200;
export const RATING_SPREAD_WIDENS_BY = 800;

/**
 * The widest spread of ratings (highest minus lowest) a full table of four is seated with once its
 * longest-waiting player has waited `waitedMs`: 200 points at once, widening evenly to 1,000 at
 * the fill time, after which any spread will do (that player is seated then in any case).
 */
export function ratingSpreadFor(waitedMs: number, fillMs: number): number {
  if (waitedMs >= fillMs) return Infinity;
  return RATING_SPREAD_AT_ONCE + (RATING_SPREAD_WIDENS_BY * Math.max(0, waitedMs)) / fillMs;
}

function sortByArrival(g: Entry[]): Entry[] {
  return [...g].sort((a, b) => a.joinedAt - b.joinedAt || a.seq - b.seq);
}

/** The age a birth year makes someone at the least this year (no birthday is asked, so the latest one is assumed). */
export function minimumAge(birthYear: number, currentYear: number): number {
  return currentYear - birthYear - 1;
}

/**
 * The repositories' answer to `MatchmakerOptions.check`: banned first, then the birth year
 * (`age_missing` when the server has none, so the app may send the one it holds; `age_under` when
 * the year on file makes the account younger than 18, which nothing the app sends can change).
 */
export async function quickMatchCheck(
  repos: {
    users: { get(id: string): Promise<{ birthYear: number | null; deletedAt: number | null } | null> };
    moderation: { status(id: string): Promise<{ bannedAt: number | null } | null> };
  },
  userId: string,
  now: number,
): Promise<AccountRefusal | null> {
  const [user, status] = await Promise.all([repos.users.get(userId), repos.moderation.status(userId)]);
  if (!user || user.deletedAt !== null) throw new Error('No such account');
  if (status && status.bannedAt !== null) return 'banned';
  if (user.birthYear === null) return 'age_missing';
  if (minimumAge(user.birthYear, new Date(now).getUTCFullYear()) < QUICK_MATCH_MIN_AGE) return 'age_under';
  return null;
}

/** The repositories' answer to `MatchmakerOptions.avoid`: blocks in both directions. */
export async function blockedEitherWay(repos: { blocks: { list(id: string): Promise<Array<{ blockedId: string }>>; blockersOf(id: string): Promise<string[]> } }, userId: string): Promise<string[]> {
  const [mine, theirs] = await Promise.all([repos.blocks.list(userId), repos.blocks.blockersOf(userId)]);
  return [...mine.map((b) => b.blockedId), ...theirs];
}

export class Matchmaker implements QueueGate {
  private readonly entries = new Map<string, Entry>();
  /** Requests still being checked, by peer; a leave meanwhile cancels the request. */
  private readonly pending = new Map<string, number>();
  /** Quick-match tables shared, by pair of accounts ("a b", a < b), least recently seen first. */
  private readonly pairs = new Map<string, QuickMatchPair>();
  private seq = 0;
  /** Without a `pairStore`: the IPv4 tables each pair shared on its last such UTC day, and whether that kept it apart that day. */
  private readonly sharedDays = new Map<string, { day: number; today: number; apart: boolean }>();
  /** The chain of pair-count writes to `pairStore`. */
  private pairWrites: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  readonly fillMs: number;
  private readonly statusEveryMs: number;

  constructor(private readonly opts: MatchmakerOptions) {
    this.now = opts.now ?? Date.now;
    this.fillMs = opts.fillMs ?? DEFAULT_QUICK_MATCH_FILL_MS;
    this.statusEveryMs = opts.statusEveryMs ?? QUEUE_STATUS_MS;
  }

  /** Players waiting (not those still being checked). */
  size(): number {
    return this.entries.size;
  }

  /** The accounts waiting, in arrival order (for tests and diagnostics). */
  waiting(): string[] {
    return this.ordered().map((e) => e.peer.userId);
  }

  /**
   * Put a socket in the queue. Resolves once it is in (or refused): the checks are asynchronous,
   * and the socket may leave meanwhile, which cancels the request.
   */
  async enqueue(peer: QueuePeer): Promise<void> {
    const queued = this.entries.get(peer.peerId);
    if (queued) {
      // Asked again from the same socket: it keeps its place and hears where it stands.
      this.sendStatus(queued, this.groups());
      return;
    }
    const ticket = ++this.seq;
    this.pending.set(peer.peerId, ticket);
    let avoid: Set<string>;
    let apart: Set<string>;
    let device: string | null;
    let rating: number;
    try {
      const refusal = await this.opts.check(peer.userId);
      if (this.pending.get(peer.peerId) !== ticket) return;
      if (refusal) {
        this.pending.delete(peer.peerId);
        return refuse(peer, refusal);
      }
      // One quick-match table per account: back to the one it is at, never a second.
      const room = this.opts.seatedAt?.(peer.userId);
      if (room !== undefined) {
        this.pending.delete(peer.peerId);
        return refuse(peer, 'seated', { room });
      }
      [avoid, apart, device, rating] = await Promise.all([new Set(await this.opts.avoid(peer.userId)), this.keptApartFrom(peer.userId), this.deviceOf(peer), this.ratingOf(peer.userId)]);
    } catch (e) {
      if (this.pending.get(peer.peerId) !== ticket) return;
      this.pending.delete(peer.peerId);
      this.opts.log?.(`[signal] quick match check failed: ${(e as Error).message}`);
      return refuse(peer, 'unavailable');
    }
    if (this.pending.get(peer.peerId) !== ticket) return;
    this.pending.delete(peer.peerId);
    // One entry per account: a second socket takes over the first one's place.
    let joinedAt = this.now();
    let seq = ticket;
    for (const [peerId, e] of this.entries) {
      if (e.peer.userId !== peer.userId) continue;
      this.entries.delete(peerId);
      refuse(e.peer, 'replaced');
      joinedAt = e.joinedAt;
      seq = e.seq;
    }
    const address = peer.address !== undefined ? addressKey(peer.address) : null;
    const entry: Entry = { peer, joinedAt, seq, avoid, apart, address, device, rating, lastStatusAt: this.now(), toldCooldown: false };
    this.entries.set(peer.peerId, entry);
    this.match();
    if (this.entries.has(peer.peerId)) this.sendStatus(entry, this.groups());
  }

  /** The socket left the queue (`leave_queue`, or it closed). */
  leave(peerId: string): void {
    this.pending.delete(peerId);
    const e = this.entries.get(peerId);
    if (!e) return;
    this.entries.delete(peerId);
    e.peer.send({ t: 'queue_left' });
    this.match();
  }

  /**
   * Pairs of accounts that sat together at `min` or more quick-match tables, most often first,
   * when this matchmaker keeps them itself (no `pairStore`: in this process only, lost on a
   * restart). With a `pairStore` they are read from there instead.
   */
  frequentPairs(min = 3): QuickMatchPair[] {
    return [...this.pairs.values()]
      .filter((p) => p.tables >= min)
      .sort((x, y) => y.tables - x.tables || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0))
      .map((p) => ({ ...p }));
  }

  /** Resolves once every pair count written so far has reached the pair store (tests, shutdown). */
  pairsSaved(): Promise<void> {
    return this.pairWrites;
  }

  private countPairs(seated: Entry[]): void {
    const at = this.now();
    const store = this.opts.pairStore;
    if (store) {
      const pairs: Array<{ a: string; b: string; shared: boolean }> = [];
      for (let i = 0; i < seated.length; i++) {
        for (let j = i + 1; j < seated.length; j++) {
          const [x, y] = seated[i].peer.userId < seated[j].peer.userId ? [seated[i], seated[j]] : [seated[j], seated[i]];
          if (x.peer.userId !== y.peer.userId) pairs.push({ a: x.peer.userId, b: y.peer.userId, shared: x.address !== null && x.address === y.address });
        }
      }
      // One write after another, so the counts add up in order; a failed write is logged, not retried.
      this.pairWrites = this.pairWrites.then(() => store.record(pairs, at, MAX_TRACKED_PAIRS)).catch((e: Error) => this.opts.log?.(`[signal] quick match pair counts not saved: ${e.message}`));
      return;
    }
    for (let i = 0; i < seated.length; i++) {
      for (let j = i + 1; j < seated.length; j++) {
        const [x, y] = seated[i].peer.userId < seated[j].peer.userId ? [seated[i], seated[j]] : [seated[j], seated[i]];
        const a = x.peer.userId;
        const b = y.peer.userId;
        if (a === b) continue;
        const key = `${a} ${b}`;
        const shared = x.address !== null && x.address === y.address ? 1 : 0;
        const p = this.pairs.get(key) ?? { a, b, tables: 0, sharedAddress: 0, lastAt: at };
        this.pairs.delete(key);
        this.pairs.set(key, { ...p, tables: p.tables + 1, sharedAddress: p.sharedAddress + shared, lastAt: at });
        if (shared) {
          const day = Math.floor(at / DAY_MS);
          const d = this.sharedDays.get(key);
          const today = d && d.day === day ? d.today + 1 : 1;
          // Kept apart for the rest of this UTC day only: a new day starts the count again.
          this.sharedDays.set(key, { day, today, apart: today >= KEEP_APART_SHARED_PER_DAY });
        }
        if (this.pairs.size > MAX_TRACKED_PAIRS) {
          // The pair seen together least recently goes, unless it is kept apart today.
          const old = [...this.pairs.keys()].find((k) => !this.apartToday(this.sharedDays.get(k), at));
          if (old !== undefined) {
            this.pairs.delete(old);
            this.sharedDays.delete(old);
          }
        }
      }
    }
  }

  /** Whether a pair's shared-address count keeps it apart on the UTC day of `at`. */
  private apartToday(d: { day: number; apart: boolean } | undefined, at: number): boolean {
    return !!d && d.apart && d.day === Math.floor(at / DAY_MS);
  }

  /** Who this account is kept apart from today (after every pair count written so far); unknown reads as nobody. */
  private async keptApartFrom(userId: string): Promise<Set<string>> {
    const store = this.opts.pairStore;
    const at = this.now();
    if (!store) {
      const out = new Set<string>();
      for (const [key, d] of this.sharedDays) {
        const [a, b] = key.split(' ');
        if (this.apartToday(d, at) && (a === userId || b === userId)) out.add(a === userId ? b : a);
      }
      return out;
    }
    try {
      await this.pairWrites;
      return new Set(await store.keptApart(userId, at));
    } catch (e) {
      this.opts.log?.(`[signal] quick match kept-apart pairs not read: ${(e as Error).message}`);
      return new Set();
    }
  }

  private async ratingOf(userId: string): Promise<number> {
    if (!this.opts.rating) return UNRATED;
    try {
      const r = await this.opts.rating(userId);
      return Number.isFinite(r) ? r : UNRATED;
    } catch {
      return UNRATED;
    }
  }

  private async deviceOf(peer: QueuePeer): Promise<string | null> {
    if (!this.opts.device) return null;
    try {
      return (await this.opts.device(peer)) || null;
    } catch {
      return null;
    }
  }

  /** Take an account out of the queue (it was banned). */
  removeUser(userId: string): void {
    for (const [peerId, e] of this.entries) {
      if (e.peer.userId !== userId) continue;
      this.entries.delete(peerId);
      refuse(e.peer, 'banned');
    }
  }

  /** The account's blocks changed: read them again if it is waiting. */
  blocksChanged(userId: string): void {
    for (const e of this.entries.values()) {
      if (e.peer.userId !== userId) continue;
      this.opts.avoid(userId).then(
        (ids) => {
          e.avoid = new Set(ids);
        },
        () => undefined,
      );
    }
  }

  /** Seat whoever can be seated and tell the rest how the search is going. Call every ~500 ms. */
  tick(): void {
    this.match();
    const groups = this.groups();
    const now = this.now();
    for (const e of this.entries.values()) if (now - e.lastStatusAt >= this.statusEveryMs) this.sendStatus(e, groups);
  }

  private ordered(): Entry[] {
    return [...this.entries.values()].sort((a, b) => a.joinedAt - b.joinedAt || a.seq - b.seq);
  }

  /**
   * Who would sit with whom now (for `queue_status`): in arrival order, each player not yet placed
   * starts a group and takes in the waiting players closest to its rating (earliest first on a
   * tie) that nothing keeps apart from the group, nor a shared IPv4 address; a group whose first
   * player's wait is up also takes in players only a shared IPv4 address kept apart.
   */
  private groups(): Entry[][] {
    const left = this.ordered();
    const groups: Entry[][] = [];
    while (left.length > 0) {
      const g = this.gather(left[0], left.slice(1), this.waitIsUp(left[0]));
      for (const e of g) left.splice(left.indexOf(e), 1);
      groups.push(g);
    }
    return groups;
  }

  /** Whether this player has waited the fill time: its group is seated now, with bots if need be. */
  private waitIsUp(e: Entry): boolean {
    return this.now() - e.joinedAt >= this.fillMs;
  }

  /**
   * `first` and up to three of `others` (in arrival order), closest in rating to `first` first (the
   * earlier on a tie), each kept only if nothing keeps it apart from those already taken (a block,
   * a device, an IPv6 /64) nor a shared IPv4 address; then, when `shareIPv4`, the same again for
   * those only a shared IPv4 address kept out.
   */
  private gather(first: Entry, others: Entry[], shareIPv4: boolean): Entry[] {
    const byRating = others.map((e, i) => ({ e, i })).sort((x, y) => Math.abs(x.e.rating - first.rating) - Math.abs(y.e.rating - first.rating) || x.i - y.i).map((x) => x.e);
    const g = [first];
    for (const strict of shareIPv4 ? [true, false] : [true]) {
      for (const e of byRating) {
        if (g.length === TABLE_SIZE) return g;
        if (g.includes(e) || g.some((o) => clash(e, o) || (strict && sameIPv4(e, o)))) continue;
        g.push(e);
      }
    }
    return g;
  }

  /**
   * The table of four to seat now, if any: of the full groups the waiting players can make (each
   * player in turn taking in those closest to its rating, as `gather` does), the one with the
   * smallest spread of ratings (the earliest first player on a tie), provided that spread is within
   * what its longest-waiting player accepts (`ratingSpreadFor`). Null when no full group is close
   * enough yet: they wait on, but never past the fill time.
   */
  private closestFullGroup(): Entry[] | null {
    const all = this.ordered();
    let best: { g: Entry[]; spread: number } | null = null;
    for (const first of all) {
      const g = this.gather(
        first,
        all.filter((e) => e !== first),
        false,
      );
      if (g.length < TABLE_SIZE) continue;
      const ratings = g.map((e) => e.rating);
      const spread = Math.max(...ratings) - Math.min(...ratings);
      const waited = this.now() - Math.min(...g.map((e) => e.joinedAt));
      if (spread > ratingSpreadFor(waited, this.fillMs)) continue;
      if (!best || spread < best.spread) best = { g, spread };
    }
    return best ? sortByArrival(best.g) : null;
  }

  /**
   * Seat whoever can be seated. First the closest full tables, while any is within what its
   * players accept (with more players waiting than one table holds, the closest ratings sit
   * together first). Then each player whose wait is up, earliest first, is seated now with the
   * waiting players closest to its rating that may sit with it, and Club bots in the empty seats:
   * so nobody waits past the fill time, as before ratings counted.
   */
  private match(): void {
    // A group whose players all lack allowance seats nobody; it is not tried again in this pass.
    const tried = new Set<string>();
    for (;;) {
      const g = this.closestFullGroup();
      if (!g) break;
      const key = g.map((e) => e.peer.peerId).join(' ');
      if (tried.has(key)) break;
      tried.add(key);
      this.seat(g);
    }
    for (const e of this.ordered()) {
      if (!this.entries.has(e.peer.peerId) || !this.waitIsUp(e)) continue;
      const others = this.ordered().filter((o) => o !== e);
      this.seat(sortByArrival(this.gather(e, others, true)));
    }
  }

  /** Charge and open a table for a group (in seat order); a player with no allowance left waits on. */
  private seat(g: Entry[]): void {
    // The table counts against its players' create allowance, like any table they open. A player
    // with none left waits on (it is asked again at the next pass); the others are not held up.
    const broke = new Set(this.opts.charge?.(g.map((e) => e.peer.peerId)) ?? []);
    const seated = g.filter((e) => !broke.has(e.peer.peerId));
    for (const e of seated) this.entries.delete(e.peer.peerId);
    // A player left waiting for its allowance hears at once how long that is (once: the regular status repeats it).
    for (const e of g) if (broke.has(e.peer.peerId) && !e.toldCooldown) this.sendStatus(e, this.groups());
    if (seated.length === 0) return;
    let room: string;
    try {
      room = this.opts.openTable(
        seated.map((e) => e.peer.userId),
        linkedPairs(seated),
      );
    } catch (e) {
      this.opts.log?.(`[signal] quick match table not opened: ${(e as Error).message}`);
      for (const x of seated) refuse(x.peer, 'unavailable');
      return;
    }
    this.countPairs(seated);
    for (const e of seated) e.peer.send({ t: 'matched', room, humans: seated.length, bots: TABLE_SIZE - seated.length });
  }

  private sendStatus(e: Entry, groups: Entry[][]): void {
    const now = this.now();
    e.lastStatusAt = now;
    const position = this.ordered().indexOf(e) + 1;
    const humans = groups.find((g) => g.includes(e))?.length ?? 1;
    // A player who opened a table moments ago (or whose address did) is seated only once its allowance is back: say how long that is, and whose it is.
    const cooldown = this.opts.cooldown?.(e.peer.peerId) ?? { ms: 0, by: 'account' as const };
    const cooldownMs = Number.isFinite(cooldown.ms) && cooldown.ms > 0 ? Math.ceil(cooldown.ms) : 0;
    e.toldCooldown = cooldownMs > 0;
    e.peer.send({ t: 'queue_status', position, waitedMs: now - e.joinedAt, humans, fillMs: this.fillMs, ...(cooldownMs > 0 ? { cooldownMs, cooldownBy: cooldown.by } : {}) });
  }
}

/**
 * Two entries that may never share a table: a block either way, one device, or one address key
 * that is not an IPv4 address (an IPv6 /64, or an address that could not be read).
 */
function clash(a: Entry, b: Entry): boolean {
  if (a.avoid.has(b.peer.userId) || b.avoid.has(a.peer.userId)) return true;
  if (a.apart.has(b.peer.userId) || b.apart.has(a.peer.userId)) return true;
  if (a.address !== null && a.address === b.address && isIP(a.address) !== 4) return true;
  return a.device !== null && a.device === b.device;
}

/**
 * The pairs of a seated group (by account) that queued from one address key (an IPv4 address or an
 * IPv6 /64) or one device: neither account of such a pair is rated at that table (src/tableRating.ts).
 */
export function linkedPairs(seated: Array<{ peer: { userId: string }; address: string | null; device: string | null }>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < seated.length; i++) {
    for (let j = i + 1; j < seated.length; j++) {
      const [x, y] = [seated[i], seated[j]];
      if (x.peer.userId === y.peer.userId) continue;
      if ((x.address !== null && x.address === y.address) || (x.device !== null && x.device === y.device)) out.push([x.peer.userId, y.peer.userId]);
    }
  }
  return out;
}

/** Two entries from one IPv4 address: kept apart while others are waiting (`Matchmaker.groups`). */
function sameIPv4(a: Entry, b: Entry): boolean {
  return a.address !== null && a.address === b.address && isIP(a.address) === 4;
}

function refuse(peer: QueuePeer, code: QueueRefusal, extra: { room?: string } = {}): void {
  peer.send({ t: 'queue_error', code, message: QUEUE_MESSAGES[code], ...extra });
}
