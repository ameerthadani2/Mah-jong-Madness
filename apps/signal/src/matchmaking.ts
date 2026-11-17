/**
 * Quick match (plan decision 3): instant seating with strangers.
 *
 * A signed-in socket (guests too) sends `{t:'queue'}`. The server checks the account (not banned,
 * a birth year on file that makes it 18 or older: `age_missing` without one, `age_under` when it
 * is too young; the year is write-once, see `PATCH /api/me`) and loads who it must never sit with (players it
 * blocked and players who blocked it), then answers `{t:'queue_status', position, waitedMs,
 * humans, fillMs}` at once and every `statusEveryMs` (2 s) while it waits. Players are grouped in
 * arrival order, four to a table, never two at one table where either blocked the other, and never
 * two accounts from one IPv6 /64 (as `addressKey` keys it) or one device (the install the session
 * was made on) at one table: each of them is seated with others, or with bots once its wait is up.
 * One IPv4 address is only a preference, because a mobile carrier puts many strangers behind one
 * shared address: accounts behind one IPv4 address are grouped apart while other humans are
 * waiting, and a group whose wait is up takes in a waiting account from its own IPv4 address (with
 * no block or shared device or /64) rather than seat bots in that place. The matchmaker also
 * counts, in memory per process, how often each pair of accounts sat together and at how many of
 * those tables they shared an IPv4 address (`frequentPairs`, shown to moderators). A group
 * of four is seated at once; a group of one to three is seated with Club bots in the empty seats
 * once its first player has waited `fillMs` (QUICK_MATCH_FILL_MS, default 20 s), so a solo player
 * always gets a game. Each player of a seated group gets `{t:'matched', room, humans, bots}` and
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
 * seated without it.
 *
 * Refusals are `{t:'queue_error', code, message}` with code `banned`, `age_missing`, `age_under`,
 * `rate_limited`, `sign_in`, `unavailable`, `replaced` or `seated` (which also carries `room`).
 */

import { isIP } from 'node:net';
import { addressKey } from './limits';

/** Default for `MatchmakerOptions.fillMs` (QUICK_MATCH_FILL_MS). */
export const DEFAULT_QUICK_MATCH_FILL_MS = 20_000;
/** Longest QUICK_MATCH_FILL_MS accepted (10 minutes). */
const MAX_FILL_MS = 600_000;

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
  /** Open the table for a group, in seat order; returns its room code. A throw answers `unavailable`. */
  openTable(userIds: string[]): string;
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
  log?: (line: string) => void;
}

interface Entry {
  peer: QueuePeer;
  joinedAt: number;
  /** Arrival order among entries that joined in the same millisecond. */
  seq: number;
  avoid: Set<string>;
  /**
   * The address key and device: no two entries that share a device or an IPv6 /64 sit at one
   * table; two that share an IPv4 address do only when the alternative is bots (`groups`).
   */
  address: string | null;
  device: string | null;
  lastStatusAt: number;
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
    let device: string | null;
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
      [avoid, device] = await Promise.all([new Set(await this.opts.avoid(peer.userId)), this.deviceOf(peer)]);
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
    const entry: Entry = { peer, joinedAt, seq, avoid, address, device, lastStatusAt: this.now() };
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
   * Pairs of accounts that sat together at `min` or more quick-match tables, most often first.
   * Kept in memory by this process only (lost on a restart, and not shared between servers).
   */
  frequentPairs(min = 3): QuickMatchPair[] {
    return [...this.pairs.values()]
      .filter((p) => p.tables >= min)
      .sort((x, y) => y.tables - x.tables || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0))
      .map((p) => ({ ...p }));
  }

  private countPairs(seated: Entry[]): void {
    const at = this.now();
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
        if (this.pairs.size > MAX_TRACKED_PAIRS) this.pairs.delete(this.pairs.keys().next().value as string);
      }
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
   * Groups in arrival order: each player joins the earliest group with room and nobody it may not
   * sit with, nor anybody from its IPv4 address. Then each group whose wait is up and still has
   * room, earliest first, takes in waiting players from later groups that are not full (earliest
   * first) whom only a shared IPv4 address kept apart, so they sit together rather than with bots.
   */
  private groups(): Entry[][] {
    const groups: Entry[][] = [];
    for (const e of this.ordered()) {
      const g = groups.find((g) => g.length < TABLE_SIZE && g.every((o) => !clash(e, o) && !sameIPv4(e, o)));
      if (g) g.push(e);
      else groups.push([e]);
    }
    const now = this.now();
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g.length === 0 || g.length === TABLE_SIZE || now - Math.min(...g.map((e) => e.joinedAt)) < this.fillMs) continue;
      for (let j = i + 1; j < groups.length && g.length < TABLE_SIZE; j++) {
        const h = groups[j];
        if (h.length === TABLE_SIZE) continue;
        for (const e of [...h]) {
          if (g.length === TABLE_SIZE) break;
          if (g.some((o) => clash(e, o))) continue;
          g.push(e);
          h.splice(h.indexOf(e), 1);
        }
      }
    }
    return groups.filter((g) => g.length > 0);
  }

  private match(): void {
    const now = this.now();
    for (const g of this.groups()) {
      const full = g.length === TABLE_SIZE;
      if (!full && now - Math.min(...g.map((e) => e.joinedAt)) < this.fillMs) continue;
      // The table counts against its players' create allowance, like any table they open. A player
      // with none left waits on (it is asked again at the next pass); the others are not held up.
      const broke = new Set(this.opts.charge?.(g.map((e) => e.peer.peerId)) ?? []);
      const seated = g.filter((e) => !broke.has(e.peer.peerId));
      for (const e of seated) this.entries.delete(e.peer.peerId);
      if (seated.length === 0) continue;
      let room: string;
      try {
        room = this.opts.openTable(seated.map((e) => e.peer.userId));
      } catch (e) {
        this.opts.log?.(`[signal] quick match table not opened: ${(e as Error).message}`);
        for (const x of seated) refuse(x.peer, 'unavailable');
        continue;
      }
      this.countPairs(seated);
      for (const e of seated) e.peer.send({ t: 'matched', room, humans: seated.length, bots: TABLE_SIZE - seated.length });
    }
  }

  private sendStatus(e: Entry, groups: Entry[][]): void {
    const now = this.now();
    e.lastStatusAt = now;
    const position = this.ordered().indexOf(e) + 1;
    const humans = groups.find((g) => g.includes(e))?.length ?? 1;
    e.peer.send({ t: 'queue_status', position, waitedMs: now - e.joinedAt, humans, fillMs: this.fillMs });
  }
}

/**
 * Two entries that may never share a table: a block either way, one device, or one address key
 * that is not an IPv4 address (an IPv6 /64, or an address that could not be read).
 */
function clash(a: Entry, b: Entry): boolean {
  if (a.avoid.has(b.peer.userId) || b.avoid.has(a.peer.userId)) return true;
  if (a.address !== null && a.address === b.address && isIP(a.address) !== 4) return true;
  return a.device !== null && a.device === b.device;
}

/** Two entries from one IPv4 address: kept apart while others are waiting (`Matchmaker.groups`). */
function sameIPv4(a: Entry, b: Entry): boolean {
  return a.address !== null && a.address === b.address && isIP(a.address) === 4;
}

function refuse(peer: QueuePeer, code: QueueRefusal, extra: { room?: string } = {}): void {
  peer.send({ t: 'queue_error', code, message: QUEUE_MESSAGES[code], ...extra });
}
