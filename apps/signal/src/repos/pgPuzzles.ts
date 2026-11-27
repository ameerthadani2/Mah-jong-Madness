/**
 * Postgres repositories for puzzle results and ratings, Puzzle Rush runs, daily attempts, puzzle flags and the puzzle leaderboards.
 * Part of the Postgres repositories that createPgRepos (pg.ts) assembles; the rules in pg.ts apply here too.
 */
import type { Queryable } from '../db';
import type { PuzzleType } from '@mjm/engine';
import {
  type BoardEntry,
  type BoardPage,
  type BoardQuery,
  type LeaderboardsRepo,
  type PuzzleRatingRecord,
  type PuzzleRatingsRepo,
  type PuzzleResultRecord,
  type PuzzleResultsRepo,
  type RushRunRecord,
  type RushRunsRepo,
  type DailyAttemptRecord,
  type DailyAttemptsRepo,
  type HandReviewsRepo,
  type PuzzleFlagRecord,
  type PuzzleFlagsRepo,
  type PuzzleFlagStatus,
  type RecentPuzzleResult,
  type RushAnswerRecord,
} from './types';
import { type Tx, isUuid, toDate, toMs } from './pgShared';

interface PuzzleRow {
  id: string;
  user_id: string;
  kind: string;
  puzzle_key: string;
  correct: boolean;
  seconds: number;
  rating_after: number | null;
  created_at: Date;
  ranked: boolean;
  held: boolean;
}

const puzzleFromRow = (r: PuzzleRow): PuzzleResultRecord => ({
  id: Number(r.id),
  userId: r.user_id,
  kind: r.kind,
  puzzleKey: r.puzzle_key,
  correct: r.correct,
  seconds: r.seconds,
  ratingAfter: r.rating_after,
  createdAt: r.created_at.getTime(),
  ranked: r.ranked,
  held: r.held,
});

export function pgPuzzleResults(q: Queryable): PuzzleResultsRepo {
  const COLS = 'id, user_id, kind, puzzle_key, correct, seconds, rating_after, created_at, ranked, held';
  return {
    async record(p) {
      const res = await q.query<PuzzleRow>(
        'INSERT INTO puzzle_results (user_id, kind, puzzle_key, correct, seconds, rating_after, created_at, ranked, held) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING ' + COLS,
        [p.userId, p.kind, p.puzzleKey, p.correct, p.seconds, p.ratingAfter, toDate(p.createdAt), p.ranked ?? true, p.held ?? false],
      );
      return puzzleFromRow(res.rows[0]);
    },
    async recordDaily(p) {
      if (!isUuid(p.userId)) return null;
      const res = await q.query<PuzzleRow>(
        "INSERT INTO puzzle_results (user_id, kind, puzzle_key, correct, seconds, rating_after, created_at, ranked, held) VALUES ($1, 'daily', $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (user_id, puzzle_key) WHERE kind = 'daily' DO NOTHING RETURNING " +
          COLS,
        [p.userId, p.puzzleKey, p.correct, p.seconds, p.ratingAfter, toDate(p.createdAt), p.ranked ?? true, p.held ?? false],
      );
      return res.rows[0] ? puzzleFromRow(res.rows[0]) : null;
    },
    async listForUser(userId, limit = 500) {
      if (!isUuid(userId)) return [];
      const res = await q.query<PuzzleRow>('SELECT ' + COLS + ' FROM puzzle_results WHERE user_id = $1 ORDER BY created_at, id LIMIT $2', [
        userId,
        Math.max(1, Math.min(5000, Math.floor(limit))),
      ]);
      return res.rows.map(puzzleFromRow);
    },
    async moveToUser(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return 0;
      // One daily result per date key: the target's own stays, the guest's for that key stays behind.
      const res = await q.query(
        "UPDATE puzzle_results p SET user_id = $2 WHERE p.user_id = $1 AND NOT (p.kind = 'daily' AND EXISTS (SELECT 1 FROM puzzle_results t WHERE t.user_id = $2 AND t.kind = 'daily' AND t.puzzle_key = p.puzzle_key))",
        [fromUserId, toUserId],
      );
      return res.rowCount ?? 0;
    },
    async listHeldDaily(limit) {
      const res = await q.query<PuzzleRow>('SELECT ' + COLS + " FROM puzzle_results WHERE held AND kind = 'daily' ORDER BY created_at, id LIMIT $1", [Math.max(1, Math.min(1000, Math.floor(limit)))]);
      return res.rows.map(puzzleFromRow);
    },
    async reviewHeldDaily(id, confirmed) {
      if (!Number.isSafeInteger(id) || id < 1) return null;
      const res = await q.query<PuzzleRow>("UPDATE puzzle_results SET held = false, ranked = $2 WHERE id = $1 AND held AND kind = 'daily' RETURNING " + COLS, [id, confirmed]);
      return res.rows[0] ? puzzleFromRow(res.rows[0]) : null;
    },
  };
}

