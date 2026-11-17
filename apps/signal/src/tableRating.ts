/**
 * The table rating: one number per account, moved only by finished quick-match matches between
 * humans (docs/API.md, "Table rating"). After each such match every pair of human seats is scored
 * by their final scores (the higher score wins the pair, equal scores draw) with an Elo-style
 * update: each account's change is `K * sum(result - expected) / (humans - 1)`, so a match moves a
 * rating about as much as one game whatever the number of humans. `K` is `TABLE_RATING_K` (small),
 * and `PROVISIONAL_K` for an account's first `PROVISIONAL_MATCHES` matches, so a new account finds
 * its level quickly. Bots never move a rating and are never rated against; a match with fewer than
 * two humans (distinct accounts) moves none. Two seats the queue linked (they joined from one
 * address, an IPv4 address or an IPv6 /64, or from one device: matchmaking.ts `linkedPairs`) never
 * move each other's rating, so a second account behind one home address cannot feed the first; each
 * still counts for everyone else at the table, and a seat whose only human opponents are linked to
 * it is not moved by the match at all. Quick match prefers tables of close ratings (matchmaking.ts).
 */
import type { Repos, TableRatingRecord } from './repos';

export const DEFAULT_TABLE_RATING = 1500;
export const TABLE_RATING_K = 16;
export const PROVISIONAL_K = 40;
export const PROVISIONAL_MATCHES = 20;
export const MIN_TABLE_RATING = 100;
export const MAX_TABLE_RATING = 4000;

export interface RatedSeat {
  userId: string;
  rating: number;
  /** Quick-match matches that already moved this rating. */
  matches: number;
  /** The seat's final score. */
  score: number;
}

/** The chance the Elo model gives `a` of finishing above `b`. */
export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / 400));
}

/** The K an account with `matches` rated matches behind it is moved by. */
export function kFor(matches: number): number {
  return matches < PROVISIONAL_MATCHES ? PROVISIONAL_K : TABLE_RATING_K;
}

/** The key of a pair of accounts, whichever order they come in. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/**
 * The change of each human seat after one match (same order as `seats`, rounded to whole points,
 * kept within 100 to 4000). Each seat is scored against the other seats except those `linked` to
 * it (pairs by `pairKey`: one address or one device), averaged over the seats it is scored against;
 * a seat with none to be scored against (fewer than two seats, or all linked) does not change.
 */
export function ratingChanges(seats: RatedSeat[], linked: ReadonlySet<string> = new Set()): number[] {
  return seats.map((me) => {
    let sum = 0;
    let counted = 0;
    for (const other of seats) {
      if (other === me || linked.has(pairKey(me.userId, other.userId))) continue;
      const result = me.score > other.score ? 1 : me.score < other.score ? 0 : 0.5;
      sum += result - expectedScore(me.rating, other.rating);
      counted++;
    }
    if (counted === 0) return 0;
    const raw = Math.round((kFor(me.matches) * sum) / counted);
    return Math.min(MAX_TABLE_RATING, Math.max(MIN_TABLE_RATING, me.rating + raw)) - me.rating;
  });
}

/** What the API answers for an account (`GET /api/me`, `GET /api/me/table-rating`). */
export interface TableRatingView {
  rating: number;
  matches: number;
  provisional: boolean;
  /** The last quick-match match that moved it, or null before the first. */
  last: { room: string; change: number; at: string } | null;
}

export function tableRatingView(row: TableRatingRecord | null): TableRatingView {
  if (!row) return { rating: DEFAULT_TABLE_RATING, matches: 0, provisional: true, last: null };
  return {
    rating: row.rating,
    matches: row.matches,
    provisional: row.matches < PROVISIONAL_MATCHES,
    last: row.lastRoom !== null ? { room: row.lastRoom, change: row.lastChange, at: new Date(row.updatedAt).toISOString() } : null,
  };
}

/** One seat of a finished match, as the table reports it. */
export interface FinishedSeat {
  userId?: string;
  isBot: boolean;
}

/**
 * Apply a finished quick-match match to the ratings of its humans, in one transaction. Seats that
 * are bots, have no account, or are not among `players` (the accounts the table was opened for)
 * are left out; an account in two seats counts once (its first). Pairs in `linked` (the queue's
 * pairs that shared an address or a device) do not move each other (`ratingChanges`); an account
 * scored against nobody is left as it was (its match count too). A match already applied (any of
 * its humans' last match is this one, as after a restart) changes nothing. Returns the changes by
 * account (empty when nothing moved).
 */
export async function applyQuickMatchRating(
  repos: Pick<Repos, 'transaction'>,
  match: { matchId: string; room: string; seats: FinishedSeat[]; scores: number[]; players?: Iterable<string>; linked?: Iterable<readonly [string, string]> },
  at: number,
): Promise<Map<string, number>> {
  const allowed = match.players ? new Set(match.players) : null;
  const humans: Array<{ userId: string; score: number }> = [];
  match.seats.forEach((s, i) => {
    if (s.isBot || !s.userId || (allowed && !allowed.has(s.userId)) || humans.some((h) => h.userId === s.userId)) return;
    humans.push({ userId: s.userId, score: match.scores[i] ?? 0 });
  });
  if (humans.length < 2 || !match.matchId) return new Map();
  const linked = new Set([...(match.linked ?? [])].map(([a, b]) => pairKey(a, b)));
  const scored = humans.filter((h) => humans.some((o) => o !== h && !linked.has(pairKey(h.userId, o.userId))));
  if (scored.length === 0) return new Map();
  return repos.transaction(async (tx) => {
    const rows = new Map((await tx.tableRatings.getManyForUpdate(humans.map((h) => h.userId))).map((r) => [r.userId, r]));
    if ([...rows.values()].some((r) => r.lastMatchId === match.matchId)) return new Map<string, number>();
    const seats: RatedSeat[] = humans.map((h) => ({ userId: h.userId, score: h.score, rating: rows.get(h.userId)?.rating ?? DEFAULT_TABLE_RATING, matches: rows.get(h.userId)?.matches ?? 0 }));
    const changes = ratingChanges(seats, linked);
    const out = new Map<string, number>();
    for (let i = 0; i < seats.length; i++) {
      const s = seats[i];
      if (!scored.includes(humans[i])) continue;
      await tx.tableRatings.set({ userId: s.userId, rating: s.rating + changes[i], matches: s.matches + 1, lastMatchId: match.matchId.slice(0, 128), lastRoom: match.room.slice(0, 32), lastChange: changes[i], updatedAt: at });
      out.set(s.userId, changes[i]);
    }
    return out;
  });
}
