/**
 * Postgres repositories for player reports, blocks and account moderation (bans).
 * Part of the Postgres repositories that createPgRepos (pg.ts) assembles; the rules in pg.ts apply here too.
 */
import type { Queryable } from '../db';
import {
  withoutName,
  type BlockRecord,
  type BlocksRepo,
  type ModerationRepo,
  type ReportReason,
  type ReportResolution,
  type ReportRecord,
  type ReportsRepo,
} from './types';
import { type Tx, isUuid, toDate, toMs } from './pgShared';

interface ReportRow {
  id: string | number;
  reporter_id: string;
  reported_user_id: string;
  room_code: string | null;
  reason: ReportReason;
  details: string | null;
  status: ReportRecord['status'];
  created_at: Date;
  resolution: ReportResolution | null;
  resolved_at: Date | null;
}

const reportFromRow = (r: ReportRow): ReportRecord => ({
  id: Number(r.id),
  reporterId: r.reporter_id,
  reportedUserId: r.reported_user_id,
  roomCode: r.room_code,
  reason: r.reason,
  details: r.details,
  status: r.status,
  createdAt: r.created_at.getTime(),
  ...(r.resolution ? { resolution: r.resolution } : {}),
  ...(r.resolved_at ? { resolvedAt: r.resolved_at.getTime() } : {}),
});

export function pgReports(q: Queryable, tx: Tx): ReportsRepo {
  const COLS = 'id, reporter_id, reported_user_id, room_code, reason, details, status, created_at, resolution, resolved_at';
  return {
    async create(r) {
      const res = await q.query<ReportRow>(
        'INSERT INTO reports (reporter_id, reported_user_id, room_code, reason, details, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ' + COLS,
        [r.reporterId, r.reportedUserId, r.roomCode, r.reason, r.details, toDate(r.createdAt)],
      );
      return reportFromRow(res.rows[0]);
    },
    async countByReporterSince(reporterId, since) {
      if (!isUuid(reporterId)) return 0;
      const res = await q.query<{ n: string }>('SELECT count(*) AS n FROM reports WHERE reporter_id = $1 AND created_at >= $2', [reporterId, toDate(since)]);
      return Number(res.rows[0]?.n ?? 0);
    },
    async listAbout(reportedUserId, limit = 100) {
      if (!isUuid(reportedUserId)) return [];
      const res = await q.query<ReportRow>('SELECT ' + COLS + ' FROM reports WHERE reported_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2', [
        reportedUserId,
        Math.max(1, Math.min(1000, Math.floor(limit))),
      ]);
      return res.rows.map(reportFromRow);
    },
    async moveToUser(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return 0;
      return tx(async (c) => {
        // A report between the two accounts would name one user twice (reporter <> reported): drop it.
        const dropped = await c.query('DELETE FROM reports WHERE (reporter_id = $1 AND reported_user_id = $2) OR (reporter_id = $2 AND reported_user_id = $1)', [fromUserId, toUserId]);
        const filed = await c.query('UPDATE reports SET reporter_id = $2 WHERE reporter_id = $1', [fromUserId, toUserId]);
        const about = await c.query('UPDATE reports SET reported_user_id = $2 WHERE reported_user_id = $1', [fromUserId, toUserId]);
        return (dropped.rowCount ?? 0) + (filed.rowCount ?? 0) + (about.rowCount ?? 0);
      });
    },
    async redactName(userId, name) {
      if (!isUuid(userId)) return 0;
      return tx(async (c) => {
        const rows = await c.query<{ id: string; details: string }>(
          'SELECT id, details FROM reports WHERE (reporter_id = $1 OR reported_user_id = $1) AND details IS NOT NULL ORDER BY id FOR UPDATE',
          [userId],
        );
        let n = 0;
        for (const r of rows.rows) {
          const details = withoutName(r.details, name);
          if (details === r.details) continue;
          await c.query('UPDATE reports SET details = $2 WHERE id = $1', [r.id, details]);
          n++;
        }
        return n;
      });
    },
    async get(id) {
      if (!Number.isSafeInteger(id) || id < 1) return null;
      const res = await q.query<ReportRow>('SELECT ' + COLS + ' FROM reports WHERE id = $1', [id]);
      return res.rows[0] ? reportFromRow(res.rows[0]) : null;
    },
    async listByStatus(status, limit = 100) {
      const res = await q.query<ReportRow>('SELECT ' + COLS + ' FROM reports WHERE status = $1 ORDER BY created_at, id LIMIT $2', [status, Math.max(1, Math.min(1000, Math.floor(limit)))]);
      return res.rows.map(reportFromRow);
    },
    async claim(id, resolution, at) {
      if (!Number.isSafeInteger(id) || id < 1) return null;
      // One conditional write: of two moderators deciding at once, the second finds the report closed.
      const res = await q.query<ReportRow>("UPDATE reports SET status = $2, resolution = $3, resolved_at = $4 WHERE id = $1 AND status = 'open' RETURNING " + COLS, [
        id,
        resolution === 'dismiss' ? 'dismissed' : 'actioned',
        resolution,
        toDate(at),
      ]);
      return res.rows[0] ? reportFromRow(res.rows[0]) : null;
    },
    async resolve(id, resolution, at) {
      return (await this.claim(id, resolution, at)) !== null;
    },
  };
}

// ---------------------------------------------------------------------------------------------

interface BlockRow {
  blocker_id: string;
  blocked_id: string;
  created_at: Date;
}

