/**
 * Store reconciliation (reconcile.ts) with a fake RevenueCat REST API, and the store and support
 * routes (admin.ts) called through their route handlers. No network: `fetch` is injected.
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adminAuthorised, storeRoutes, type StoreRouteCtx } from '../src/admin';
import { purgeDeletedUsers } from '../src/auth';
import { createMemoryRepos, type Repos } from '../src/repos';
import { createRevenueCatClient, eventsFromSubscriber, Reconciler, revenueCatClientFromEnv, startReconcileJob, type FetchLike } from '../src/reconcile';
import { WalletError, WalletService, type StoreEvent } from '../src/wallet';

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

/** A fake RevenueCat REST API: subscriber records by app user id; records every request. */
function fakeRevenueCat(records: Record<string, unknown> = {}) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  let failWith: number | null = null;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (failWith) return { status: failWith, json: async () => ({}) };
    const id = decodeURIComponent(url.split('/subscribers/')[1] ?? '');
    const rec = records[id];
    return rec ? { status: 200, json: async () => rec } : { status: 404, json: async () => ({ code: 7259 }) };
  };
  return { fetch, calls, records, fail: (status: number | null) => (failWith = status) };
}

const subscriber = (s: { subscriptions?: Record<string, unknown>; non_subscriptions?: Record<string, unknown[]> }) => ({ request_date_ms: T0, subscriber: { original_app_user_id: 'x', subscriptions: {}, non_subscriptions: {}, ...s } });

async function setup(opts: { testers?: string[] } = {}) {
  let t = T0;
  const now = () => t;
  const repos = createMemoryRepos();
  const wallet = new WalletService(repos, { now, log: () => {}, testerUserIds: new Set(opts.testers ?? []) });
  const rc = fakeRevenueCat();
  const client = createRevenueCatClient({ secretKey: 'sk_test_secret', fetch: rc.fetch });
  const reconciler = new Reconciler({ repos, wallet, client, now, log: () => {} });
  const user = async () => (await repos.users.create({ id: randomUUID(), kind: 'guest', createdAt: T0 })).id;
  return { repos, wallet, rc, reconciler, user, now, advance: (ms: number) => (t += ms) };
}

