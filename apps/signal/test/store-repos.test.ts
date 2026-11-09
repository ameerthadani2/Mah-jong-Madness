/**
 * The repository methods the store relies on, against memory and (with DATABASE_URL_TEST)
 * Postgres: debits that may not go below zero unless a refund allows it, credits to a negative
 * balance, the analytics choice, the users with recent store activity, and the 0004 migration's
 * rename of the old shared plan entitlements.
 */
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { createPool, type Pool } from '../src/db';
import { listMigrations, migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';
import { WalletService } from '../src/wallet';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);

function contract(name: string, repos: () => Repos) {
  describe(name, () => {
    const user = async () => (await repos().users.create({ id: randomUUID(), kind: 'guest', createdAt: T0 })).id;

    it('a debit never takes purchased diamonds below zero unless allowed; credits always land, even on a debt', async () => {
      const r = repos();
      const u = await user();
      await r.wallet.apply({ userId: u, delta: 100, bonus: 20, reason: 'purchase', createdAt: T0 });
      expect(await r.wallet.apply({ userId: u, delta: -150, reason: 'spend', createdAt: T0 })).toBeNull();
      expect(await r.wallet.apply({ userId: u, delta: 0, bonus: -30, reason: 'spend', createdAt: T0 })).toBeNull();
      const refund = await r.wallet.apply({ userId: u, delta: -400, bonus: -20, reason: 'refund', ref: 'refund:x', createdAt: T0 }, { allowNegative: true });
      expect(refund?.wallet).toMatchObject({ diamonds: -300, bonusDiamonds: 0 });
      expect(await r.wallet.apply({ userId: u, delta: -1, reason: 'spend', createdAt: T0 })).toBeNull();
      expect((await r.wallet.apply({ userId: u, delta: 200, reason: 'purchase', createdAt: T0 }))?.wallet).toMatchObject({ diamonds: -100 });
      expect(await r.wallet.get(u)).toMatchObject({ diamonds: -100, bonusDiamonds: 0 });
      expect((await r.wallet.listLedger(u)).map((l) => [l.delta, l.bonus, l.reason])).toEqual([
        [100, 20, 'purchase'],
        [-400, -20, 'refund'],
        [200, 0, 'purchase'],
      ]);
    });

    it('stores the analytics choice per user; unknown users have none', async () => {
      const r = repos();
      const u = await user();
      expect(await r.users.getAnalyticsConsent(u)).toBeNull();
      expect(await r.users.setAnalyticsConsent(u, true)).toBe(true);
      expect(await r.users.getAnalyticsConsent(u)).toBe(true);
      expect(await r.users.setAnalyticsConsent(u, false)).toBe(true);
      expect(await r.users.getAnalyticsConsent(u)).toBe(false);
      expect(await r.users.setAnalyticsConsent(randomUUID(), true)).toBe(false);
      expect(await r.users.getAnalyticsConsent('not-a-uuid')).toBeNull();
    });

    it('lists the users with store events since a time', async () => {
      const r = repos();
      const [a, b] = [await user(), await user()];
      const ev = (eventId: string, userId: string | null, receivedAt: number) => r.storeEvents.record({ eventId, vendor: 'revenuecat', type: 'RENEWAL', userId, productId: 'coach.gold.month', environment: 'PRODUCTION', outcome: 'entitled', raw: {}, receivedAt });
      const tag = randomHex(4);
      await ev(`old-${tag}`, a, T0 - 10 * 86_400_000);
      await ev(`new-${tag}`, b, T0);
      await ev(`again-${tag}`, b, T0 + 1);
      await ev(`anon-${tag}`, null, T0);
      const active = await r.storeEvents.usersActiveSince(T0 - 7 * 86_400_000);
      expect(active).toContain(b);
      expect(active).not.toContain(a);
      expect(active.filter((x) => x === b)).toHaveLength(1);
    });

    it('a refunded pack that was spent leaves a debt that blocks spends (WalletService over these repos)', async () => {
      const r = repos();
      const u = await user();
      const wallet = new WalletService(r, { now: () => T0, log: () => {}, testerUserIds: [] });
      const event = (type: string, extra: Record<string, unknown> = {}) => ({
        vendor: 'revenuecat',
        eventId: randomUUID(),
        type,
        userIds: [u],
        storeProductId: 'diamonds.300',
        transactionId: `tx-${u}`,
        expiresAt: null,
        purchasedAt: T0,
        price: 4.99,
        currency: 'USD',
        store: 'app_store',
        environment: 'PRODUCTION',
        cancelReason: null,
        transferredFrom: [],
        transferredTo: [],
        raw: {},
        ...extra,
      });
      expect((await wallet.applyStoreEvent(event('NON_RENEWING_PURCHASE'))).outcome).toBe('credited');
      await wallet.spend(u, 'theme.bamboo');
      expect((await wallet.applyStoreEvent(event('CANCELLATION', { cancelReason: 'CUSTOMER_SUPPORT' }))).outcome).toBe('refunded');
      expect(await r.wallet.get(u)).toMatchObject({ diamonds: -300 });
      await wallet.credit(u, 0, 'grant', null, 400);
      await expect(wallet.spend(u, 'theme.imperial')).rejects.toMatchObject({ code: 'insufficient' });
    });
  });
}

