/**
 * Postgres repositories for table snapshots, match results, the table rating and the quick-match pair counts.
 * Part of the Postgres repositories that createPgRepos (pg.ts) assembles; the rules in pg.ts apply here too.
 */
import type { Queryable } from '../db';
import {
  KEEP_APART_SHARED_PER_DAY,
  DELETED_PLAYER_NAME,
  type MatchPlayer,
  type MatchResultRecord,
  type MatchResultsRepo,
  type TableRatingRecord,
  type TableRatingsRepo,
  type QuickMatchPairRecord,
  type QuickMatchPairsRepo,
  type TableSnapshotRecord,
  type TableSnapshotsRepo,
  type TableStatus,
} from './types';
import { isUuid, toDate, json } from './pgShared';

interface SnapshotRow {
  room_code: string;
  club_code: string | null;
  status: TableStatus;
  snapshot: unknown;
  updated_at: Date;
  problem: string | null;
}

const snapshotFromRow = (r: SnapshotRow): TableSnapshotRecord => ({
  roomCode: r.room_code,
  clubCode: r.club_code,
  status: r.status,
  snapshot: r.snapshot,
  updatedAt: r.updated_at.getTime(),
  ...(r.problem !== null ? { problem: r.problem } : {}),
});

export function pgTableSnapshots(q: Queryable): TableSnapshotsRepo {
  const COLS = 'room_code, club_code, status, snapshot, updated_at, problem';
  return {
    async save(s) {
      await q.query(
        `INSERT INTO table_snapshots (room_code, club_code, status, snapshot, updated_at, problem) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         ON CONFLICT (room_code) DO UPDATE SET club_code = excluded.club_code, status = excluded.status, snapshot = excluded.snapshot, updated_at = excluded.updated_at, problem = excluded.problem`,
        [s.roomCode, s.clubCode, s.status, json(s.snapshot), toDate(s.updatedAt), s.problem?.slice(0, 500) ?? null],
      );
    },
    async get(roomCode) {
      const res = await q.query<SnapshotRow>('SELECT ' + COLS + ' FROM table_snapshots WHERE room_code = $1', [roomCode]);
      return res.rows[0] ? snapshotFromRow(res.rows[0]) : null;
    },
    async listActive() {
      const res = await q.query<SnapshotRow>("SELECT " + COLS + " FROM table_snapshots WHERE status IN ('open', 'playing') ORDER BY updated_at, room_code");
      return res.rows.map(snapshotFromRow);
    },
    async listDamaged(limit) {
      const res = await q.query<SnapshotRow>("SELECT " + COLS + " FROM table_snapshots WHERE status = 'damaged' ORDER BY updated_at DESC, room_code LIMIT $1", [limit]);
      return res.rows.map(snapshotFromRow);
    },
    async delete(roomCode) {
      const res = await q.query('DELETE FROM table_snapshots WHERE room_code = $1', [roomCode]);
      return (res.rowCount ?? 0) > 0;
    },
    async pruneFinished(before) {
      const res = await q.query("DELETE FROM table_snapshots WHERE status = 'finished' AND updated_at < $1", [toDate(before)]);
      return res.rowCount ?? 0;
    },
    async pruneDamaged(before) {
      const res = await q.query("DELETE FROM table_snapshots WHERE status = 'damaged' AND updated_at < $1", [toDate(before)]);
      return res.rowCount ?? 0;
    },
  };
}

interface MatchRow {
  id: string;
  room_code: string;
  club_code: string | null;
  hand_count: number;
  scores: number[];
  players: MatchPlayer[];
  hands_won: number[];
  finished_at: Date;
}

const matchFromRow = (r: MatchRow): MatchResultRecord => ({
  id: Number(r.id),
  roomCode: r.room_code,
  clubCode: r.club_code,
  handCount: r.hand_count,
  scores: r.scores,
  players: r.players,
  handsWon: r.hands_won,
  finishedAt: r.finished_at.getTime(),
});

