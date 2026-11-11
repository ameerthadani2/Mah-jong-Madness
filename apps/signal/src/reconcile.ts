/**
 * Store reconciliation: catches purchases and subscriptions whose webhook never arrived (the
 * server was down longer than RevenueCat retries, a deploy dropped a request) by reading the
 * player's purchases from RevenueCat's REST API and applying them through the same
 * `WalletService.applyStoreEvent` path the webhook uses, so nothing is ever granted twice:
 *
 * - a one-time purchase (diamond pack) becomes a NON_RENEWING_PURCHASE keyed on its store
 *   transaction id, which the wallet credits at most once whichever path saw it first;
 * - a live subscription period becomes a SUBSCRIPTION_EXTENDED up to the store's expiry, keyed on
 *   the plan and that expiry, so a later period is a new event and an old one never shortens it;
 * - a refunded subscription becomes a CANCELLATION with reason CUSTOMER_SUPPORT.
 *
 * Sandbox purchases follow the same tester rule as the webhook. Synthesised events are recorded
 * in `store_events` like the webhook's (vendor `revenuecat`), so running a sync twice changes
 * nothing the second time. Their ids start `sync:<account id>:`, the account they were applied
 * to: the store reports one subscription under whichever app user id holds it now, so the same
 * period seen for an old account and later for the account it was restored on are two events,
 * and the first can never stand in the way of the second. An account that is deleted, purged or
 * unknown is not synced at all, and each event is applied on its own: one that fails is logged
 * and counted, and the rest still apply.
 *
 * It runs after Restore (`POST /api/wallet/sync`, admin.ts) and nightly for every account with
 * store activity in the last 7 days (`startReconcileJob`). Without REVENUECAT_SECRET_KEY there is
 * no client and nothing runs. `fetch` is injected, so the tests never touch the network.
 *
 * RevenueCat REST v1: `GET https://api.revenuecat.com/v1/subscribers/{app_user_id}` with
 * `Authorization: Bearer <secret key>` answers `{ subscriber: { subscriptions: { <product id>:
 * { expires_date, purchase_date, store, is_sandbox, refunded_at, store_transaction_id, … } },
 * non_subscriptions: { <product id>: [{ id, purchase_date, store, is_sandbox,
 * store_transaction_id }] } } }`.
 */
import type { Repos } from './repos/types';
import type { StoreEvent, StoreResult, WalletService } from './wallet';

type Env = Record<string, string | undefined>;

/** The part of `fetch` the client uses. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>;

export interface RevenueCatClient {
  /** The subscriber record for this app user id, or null when RevenueCat has never seen it. Throws on other failures. */
  subscriber(appUserId: string): Promise<unknown | null>;
}

export const REVENUECAT_API = 'https://api.revenuecat.com/v1';

export class ReconcileError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'ReconcileError';
  }
}

export function createRevenueCatClient(opts: { secretKey: string; fetch?: FetchLike; baseUrl?: string; timeoutMs?: number }): RevenueCatClient {
  const fetcher = opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const base = (opts.baseUrl ?? REVENUECAT_API).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    async subscriber(appUserId) {
      const signal = AbortSignal.timeout(timeoutMs);
      const res = await fetcher(`${base}/subscribers/${encodeURIComponent(appUserId)}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${opts.secretKey}`, accept: 'application/json' },
        signal,
      });
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw new ReconcileError(`RevenueCat answered ${res.status}`, res.status);
      return res.json();
    },
  };
}

/** A client when REVENUECAT_SECRET_KEY is set, otherwise null (reconciliation off). */
export function revenueCatClientFromEnv(env: Env = process.env, fetch?: FetchLike): RevenueCatClient | null {
  const secretKey = (env.REVENUECAT_SECRET_KEY ?? '').trim();
  return secretKey ? createRevenueCatClient({ secretKey, fetch }) : null;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 255): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const time = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
};

function baseEvent(userId: string, eventId: string, type: string, productId: string, item: Record<string, unknown>, raw: unknown): StoreEvent {
  return {
    vendor: 'revenuecat',
    eventId,
    type,
    userIds: [userId],
    storeProductId: productId,
    transactionId: text(item.store_transaction_id),
    expiresAt: time(item.expires_date),
    purchasedAt: time(item.purchase_date),
    price: null,
    currency: null,
    store: (text(item.store, 32) ?? 'unknown').toLowerCase(),
    environment: item.is_sandbox === true ? 'SANDBOX' : 'PRODUCTION',
    cancelReason: null,
    transferredFrom: [],
    transferredTo: [],
    raw: { source: 'reconcile', productId, item: raw },
  };
}

/**
 * The store events a subscriber record implies for the account `userId`, oldest information
 * first. Every event id carries that account id. Purchases without a store transaction id are
 * skipped: without it a webhook credit and a sync credit could not be told apart.
 */