let memory: Repos;
beforeAll(() => {
  memory = createMemoryRepos();
});
contract('store repositories (memory)', () => memory);

describe.skipIf(!PG_URL)('store repositories (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_store_' + randomHex(6);

  beforeAll(async () => {
    admin = createPool(PG_URL!, { max: 1 });
    await admin.query('CREATE SCHEMA ' + schema);
    pool = createPool(PG_URL!, { options: '-c search_path=' + schema });
    await migrate(pool, { log: () => {} });
    pg = createPgRepos(pool);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await admin?.end();
  });

  contract('contract', () => pg);

  it('0004 carries the old shared plan entitlements on as the monthly plans', async () => {
    const s2 = 'mjm_store_mig_' + randomHex(6);
    await admin!.query('CREATE SCHEMA ' + s2);
    const p2 = createPool(PG_URL!, { options: '-c search_path=' + s2 });
    try {
      // Apply everything before 0004 from a copy of those files, write old rows, then let migrate() run the rest.
      const before = mkdtempSync(join(tmpdir(), 'mjm-mig-'));
      const files = listMigrations();
      const upTo = files.findIndex((f) => f.version.startsWith('0004'));
      expect(upTo).toBeGreaterThan(0);
      for (const f of files.slice(0, upTo)) copyFileSync(f.path, join(before, `${f.version}.sql`));
      await migrate(p2, { dir: before, log: () => {} });
      const id = randomUUID();
      await p2.query("INSERT INTO users (id, kind) VALUES ($1, 'guest')", [id]);
      await p2.query("INSERT INTO entitlements (user_id, entitlement, expires_at, source) VALUES ($1, 'coach.gold', now() + interval '3 days', 'store'), ($1, 'coach.platinum', NULL, 'store'), ($1, 'theme.jade', NULL, 'diamonds')", [id]);
      await migrate(p2, { log: () => {} });
      const rows = await p2.query<{ entitlement: string }>('SELECT entitlement FROM entitlements WHERE user_id = $1 ORDER BY entitlement', [id]);
      expect(rows.rows.map((r) => r.entitlement)).toEqual(['coach.gold.month', 'fourwinds.month', 'theme.jade']);
      const cons = await p2.query("SELECT conname FROM pg_constraint WHERE conrelid = 'wallets'::regclass AND contype = 'c'");
      expect(cons.rows.map((r: { conname: string }) => r.conname)).toEqual(['wallets_bonus_diamonds_check']);
    } finally {
      await p2.end();
      await admin!.query('DROP SCHEMA IF EXISTS ' + s2 + ' CASCADE');
    }
  });
});