export function pgMatchResults(q: Queryable): MatchResultsRepo {
  const COLS = 'id, room_code, club_code, hand_count, scores, players, hands_won, finished_at';
  return {
    async record(m) {
      const res = await q.query<MatchRow>(
        'INSERT INTO match_results (room_code, club_code, hand_count, scores, players, hands_won, finished_at) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7) RETURNING ' + COLS,
        [m.roomCode, m.clubCode, m.handCount, json(m.scores), json(m.players), json(m.handsWon), toDate(m.finishedAt)],
      );
      return matchFromRow(res.rows[0]);
    },
    async listForClub(clubCode, limit = 50) {
      const res = await q.query<MatchRow>('SELECT ' + COLS + ' FROM match_results WHERE club_code = $1 ORDER BY finished_at DESC, id DESC LIMIT $2', [
        clubCode,
        Math.max(1, Math.min(500, Math.floor(limit))),
      ]);
      return res.rows.map(matchFromRow);
    },
    async listForRoom(roomCode) {
      const res = await q.query<MatchRow>('SELECT ' + COLS + ' FROM match_results WHERE room_code = $1 ORDER BY id', [roomCode]);
      return res.rows.map(matchFromRow);
    },
    async anonymiseUser(userId, opts = {}) {
      // `players` is a JSON array of seats: rewrite the seats this account held, in seat order, in the rows that name it.
      const res = await q.query(
        `UPDATE match_results SET players = (
           SELECT jsonb_agg(CASE WHEN p->>'userId' = $1 THEN p || jsonb_build_object('name', $2::text) || CASE WHEN $3::boolean THEN '{"userId": null}'::jsonb ELSE '{}'::jsonb END ELSE p END ORDER BY ord)
           FROM jsonb_array_elements(players) WITH ORDINALITY AS seat(p, ord))
         WHERE players @> jsonb_build_array(jsonb_build_object('userId', $1::text))`,
        [userId, DELETED_PLAYER_NAME, opts.forget === true],
      );
      return res.rowCount ?? 0;
    },
    async moveToUser(fromUserId, toUserId) {
      const res = await q.query(
        `UPDATE match_results SET players = (
           SELECT jsonb_agg(CASE WHEN p->>'userId' = $1 THEN p || jsonb_build_object('userId', $2::text) ELSE p END ORDER BY ord)
           FROM jsonb_array_elements(players) WITH ORDINALITY AS seat(p, ord))
         WHERE players @> jsonb_build_array(jsonb_build_object('userId', $1::text))`,
        [fromUserId, toUserId],
      );
      return res.rowCount ?? 0;
    },
  };
}

interface TableRatingRow {
  user_id: string;
  rating: number;
  matches: number;
  last_match_id: string | null;
  last_room: string | null;
  last_change: number;
  updated_at: Date;
}

const tableRatingFromRow = (r: TableRatingRow): TableRatingRecord => ({
  userId: r.user_id,
  rating: r.rating,
  matches: r.matches,
  lastMatchId: r.last_match_id,
  lastRoom: r.last_room,
  lastChange: r.last_change,
  updatedAt: r.updated_at.getTime(),
});