interface RatingRow {
  user_id: string;
  rating: number;
  rated: number;
  updated_at: Date;
}

const ratingFromRow = (r: RatingRow): PuzzleRatingRecord => ({ userId: r.user_id, rating: r.rating, rated: r.rated, updatedAt: r.updated_at.getTime() });

export function pgPuzzleRatings(q: Queryable): PuzzleRatingsRepo {
  const COLS = 'user_id, rating, rated, updated_at';
  return {
    async get(userId) {
      if (!isUuid(userId)) return null;
      const res = await q.query<RatingRow>('SELECT ' + COLS + ' FROM puzzle_ratings WHERE user_id = $1', [userId]);
      return res.rows[0] ? ratingFromRow(res.rows[0]) : null;
    },
    async getForUpdate(userId) {
      if (!isUuid(userId)) return null;
      // Lock the user row too, so the first submission (no rating row yet) is serialised as well.
      await q.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      const res = await q.query<RatingRow>('SELECT ' + COLS + ' FROM puzzle_ratings WHERE user_id = $1 FOR UPDATE', [userId]);
      return res.rows[0] ? ratingFromRow(res.rows[0]) : null;
    },
    async set(r) {
      await q.query(
        'INSERT INTO puzzle_ratings (user_id, rating, rated, updated_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET rating = excluded.rating, rated = excluded.rated, updated_at = excluded.updated_at',
        [r.userId, r.rating, r.rated, toDate(r.updatedAt)],
      );
    },
    async mergeInto(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return;
      await q.query(
        `INSERT INTO puzzle_ratings (user_id, rating, rated, updated_at)
         SELECT $2, f.rating, f.rated, f.updated_at FROM puzzle_ratings f WHERE f.user_id = $1
         ON CONFLICT (user_id) DO UPDATE SET rating = excluded.rating, rated = excluded.rated, updated_at = excluded.updated_at
         WHERE excluded.rated > puzzle_ratings.rated`,
        [fromUserId, toUserId],
      );
      await q.query('DELETE FROM puzzle_ratings WHERE user_id = $1', [fromUserId]);
    },
  };
}

interface RushRunRow {
  id: string;
  user_id: string;
  seed: string;
  started_at: Date;
  expires_at: Date;
  finished_at: Date | null;
  solved: number | null;
  wrong: number | null;
  seconds: number | null;
  score: number | null;
  ranked: boolean;
  served_index: number;
  served_at: Date;
  inhuman: boolean;
  held: boolean;
}

const rushRunFromRow = (r: RushRunRow): RushRunRecord => ({
  id: r.id,
  userId: r.user_id,
  seed: r.seed,
  startedAt: r.started_at.getTime(),
  expiresAt: r.expires_at.getTime(),
  finishedAt: toMs(r.finished_at),
  solved: r.solved,
  wrong: r.wrong,
  seconds: r.seconds,
  score: r.score,
  ranked: r.ranked,
  servedIndex: r.served_index,
  servedAt: r.served_at.getTime(),
  inhuman: r.inhuman,
  held: r.held,
});

