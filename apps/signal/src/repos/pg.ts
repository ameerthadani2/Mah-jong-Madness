/**
 * Postgres repositories over the schema in migrations/. Every statement is a constant string
 * with $n placeholders; values only ever travel as parameters (test/repos.test.ts fails if
 * this file gains string interpolation). jsonb values are sent as JSON text and cast, because
 * pg would otherwise turn a JavaScript array into a Postgres array literal.
 *
 * Ids that are uuid columns are checked before they reach SQL, so a malformed id from a client
 * reads as "not found" rather than a database error.
 */
import type { Club, ClubMember, ClubSettings, ClubTable, Identity, SeasonRecord } from '../clubs';
import type { Pool, Queryable } from '../db';
import {
  DELETED_PLAYER_NAME,
  type ClubMembership,
  type ClubsRepo,
  type DeviceRecord,
  type DevicesRepo,
  type EntitlementRecord,
  type IdentitiesRepo,
  type IdentityProvider,
  type IdentityRecord,
  type LedgerEntry,
  type MatchPlayer,
  type MatchResultRecord,
  type MatchResultsRepo,
  type PurchaseRecord,
  type PushTarget,
  type PuzzleResultRecord,
  type PuzzleResultsRepo,
  type ReportReason,
  type ReportRecord,
  type ReportsRepo,
  type Repos,
  type SessionRecord,
  type SessionsRepo,
  type StoreEventRecord,
  type StoreEventsRepo,
  type TableSnapshotRecord,
  type TableSnapshotsRepo,
  type TableStatus,
  type UserKind,
  type UserRecord,
  type UsersRepo,
  type WalletRecord,
  type WalletRepo,
} from './types';

type Tx = <T>(fn: (q: Queryable) => Promise<T>) => Promise<T>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

const toDate = (ms: number | null | undefined): Date | null => (ms === null || ms === undefined ? null : new Date(ms));
const toMs = (d: Date | null): number | null => (d === null ? null : d.getTime());
const toNum = (v: string | number | null): number | null => (v === null ? null : Number(v));
const json = (v: unknown): string => JSON.stringify(v ?? null);

// ---------------------------------------------------------------------------------------------

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