export function pgTableRatings(q: Queryable): TableRatingsRepo {
  const COLS = 'user_id, rating, matches, last_match_id, last_room, last_change, updated_at';
  return {
    async get(userId) {
      if (!isUuid(userId)) return null;
      const res = await q.query<TableRatingRow>('SELECT ' + COLS + ' FROM table_ratings WHERE user_id = $1', [userId]);
      return res.rows[0] ? tableRatingFromRow(res.rows[0]) : null;
    },
    async getMany(userIds) {
      const ids = [...new Set(userIds.filter(isUuid))];
      if (ids.length === 0) return [];
      const res = await q.query<TableRatingRow>('SELECT ' + COLS + ' FROM table_ratings WHERE user_id = ANY($1::uuid[])', [ids]);
      return res.rows.map(tableRatingFromRow);
    },
    async getManyForUpdate(userIds) {
      const ids = [...new Set(userIds.filter(isUuid))].sort();
      if (ids.length === 0) return [];
      // The user rows too, in id order, so a first match (no rating rows yet) is serialised as well, without deadlocks.
      await q.query('SELECT id FROM users WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [ids]);
      const res = await q.query<TableRatingRow>('SELECT ' + COLS + ' FROM table_ratings WHERE user_id = ANY($1::uuid[]) ORDER BY user_id FOR UPDATE', [ids]);
      return res.rows.map(tableRatingFromRow);
    },
    async set(r) {
      await q.query(
        `INSERT INTO table_ratings (user_id, rating, matches, last_match_id, last_room, last_change, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id) DO UPDATE SET rating = excluded.rating, matches = excluded.matches, last_match_id = excluded.last_match_id, last_room = excluded.last_room, last_change = excluded.last_change, updated_at = excluded.updated_at`,
        [r.userId, r.rating, r.matches, r.lastMatchId, r.lastRoom, r.lastChange, toDate(r.updatedAt)],
      );
    },
    async mergeInto(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return;
      await q.query(
        `INSERT INTO table_ratings (user_id, rating, matches, last_match_id, last_room, last_change, updated_at)
         SELECT $2, f.rating, f.matches, f.last_match_id, f.last_room, f.last_change, f.updated_at FROM table_ratings f WHERE f.user_id = $1
         ON CONFLICT (user_id) DO UPDATE SET rating = excluded.rating, matches = excluded.matches, last_match_id = excluded.last_match_id, last_room = excluded.last_room, last_change = excluded.last_change, updated_at = excluded.updated_at
         WHERE excluded.matches > table_ratings.matches`,
        [fromUserId, toUserId],
      );
      await q.query('DELETE FROM table_ratings WHERE user_id = $1', [fromUserId]);
    },
  };
}

interface PairRow {
  a: string;
  b: string;
  tables: number;
  shared_address: number;
  last_at: Date;
}

export function pgQuickMatchPairs(q: Queryable): QuickMatchPairsRepo {
  return {
    async record(pairs, at, max) {
      const rows = pairs.filter((p) => p.a < p.b && isUuid(p.a) && isUuid(p.b));
      if (rows.length === 0) return;
      // A table they shared an IPv4 address at counts towards that UTC day; the third in one day keeps them apart for good.
      await q.query(
        `INSERT INTO quick_match_pairs (a, b, tables, shared_address, last_at, shared_day, shared_today, kept_apart)
         SELECT x.a, x.b, 1, x.shared, $4, CASE WHEN x.shared = 1 THEN ($4::timestamptz AT TIME ZONE 'UTC')::date END, x.shared, x.shared >= $5
         FROM unnest($1::uuid[], $2::uuid[], $3::int[]) AS x(a, b, shared)
         WHERE EXISTS (SELECT 1 FROM users WHERE id = x.a) AND EXISTS (SELECT 1 FROM users WHERE id = x.b)
         ON CONFLICT (a, b) DO UPDATE SET tables = quick_match_pairs.tables + 1, shared_address = quick_match_pairs.shared_address + excluded.shared_address, last_at = excluded.last_at,
           shared_day = CASE WHEN excluded.shared_address = 1 THEN excluded.shared_day ELSE quick_match_pairs.shared_day END,
           shared_today = CASE WHEN excluded.shared_address = 0 THEN quick_match_pairs.shared_today WHEN quick_match_pairs.shared_day = excluded.shared_day THEN quick_match_pairs.shared_today + 1 ELSE 1 END,
           kept_apart = quick_match_pairs.kept_apart OR (excluded.shared_address = 1 AND (CASE WHEN quick_match_pairs.shared_day = excluded.shared_day THEN quick_match_pairs.shared_today + 1 ELSE 1 END) >= $5)`,
        [rows.map((p) => p.a), rows.map((p) => p.b), rows.map((p) => (p.shared ? 1 : 0)), toDate(at), KEEP_APART_SHARED_PER_DAY],
      );
      await q.query('DELETE FROM quick_match_pairs WHERE (a, b) IN (SELECT a, b FROM quick_match_pairs WHERE NOT kept_apart ORDER BY last_at DESC, a, b OFFSET $1)', [max]);
    },
    async keptApart(userId) {
      if (!isUuid(userId)) return [];
      const res = await q.query<{ other: string }>('SELECT CASE WHEN a = $1 THEN b ELSE a END AS other FROM quick_match_pairs WHERE kept_apart AND (a = $1 OR b = $1) ORDER BY (CASE WHEN a = $1 THEN b ELSE a END)::text', [userId]);
      return res.rows.map((r) => r.other);
    },
    async frequent(min, limit) {
      const res = await q.query<PairRow>('SELECT a, b, tables, shared_address, last_at FROM quick_match_pairs WHERE tables >= $1 ORDER BY tables DESC, a::text, b::text LIMIT $2', [min, limit]);
      return res.rows.map((r): QuickMatchPairRecord => ({ a: r.a, b: r.b, tables: r.tables, sharedAddress: r.shared_address, lastAt: r.last_at.getTime() }));
    },
  };
}