export function pgRushRuns(q: Queryable): RushRunsRepo {
  const COLS = 'id, user_id, seed, started_at, expires_at, finished_at, solved, wrong, seconds, score, ranked, served_index, served_at, inhuman, held';
  return {
    async create(r) {
      const res = await q.query<RushRunRow>('INSERT INTO puzzle_rush_runs (id, user_id, seed, started_at, expires_at, served_at) VALUES ($1, $2, $3, $4, $5, $4) RETURNING ' + COLS, [
        r.id,
        r.userId,
        r.seed,
        toDate(r.startedAt),
        toDate(r.expiresAt),
      ]);
      return rushRunFromRow(res.rows[0]);
    },
    async get(id) {
      if (!isUuid(id)) return null;
      const res = await q.query<RushRunRow>('SELECT ' + COLS + ' FROM puzzle_rush_runs WHERE id = $1', [id]);
      return res.rows[0] ? rushRunFromRow(res.rows[0]) : null;
    },
    async getForUpdate(id) {
      if (!isUuid(id)) return null;
      const res = await q.query<RushRunRow>('SELECT ' + COLS + ' FROM puzzle_rush_runs WHERE id = $1 FOR UPDATE', [id]);
      return res.rows[0] ? rushRunFromRow(res.rows[0]) : null;
    },
    async answer(id, a) {
      if (!isUuid(id)) return false;
      // One statement: the answer is stored only while the run waits on that very puzzle, and the next is served at the answer's time.
      const res = await q.query(
        `WITH served AS (
           UPDATE puzzle_rush_runs SET served_index = served_index + 1, served_at = $6
            WHERE id = $1 AND finished_at IS NULL AND served_index = $2 RETURNING id)
         INSERT INTO puzzle_rush_answers (run_id, idx, type, correct, served_at, answered_at)
         SELECT id, $2, $3, $4, $5, $6 FROM served ON CONFLICT DO NOTHING`,
        [id, a.index, a.type, a.correct, toDate(a.servedAt), toDate(a.answeredAt)],
      );
      return (res.rowCount ?? 0) === 1;
    },
    async answers(id) {
      if (!isUuid(id)) return [];
      const res = await q.query<{ idx: number; type: PuzzleType; correct: boolean; served_at: Date; answered_at: Date }>(
        'SELECT idx, type, correct, served_at, answered_at FROM puzzle_rush_answers WHERE run_id = $1 ORDER BY idx',
        [id],
      );
      return res.rows.map((r): RushAnswerRecord => ({ index: r.idx, type: r.type, correct: r.correct, servedAt: r.served_at.getTime(), answeredAt: r.answered_at.getTime() }));
    },
    async finish(id, r) {
      if (!isUuid(id)) return null;
      const res = await q.query<RushRunRow>(
        'UPDATE puzzle_rush_runs SET finished_at = $2, solved = $3, wrong = $4, seconds = $5, score = $6, ranked = $7, inhuman = $8, held = $9 WHERE id = $1 AND finished_at IS NULL RETURNING ' + COLS,
        [id, toDate(r.finishedAt), r.solved, r.wrong, r.seconds, r.score, r.ranked ?? true, r.inhuman ?? false, r.held ?? false],
      );
      return res.rows[0] ? rushRunFromRow(res.rows[0]) : null;
    },
    async listHeld(limit) {
      const res = await q.query<RushRunRow>('SELECT ' + COLS + ' FROM puzzle_rush_runs WHERE held AND finished_at IS NOT NULL ORDER BY finished_at, id LIMIT $1', [Math.max(1, Math.min(1000, Math.floor(limit)))]);
      return res.rows.map(rushRunFromRow);
    },
    async reviewHeld(id, confirmed) {
      if (!isUuid(id)) return null;
      const res = await q.query<RushRunRow>('UPDATE puzzle_rush_runs SET held = false, ranked = $2 WHERE id = $1 AND held RETURNING ' + COLS, [id, confirmed]);
      return res.rows[0] ? rushRunFromRow(res.rows[0]) : null;
    },
    async countStartedSince(userId, since) {
      if (!isUuid(userId)) return 0;
      const res = await q.query<{ n: string }>('SELECT count(*) AS n FROM puzzle_rush_runs WHERE user_id = $1 AND started_at >= $2', [userId, toDate(since)]);
      return Number(res.rows[0].n);
    },
    async moveToUser(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return 0;
      const res = await q.query('UPDATE puzzle_rush_runs SET user_id = $2 WHERE user_id = $1', [fromUserId, toUserId]);
      return res.rowCount ?? 0;
    },
    async pruneUnfinished(before) {
      const res = await q.query('DELETE FROM puzzle_rush_runs WHERE finished_at IS NULL AND expires_at < $1', [toDate(before)]);
      return res.rowCount ?? 0;
    },
  };
}

interface DailyAttemptRow {
  id: string;
  user_id: string;
  date_key: string;
  started_at: Date;
  finished_at: Date | null;
}

const dailyAttemptFromRow = (r: DailyAttemptRow): DailyAttemptRecord => ({
  id: r.id,
  userId: r.user_id,
  dateKey: r.date_key,
  startedAt: r.started_at.getTime(),
  finishedAt: toMs(r.finished_at),
});

