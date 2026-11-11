/**
 * Quick match (plan decision 3): instant seating with strangers.
 *
 * A signed-in socket (guests too) sends `{t:'queue'}`. The server checks the account (not banned,
 * a birth year on file that makes it 17 or older: `age_missing` without one, `age_under` when it
 * is too young; the year is write-once, see `PATCH /api/me`) and loads who it must never sit with (players it
 * blocked and players who blocked it), then answers `{t:'queue_status', position, waitedMs,
 * humans, fillMs}` at once and every `statusEveryMs` (2 s) while it waits. Players are grouped in
 * arrival order, four to a table, never two at one table where either blocked the other. A group
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
export const QUICK_MATCH_MIN_AGE = 17;
export const TABLE_SIZE = 4;

export type QueueRefusal = 'banned' | 'age_missing' | 'age_under' | 'rate_limited' | 'sign_in' | 'unavailable' | 'replaced' | 'seated';
/** What the account check can answer. */
export type AccountRefusal = 'banned' | 'age_missing' | 'age_under';

export const QUEUE_MESSAGES: Record<QueueRefusal, string> = {
  banned: 'This account has been banned',
  age_missing: 'Quick match needs your birth year',
  age_under: 'Quick match is for players aged 17 or older',
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
  send(msg: unknown): void;
}

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
  lastStatusAt: number;
}

/** The age a birth year makes someone at the least this year (no birthday is asked, so the latest one is assumed). */
export function minimumAge(birthYear: number, currentYear: number): number {
  return currentYear - birthYear - 1;
}

/**
 * The repositories' answer to `MatchmakerOptions.check`: banned first, then the birth year
 * (`age_missing` when the server has none, so the app may send the one it holds; `age_under` when
 * the year on file makes the account younger than 17, which nothing the app sends can change).
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
      avoid = new Set(await this.opts.avoid(peer.userId));
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
    const entry: Entry = { peer, joinedAt, seq, avoid, lastStatusAt: this.now() };
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

  /** Groups in arrival order: each player joins the earliest group with room and nobody it may not sit with. */
  private groups(): Entry[][] {
    const groups: Entry[][] = [];
    for (const e of this.ordered()) {
      const g = groups.find((g) => g.length < TABLE_SIZE && g.every((o) => !clash(e, o)));
      if (g) g.push(e);
      else groups.push([e]);
    }
    return groups;
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

function clash(a: Entry, b: Entry): boolean {
  return a.avoid.has(b.peer.userId) || b.avoid.has(a.peer.userId);
}

function refuse(peer: QueuePeer, code: QueueRefusal, extra: { room?: string } = {}): void {
  peer.send({ t: 'queue_error', code, message: QUEUE_MESSAGES[code], ...extra });
}
