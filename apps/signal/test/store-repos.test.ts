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
import { deleteAccount, purgeDeletedUsers } from '../src/auth';
import { eventsFromSubscriber, Reconciler } from '../src/reconcile';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';
import { WalletService, type StoreEvent } from '../src/wallet';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const T0 = Date.UTC(2026, 10, 9, 8, 0, 0);
const DAY = 86_400_000;

/** A store event naming `userId` (a TRANSFER names nobody: give `transferredFrom` and `transferredTo`). */
const storeEvent = (userId: string | null, type: string, extra: Partial<StoreEvent> = {}): StoreEvent => ({
  vendor: 'revenuecat',
  eventId: randomUUID(),
  type,
  userIds: userId ? [userId] : [],
  storeProductId: null,
  transactionId: null,
  expiresAt: null,
  purchasedAt: T0,
  price: null,
  currency: null,
  store: 'app_store',
  environment: 'PRODUCTION',
  cancelReason: null,
  transferredFrom: [],
  transferredTo: [],
  raw: {},
  ...extra,
});

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

    it('finds a purchase by its store transaction id, whichever account holds it', async () => {
      const r = repos();
      const u = await user();
      const transactionId = `tx-find-${u}`;
      expect(await r.wallet.findPurchase(transactionId)).toBeNull();
      await r.wallet.recordPurchase({ userId: u, store: 'play_store', transactionId, productId: 'diamonds.60', price: null, currency: null, eventId: null, raw: {}, createdAt: T0 });
      expect(await r.wallet.findPurchase(transactionId)).toMatchObject({ userId: u, store: 'play_store', productId: 'diamonds.60' });
    });

    it('a pack refunded after Restore moved it to another account is taken back from the account that was credited', async () => {
      const r = repos();
      const wallet = new WalletService(r, { now: () => T0, log: () => {}, testerUserIds: [] });
      const [a, c] = [await user(), await user()];
      const pack = { storeProductId: 'diamonds.7500', transactionId: `tx-moved-${a}` };
      expect((await wallet.applyStoreEvent(storeEvent(a, 'NON_RENEWING_PURCHASE', pack))).outcome).toBe('credited');
      await wallet.spend(a, 'bundle.dragon');
      const spent = await r.wallet.get(a);
      // Restore on C: the store now reports the purchase, and its refund, under C. The diamonds stayed on A.
      await wallet.applyStoreEvent(storeEvent(null, 'TRANSFER', { transferredFrom: [a], transferredTo: [c] }));
      const refund = await wallet.applyStoreEvent(storeEvent(c, 'CANCELLATION', { ...pack, cancelReason: 'CUSTOMER_SUPPORT' }));
      expect(refund).toMatchObject({ outcome: 'refunded', userId: a });
      const after = await r.wallet.get(a);
      expect(spent.diamonds + spent.bonusDiamonds - (after.diamonds + after.bonusDiamonds)).toBe(7500);
      expect(after.diamonds).toBeLessThan(0);
      expect(await r.wallet.get(c)).toMatchObject({ diamonds: 0, bonusDiamonds: 0 });
      await expect(wallet.spend(a, 'theme.bamboo')).rejects.toMatchObject({ code: 'insufficient' });
      // The same refund under another event id (the nightly sync also reports it) takes nothing more.
      expect((await wallet.applyStoreEvent(storeEvent(c, 'CANCELLATION', { ...pack, cancelReason: 'CUSTOMER_SUPPORT' }))).outcome).toBe('duplicate');
      expect((await wallet.applyStoreEvent(storeEvent(a, 'CANCELLATION', { ...pack, cancelReason: 'CUSTOMER_SUPPORT' }))).outcome).toBe('duplicate');
      expect(await r.wallet.get(a)).toMatchObject({ diamonds: after.diamonds, bonusDiamonds: after.bonusDiamonds });
    });

    it('a refund follows a pack bought by a guest to the account the guest was merged into', async () => {
      const r = repos();
      const wallet = new WalletService(r, { now: () => T0, log: () => {}, testerUserIds: [] });
      const [guest, account, other] = [await user(), await user(), await user()];
      const pack = { storeProductId: 'diamonds.300', transactionId: `tx-merged-${guest}` };
      await wallet.applyStoreEvent(storeEvent(guest, 'NON_RENEWING_PURCHASE', pack));
      await r.wallet.mergeInto(guest, account, T0);
      await r.users.update(guest, { deletedAt: T0, mergedInto: account });
      expect(await wallet.applyStoreEvent(storeEvent(other, 'CANCELLATION', { ...pack, cancelReason: 'CUSTOMER_SUPPORT' }))).toMatchObject({ outcome: 'refunded', userId: account });
      expect(await r.wallet.get(account)).toMatchObject({ diamonds: 0, bonusDiamonds: 0 });
      expect(await r.wallet.get(other)).toMatchObject({ diamonds: 0, bonusDiamonds: 0 });
    });

    it('Restore on a new account grants the live plan although the store also lists a pack the old account bought', async () => {
      const r = repos();
      const lines: string[] = [];
      const wallet = new WalletService(r, { now: () => T0, log: () => {}, testerUserIds: [] });
      const [old, fresh] = [await user(), await user()];
      const pack = `tx-pack-${old}`;
      const plan = `tx-plan-${old}`;
      expect((await wallet.applyStoreEvent(storeEvent(old, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.300', transactionId: pack }))).outcome).toBe('credited');
      expect((await wallet.applyStoreEvent(storeEvent(old, 'INITIAL_PURCHASE', { storeProductId: 'fourwinds.month', transactionId: plan, expiresAt: T0 + 30 * DAY }))).outcome).toBe('entitled');
      await deleteAccount(r, old, { now: () => T0 });
      // The TRANSFER webhook was missed: after Restore the store lists the old account's purchases under the new one.
      const client = {
        subscriber: async () => ({
          subscriber: {
            non_subscriptions: { 'diamonds.300': [{ id: 'rc1', purchase_date: new Date(T0).toISOString(), store: 'app_store', is_sandbox: false, store_transaction_id: pack }] },
            subscriptions: { 'fourwinds.month': { expires_date: new Date(T0 + 40 * DAY).toISOString(), purchase_date: new Date(T0).toISOString(), store: 'app_store', is_sandbox: false, store_transaction_id: plan } },
          },
        }),
      };
      const reconciler = new Reconciler({ repos: r, wallet, client, now: () => T0, log: (l) => lines.push(l) });
      const first = await reconciler.syncUser(fresh);
      expect(first.outcomes.map((o) => o.outcome)).toEqual(['duplicate', 'entitled']);
      expect(first).toMatchObject({ applied: 1, failed: 0 });
      expect(await wallet.tierOf(fresh)).toBe('fourwinds');
      // The pack was credited once, to the account that bought it; it is never credited again.
      expect(await r.wallet.get(fresh)).toMatchObject({ diamonds: 0, bonusDiamonds: 0 });
      expect((await r.wallet.findPurchase(pack))?.userId).toBe(old);
      expect((await reconciler.syncUser(fresh)).outcomes.map((o) => o.outcome)).toEqual(['duplicate', 'duplicate']);
      // A webhook for the same pack that names the new account is a duplicate too, not an error.
      expect((await wallet.applyStoreEvent(storeEvent(fresh, 'NON_RENEWING_PURCHASE', { storeProductId: 'diamonds.300', transactionId: pack }))).outcome).toBe('duplicate');
      expect(lines.filter((l) => l.includes('failed'))).toEqual([]);
    });

    it('a plan the store moved to a new account is granted there although the old account was synced with it first', async () => {
      const r = repos();
      let now = T0;
      const wallet = new WalletService(r, { now: () => now, log: () => {}, testerUserIds: [] });
      const [old, fresh] = [await user(), await user()];
      const expires = T0 + 365 * DAY;
      const plan = { expires_date: new Date(expires).toISOString(), purchase_date: new Date(T0).toISOString(), store: 'app_store', is_sandbox: false, store_transaction_id: `tx-year-${old}` };
      // The store lists the subscription under whichever app user id holds it.
      let holder = old;
      const client = { subscriber: async (id: string) => ({ subscriber: { non_subscriptions: {}, subscriptions: id === holder ? { 'fourwinds.year': plan } : {} } }) };
      const reconciler = new Reconciler({ repos: r, wallet, client, now: () => now, log: () => {} });
      // Synced while it was live (granted there), and again by the nightly run after the player deleted it.
      expect((await reconciler.syncUser(old)).outcomes).toEqual([{ eventId: `sync:${old}:period:fourwinds.year:${expires}`, outcome: 'entitled' }]);
      now = T0 + DAY;
      await deleteAccount(r, old, { now: () => now });
      now = T0 + 2 * DAY;
      expect(await reconciler.syncUser(old)).toMatchObject({ checked: false, outcomes: [] });
      now = T0 + 32 * DAY;
      expect((await purgeDeletedUsers(r, { now: () => now })).userIds).toContain(old);
      // The player makes a new account and taps Restore: the store moves the subscription, no TRANSFER reaches us.
      holder = fresh;
      expect((await reconciler.syncUser(fresh)).outcomes).toEqual([{ eventId: `sync:${fresh}:period:fourwinds.year:${expires}`, outcome: 'entitled' }]);
      expect(await wallet.tierOf(fresh)).toBe('fourwinds');
    });

    it('a sync event on record that reached no account does not stop the same period being granted to another', async () => {
      const r = repos();
      const wallet = new WalletService(r, { now: () => T0, log: () => {}, testerUserIds: [] });
      const fresh = await user();
      const gone = randomUUID();
      const expires = T0 + 365 * DAY;
      const record = { subscriber: { subscriptions: { 'fourwinds.year': { expires_date: new Date(expires).toISOString(), purchase_date: new Date(T0).toISOString(), store: 'app_store', store_transaction_id: `tx-gone-${gone}` } } } };
      const [forGone] = eventsFromSubscriber(gone, record, T0);
      expect(await wallet.applyStoreEvent(forGone)).toMatchObject({ outcome: 'ignored_unknown_user', userId: null });
      expect(await r.storeEvents.get(forGone.eventId)).toMatchObject({ outcome: 'ignored_unknown_user' });
      const reconciler = new Reconciler({ repos: r, wallet, client: { subscriber: async () => record }, now: () => T0, log: () => {} });
      expect((await reconciler.syncUser(fresh)).outcomes.map((o) => o.outcome)).toEqual(['entitled']);
      expect(await wallet.tierOf(fresh)).toBe('fourwinds');
    });

    it('refunding a store month never takes time that support granted on the same plan, whichever came first', async () => {
      const r = repos();
      const wallet = new WalletService(r, { now: () => T0, log: () => {}, testerUserIds: [] });
      const month = (u: string, n: number) => ({ storeProductId: 'fourwinds.month', transactionId: `tx-month-${n}-${u}`, expiresAt: T0 + 30 * DAY });
      const plan = async (u: string) => (await wallet.summary(u)).entitlements.filter((e) => e.entitlement === 'fourwinds.month');

      // The store month first, then 180 days from support.
      const a = await user();
      await wallet.applyStoreEvent(storeEvent(a, 'INITIAL_PURCHASE', month(a, 1)));
      await wallet.grantSupport(a, 'fourwinds.month', T0 + 180 * DAY, 'Ticket 7');
      expect(await plan(a)).toEqual([{ entitlement: 'fourwinds.month', expiresAt: T0 + 180 * DAY, active: true }]);
      expect((await wallet.applyStoreEvent(storeEvent(a, 'CANCELLATION', { ...month(a, 1), cancelReason: 'CUSTOMER_SUPPORT' }))).outcome).toBe('refunded');
      expect(await wallet.tierOf(a)).toBe('fourwinds');
      expect(await plan(a)).toEqual([{ entitlement: 'fourwinds.month', expiresAt: T0 + 180 * DAY, active: true }]);
      expect((await r.wallet.getEntitlements(a)).map((e) => [e.entitlement, e.source, e.expiresAt]).sort()).toEqual([
        ['fourwinds.month', 'store', T0],
        ['support:fourwinds.month', 'support', T0 + 180 * DAY],
      ]);

      // Ten days from support first, then a store month that is refunded: the ten days stay.
      const b = await user();
      await wallet.grantSupport(b, 'fourwinds.month', T0 + 10 * DAY, 'Ticket 8');
      expect((await wallet.applyStoreEvent(storeEvent(b, 'INITIAL_PURCHASE', month(b, 2)))).outcome).toBe('entitled');
      expect(await plan(b)).toEqual([{ entitlement: 'fourwinds.month', expiresAt: T0 + 30 * DAY, active: true }]);
      await wallet.applyStoreEvent(storeEvent(b, 'CANCELLATION', { ...month(b, 2), cancelReason: 'CUSTOMER_SUPPORT' }));
      expect(await plan(b)).toEqual([{ entitlement: 'fourwinds.month', expiresAt: T0 + 10 * DAY, active: true }]);
      expect(await wallet.hasFourWinds(b)).toBe(true);

      // A row support wrote under the plan's own name (older grants) is not cut by a store refund either.
      const c = await user();
      await r.wallet.setEntitlement({ userId: c, entitlement: 'fourwinds.month', expiresAt: T0 + 90 * DAY, source: 'support', updatedAt: T0 });
      await wallet.applyStoreEvent(storeEvent(c, 'CANCELLATION', { ...month(c, 3), cancelReason: 'CUSTOMER_SUPPORT' }));
      expect(await plan(c)).toEqual([{ entitlement: 'fourwinds.month', expiresAt: T0 + 90 * DAY, active: true }]);
    });

    it('a TRANSFER moves only the plans bought on the store it came from; support grants and other stores stay', async () => {
      const r = repos();
      const wallet = new WalletService(r, { now: () => T0, log: () => {}, testerUserIds: [] });
      const [a, c] = [await user(), await user()];
      await wallet.applyStoreEvent(storeEvent(a, 'INITIAL_PURCHASE', { store: 'play_store', storeProductId: 'fourwinds:year', transactionId: `GPA.${a}`, expiresAt: T0 + 365 * DAY }));
      await wallet.applyStoreEvent(storeEvent(a, 'INITIAL_PURCHASE', { store: 'app_store', storeProductId: 'coach.gold.month', transactionId: `ios-${a}`, expiresAt: T0 + 30 * DAY }));
      await wallet.grantSupport(a, 'coach.gold.year', T0 + 60 * DAY, 'Ticket 9');
      const live = async (u: string) => (await wallet.summary(u)).entitlements.filter((e) => e.active).map((e) => e.entitlement).sort();
      // Restore on a shared iPad signed in as C: only the App Store receipt moves.
      expect((await wallet.applyStoreEvent(storeEvent(null, 'TRANSFER', { store: 'app_store', transferredFrom: [a], transferredTo: [c] }))).outcome).toBe('transferred');
      expect(await live(a)).toEqual(['coach.gold.year', 'fourwinds.year']);
      expect(await wallet.tierOf(a)).toBe('fourwinds');
      expect(await live(c)).toEqual(['coach.gold.month']);
      expect(await wallet.tierOf(c)).toBe('gold');
      // The same again moves nothing; a transfer from Google Play then moves the Play plan.
      expect((await wallet.applyStoreEvent(storeEvent(null, 'TRANSFER', { store: 'app_store', transferredFrom: [a], transferredTo: [c] }))).outcome).toBe('recorded');
      expect((await wallet.applyStoreEvent(storeEvent(null, 'TRANSFER', { store: 'play_store', transferredFrom: [a], transferredTo: [c] }))).outcome).toBe('transferred');
      expect(await live(a)).toEqual(['coach.gold.year']);
      expect(await wallet.tierOf(c)).toBe('fourwinds');
      // A plan with no purchase on record (granted by a sync), or an event that names no store, moves as before.
      const [d, f] = [await user(), await user()];
      await r.wallet.setEntitlement({ userId: d, entitlement: 'coach.gold.year', expiresAt: T0 + 300 * DAY, source: 'store', updatedAt: T0 });
      expect((await wallet.applyStoreEvent(storeEvent(null, 'TRANSFER', { store: 'app_store', transferredFrom: [d], transferredTo: [f] }))).outcome).toBe('transferred');
      expect(await wallet.tierOf(f)).toBe('gold');
      expect((await wallet.applyStoreEvent(storeEvent(null, 'TRANSFER', { store: 'unknown', transferredFrom: [c], transferredTo: [f] }))).outcome).toBe('transferred');
      expect(await wallet.tierOf(f)).toBe('fourwinds');
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