export function pgDailyAttempts(q: Queryable): DailyAttemptsRepo {
  const COLS = 'id, user_id, date_key, started_at, finished_at';
  return {
    async start(a) {
      // One attempt per account and key: a second start returns the first (the no-op update makes RETURNING answer).
      const res = await q.query<DailyAttemptRow>(
        'INSERT INTO puzzle_daily_attempts (id, user_id, date_key, started_at) VALUES ($1, $2, $3, $4) ON CONFLICT (user_id, date_key) DO UPDATE SET date_key = excluded.date_key RETURNING ' +
          COLS,
        [a.id, a.userId, a.dateKey, toDate(a.startedAt)],
      );
      return dailyAttemptFromRow(res.rows[0]);
    },
    async get(id) {
      if (!isUuid(id)) return null;
      const res = await q.query<DailyAttemptRow>('SELECT ' + COLS + ' FROM puzzle_daily_attempts WHERE id = $1', [id]);
      return res.rows[0] ? dailyAttemptFromRow(res.rows[0]) : null;
    },
    async finish(id, finishedAt) {
      if (!isUuid(id)) return null;
      const res = await q.query<DailyAttemptRow>('UPDATE puzzle_daily_attempts SET finished_at = $2 WHERE id = $1 AND finished_at IS NULL RETURNING ' + COLS, [id, toDate(finishedAt)]);
      return res.rows[0] ? dailyAttemptFromRow(res.rows[0]) : null;
    },
    async moveToUser(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return 0;
      const res = await q.query(
        'UPDATE puzzle_daily_attempts a SET user_id = $2 WHERE a.user_id = $1 AND NOT EXISTS (SELECT 1 FROM puzzle_daily_attempts t WHERE t.user_id = $2 AND t.date_key = a.date_key)',
        [fromUserId, toUserId],
      );
      return res.rowCount ?? 0;
    },
    async prune(before) {
      const res = await q.query('DELETE FROM puzzle_daily_attempts WHERE started_at < $1', [toDate(before)]);
      return res.rowCount ?? 0;
    },
  };
}

export function pgHandReviews(q: Queryable, tx: Tx): HandReviewsRepo {
  const countSince = async (c: Queryable, userId: string, since: number) =>
    Number((await c.query<{ n: string }>('SELECT count(*) AS n FROM hand_reviews WHERE user_id = $1 AND reviewed_at >= $2', [userId, toDate(since)])).rows[0].n);
  return {
    async open(userId, handKey, at, since, limit) {
      if (!isUuid(userId)) return { outcome: 'limited', used: 0 };
      return tx(async (c) => {
        // The account's row is locked first, so two opens at once cannot both take the last free review.
        await c.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
        const seen = await c.query('SELECT 1 FROM hand_reviews WHERE user_id = $1 AND hand_key = $2', [userId, handKey]);
        const used = await countSince(c, userId, since);
        if (seen.rows.length > 0) return { outcome: 'again' as const, used };
        if (limit !== null && used >= limit) return { outcome: 'limited' as const, used };
        await c.query('INSERT INTO hand_reviews (user_id, hand_key, reviewed_at) VALUES ($1, $2, $3) ON CONFLICT (user_id, hand_key) DO NOTHING', [userId, handKey, toDate(at)]);
        return { outcome: 'counted' as const, used: used + 1 };
      });
    },
    async countSince(userId, since) {
      if (!isUuid(userId)) return 0;
      return countSince(q, userId, since);
    },
    async moveToUser(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return 0;
      const res = await q.query(
        'UPDATE hand_reviews h SET user_id = $2 WHERE h.user_id = $1 AND NOT EXISTS (SELECT 1 FROM hand_reviews t WHERE t.user_id = $2 AND t.hand_key = h.hand_key)',
        [fromUserId, toUserId],
      );
      await q.query('DELETE FROM hand_reviews WHERE user_id = $1', [fromUserId]);
      return res.rowCount ?? 0;
    },
    async prune(before) {
      const res = await q.query('DELETE FROM hand_reviews WHERE reviewed_at < $1', [toDate(before)]);
      return res.rowCount ?? 0;
    },
  };
}

interface PuzzleFlagRow {
  user_id: string;
  status: PuzzleFlagStatus;
  reason: string;
  flagged_at: Date;
  reviewed_at: Date | null;
}

const flagFromRow = (r: PuzzleFlagRow): PuzzleFlagRecord => ({ userId: r.user_id, status: r.status, reason: r.reason, flaggedAt: r.flagged_at.getTime(), reviewedAt: toMs(r.reviewed_at) });