const webhookPurchase = (userId: string, productId: string, transactionId: string, extra: Partial<StoreEvent> = {}): StoreEvent => ({
  vendor: 'revenuecat',
  eventId: randomUUID(),
  type: 'NON_RENEWING_PURCHASE',
  userIds: [userId],
  storeProductId: productId,
  transactionId,
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

const balance = async (repos: Repos, userId: string) => {
  const w = await repos.wallet.get(userId);
  return [w.diamonds, w.bonusDiamonds];
};

afterEach(() => {
  vi.useRealTimers();
});

describe('RevenueCat REST client', () => {
  it('asks GET /v1/subscribers/{id} with the secret key, and reads 404 as no record', async () => {
    const rc = fakeRevenueCat({ 'u 1': { subscriber: {} } });
    const client = createRevenueCatClient({ secretKey: 'sk_live', fetch: rc.fetch });
    expect(await client.subscriber('u 1')).toEqual({ subscriber: {} });
    expect(await client.subscriber('nobody')).toBeNull();
    expect(rc.calls[0]).toEqual({ url: 'https://api.revenuecat.com/v1/subscribers/u%201', auth: 'Bearer sk_live' });
    rc.fail(500);
    await expect(client.subscriber('u 1')).rejects.toThrow('RevenueCat answered 500');
  });

  it('exists only when REVENUECAT_SECRET_KEY is set', () => {
    expect(revenueCatClientFromEnv({})).toBeNull();
    expect(revenueCatClientFromEnv({ REVENUECAT_SECRET_KEY: '  ' })).toBeNull();
    expect(revenueCatClientFromEnv({ REVENUECAT_SECRET_KEY: 'sk_x' })).not.toBeNull();
  });
});

describe('events from a subscriber record', () => {
  it('maps one-time purchases, live periods and refunds; skips expired periods and purchases without a transaction id', () => {
    const body = subscriber({
      non_subscriptions: {
        'diamonds.300': [{ id: 'a1', purchase_date: iso(T0 - DAY), store: 'app_store', is_sandbox: false, store_transaction_id: 'TX300' }, { id: 'a2', purchase_date: iso(T0), store: 'app_store' }],
      },
      subscriptions: {
        'fourwinds.month': { expires_date: iso(T0 + 20 * DAY), purchase_date: iso(T0 - 10 * DAY), store: 'play_store', is_sandbox: true, refunded_at: null, store_transaction_id: 'GPA.1' },
        'coach.gold.month': { expires_date: iso(T0 - DAY), purchase_date: iso(T0 - 31 * DAY), store: 'app_store', store_transaction_id: 'OLD' },
        'coach.gold.year': { expires_date: iso(T0 + 300 * DAY), purchase_date: iso(T0 - 65 * DAY), store: 'app_store', refunded_at: iso(T0 - DAY), store_transaction_id: 'Y1' },
      },
    });
    const events = eventsFromSubscriber('u1', body, T0);
    expect(events.map((e) => [e.eventId, e.type, e.storeProductId, e.transactionId, e.environment, e.cancelReason])).toEqual([
      ['sync:purchase:TX300', 'NON_RENEWING_PURCHASE', 'diamonds.300', 'TX300', 'PRODUCTION', null],
      [`sync:period:fourwinds.month:${T0 + 20 * DAY}`, 'SUBSCRIPTION_EXTENDED', 'fourwinds.month', 'GPA.1', 'SANDBOX', null],
      ['sync:refund:coach.gold.year:Y1', 'CANCELLATION', 'coach.gold.year', 'Y1', 'PRODUCTION', 'CUSTOMER_SUPPORT'],
    ]);
    expect(eventsFromSubscriber('u1', { nope: true }, T0)).toEqual([]);
  });
});

describe('Reconciler', () => {
  it('credits a diamond pack whose webhook never arrived, once, however often it runs', async () => {
    const { repos, rc, reconciler, user } = await setup();
    const u = await user();
    rc.records[u] = subscriber({ non_subscriptions: { 'diamonds.3450': [{ id: 'p', purchase_date: iso(T0), store: 'app_store', store_transaction_id: 'MISSED-1' }] } });
    expect((await reconciler.syncUser(u)).applied).toBe(1);
    expect(await balance(repos, u)).toEqual([3000, 450]);
    const again = await reconciler.syncUser(u);
    expect(again).toMatchObject({ checked: true, applied: 0, outcomes: [{ eventId: 'sync:purchase:MISSED-1', outcome: 'duplicate' }] });
    expect(await balance(repos, u)).toEqual([3000, 450]);
  });

  it('never credits twice when the webhook and the sync both saw the purchase, in either order', async () => {
    const { repos, wallet, rc, reconciler, user } = await setup();
    const u = await user();
    rc.records[u] = subscriber({ non_subscriptions: { 'diamonds.600': [{ id: 'p', purchase_date: iso(T0), store: 'app_store', store_transaction_id: 'BOTH-1' }] } });
    expect((await wallet.applyStoreEvent(webhookPurchase(u, 'diamonds.600', 'BOTH-1'))).outcome).toBe('credited');
    expect((await reconciler.syncUser(u)).outcomes.map((o) => o.outcome)).toEqual(['duplicate']);
    expect(await balance(repos, u)).toEqual([600, 0]);
    const v = await user();
    rc.records[v] = subscriber({ non_subscriptions: { 'diamonds.600': [{ id: 'p', purchase_date: iso(T0), store: 'app_store', store_transaction_id: 'BOTH-2' }] } });
    expect((await reconciler.syncUser(v)).applied).toBe(1);
    expect((await wallet.applyStoreEvent(webhookPurchase(v, 'diamonds.600', 'BOTH-2'))).outcome).toBe('duplicate');
    expect(await balance(repos, v)).toEqual([600, 0]);
  });

  it('grants a live subscription the webhook missed, and applies a refund it missed', async () => {
    const { wallet, rc, reconciler, user } = await setup();
    const u = await user();
    rc.records[u] = subscriber({ subscriptions: { 'fourwinds.year': { expires_date: iso(T0 + 300 * DAY), purchase_date: iso(T0 - 65 * DAY), store: 'app_store', store_transaction_id: 'FW-1' } } });
    expect((await reconciler.syncUser(u)).outcomes.map((o) => o.outcome)).toEqual(['entitled']);
    expect(await wallet.tierOf(u)).toBe('fourwinds');
    rc.records[u] = subscriber({ subscriptions: { 'fourwinds.year': { expires_date: iso(T0 + 300 * DAY), purchase_date: iso(T0 - 65 * DAY), store: 'app_store', refunded_at: iso(T0), store_transaction_id: 'FW-1' } } });
    expect((await reconciler.syncUser(u)).outcomes.map((o) => o.outcome)).toEqual(['refunded']);
    expect(await wallet.tierOf(u)).toBe('free');
  });

  it('follows the sandbox rule: a non-tester gets nothing, a tester gets the purchase', async () => {
    const tester = randomUUID();
    const { repos, rc, reconciler } = await setup({ testers: [tester] });
    const other = randomUUID();
    for (const id of [tester, other]) {
      await repos.users.create({ id, kind: 'guest', createdAt: T0 });
      rc.records[id] = subscriber({ non_subscriptions: { 'diamonds.60': [{ id: 'p', purchase_date: iso(T0), store: 'app_store', is_sandbox: true, store_transaction_id: `SB-${id}` }] } });
    }
    expect((await reconciler.syncUser(other)).outcomes.map((o) => o.outcome)).toEqual(['ignored_sandbox']);
    expect((await reconciler.syncUser(tester)).outcomes.map((o) => o.outcome)).toEqual(['credited']);
    expect(await balance(repos, other)).toEqual([0, 0]);
  });

  it('after a deleted account is purged, a sync of the new account finds the subscription the store moved to it', async () => {
    const { repos, wallet, rc, reconciler, user, advance } = await setup();
    const old = await user();
    await wallet.applyStoreEvent({ ...webhookPurchase(old, 'fourwinds.month', 'SUB-1'), type: 'INITIAL_PURCHASE', expiresAt: T0 + 30 * DAY });
    await repos.users.update(old, { deletedAt: T0 });
    advance(31 * DAY);
    await purgeDeletedUsers(repos, { now: () => T0 + 31 * DAY });
    expect(await repos.users.get(old)).toBeNull();
    const fresh = await user();
    rc.records[fresh] = subscriber({ subscriptions: { 'fourwinds.month': { expires_date: iso(T0 + 61 * DAY), purchase_date: iso(T0 + 31 * DAY), store: 'app_store', store_transaction_id: 'SUB-2' } } });
    expect((await reconciler.syncUser(fresh)).applied).toBe(1);
    expect(await wallet.hasFourWinds(fresh)).toBe(true);
  });

  it('syncs every account with store activity in the last 7 days; one failure does not stop the rest', async () => {
    const { repos, wallet, rc, reconciler, user, advance } = await setup();
    const quiet = await user();
    await wallet.applyStoreEvent(webhookPurchase(quiet, 'diamonds.60', 'Q-1'));
    advance(8 * DAY);
    const busy = await user();
    const broken = await user();
    await wallet.applyStoreEvent(webhookPurchase(busy, 'diamonds.60', 'B-1'));
    await wallet.applyStoreEvent(webhookPurchase(broken, 'diamonds.60', 'X-1'));
    rc.records[busy] = subscriber({ non_subscriptions: { 'diamonds.300': [{ id: 'p', purchase_date: iso(T0), store: 'app_store', store_transaction_id: 'B-2' }] } });
    rc.records[broken] = 'not json';
    const res = await reconciler.syncRecent();
    expect(res).toEqual({ users: 2, applied: 1, failed: 0 });
    expect(rc.calls.map((c) => c.url.split('/').pop()).sort()).toEqual([busy, broken].sort());
    expect(await balance(repos, busy)).toEqual([360, 0]);
    rc.fail(503);
    expect(await reconciler.syncRecent()).toEqual({ users: 2, applied: 0, failed: 2 });
  });

  it('does nothing without a client, and the nightly job runs once a day', async () => {
    const { repos, wallet } = await setup();
    const off = new Reconciler({ repos, wallet, client: null });
    expect(off.enabled).toBe(false);
    expect(await off.syncUser('u')).toEqual({ userId: 'u', checked: false, outcomes: [], applied: 0 });
    expect(await off.syncRecent()).toEqual({ users: 0, applied: 0, failed: 0 });
    vi.useFakeTimers();
    const on = new Reconciler({ repos, wallet, client: { subscriber: async () => null } });
    const spy = vi.spyOn(on, 'syncRecent');
    const stop = startReconcileJob(on, { log: () => {} });
    await vi.advanceTimersByTimeAsync(DAY - 1);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(spy).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(2 * DAY);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/** The store routes, through a stand-in for api.ts's route factory. */
function routes(deps: Parameters<typeof storeRoutes>[1]) {
  const table = storeRoutes((method, path, handler) => ({ method, path, handler }), deps);
  const call = async (method: string, path: string, opts: { body?: Record<string, unknown>; userId?: string; authorization?: string } = {}) => {
    const route = table.find((x) => x.method === method && x.path === path);
    if (!route) throw new Error(`no route ${method} ${path}`);
    const ctx: StoreRouteCtx = {
      body: opts.body ?? {},
      req: { headers: opts.authorization ? { authorization: opts.authorization } : {} } as StoreRouteCtx['req'],
      caller: async () => {
        if (!opts.userId) throw new Error('no session');
        return { userId: opts.userId };
      },
    };
    try {
      return { status: 200, json: (await route.handler(ctx)) as Record<string, unknown> };
    } catch (e) {
      if (e instanceof WalletError) return { status: e.status, json: { error: e.code } as Record<string, unknown> };
      throw e;
    }
  };
  return { table, call };
}

describe('POST /api/wallet/sync', () => {
  it('applies missed purchases for the caller and answers the wallet; without a key it only answers the wallet', async () => {
    const { repos, wallet, reconciler, rc, user, now } = await setup();
    const u = await user();
    rc.records[u] = subscriber({ non_subscriptions: { 'diamonds.300': [{ id: 'p', purchase_date: iso(T0), store: 'app_store', store_transaction_id: 'R-1' }] } });
    const { call } = routes({ repos, wallet, reconciler, now, adminToken: null });
    expect(await call('POST', '/api/wallet/sync', { userId: u })).toEqual({ status: 200, json: { synced: true, applied: 1, wallet: { diamonds: 300, bonusDiamonds: 0 }, cosmetics: [], coachTier: 'free' } });
    const offline = routes({ repos, wallet, now, env: {}, adminToken: null });
    expect(await offline.call('POST', '/api/wallet/sync', { userId: u })).toMatchObject({ status: 200, json: { synced: false, applied: 0, wallet: { diamonds: 300 } } });
  });

  it('is limited per account, and says when the store cannot be reached', async () => {
    const { repos, wallet, reconciler, rc, user, now } = await setup();
    const u = await user();
    const { call } = routes({ repos, wallet, reconciler, now, adminToken: null });
    rc.fail(500);
    expect((await call('POST', '/api/wallet/sync', { userId: u })).json).toEqual({ error: 'store_unreachable' });
    rc.fail(null);
    for (let i = 1; i < 4; i++) expect((await call('POST', '/api/wallet/sync', { userId: u })).status).toBe(200);
    expect(await call('POST', '/api/wallet/sync', { userId: u })).toEqual({ status: 429, json: { error: 'rate_limited' } });
  });
});

describe('POST /api/admin/grant', () => {
  const ADMIN = 'admin-token-0123456789abcdef';

  it('is off without ADMIN_TOKEN and refuses a wrong token, in constant time', async () => {
    const { repos, wallet, user, now } = await setup();
    const u = await user();
    expect((await routes({ repos, wallet, now, env: {} }).call('POST', '/api/admin/grant', { body: { userId: u, diamonds: 5, note: 'x' } })).status).toBe(503);
    const { call } = routes({ repos, wallet, now, env: { ADMIN_TOKEN: ADMIN } });
    for (const authorization of [undefined, 'Bearer nope', ADMIN, `Bearer ${ADMIN}x`]) {
      expect((await call('POST', '/api/admin/grant', { authorization, body: { userId: u, diamonds: 5, note: 'x' } })).status).toBe(401);
    }
    expect(await balance(repos, u)).toEqual([0, 0]);
    expect(adminAuthorised(`Bearer ${ADMIN}`, ADMIN)).toBe(true);
    expect(adminAuthorised(`Bearer ${ADMIN}`, null)).toBe(false);
  });

  it('grants diamonds as a support ledger entry, and a plan or look as a support entitlement', async () => {
    const { repos, wallet, user, now } = await setup();
    const u = await user();
    const { call } = routes({ repos, wallet, now, env: { ADMIN_TOKEN: ADMIN } });
    const auth = `Bearer ${ADMIN}`;
    const res = await call('POST', '/api/admin/grant', { authorization: auth, body: { userId: u, diamonds: 300, bonus: 50, note: 'Ticket 42: pack never arrived' } });
    expect(res).toMatchObject({ status: 200, json: { ok: true, granted: { diamonds: 300, bonus: 50 }, wallet: { diamonds: 300, bonusDiamonds: 50 } } });
    expect((await repos.wallet.listLedger(u)).at(-1)).toMatchObject({ delta: 300, bonus: 50, reason: 'support', ref: 'support:Ticket 42: pack never arrived' });
    const plan = await call('POST', '/api/admin/grant', { authorization: auth, body: { userId: u, entitlement: 'fourwinds.month', days: 30, note: 'Ticket 43' } });
    expect(plan).toMatchObject({ status: 200, json: { coachTier: 'fourwinds', granted: { entitlement: 'fourwinds.month', expiresAt: iso(T0 + 30 * DAY) } } });
    expect((await repos.wallet.getEntitlements(u)).find((e) => e.entitlement === 'fourwinds.month')).toMatchObject({ source: 'support', expiresAt: T0 + 30 * DAY });
    expect((await call('POST', '/api/admin/grant', { authorization: auth, body: { userId: u, entitlement: 'theme.jade', note: 'Ticket 44' } })).json).toMatchObject({ cosmetics: ['theme.jade'] });
    expect((await repos.wallet.listLedger(u)).filter((l) => l.reason === 'support').map((l) => l.ref)).toEqual(['support:Ticket 42: pack never arrived', 'support:fourwinds.month:Ticket 43', 'support:theme.jade:Ticket 44']);
  });

  it('refuses unknown accounts and entitlements, plans without days, nonsense amounts and grants without a note', async () => {
    const { repos, wallet, user, now } = await setup();
    const u = await user();
    const { call } = routes({ repos, wallet, now, env: { ADMIN_TOKEN: ADMIN } });
    const grant = async (body: Record<string, unknown>) => (await call('POST', '/api/admin/grant', { authorization: `Bearer ${ADMIN}`, body })).json.error;
    expect(await grant({ userId: randomUUID(), diamonds: 5, note: 'n' })).toBe('not_found');
    expect(await grant({ userId: u, entitlement: 'coach.platinum', days: 3, note: 'n' })).toBe('invalid');
    expect(await grant({ userId: u, entitlement: 'coach.gold.year', note: 'n' })).toBe('invalid');
    expect(await grant({ userId: u, diamonds: -5, note: 'n' })).toBe('invalid');
    expect(await grant({ userId: u, diamonds: 1.5, note: 'n' })).toBe('invalid');
    expect(await grant({ userId: u, diamonds: 5 })).toBe('invalid');
    expect(await grant({ userId: u, note: 'n' })).toBe('invalid');
    await repos.users.update(u, { deletedAt: T0 });
    expect(await grant({ userId: u, diamonds: 5, note: 'n' })).toBe('not_found');
    expect(await balance(repos, u)).toEqual([0, 0]);
  });
});
