/**
 * Postgres repositories for users, their sign-in identities, sessions and devices (push targets).
 * Part of the Postgres repositories that createPgRepos (pg.ts) assembles; the rules in pg.ts apply here too.
 */
import type { Queryable } from '../db';
import {
  type DeviceRecord,
  type DevicesRepo,
  type IdentitiesRepo,
  type IdentityProvider,
  type IdentityRecord,
  type PushTarget,
  type SessionRecord,
  type SessionsRepo,
  type UserKind,
  type UserRecord,
  type UsersRepo,
} from './types';
import { isUuid, toDate, toMs } from './pgShared';

interface UserRow {
  id: string;
  kind: UserKind;
  display_name: string;
  avatar: string | null;
  email: string | null;
  birth_year: number | null;
  locale: string | null;
  created_at: Date;
  last_seen_at: Date;
  deleted_at: Date | null;
  merged_into: string | null;
}

const USER_COLUMNS = 'id, kind, display_name, avatar, email, birth_year, locale, created_at, last_seen_at, deleted_at, merged_into';

function userFromRow(r: UserRow): UserRecord {
  return {
    id: r.id,
    kind: r.kind,
    displayName: r.display_name,
    avatar: r.avatar,
    email: r.email,
    birthYear: r.birth_year,
    locale: r.locale,
    createdAt: r.created_at.getTime(),
    lastSeenAt: r.last_seen_at.getTime(),
    deletedAt: toMs(r.deleted_at),
    mergedInto: r.merged_into,
  };
}

export function pgUsers(q: Queryable): UsersRepo {
  const get = async (id: string): Promise<UserRecord | null> => {
    if (!isUuid(id)) return null;
    const res = await q.query<UserRow>('SELECT ' + USER_COLUMNS + ' FROM users WHERE id = $1', [id]);
    return res.rows[0] ? userFromRow(res.rows[0]) : null;
  };
  return {
    async create(u) {
      const res = await q.query<UserRow>(
        'INSERT INTO users (id, kind, display_name, avatar, email, birth_year, locale, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING ' +
          USER_COLUMNS,
        [u.id, u.kind, u.displayName ?? '', u.avatar ?? null, u.email ?? null, u.birthYear ?? null, u.locale ?? null, toDate(u.createdAt)],
      );
      return userFromRow(res.rows[0]);
    },
    get,
    async update(id, p) {
      if (!isUuid(id)) return null;
      // Each column is replaced only when the patch names it ($n IS TRUE flags), so null can be written on purpose.
      const res = await q.query<UserRow>(
        `UPDATE users SET
           kind = CASE WHEN $2 THEN $3 ELSE kind END,
           display_name = CASE WHEN $4 THEN $5 ELSE display_name END,
           avatar = CASE WHEN $6 THEN $7 ELSE avatar END,
           email = CASE WHEN $8 THEN $9 ELSE email END,
           birth_year = CASE WHEN $10 THEN $11::smallint ELSE birth_year END,
           locale = CASE WHEN $12 THEN $13 ELSE locale END,
           last_seen_at = CASE WHEN $14 THEN $15::timestamptz ELSE last_seen_at END,
           deleted_at = CASE WHEN $16 THEN $17::timestamptz ELSE deleted_at END,
           merged_into = CASE WHEN $18 THEN $19::uuid ELSE merged_into END
         WHERE id = $1 RETURNING ` + USER_COLUMNS,
        [
          id,
          'kind' in p,
          p.kind ?? null,
          'displayName' in p,
          p.displayName ?? '',
          'avatar' in p,
          p.avatar ?? null,
          'email' in p,
          p.email ?? null,
          'birthYear' in p,
          p.birthYear ?? null,
          'locale' in p,
          p.locale ?? null,
          'lastSeenAt' in p,
          toDate(p.lastSeenAt),
          'deletedAt' in p,
          toDate(p.deletedAt),
          'mergedInto' in p,
          p.mergedInto ?? null,
        ],
      );
      return res.rows[0] ? userFromRow(res.rows[0]) : null;
    },
    async getAnalyticsConsent(id) {
      if (!isUuid(id)) return null;
      const res = await q.query<{ analytics_consent: boolean | null }>('SELECT analytics_consent FROM users WHERE id = $1', [id]);
      return res.rows[0]?.analytics_consent ?? null;
    },
    async setAnalyticsConsent(id, consent) {
      if (!isUuid(id)) return false;
      const res = await q.query('UPDATE users SET analytics_consent = $2 WHERE id = $1', [id, consent]);
      return (res.rowCount ?? 0) > 0;
    },
    async getLeaderboardVisible(id) {
      if (!isUuid(id)) return true;
      const res = await q.query<{ leaderboard_visible: boolean }>('SELECT leaderboard_visible FROM users WHERE id = $1', [id]);
      return res.rows[0]?.leaderboard_visible ?? true;
    },
    async setLeaderboardVisible(id, visible) {
      if (!isUuid(id)) return false;
      const res = await q.query('UPDATE users SET leaderboard_visible = $2 WHERE id = $1', [id, visible]);
      return (res.rowCount ?? 0) > 0;
    },
    async purgeDeleted(before) {
      return (await this.purgeDeletedIds(before)).length;
    },
    async purgeDeletedIds(before) {
      // Everything that references the row cascades (0001_init); a club owner is never deleted (clubs.owner_id has no cascade).
      const res = await q.query<{ id: string }>(
        'DELETE FROM users u WHERE u.deleted_at IS NOT NULL AND u.deleted_at < $1 AND NOT EXISTS (SELECT 1 FROM clubs c WHERE c.owner_id = u.id) RETURNING u.id',
        [toDate(before)],
      );
      return res.rows.map((r) => r.id);
    },
  };
}

