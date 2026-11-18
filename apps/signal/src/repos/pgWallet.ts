/**
 * Postgres repositories for the diamond wallet with its ledger, purchases and entitlements, and the store event log.
 * Part of the Postgres repositories that createPgRepos (pg.ts) assembles; the rules in pg.ts apply here too.
 */
import type { Queryable } from '../db';
import {
  type EntitlementRecord,
  type LedgerEntry,
  type PurchaseRecord,
  type StoreEventRecord,
  type StoreEventsRepo,
  type WalletRecord,
  type WalletRepo,
} from './types';
import { type Tx, isUuid, toDate, toMs, toNum, json } from './pgShared';

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

export function pgStoreEvents(q: Queryable): StoreEventsRepo {
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
    async usersActiveSince(since) {
      const res = await q.query<{ user_id: string }>('SELECT DISTINCT user_id FROM store_events WHERE user_id IS NOT NULL AND received_at >= $1 ORDER BY user_id', [toDate(since)]);
      return res.rows.map((r) => r.user_id);
    },
    async listForUser(userId, limit) {
      if (!isUuid(userId)) return [];
      const res = await q.query<StoreEventRow>('SELECT ' + COLS + ' FROM store_events WHERE user_id = $1 ORDER BY received_at DESC, event_id DESC LIMIT $2', [userId, limit]);
      return res.rows.map(storeEventFromRow);
    },
  };
}

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
  period_ends_at: Date | null;
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
  periodEndsAt: r.period_ends_at ? r.period_ends_at.getTime() : null,
});
const entitlementFromRow = (r: EntitlementRow): EntitlementRecord => ({
  userId: r.user_id,
  entitlement: r.entitlement,
  expiresAt: toMs(r.expires_at),
  source: r.source,
  updatedAt: r.updated_at.getTime(),
});

export function pgWallet(q: Queryable, tx: Tx): WalletRepo {
  const LEDGER_COLS = 'id, user_id, delta, bonus, reason, ref, created_at';
  const PURCHASE_COLS = 'id, user_id, store, transaction_id, product_id, price, currency, event_id, raw, created_at, period_ends_at';
  return {
    async get(userId) {
      if (!isUuid(userId)) return { userId, diamonds: 0, bonusDiamonds: 0, updatedAt: 0 };
      const res = await q.query<WalletRow>('SELECT user_id, diamonds, bonus_diamonds, updated_at FROM wallets WHERE user_id = $1', [userId]);
      return res.rows[0] ? walletFromRow(res.rows[0]) : { userId, diamonds: 0, bonusDiamonds: 0, updatedAt: 0 };
    },
    async apply(e, opts) {
      return tx(async (c) => {
        const at = toDate(e.createdAt);
        const bonus = e.bonus ?? 0;
        await c.query('INSERT INTO wallets (user_id, diamonds, bonus_diamonds, updated_at) VALUES ($1, 0, 0, $2) ON CONFLICT (user_id) DO NOTHING', [e.userId, at]);
        const w = await c.query<WalletRow>(
          `UPDATE wallets SET diamonds = diamonds + $2, bonus_diamonds = bonus_diamonds + $3, updated_at = $4
           WHERE user_id = $1 AND ($2 >= 0 OR diamonds + $2 >= 0 OR $5::boolean) AND bonus_diamonds + $3 >= 0
           RETURNING user_id, diamonds, bonus_diamonds, updated_at`,
          [e.userId, e.delta, bonus, at, opts?.allowNegative === true],
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
        `INSERT INTO purchases (user_id, store, transaction_id, product_id, price, currency, event_id, raw, created_at, period_ends_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10) ON CONFLICT DO NOTHING RETURNING ` + PURCHASE_COLS,
        [p.userId, p.store, p.transactionId, p.productId, p.price, p.currency, p.eventId, json(p.raw), toDate(p.createdAt), toDate(p.periodEndsAt ?? null)],
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
    async findPurchase(transactionId) {
      const res = await q.query<PurchaseRow>('SELECT ' + PURCHASE_COLS + ' FROM purchases WHERE transaction_id = $1', [transactionId]);
      return res.rows[0] ? purchaseFromRow(res.rows[0]) : null;
    },
    async movePurchases(fromUserId, toUserId, transactionIds) {
      if (!isUuid(fromUserId) || !isUuid(toUserId) || transactionIds.length === 0) return 0;
      const res = await q.query('UPDATE purchases SET user_id = $2 WHERE user_id = $1 AND transaction_id = ANY($3::text[])', [fromUserId, toUserId, transactionIds]);
      return res.rowCount ?? 0;
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