export function pgPuzzleFlags(q: Queryable): PuzzleFlagsRepo {
  const COLS = 'user_id, status, reason, flagged_at, reviewed_at';
  return {
    async get(userId) {
      if (!isUuid(userId)) return null;
      const res = await q.query<PuzzleFlagRow>('SELECT ' + COLS + ' FROM puzzle_flags WHERE user_id = $1', [userId]);
      return res.rows[0] ? flagFromRow(res.rows[0]) : null;
    },
    async flag(userId, reason, at) {
      // A confirmed flag stays confirmed (the update's WHERE leaves it, and the select returns it).
      await q.query(
        "INSERT INTO puzzle_flags (user_id, status, reason, flagged_at) VALUES ($1, 'flagged', $2, $3) ON CONFLICT (user_id) DO UPDATE SET status = 'flagged', reason = excluded.reason, flagged_at = excluded.flagged_at, reviewed_at = NULL WHERE puzzle_flags.status <> 'confirmed'",
        [userId, reason.slice(0, 500), toDate(at)],
      );
      return (await this.get(userId))!;
    },
    async review(userId, status, at) {
      if (!isUuid(userId)) return null;
      const res = await q.query<PuzzleFlagRow>('UPDATE puzzle_flags SET status = $2, reviewed_at = $3 WHERE user_id = $1 RETURNING ' + COLS, [userId, status, toDate(at)]);
      return res.rows[0] ? flagFromRow(res.rows[0]) : null;
    },
    async list(status, limit) {
      const res = await q.query<PuzzleFlagRow>('SELECT ' + COLS + ' FROM puzzle_flags WHERE status = $1 ORDER BY flagged_at, user_id LIMIT $2', [status, Math.max(1, Math.min(1000, Math.floor(limit)))]);
      return res.rows.map(flagFromRow);
    },
    async recentResults(userId, after, limit) {
      if (!isUuid(userId)) return [];
      const res = await q.query<{ kind: 'daily' | 'rush'; at: Date; seconds: number; solved: number; wrong: number; inhuman: boolean }>(
        `(SELECT 'daily' AS kind, created_at AS at, seconds, CASE WHEN correct THEN 1 ELSE 0 END AS solved, CASE WHEN correct THEN 0 ELSE 1 END AS wrong, false AS inhuman
            FROM puzzle_results WHERE user_id = $1 AND kind = 'daily' AND created_at > $2 ORDER BY created_at DESC LIMIT $3)
         UNION ALL
         (SELECT 'rush' AS kind, finished_at AS at, seconds, solved, wrong, inhuman
            FROM puzzle_rush_runs WHERE user_id = $1 AND finished_at IS NOT NULL AND finished_at > $2 ORDER BY finished_at DESC LIMIT $3)
         ORDER BY at DESC LIMIT $3`,
        [userId, toDate(after), Math.max(1, Math.min(100, Math.floor(limit)))],
      );
      return res.rows.map((r): RecentPuzzleResult => ({ kind: r.kind, at: r.at.getTime(), seconds: Number(r.seconds), answers: Number(r.solved) + Number(r.wrong), solved: Number(r.solved), wrong: Number(r.wrong), ...(r.kind === 'rush' ? { inhuman: r.inhuman } : {}) }));
    },
    async moveToUser(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return;
      await q.query(
        `INSERT INTO puzzle_flags (user_id, status, reason, flagged_at, reviewed_at)
         SELECT $2, f.status, f.reason, f.flagged_at, f.reviewed_at FROM puzzle_flags f WHERE f.user_id = $1 AND f.status <> 'cleared'
         ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, reason = excluded.reason, flagged_at = excluded.flagged_at, reviewed_at = excluded.reviewed_at
         WHERE puzzle_flags.status = 'cleared'`,
        [fromUserId, toUserId],
      );
      await q.query('DELETE FROM puzzle_flags WHERE user_id = $1', [fromUserId]);
    },
  };
}

interface BoardSqlRow {
  user_id: string;
  score: number;
  tiebreak: number;
  count: number;
  at: Date;
  display_name: string;
  avatar: string | null;
}

/** Each board's entries as (user_id, score, tiebreak, count, at), with $1 its one parameter. */
const DAILY_ENTRIES =
  "SELECT user_id, CASE WHEN correct THEN 1 ELSE 0 END AS score, seconds AS tiebreak, 0 AS count, created_at AS at FROM puzzle_results WHERE kind = 'daily' AND ranked AND puzzle_key = $1";