interface IdentityRow {
  provider: IdentityProvider;
  subject: string;
  user_id: string;
  secret_hash: string | null;
  email: string | null;
  created_at: Date;
}

const identityFromRow = (r: IdentityRow): IdentityRecord => ({
  provider: r.provider,
  subject: r.subject,
  userId: r.user_id,
  secretHash: r.secret_hash,
  email: r.email,
  createdAt: r.created_at.getTime(),
});

export function pgIdentities(q: Queryable): IdentitiesRepo {
  const COLS = 'provider, subject, user_id, secret_hash, email, created_at';
  return {
    async get(provider, subject) {
      const res = await q.query<IdentityRow>('SELECT ' + COLS + ' FROM auth_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
      return res.rows[0] ? identityFromRow(res.rows[0]) : null;
    },
    async listForUser(userId) {
      if (!isUuid(userId)) return [];
      const res = await q.query<IdentityRow>('SELECT ' + COLS + ' FROM auth_identities WHERE user_id = $1 ORDER BY created_at, provider', [userId]);
      return res.rows.map(identityFromRow);
    },
    async create(i) {
      const res = await q.query(
        'INSERT INTO auth_identities (provider, subject, user_id, secret_hash, email, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider, subject) DO NOTHING',
        [i.provider, i.subject, i.userId, i.secretHash, i.email, toDate(i.createdAt)],
      );
      return res.rowCount === 1;
    },
    async updateSecretHash(provider, subject, secretHash) {
      await q.query('UPDATE auth_identities SET secret_hash = $3 WHERE provider = $1 AND subject = $2', [provider, subject, secretHash]);
    },
    async delete(provider, subject) {
      const res = await q.query('DELETE FROM auth_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
      return (res.rowCount ?? 0) > 0;
    },
    async deleteForUser(userId) {
      if (!isUuid(userId)) return 0;
      const res = await q.query('DELETE FROM auth_identities WHERE user_id = $1', [userId]);
      return res.rowCount ?? 0;
    },
  };
}

interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  token_hash: string;
  created_at: Date;
  expires_at: Date;
  rotated_from: string | null;
  revoked_at: Date | null;
}

const sessionFromRow = (r: SessionRow): SessionRecord => ({
  id: r.id,
  userId: r.user_id,
  deviceId: r.device_id,
  tokenHash: r.token_hash,
  createdAt: r.created_at.getTime(),
  expiresAt: r.expires_at.getTime(),
  rotatedFrom: r.rotated_from,
  revokedAt: toMs(r.revoked_at),
});

export function pgSessions(q: Queryable): SessionsRepo {
  const COLS = 'id, user_id, device_id, token_hash, created_at, expires_at, rotated_from, revoked_at';
  return {
    async create(s) {
      await q.query('INSERT INTO sessions (' + COLS + ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        s.id,
        s.userId,
        s.deviceId,
        s.tokenHash,
        toDate(s.createdAt),
        toDate(s.expiresAt),
        s.rotatedFrom,
        toDate(s.revokedAt),
      ]);
    },
    async get(id) {
      if (!isUuid(id)) return null;
      const res = await q.query<SessionRow>('SELECT ' + COLS + ' FROM sessions WHERE id = $1', [id]);
      return res.rows[0] ? sessionFromRow(res.rows[0]) : null;
    },
    async findByHash(tokenHash) {
      const res = await q.query<SessionRow>('SELECT ' + COLS + ' FROM sessions WHERE token_hash = $1', [tokenHash]);
      return res.rows[0] ? sessionFromRow(res.rows[0]) : null;
    },
    async update(id, p) {
      if (!isUuid(id)) return;
      await q.query(
        `UPDATE sessions SET
           expires_at = CASE WHEN $2 THEN $3::timestamptz ELSE expires_at END,
           revoked_at = CASE WHEN $4 THEN $5::timestamptz ELSE revoked_at END,
           token_hash = CASE WHEN $6 THEN $7 ELSE token_hash END
         WHERE id = $1`,
        [id, 'expiresAt' in p, toDate(p.expiresAt), 'revokedAt' in p, toDate(p.revokedAt), 'tokenHash' in p, p.tokenHash ?? ''],
      );
    },
    async revokeIfActive(id, at) {
      if (!isUuid(id)) return false;
      const res = await q.query('UPDATE sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL', [id, toDate(at)]);
      return res.rowCount === 1;
    },
    async revokeAllForUser(userId, at, exceptId) {
      if (!isUuid(userId)) return 0;
      const res = await q.query(
        'UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND (revoked_at IS NULL OR revoked_at > $2) AND ($3::uuid IS NULL OR id <> $3::uuid)',
        [userId, toDate(at), isUuid(exceptId) ? exceptId : null],
      );
      return res.rowCount ?? 0;
    },
    async deleteForUser(userId) {
      if (!isUuid(userId)) return 0;
      const res = await q.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
      return res.rowCount ?? 0;
    },
    async pruneEnded(at) {
      const res = await q.query('DELETE FROM sessions WHERE expires_at <= $1 OR (revoked_at IS NOT NULL AND revoked_at <= $1)', [toDate(at)]);
      return res.rowCount ?? 0;
    },
  };
}

