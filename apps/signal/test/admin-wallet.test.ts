/**
 * GET /api/admin/users/:id/wallet through the real API handler: the support report of one account's wallet (balances,
 * entitlement rows with plan, store, source and expiry, the latest ledger entries and store events), on memory and,
 * with DATABASE_URL_TEST, on Postgres. scripts/store-check.ts polls it during the owner's sandbox store run.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomHex } from '@mjm/engine';
import { WALLET_REPORT_ROWS } from '../src/admin';
import { createPool, type Pool } from '../src/db';
import { migrate } from '../src/migrate';
import { createMemoryRepos, createPgRepos, type Repos } from '../src/repos';
import { WalletService, type StoreEvent } from '../src/wallet';
import { apiFixture } from './helpers';

const PG_URL = process.env.DATABASE_URL_TEST?.trim();
const ADMIN = 'admin-token-0123456789abcdef';
const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const storeEvent = (userId: string, type: string, storeProductId: string, transactionId: string, extra: Partial<StoreEvent> = {}): StoreEvent => ({
  vendor: 'revenuecat',
  eventId: randomUUID(),
  type,
  userIds: [userId],
  storeProductId,
  transactionId,
  expiresAt: null,
  purchasedAt: T0,
  price: 4.99,
  currency: 'USD',
  store: 'play_store',
  environment: 'SANDBOX',
  cancelReason: null,
  transferredFrom: [],
  transferredTo: [],
  raw: {},
  ...extra,
});

function contract(name: string, makeRepos: () => Repos) {
  describe(name, () => {
    const setup = async () => {
      let t = T0;
      const repos = makeRepos();
      const tester = (await repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: T0 })).id;
      const other = (await repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: T0 })).id;
      const wallet = new WalletService(repos, { now: () => t, log: () => {}, testerUserIds: new Set([tester]) });
      const f = apiFixture({ now: () => t, deps: { repos, wallet, adminToken: ADMIN } });
      const report = async (userId: string, authorization = `Bearer ${ADMIN}`) => f.call('GET', `/api/admin/users/${userId}/wallet`, undefined, { authorization });
      return { repos, wallet, tester, other, report, advance: (ms: number) => (t += ms) };
    };

    it('answers 401 without the admin token, 404 for an unknown account and an empty wallet for a new one', async () => {
      const { tester, report } = await setup();
      for (const authorization of ['', 'Bearer nope', ADMIN]) expect((await report(tester, authorization)).status).toBe(401);
      expect((await report(randomUUID())).status).toBe(404);
      expect((await report('not-an-id')).status).toBe(404);
      const res = await report(tester);
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({ userId: tester, deleted: false, wallet: { diamonds: 0, bonusDiamonds: 0 }, entitlements: [], ledger: [], storeEvents: [] });
    });

    it('shows a pack, a plan with its store and expiry, a refund, and a non-tester sandbox purchase granting nothing', async () => {
      const { wallet, tester, other, report, advance } = await setup();
      await wallet.applyStoreEvent(storeEvent(tester, 'NON_RENEWING_PURCHASE', 'diamonds.60', 'GPA.pack-1'));
      advance(1000);
      await wallet.applyStoreEvent(storeEvent(tester, 'INITIAL_PURCHASE', 'coach.gold:month', 'GPA.sub-1', { expiresAt: T0 + 30 * DAY }));
      advance(1000);
      await wallet.grantSupport(tester, 'theme.jade', null, 'Ticket 7');
      let res = (await report(tester)).json as Record<string, any>;
      expect(res.wallet).toMatchObject({ diamonds: 60, bonusDiamonds: 0 });
      expect(res.entitlements).toEqual([
        { entitlement: 'coach.gold.month', product: 'coach.gold.month', plan: 'gold', store: 'play_store', source: 'store', expiresAt: iso(T0 + 30 * DAY), live: true, updatedAt: iso(T0 + 1000) },
        { entitlement: 'theme.jade', product: 'theme.jade', plan: null, store: null, source: 'support', expiresAt: null, live: true, updatedAt: iso(T0 + 2000) },
      ]);
      expect(res.ledger.map((l: Record<string, unknown>) => [l.reason, l.delta, l.ref])).toEqual([
        ['support', 0, 'support:theme.jade:Ticket 7'],
        ['purchase', 60, 'play_store:GPA.pack-1'],
      ]);
      expect(res.storeEvents.map((e: Record<string, unknown>) => [e.type, e.outcome, e.environment])).toEqual([
        ['INITIAL_PURCHASE', 'entitled', 'SANDBOX'],
        ['NON_RENEWING_PURCHASE', 'credited', 'SANDBOX'],
      ]);

      // Refunds: the plan's only charge ends it now; the pack takes its diamonds back.
      advance(1000);
      await wallet.applyStoreEvent(storeEvent(tester, 'CANCELLATION', 'coach.gold:month', 'GPA.sub-1', { cancelReason: 'CUSTOMER_SUPPORT', expiresAt: T0 + 30 * DAY }));
      await wallet.applyStoreEvent(storeEvent(tester, 'CANCELLATION', 'diamonds.60', 'GPA.pack-1', { cancelReason: 'CUSTOMER_SUPPORT' }));
      res = (await report(tester)).json as Record<string, any>;
      expect(res.wallet.diamonds).toBe(0);
      expect(res.entitlements[0]).toMatchObject({ entitlement: 'coach.gold.month', live: false, expiresAt: iso(T0 + 3000) });
      expect(res.ledger.filter((l: Record<string, unknown>) => l.reason === 'refund').map((l: Record<string, unknown>) => [l.delta, l.ref])).toEqual(
        expect.arrayContaining([
          [0, 'refund:GPA.sub-1'],
          [-60, 'refund:GPA.pack-1'],
        ]),
      );

      // Someone not on the tester list: the sandbox purchase is on record and grants nothing.
      await wallet.applyStoreEvent(storeEvent(other, 'NON_RENEWING_PURCHASE', 'diamonds.60', 'GPA.pack-2'));
      const theirs = (await report(other)).json as Record<string, any>;
      expect(theirs.wallet).toMatchObject({ diamonds: 0, bonusDiamonds: 0 });
      expect(theirs.ledger).toEqual([]);
      expect(theirs.storeEvents.map((e: Record<string, unknown>) => [e.type, e.outcome])).toEqual([['NON_RENEWING_PURCHASE', 'ignored_sandbox']]);
    });

    it(`lists only the latest ${WALLET_REPORT_ROWS} ledger entries and store events, newest first`, async () => {
      const { wallet, tester, report, advance } = await setup();
      for (let i = 1; i <= WALLET_REPORT_ROWS + 5; i++) {
        advance(1000);
        await wallet.applyStoreEvent(storeEvent(tester, 'NON_RENEWING_PURCHASE', 'diamonds.60', `GPA.many-${i}`));
      }
      const res = (await report(tester)).json as Record<string, any>;
      expect(res.wallet.diamonds).toBe(60 * (WALLET_REPORT_ROWS + 5));
      expect(res.ledger).toHaveLength(WALLET_REPORT_ROWS);
      expect(res.ledger[0].ref).toBe(`play_store:GPA.many-${WALLET_REPORT_ROWS + 5}`);
      expect(res.ledger.at(-1).ref).toBe('play_store:GPA.many-6');
      expect(res.storeEvents).toHaveLength(WALLET_REPORT_ROWS);
      expect(res.storeEvents[0].at).toBe(iso(T0 + (WALLET_REPORT_ROWS + 5) * 1000));
    });
  });
}

contract('the admin wallet report (memory)', createMemoryRepos);

describe.skipIf(!PG_URL)('the admin wallet report (postgres)', () => {
  let admin: Pool | undefined;
  let pool: Pool | undefined;
  let pg: Repos;
  const schema = 'mjm_wallet_report_' + randomHex(6);

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
});

describe('without ADMIN_TOKEN', () => {
  it('answers 503', async () => {
    const f = apiFixture({ deps: { adminToken: null } });
    const g = await f.guest();
    expect((await f.call('GET', `/api/admin/users/${g.userId}/wallet`, undefined, { authorization: 'Bearer anything' })).status).toBe(503);
  });
});