const RUSH_ENTRIES =
  'SELECT DISTINCT ON (user_id) user_id, score, 0 AS tiebreak, solved AS count, finished_at AS at FROM puzzle_rush_runs WHERE finished_at IS NOT NULL AND ranked AND finished_at >= $1 AND score > 0 ORDER BY user_id, score DESC, finished_at, id';
const RATING_ENTRIES = 'SELECT user_id, rating AS score, 0 AS tiebreak, rated AS count, updated_at AS at FROM puzzle_ratings WHERE rated >= $1';
/** An automation flag keeps the account off the boards (flagged or confirmed; a cleared flag does not). */
const FLAGGED = "EXISTS (SELECT 1 FROM puzzle_flags f WHERE f.user_id = e.user_id AND f.status <> 'cleared')";
/** Listed: live, not banned, visible, not flagged, and in scope ($2: the club's member ids, or null for everyone). */
const BOARD_LISTED = ' JOIN users u ON u.id = e.user_id WHERE u.deleted_at IS NULL AND u.banned_at IS NULL AND u.leaderboard_visible AND NOT ' + FLAGGED + ' AND ($2::uuid[] IS NULL OR e.user_id = ANY($2::uuid[]))';
const BOARD_COLS = 'SELECT e.user_id, e.score, e.tiebreak, e.count, e.at, u.display_name, u.avatar FROM e';

const boardEntry = (r: BoardSqlRow): BoardEntry => ({
  userId: r.user_id,
  displayName: r.display_name,
  avatar: r.avatar,
  score: Number(r.score),
  tiebreak: Number(r.tiebreak),
  count: Number(r.count),
  at: r.at.getTime(),
});

export function pgLeaderboards(q: Queryable): LeaderboardsRepo {
  const page = async (entries: string, param: unknown, query: BoardQuery): Promise<BoardPage> => {
    const scope = query.userIds ? query.userIds.filter(isUuid) : null;
    const top = await q.query<BoardSqlRow>('WITH e AS (' + entries + ') ' + BOARD_COLS + BOARD_LISTED + ' ORDER BY e.score DESC, e.tiebreak, e.at, e.user_id LIMIT $3', [
      param,
      scope,
      Math.max(1, Math.min(1000, Math.floor(query.limit))),
    ]);
    const rows = top.rows.map((r, i) => ({ ...boardEntry(r), rank: i + 1 }));
    if (!isUuid(query.viewerId)) return { rows, me: null };
    // The viewer: on the list, or (hidden, banned or further down) ranked behind the listed entries ahead of them.
    const listed = rows.find((r) => r.userId === query.viewerId);
    if (listed) return { rows, me: { ...listed, hidden: false, flagged: false } };
    const own = await q.query<BoardSqlRow & { visible: boolean; flagged: boolean }>(
      'WITH e AS (' +
        entries +
        ') SELECT e.user_id, e.score, e.tiebreak, e.count, e.at, u.display_name, u.avatar, (u.leaderboard_visible AND u.banned_at IS NULL AND NOT ' +
        FLAGGED +
        ') AS visible, ' +
        FLAGGED +
        ' AS flagged FROM e JOIN users u ON u.id = e.user_id WHERE u.deleted_at IS NULL AND e.user_id = $2 AND ($3::uuid[] IS NULL OR e.user_id = ANY($3::uuid[]))',
      [param, query.viewerId, scope],
    );
    if (!own.rows[0]) return { rows, me: null };
    const mine = boardEntry(own.rows[0]);
    const ahead = await q.query<{ n: string }>(
      'WITH e AS (' +
        entries +
        ') SELECT count(*) AS n FROM e' +
        BOARD_LISTED +
        ' AND e.user_id <> $3 AND (e.score > $4 OR (e.score = $4 AND (e.tiebreak < $5 OR (e.tiebreak = $5 AND (e.at < $6 OR (e.at = $6 AND e.user_id < $3))))))',
      [param, scope, query.viewerId, mine.score, mine.tiebreak, toDate(mine.at)],
    );
    return { rows, me: { ...mine, rank: Number(ahead.rows[0].n) + 1, hidden: !own.rows[0].visible, flagged: own.rows[0].flagged } };
  };
  return {
    daily: (dateKey, query) => page(DAILY_ENTRIES, dateKey, query),
    rush: (since, query) => page(RUSH_ENTRIES, toDate(since), query),
    rating: (minRated, query) => page(RATING_ENTRIES, minRated, query),
  };
}