interface DeviceRow {
  id: string;
  user_id: string;
  platform: string;
  app_build: string | null;
  push_token: string | null;
  locale: string | null;
  created_at: Date;
  last_seen_at: Date;
  install_id: string | null;
}

const deviceFromRow = (r: DeviceRow): DeviceRecord => ({
  id: r.id,
  userId: r.user_id,
  platform: r.platform,
  appBuild: r.app_build,
  pushToken: r.push_token,
  locale: r.locale,
  createdAt: r.created_at.getTime(),
  lastSeenAt: r.last_seen_at.getTime(),
  ...(r.install_id ? { installId: r.install_id } : {}),
});

export function pgDevices(q: Queryable): DevicesRepo {
  const COLS = 'id, user_id, platform, app_build, push_token, locale, created_at, last_seen_at, install_id';
  return {
    async create(d) {
      // A taken id writes nothing (and, inside a transaction, does not abort it): the caller picks another.
      const res = await q.query('INSERT INTO devices (' + COLS + ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (id) DO NOTHING', [
        d.id,
        d.userId,
        d.platform,
        d.appBuild,
        d.pushToken,
        d.locale,
        toDate(d.createdAt),
        toDate(d.lastSeenAt),
        d.installId ?? null,
      ]);
      return (res.rowCount ?? 0) > 0;
    },
    async get(id) {
      if (!isUuid(id)) return null;
      const res = await q.query<DeviceRow>('SELECT ' + COLS + ' FROM devices WHERE id = $1', [id]);
      return res.rows[0] ? deviceFromRow(res.rows[0]) : null;
    },
    async update(id, p) {
      if (!isUuid(id)) return;
      await q.query(
        `UPDATE devices SET
           platform = CASE WHEN $2 THEN $3 ELSE platform END,
           app_build = CASE WHEN $4 THEN $5 ELSE app_build END,
           push_token = CASE WHEN $6 THEN $7 ELSE push_token END,
           locale = CASE WHEN $8 THEN $9 ELSE locale END,
           last_seen_at = CASE WHEN $10 THEN $11::timestamptz ELSE last_seen_at END
         WHERE id = $1`,
        [
          id,
          'platform' in p,
          p.platform ?? '',
          'appBuild' in p,
          p.appBuild ?? null,
          'pushToken' in p,
          p.pushToken ?? null,
          'locale' in p,
          p.locale ?? null,
          'lastSeenAt' in p,
          toDate(p.lastSeenAt),
        ],
      );
    },
    async listForUser(userId) {
      if (!isUuid(userId)) return [];
      const res = await q.query<DeviceRow>('SELECT ' + COLS + ' FROM devices WHERE user_id = $1 ORDER BY created_at, id', [userId]);
      return res.rows.map(deviceFromRow);
    },
    async moveToUser(fromUserId, toUserId) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return 0;
      const res = await q.query('UPDATE devices SET user_id = $2 WHERE user_id = $1', [fromUserId, toUserId]);
      return res.rowCount ?? 0;
    },
    async deleteForUser(userId) {
      if (!isUuid(userId)) return 0;
      const res = await q.query('DELETE FROM devices WHERE user_id = $1', [userId]);
      return res.rowCount ?? 0;
    },
    async clearPushToken(token, exceptDeviceId) {
      const except = isUuid(exceptDeviceId) ? exceptDeviceId : null;
      const res = await q.query('UPDATE devices SET push_token = NULL WHERE push_token = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)', [token, except]);
      return res.rowCount ?? 0;
    },
    async pushTargets(userIds) {
      const ids = userIds.filter(isUuid);
      if (!ids.length) return [];
      const res = await q.query<{ user_id: string; id: string; push_token: string; platform: string; locale: string | null }>(
        'SELECT user_id, id, push_token, platform, locale FROM devices WHERE user_id = ANY($1::uuid[]) AND push_token IS NOT NULL ORDER BY created_at, id',
        [ids],
      );
      return res.rows.map((r): PushTarget => ({ userId: r.user_id, deviceId: r.id, token: r.push_token, platform: r.platform, locale: r.locale }));
    },
  };
}