function pgUsers(q: Queryable): UsersRepo {
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
    async purgeDeleted(before) {
      // Everything that references the row cascades (0001_init); a club owner is never deleted (clubs.owner_id has no cascade).
      const res = await q.query('DELETE FROM users u WHERE u.deleted_at IS NOT NULL AND u.deleted_at < $1 AND NOT EXISTS (SELECT 1 FROM clubs c WHERE c.owner_id = u.id)', [toDate(before)]);
      return res.rowCount ?? 0;
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

function pgIdentities(q: Queryable): IdentitiesRepo {
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

function pgSessions(q: Queryable): SessionsRepo {
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
});

function pgDevices(q: Queryable): DevicesRepo {
  const COLS = 'id, user_id, platform, app_build, push_token, locale, created_at, last_seen_at';
  return {
    async create(d) {
      await q.query('INSERT INTO devices (' + COLS + ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', [
        d.id,
        d.userId,
        d.platform,
        d.appBuild,
        d.pushToken,
        d.locale,
        toDate(d.createdAt),
        toDate(d.lastSeenAt),
      ]);
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

// ---------------------------------------------------------------------------------------------

interface StoreEventRow {
  event_id: string;
  vendor: string;
  type: string;
  user_id: string | null;
  product_id: string | null;
  environment: string | null;
  outcome: string;
  raw: unknown;
  received_at: Date;
}

const storeEventFromRow = (r: StoreEventRow): StoreEventRecord => ({
  eventId: r.event_id,
  vendor: r.vendor,
  type: r.type,
  userId: r.user_id,
  productId: r.product_id,
  environment: r.environment,
  outcome: r.outcome,
  raw: r.raw,
  receivedAt: r.received_at.getTime(),
});

function pgStoreEvents(q: Queryable): StoreEventsRepo {
  const COLS = 'event_id, vendor, type, user_id, product_id, environment, outcome, raw, received_at';
  return {
    async record(e) {
      const res = await q.query(
        'INSERT INTO store_events (' + COLS + ') VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) ON CONFLICT (event_id) DO NOTHING',
        [e.eventId, e.vendor, e.type, isUuid(e.userId) ? e.userId : null, e.productId, e.environment, e.outcome, json(e.raw), toDate(e.receivedAt)],
      );
      return (res.rowCount ?? 0) > 0;
    },
    async get(eventId) {
      const res = await q.query<StoreEventRow>('SELECT ' + COLS + ' FROM store_events WHERE event_id = $1', [eventId]);
      return res.rows[0] ? storeEventFromRow(res.rows[0]) : null;
    },
    async setOutcome(eventId, outcome, userId) {
      await q.query('UPDATE store_events SET outcome = $2, user_id = $3 WHERE event_id = $1', [eventId, outcome, isUuid(userId) ? userId : null]);
    },
    async delete(eventId) {
      const res = await q.query('DELETE FROM store_events WHERE event_id = $1', [eventId]);
      return (res.rowCount ?? 0) > 0;
    },
  };
}

interface ReportRow {
  id: string | number;
  reporter_id: string;
  reported_user_id: string;
  room_code: string | null;
  reason: ReportReason;
  details: string | null;
  status: ReportRecord['status'];
  created_at: Date;
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
});

function pgReports(q: Queryable, tx: Tx): ReportsRepo {
  const COLS = 'id, reporter_id, reported_user_id, room_code, reason, details, status, created_at';
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
  };
}

// ---------------------------------------------------------------------------------------------

interface WalletRow {
  user_id: string;
  diamonds: number;
  bonus_diamonds: number;
  updated_at: Date;
}
interface LedgerRow {
  id: string;
  user_id: string;
  delta: number;
  bonus: number;
  reason: string;
  ref: string | null;
  created_at: Date;
}
interface PurchaseRow {
  id: string;
  user_id: string;
  store: string;
  transaction_id: string;
  product_id: string;
  price: string | null;
  currency: string | null;
  event_id: string | null;
  raw: unknown;
  created_at: Date;
}
interface EntitlementRow {
  user_id: string;
  entitlement: string;
  expires_at: Date | null;
  source: string;
  updated_at: Date;
}

const walletFromRow = (r: WalletRow): WalletRecord => ({ userId: r.user_id, diamonds: r.diamonds, bonusDiamonds: r.bonus_diamonds, updatedAt: r.updated_at.getTime() });
const ledgerFromRow = (r: LedgerRow): LedgerEntry => ({
  id: Number(r.id),
  userId: r.user_id,
  delta: r.delta,
  bonus: r.bonus,
  reason: r.reason,
  ref: r.ref,
  createdAt: r.created_at.getTime(),
});
const purchaseFromRow = (r: PurchaseRow): PurchaseRecord => ({
  id: Number(r.id),
  userId: r.user_id,
  store: r.store,
  transactionId: r.transaction_id,
  productId: r.product_id,
  price: toNum(r.price),
  currency: r.currency,
  eventId: r.event_id,
  raw: r.raw,
  createdAt: r.created_at.getTime(),
});
const entitlementFromRow = (r: EntitlementRow): EntitlementRecord => ({
  userId: r.user_id,
  entitlement: r.entitlement,
  expiresAt: toMs(r.expires_at),
  source: r.source,
  updatedAt: r.updated_at.getTime(),
});

function pgWallet(q: Queryable, tx: Tx): WalletRepo {
  const LEDGER_COLS = 'id, user_id, delta, bonus, reason, ref, created_at';
  const PURCHASE_COLS = 'id, user_id, store, transaction_id, product_id, price, currency, event_id, raw, created_at';
  return {
    async get(userId) {
      if (!isUuid(userId)) return { userId, diamonds: 0, bonusDiamonds: 0, updatedAt: 0 };
      const res = await q.query<WalletRow>('SELECT user_id, diamonds, bonus_diamonds, updated_at FROM wallets WHERE user_id = $1', [userId]);
      return res.rows[0] ? walletFromRow(res.rows[0]) : { userId, diamonds: 0, bonusDiamonds: 0, updatedAt: 0 };
    },
    async apply(e) {
      return tx(async (c) => {
        const at = toDate(e.createdAt);
        const bonus = e.bonus ?? 0;
        await c.query('INSERT INTO wallets (user_id, diamonds, bonus_diamonds, updated_at) VALUES ($1, 0, 0, $2) ON CONFLICT (user_id) DO NOTHING', [e.userId, at]);
        const w = await c.query<WalletRow>(
          `UPDATE wallets SET diamonds = diamonds + $2, bonus_diamonds = bonus_diamonds + $3, updated_at = $4
           WHERE user_id = $1 AND diamonds + $2 >= 0 AND bonus_diamonds + $3 >= 0
           RETURNING user_id, diamonds, bonus_diamonds, updated_at`,
          [e.userId, e.delta, bonus, at],
        );
        if (!w.rows[0]) return null;
        const l = await c.query<LedgerRow>('INSERT INTO wallet_ledger (user_id, delta, bonus, reason, ref, created_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ' + LEDGER_COLS, [
          e.userId,
          e.delta,
          bonus,
          e.reason,
          e.ref ?? null,
          at,
        ]);
        return { wallet: walletFromRow(w.rows[0]), entry: ledgerFromRow(l.rows[0]) };
      });
    },
    async listLedger(userId) {
      if (!isUuid(userId)) return [];
      const res = await q.query<LedgerRow>('SELECT ' + LEDGER_COLS + ' FROM wallet_ledger WHERE user_id = $1 ORDER BY created_at, id', [userId]);
      return res.rows.map(ledgerFromRow);
    },
    async recordPurchase(p) {
      const ins = await q.query<PurchaseRow>(
        `INSERT INTO purchases (user_id, store, transaction_id, product_id, price, currency, event_id, raw, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) ON CONFLICT DO NOTHING RETURNING ` + PURCHASE_COLS,
        [p.userId, p.store, p.transactionId, p.productId, p.price, p.currency, p.eventId, json(p.raw), toDate(p.createdAt)],
      );
      if (ins.rows[0]) return { purchase: purchaseFromRow(ins.rows[0]), inserted: true };
      const existing = await q.query<PurchaseRow>('SELECT ' + PURCHASE_COLS + ' FROM purchases WHERE transaction_id = $1 OR ($2::text IS NOT NULL AND event_id = $2) ORDER BY id LIMIT 1', [
        p.transactionId,
        p.eventId,
      ]);
      return { purchase: purchaseFromRow(existing.rows[0]), inserted: false };
    },
    async listPurchases(userId) {
      if (!isUuid(userId)) return [];
      const res = await q.query<PurchaseRow>('SELECT ' + PURCHASE_COLS + ' FROM purchases WHERE user_id = $1 ORDER BY created_at, id', [userId]);
      return res.rows.map(purchaseFromRow);
    },
    async getEntitlements(userId) {
      if (!isUuid(userId)) return [];
      const res = await q.query<EntitlementRow>('SELECT user_id, entitlement, expires_at, source, updated_at FROM entitlements WHERE user_id = $1 ORDER BY entitlement', [userId]);
      return res.rows.map(entitlementFromRow);
    },
    async setEntitlement(e) {
      await q.query(
        `INSERT INTO entitlements (user_id, entitlement, expires_at, source, updated_at) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, entitlement) DO UPDATE SET expires_at = excluded.expires_at, source = excluded.source, updated_at = excluded.updated_at`,
        [e.userId, e.entitlement, toDate(e.expiresAt), e.source, toDate(e.updatedAt)],
      );
    },
    async deleteEntitlement(userId, entitlement) {
      if (!isUuid(userId)) return false;
      const res = await q.query('DELETE FROM entitlements WHERE user_id = $1 AND entitlement = $2', [userId, entitlement]);
      return (res.rowCount ?? 0) > 0;
    },
    async mergeInto(fromUserId, toUserId, at) {
      if (!isUuid(fromUserId) || !isUuid(toUserId)) return;
      await tx(async (c) => {
        const when = toDate(at);
        await c.query(
          `INSERT INTO wallets (user_id, diamonds, bonus_diamonds, updated_at)
           SELECT $2, diamonds, bonus_diamonds, $3 FROM wallets WHERE user_id = $1
           ON CONFLICT (user_id) DO UPDATE SET diamonds = wallets.diamonds + excluded.diamonds,
             bonus_diamonds = wallets.bonus_diamonds + excluded.bonus_diamonds, updated_at = excluded.updated_at`,
          [fromUserId, toUserId, when],
        );
        await c.query('DELETE FROM wallets WHERE user_id = $1', [fromUserId]);
        await c.query('UPDATE wallet_ledger SET user_id = $2 WHERE user_id = $1', [fromUserId, toUserId]);
        await c.query('UPDATE purchases SET user_id = $2 WHERE user_id = $1', [fromUserId, toUserId]);
        // Inside ON CONFLICT every right-hand side reads the old row, so the order of these SET items does not matter.
        await c.query(
          `INSERT INTO entitlements (user_id, entitlement, expires_at, source, updated_at)
           SELECT $2, entitlement, expires_at, source, $3 FROM entitlements WHERE user_id = $1
           ON CONFLICT (user_id, entitlement) DO UPDATE SET
             source = CASE WHEN (excluded.expires_at IS NULL AND entitlements.expires_at IS NOT NULL) OR excluded.expires_at > entitlements.expires_at
                           THEN excluded.source ELSE entitlements.source END,
             expires_at = CASE WHEN entitlements.expires_at IS NULL OR excluded.expires_at IS NULL THEN NULL
                               ELSE GREATEST(entitlements.expires_at, excluded.expires_at) END,
             updated_at = excluded.updated_at`,
          [fromUserId, toUserId, when],
        );
        await c.query('DELETE FROM entitlements WHERE user_id = $1', [fromUserId]);
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------

interface ClubRow {
  code: string;
  owner_id: string;
  name: string;
  description: string;
  rules: Club['rules'];
  settings: ClubSettings;
  created_at: Date;
  season: number;
  season_started_at: Date | null;
  season_history: SeasonRecord[] | null;
}
interface MemberRow {
  club_code: string;
  user_id: string;
  role: ClubMember['role'];
  status: 'member' | 'pending';
  display_name: string;
  avatar: string | null;
  joined_at: Date;
  season_points: number;
  lifetime_points: number;
  matches_played: number;
  matches_won: number;
  hands_won: number;
}
interface TableRow {
  code: string;
  club_code: string;
  label: string;
  rules: ClubTable['rules'];
  created_by: string;
  status: ClubTable['status'];
  state: { players?: ClubTable['players']; handNumber?: number; scores?: number[] };
  created_at: Date;
}

function identityOf(r: MemberRow): Identity {
  return r.avatar === null ? { userId: r.user_id, name: r.display_name } : { userId: r.user_id, name: r.display_name, avatar: r.avatar };
}

function assembleClubs(clubs: ClubRow[], members: MemberRow[], tables: TableRow[]): Club[] {
  const byCode = new Map<string, Club>();
  for (const c of clubs) {
    byCode.set(c.code, {
      code: c.code,
      name: c.name,
      description: c.description,
      ownerId: c.owner_id,
      createdAt: c.created_at.getTime(),
      rules: c.rules,
      settings: c.settings,
      members: [],
      pending: [],
      tables: [],
      season: c.season,
      seasonStartedAt: (c.season_started_at ?? c.created_at).getTime(),
      seasons: Array.isArray(c.season_history) ? c.season_history : [],
    });
  }
  for (const m of members) {
    const club = byCode.get(m.club_code);
    if (!club) continue;
    if (m.status === 'pending') club.pending.push(identityOf(m));
    else
      club.members.push({
        ...identityOf(m),
        role: m.role,
        joinedAt: m.joined_at.getTime(),
        points: m.lifetime_points,
        seasonPoints: m.season_points,
        matchesPlayed: m.matches_played,
        matchesWon: m.matches_won,
        handsWon: m.hands_won,
      });
  }
  for (const t of tables) {
    const club = byCode.get(t.club_code);
    if (!club) continue;
    club.tables.push({
      code: t.code,
      label: t.label,
      rules: t.rules,
      createdBy: t.created_by,
      createdAt: t.created_at.getTime(),
      status: t.status,
      players: t.state.players ?? [],
      handNumber: t.state.handNumber ?? 0,
      scores: t.state.scores ?? [],
    });
  }
  return [...byCode.values()];
}

function pgClubs(q: Queryable, tx: Tx): ClubsRepo {
  const CLUB_COLS = 'code, owner_id, name, description, rules, settings, created_at, season, season_started_at, season_history';
  const MEMBER_COLS = 'club_code, user_id, role, status, display_name, avatar, joined_at, season_points, lifetime_points, matches_played, matches_won, hands_won';
  const TABLE_COLS = 'code, club_code, label, rules, created_by, status, state, created_at';
  const load = async (c: Queryable, codes: string[] | null): Promise<Club[]> => {
    const clubs = await c.query<ClubRow>('SELECT ' + CLUB_COLS + ' FROM clubs WHERE ($1::text[] IS NULL OR code = ANY($1::text[])) ORDER BY created_at, code', [codes]);
    if (!clubs.rows.length) return [];
    const found = clubs.rows.map((r) => r.code);
    const members = await c.query<MemberRow>('SELECT ' + MEMBER_COLS + ' FROM club_members WHERE club_code = ANY($1::text[]) ORDER BY joined_at, user_id', [found]);
    const tables = await c.query<TableRow>('SELECT ' + TABLE_COLS + ' FROM club_tables WHERE club_code = ANY($1::text[]) ORDER BY created_at, code', [found]);
    return assembleClubs(clubs.rows, members.rows, tables.rows);
  };
  return {
    async save(club) {
      const rows = [
        ...club.members.map((m) => ({
          user_id: m.userId,
          role: m.role,
          status: 'member',
          display_name: m.name,
          avatar: m.avatar ?? null,
          joined_at: m.joinedAt,
          points: m.points,
          season_points: m.seasonPoints ?? m.points,
          matches_played: m.matchesPlayed,
          matches_won: m.matchesWon,
          hands_won: m.handsWon,
        })),
        ...club.pending.map((p) => ({
          user_id: p.userId,
          role: 'member',
          status: 'pending',
          display_name: p.name,
          avatar: p.avatar ?? null,
          joined_at: null,
          points: 0,
          season_points: 0,
          matches_played: 0,
          matches_won: 0,
          hands_won: 0,
        })),
      ];
      const tables = club.tables.map((t) => ({
        code: t.code,
        label: t.label,
        rules: t.rules,
        created_by: t.createdBy,
        status: t.status,
        state: { players: t.players, handNumber: t.handNumber, scores: t.scores },
        created_at: t.createdAt,
      }));
      await tx(async (c) => {
        await c.query(
          `INSERT INTO clubs (code, owner_id, name, description, rules, settings, created_at, updated_at, season, season_started_at, season_history)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, now(), $8, $9, $10::jsonb)
           ON CONFLICT (code) DO UPDATE SET owner_id = excluded.owner_id, name = excluded.name, description = excluded.description,
             rules = excluded.rules, settings = excluded.settings, updated_at = now(), season = excluded.season,
             season_started_at = excluded.season_started_at, season_history = excluded.season_history`,
          [
            club.code,
            club.ownerId,
            club.name,
            club.description,
            json(club.rules),
            json(club.settings),
            toDate(club.createdAt),
            club.season ?? 1,
            toDate(club.seasonStartedAt ?? club.createdAt),
            json(club.seasons ?? []),
          ],
        );
        await c.query('DELETE FROM club_members WHERE club_code = $1 AND NOT (user_id = ANY($2::uuid[]))', [club.code, rows.map((r) => r.user_id)]);
        await c.query(
          `INSERT INTO club_members (club_code, user_id, role, status, display_name, avatar, joined_at, season_points, lifetime_points, matches_played, matches_won, hands_won)
           SELECT $1, r.user_id, r.role, r.status, r.display_name, r.avatar, COALESCE(to_timestamp(r.joined_at / 1000.0), now()),
                  r.season_points, r.points, r.matches_played, r.matches_won, r.hands_won
           FROM jsonb_to_recordset($2::jsonb) AS r(user_id uuid, role text, status text, display_name text, avatar text,
                joined_at double precision, season_points integer, points integer, matches_played integer, matches_won integer, hands_won integer)
           ON CONFLICT (club_code, user_id) DO UPDATE SET role = excluded.role, status = excluded.status,
             display_name = excluded.display_name, avatar = excluded.avatar,
             joined_at = CASE WHEN excluded.status = 'member' THEN excluded.joined_at ELSE club_members.joined_at END,
             season_points = excluded.season_points, lifetime_points = excluded.lifetime_points, matches_played = excluded.matches_played,
             matches_won = excluded.matches_won, hands_won = excluded.hands_won`,
          [club.code, json(rows)],
        );
        await c.query('DELETE FROM club_tables WHERE club_code = $1 AND NOT (code = ANY($2::text[]))', [club.code, tables.map((t) => t.code)]);
        await c.query(
          `INSERT INTO club_tables (code, club_code, label, rules, created_by, status, state, created_at, finished_at)
           SELECT r.code, $1, r.label, r.rules, r.created_by, r.status, r.state, to_timestamp(r.created_at / 1000.0),
                  CASE WHEN r.status = 'finished' THEN now() END
           FROM jsonb_to_recordset($2::jsonb) AS r(code text, label text, rules jsonb, created_by text, status text, state jsonb, created_at double precision)
           ON CONFLICT (code) DO UPDATE SET club_code = excluded.club_code, label = excluded.label, rules = excluded.rules,
             created_by = excluded.created_by, status = excluded.status, state = excluded.state,
             finished_at = CASE WHEN excluded.status = 'finished' THEN COALESCE(club_tables.finished_at, now()) END`,
          [club.code, json(tables)],
        );
      });
    },
    async delete(code) {
      const res = await q.query('DELETE FROM clubs WHERE code = $1', [code]);
      return (res.rowCount ?? 0) > 0;
    },
    async get(code) {
      return (await load(q, [code]))[0] ?? null;
    },
    loadAll: () => load(q, null),
    async isMember(clubCode, userId) {
      if (!isUuid(userId)) return false;
      const res = await q.query("SELECT 1 FROM club_members WHERE club_code = $1 AND user_id = $2 AND status = 'member'", [clubCode, userId]);
      return (res.rowCount ?? 0) > 0;
    },
    async clubsForUser(userId) {
      if (!isUuid(userId)) return [];
      const res = await q.query<{ club_code: string; role: ClubMembership['role']; status: ClubMembership['status'] }>(
        'SELECT club_code, role, status FROM club_members WHERE user_id = $1 ORDER BY joined_at, club_code',
        [userId],
      );
      return res.rows.map((r) => ({ clubCode: r.club_code, role: r.role, status: r.status }));
    },
    async moveMemberships(fromUserId, to) {
      if (!isUuid(fromUserId) || !isUuid(to.userId)) return [];
      return tx(async (c) => {
        const touched = await c.query<{ code: string }>(
          'SELECT club_code AS code FROM club_members WHERE user_id = $1 UNION SELECT code FROM clubs WHERE owner_id = $1 ORDER BY code',
          [fromUserId],
        );
        // A full membership beats a pending request; on a tie the surviving account's row stays.
        await c.query(
          `DELETE FROM club_members t USING club_members f
           WHERE t.user_id = $2 AND f.user_id = $1 AND t.club_code = f.club_code AND t.status = 'pending' AND f.status = 'member'`,
          [fromUserId, to.userId],
        );
        await c.query('DELETE FROM club_members f USING club_members t WHERE f.user_id = $1 AND t.user_id = $2 AND f.club_code = t.club_code', [fromUserId, to.userId]);
        await c.query('UPDATE club_members SET user_id = $2, display_name = $3, avatar = $4 WHERE user_id = $1', [fromUserId, to.userId, to.name, to.avatar ?? null]);
        await c.query("UPDATE club_members m SET role = 'owner' FROM clubs c WHERE c.owner_id = $1 AND m.club_code = c.code AND m.user_id = $2", [fromUserId, to.userId]);
        await c.query('UPDATE clubs SET owner_id = $2, updated_at = now() WHERE owner_id = $1', [fromUserId, to.userId]);
        await c.query('UPDATE club_tables SET created_by = $2 WHERE created_by = $1', [fromUserId, to.userId]);
        return touched.rows.map((r) => r.code);
      });
    },
    async anonymiseUser(userId) {
      if (!isUuid(userId)) return [];
      return tx(async (c) => {
        const touched = await c.query<{ code: string }>(
          'SELECT club_code AS code FROM club_members WHERE user_id = $1 UNION SELECT code FROM clubs WHERE owner_id = $1 ORDER BY code',
          [userId],
        );
        await c.query("DELETE FROM club_members WHERE user_id = $1 AND status = 'pending'", [userId]);
        await c.query('UPDATE club_members SET display_name = $2, avatar = NULL WHERE user_id = $1', [userId, DELETED_PLAYER_NAME]);
        // A club the user owned passes to its senior admin, else its earliest member (the same rule as anonymiseUserIn).
        const passed = await c.query<{ code: string; user_id: string }>(
          `UPDATE clubs c SET owner_id = s.user_id, updated_at = now()
           FROM (SELECT DISTINCT ON (m.club_code) m.club_code, m.user_id
                 FROM club_members m JOIN clubs o ON o.code = m.club_code
                 WHERE o.owner_id = $1 AND m.user_id <> $1 AND m.status = 'member'
                 ORDER BY m.club_code, (m.role = 'admin') DESC, m.joined_at, m.user_id) s
           WHERE c.code = s.club_code RETURNING c.code, s.user_id`,
          [userId],
        );
        if (passed.rows.length) {
          await c.query("UPDATE club_members m SET role = 'owner' FROM clubs c WHERE c.code = m.club_code AND c.owner_id = m.user_id AND m.club_code = ANY($1::text[])", [passed.rows.map((r) => r.code)]);
          await c.query("UPDATE club_members SET role = 'member' WHERE user_id = $1 AND role = 'owner'", [userId]);
        }
        // Nobody else was in it: the club is dissolved (members and tables cascade).
        await c.query('DELETE FROM clubs WHERE owner_id = $1', [userId]);
        return touched.rows.map((r) => r.code);
      });
    },
  };
}

interface SnapshotRow {
  room_code: string;
  club_code: string | null;
  status: TableStatus;
  snapshot: unknown;
  updated_at: Date;
}

const snapshotFromRow = (r: SnapshotRow): TableSnapshotRecord => ({
  roomCode: r.room_code,
  clubCode: r.club_code,
  status: r.status,
  snapshot: r.snapshot,
  updatedAt: r.updated_at.getTime(),
});

function pgTableSnapshots(q: Queryable): TableSnapshotsRepo {
  const COLS = 'room_code, club_code, status, snapshot, updated_at';
  return {
    async save(s) {
      await q.query(
        `INSERT INTO table_snapshots (room_code, club_code, status, snapshot, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (room_code) DO UPDATE SET club_code = excluded.club_code, status = excluded.status, snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
        [s.roomCode, s.clubCode, s.status, json(s.snapshot), toDate(s.updatedAt)],
      );
    },
    async get(roomCode) {
      const res = await q.query<SnapshotRow>('SELECT ' + COLS + ' FROM table_snapshots WHERE room_code = $1', [roomCode]);
      return res.rows[0] ? snapshotFromRow(res.rows[0]) : null;
    },
    async listActive() {
      const res = await q.query<SnapshotRow>("SELECT " + COLS + " FROM table_snapshots WHERE status <> 'finished' ORDER BY updated_at, room_code");
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

function pgMatchResults(q: Queryable): MatchResultsRepo {
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
  };
}

interface PuzzleRow {
  id: string;
  user_id: string;
  kind: string;
  puzzle_key: string;
  correct: boolean;
  seconds: number;
  rating_after: number | null;
  created_at: Date;
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
});

function pgPuzzleResults(q: Queryable): PuzzleResultsRepo {
  const COLS = 'id, user_id, kind, puzzle_key, correct, seconds, rating_after, created_at';
  return {
    async record(p) {
      const res = await q.query<PuzzleRow>(
        'INSERT INTO puzzle_results (user_id, kind, puzzle_key, correct, seconds, rating_after, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ' + COLS,
        [p.userId, p.kind, p.puzzleKey, p.correct, p.seconds, p.ratingAfter, toDate(p.createdAt)],
      );
      return puzzleFromRow(res.rows[0]);
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
      const res = await q.query('UPDATE puzzle_results SET user_id = $2 WHERE user_id = $1', [fromUserId, toUserId]);
      return res.rowCount ?? 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------

function build(q: Queryable, tx: Tx, transaction: Repos['transaction']): Repos {
  return {
    kind: 'pg',
    users: pgUsers(q),
    identities: pgIdentities(q),
    sessions: pgSessions(q),
    devices: pgDevices(q),
    wallet: pgWallet(q, tx),
    storeEvents: pgStoreEvents(q),
    reports: pgReports(q, tx),
    clubs: pgClubs(q, tx),
    tableSnapshots: pgTableSnapshots(q),
    matchResults: pgMatchResults(q),
    puzzleResults: pgPuzzleResults(q),
    transaction,
  };
}

/** Repositories bound to one checked-out client that is already inside BEGIN; nested work joins it. */
function bound(client: Queryable): Repos {
  const repos: Repos = build(client, (fn) => fn(client), (fn) => fn(repos));
  return repos;
}

async function inTransaction<T>(pool: Pool, fn: (client: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client as unknown as Queryable);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function createPgRepos(pool: Pool): Repos {
  const tx: Tx = (fn) => inTransaction(pool, fn);
  return build(pool as unknown as Queryable, tx, (fn) => inTransaction(pool, (client) => fn(bound(client))));
}