export function eventsFromSubscriber(userId: string, body: unknown, now: number): StoreEvent[] {
  const sub = isObject(body) && isObject(body.subscriber) ? body.subscriber : null;
  if (!sub) return [];
  const out: StoreEvent[] = [];
  // store_events.event_id holds at most 255 characters.
  const id = (kind: string, ...parts: Array<string | number>) => ['sync', userId, kind, ...parts].join(':').slice(0, 255);
  const ones = isObject(sub.non_subscriptions) ? sub.non_subscriptions : {};
  for (const [productId, list] of Object.entries(ones)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isObject(item)) continue;
      const txn = text(item.store_transaction_id);
      if (!txn) continue;
      if (time(item.refunded_at) !== null) {
        out.push({ ...baseEvent(userId, id('refund', txn), 'CANCELLATION', productId, item, item), cancelReason: 'CUSTOMER_SUPPORT' });
      } else {
        out.push(baseEvent(userId, id('purchase', txn), 'NON_RENEWING_PURCHASE', productId, item, item));
      }
    }
  }
  const subs = isObject(sub.subscriptions) ? sub.subscriptions : {};
  for (const [productId, item] of Object.entries(subs)) {
    if (!isObject(item)) continue;
    const expires = time(item.expires_date);
    const txn = text(item.store_transaction_id);
    const refundedAt = time(item.refunded_at);
    if (refundedAt !== null) {
      out.push({ ...baseEvent(userId, id('refund', productId, txn ?? refundedAt), 'CANCELLATION', productId, item, item), cancelReason: 'CUSTOMER_SUPPORT', expiresAt: refundedAt });
      continue;
    }
    // Only a live period needs granting; an expired one has already ended on its own.
    if (expires === null || expires <= now) continue;
    out.push(baseEvent(userId, id('period', productId, expires), 'SUBSCRIPTION_EXTENDED', productId, item, item));
  }
  return out;
}

export interface ReconcileResult {
  userId: string;
  /** False when there is no RevenueCat client (no REVENUECAT_SECRET_KEY). */
  checked: boolean;
  /** Outcome of each event, by event id (duplicates included); `failed` for one that could not be applied. */
  outcomes: Array<{ eventId: string; outcome: StoreResult['outcome'] | 'failed' }>;
  /** How many changed something (not duplicate, not ignored). */
  applied: number;
  /** How many could not be applied this time (the next sync tries them again). */
  failed: number;
}

const CHANGED = new Set(['credited', 'entitled', 'extended', 'refunded']);

export class Reconciler {
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(
    private readonly deps: { repos: Repos; wallet: WalletService; client: RevenueCatClient | null; now?: () => number; log?: (line: string) => void },
  ) {
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  get enabled(): boolean {
    return this.deps.client !== null;
  }

  /**
   * Read this user's purchases from the store and apply what the server is missing, to the live
   * account the id stands for (a merged guest's purchases go to the account it was merged into).
   * A deleted, purged or unknown account is not read at all (`checked` false). Throws only when
   * the store cannot be read; an event that fails is counted in `failed` and the others go on.
   */
  async syncUser(userId: string): Promise<ReconcileResult> {
    const client = this.deps.client;
    const none: ReconcileResult = { userId, checked: false, outcomes: [], applied: 0, failed: 0 };
    if (!client) return none;
    const account = await this.deps.wallet.liveAccount(userId);
    if (!account) return none;
    const body = await client.subscriber(userId);
    const outcomes: ReconcileResult['outcomes'] = [];
    for (const e of eventsFromSubscriber(account, body, this.now())) {
      try {
        const r = await this.deps.wallet.applyStoreEvent(e);
        // The account went away while this ran. Nothing was granted, so nothing is kept either.
        if (r.outcome === 'ignored_unknown_user') await this.deps.repos.storeEvents.delete(e.eventId);
        outcomes.push({ eventId: e.eventId, outcome: r.outcome });
      } catch (err) {
        outcomes.push({ eventId: e.eventId, outcome: 'failed' });
        this.log(`[signal] store sync event ${e.eventId} failed: ${(err as Error).message}`);
      }
    }
    const applied = outcomes.filter((o) => CHANGED.has(o.outcome)).length;
    const failed = outcomes.filter((o) => o.outcome === 'failed').length;
    if (applied) this.log(`[signal] store sync applied ${applied} missed event(s) for ${account}`);
    return { userId, checked: true, outcomes, applied, failed };
  }

  /** Sync every account with store activity since `since` (default: the last 7 days). One failure never stops the rest; `failed` counts the accounts that had one. */
  async syncRecent(since: number = this.now() - 7 * 86_400_000): Promise<{ users: number; applied: number; failed: number }> {
    if (!this.deps.client) return { users: 0, applied: 0, failed: 0 };
    const users = await this.deps.repos.storeEvents.usersActiveSince(since);
    let applied = 0;
    let failed = 0;
    for (const userId of users) {
      try {
        const res = await this.syncUser(userId);
        applied += res.applied;
        if (res.failed) failed++;
      } catch (e) {
        failed++;
        this.log(`[signal] store sync for ${userId} failed: ${(e as Error).message}`);
      }
    }
    return { users: users.length, applied, failed };
  }
}

/**
 * Run `syncRecent` once a day (first run one interval after start). Returns a stop function.
 * Does nothing without a RevenueCat client.
 */
export function startReconcileJob(reconciler: Reconciler, opts: { intervalMs?: number; log?: (line: string) => void } = {}): () => void {
  if (!reconciler.enabled) return () => {};
  const log = opts.log ?? ((line: string) => console.log(line));
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    reconciler
      .syncRecent()
      .then((r) => {
        if (r.users) log(`[signal] nightly store sync: ${r.users} account(s), ${r.applied} missed event(s) applied, ${r.failed} failed`);
      })
      .catch((e: Error) => log(`[signal] nightly store sync failed: ${e.message}`))
      .finally(() => {
        running = false;
      });
  }, opts.intervalMs ?? 86_400_000);
  timer.unref();
  return () => clearInterval(timer);
}