const blockFromRow = (r: BlockRow): BlockRecord => ({ blockerId: r.blocker_id, blockedId: r.blocked_id, createdAt: r.created_at.getTime() });

export function pgBlocks(q: Queryable, tx: Tx): BlocksRepo {
  return {
    async add(blockerId, blockedId, at) {
      if (!isUuid(blockerId) || !isUuid(blockedId) || blockerId === blockedId) return false;
      // Both accounts must exist: the insert takes its rows from users, so a missing one inserts nothing.
      const res = await q.query(
        'INSERT INTO user_blocks (blocker_id, blocked_id, created_at) SELECT a.id, b.id, $3::timestamptz FROM users a, users b WHERE a.id = $1 AND b.id = $2 ON CONFLICT DO NOTHING',
        [blockerId, blockedId, toDate(at)],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async remove(blockerId, blockedId) {
      if (!isUuid(blockerId) || !isUuid(blockedId)) return false;
      const res = await q.query('DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2', [blockerId, blockedId]);
      return (res.rowCount ?? 0) > 0;
    },
    async list(blockerId) {
      if (!isUuid(blockerId)) return [];
      const res = await q.query<BlockRow>('SELECT blocker_id, blocked_id, created_at FROM user_blocks WHERE blocker_id = $1 ORDER BY created_at DESC, blocked_id', [blockerId]);
      return res.rows.map(blockFromRow);
    },
    async blockersOf(blockedId) {
      if (!isUuid(blockedId)) return [];
      const res = await q.query<{ blocker_id: string }>('SELECT blocker_id FROM user_blocks WHERE blocked_id = $1', [blockedId]);
      return res.rows.map((r) => r.blocker_id);
    },
    async moveToUser(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return 0;
      return tx(async (c) => {
        // A block between the two accounts would name one user twice: drop it.
        await c.query('DELETE FROM user_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [fromUserId, toUserId]);
        const made = await c.query(
          'INSERT INTO user_blocks (blocker_id, blocked_id, created_at) SELECT $2::uuid, blocked_id, created_at FROM user_blocks WHERE blocker_id = $1 ON CONFLICT DO NOTHING',
          [fromUserId, toUserId],
        );
        const named = await c.query(
          'INSERT INTO user_blocks (blocker_id, blocked_id, created_at) SELECT blocker_id, $2::uuid, created_at FROM user_blocks WHERE blocked_id = $1 ON CONFLICT DO NOTHING',
          [fromUserId, toUserId],
        );
        const gone = await c.query('DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1', [fromUserId]);
        return Math.max(gone.rowCount ?? 0, (made.rowCount ?? 0) + (named.rowCount ?? 0));
      });
    },
    async deleteForUser(userId) {
      if (!isUuid(userId)) return 0;
      const res = await q.query('DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1', [userId]);
      return res.rowCount ?? 0;
    },
  };
}

interface ModerationRow {
  banned_at: Date | null;
  ban_reason: string | null;
  muted_until: Date | null;
}

export function pgModeration(q: Queryable): ModerationRepo {
  const changed = (res: { rowCount: number | null }) => (res.rowCount ?? 0) > 0;
  return {
    async status(userId) {
      if (!isUuid(userId)) return null;
      const res = await q.query<ModerationRow>('SELECT banned_at, ban_reason, muted_until FROM users WHERE id = $1', [userId]);
      const r = res.rows[0];
      return r ? { bannedAt: toMs(r.banned_at), banReason: r.ban_reason, mutedUntil: toMs(r.muted_until) } : null;
    },
    async ban(userId, at, reason) {
      if (!isUuid(userId)) return false;
      // The ban and the devices it covers in one statement: each device's own id, and its install's.
      const res = await q.query<{ id: string }>(
        `WITH banned AS (
           UPDATE users SET banned_at = COALESCE(banned_at, $2), ban_reason = $3 WHERE id = $1 RETURNING id
         ), covered AS (
           INSERT INTO banned_devices (device_id, user_id, banned_at)
           SELECT DISTINCT ids.device_id, banned.id, $2::timestamptz
           FROM banned
           JOIN devices d ON d.user_id = banned.id
           CROSS JOIN LATERAL (VALUES (d.id), (d.install_id)) AS ids (device_id)
           WHERE ids.device_id IS NOT NULL
           ON CONFLICT DO NOTHING
         )
         SELECT id FROM banned`,
        [userId, toDate(at), reason],
      );
      return res.rows.length > 0;
    },
    async unban(userId) {
      if (!isUuid(userId)) return false;
      const res = await q.query<{ id: string }>(
        `WITH freed AS (DELETE FROM banned_devices WHERE user_id = $1)
         UPDATE users SET banned_at = NULL, ban_reason = NULL WHERE id = $1 RETURNING id`,
        [userId],
      );
      return res.rows.length > 0;
    },
    async deviceBanned(deviceId) {
      if (!isUuid(deviceId)) return false;
      const res = await q.query('SELECT 1 FROM banned_devices WHERE device_id = $1 LIMIT 1', [deviceId]);
      return res.rows.length > 0;
    },
    async mute(userId, until) {
      if (!isUuid(userId)) return false;
      return changed(await q.query('UPDATE users SET muted_until = $2 WHERE id = $1', [userId, toDate(until)]));
    },
    async mutedAfter(at) {
      const res = await q.query<{ id: string; muted_until: Date }>('SELECT id, muted_until FROM users WHERE muted_until > $1', [toDate(at)]);
      return res.rows.map((r) => ({ userId: r.id, mutedUntil: r.muted_until.getTime() }));
    },
  };
}
