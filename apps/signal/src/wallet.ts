/**
 * WalletService: every change to a player's diamonds and entitlements goes through here, over
 * `repos.wallet` (balances, ledger, purchases, entitlements) and `repos.storeEvents`.
 *
 * - `credit` adds diamonds with a ledger entry.
 * - `spend` buys a cosmetic with diamonds: an atomic debit plus a permanent entitlement, or
 *   `409 insufficient` / `409 owned`. Bonus diamonds are spent before purchased ones.
 * - `applyStoreEvent` turns a vendor-neutral store notification (see revenuecat.ts) into grants.
 *   It is idempotent on the event id: the event row is written first, in the same transaction as
 *   its effects, so a redelivered event changes nothing. Diamond credits are additionally keyed
 *   on the store transaction id (purchases.transaction_id is unique), so one purchase is never
 *   credited twice, under two event ids or under two accounts, and its refund is taken from the
 *   account that holds the purchase. A TRANSFER moves a plan's purchases with the plan, and a
 *   later event for one of them that names an account it moved away from (a refund or renewal
 *   delivered late) is applied to the account that holds it now.
 *
 * Diamonds and entitlements have no monetary value and cannot be redeemed or transferred between
 * players. Work for one user is serialised in this process (one game server machine), and on
 * Postgres every operation is one transaction.
 */
import { bundlePrice, COSMETIC_ENTITLEMENTS, PERIOD_MS, planOfEntitlement, productForStoreId, serverProduct, supportPlanKey, TIER_RANK, tierOfEntitlement, tierOfEntitlements, type CoachTier, type ServerProduct } from './catalog';
import { NO_ANALYTICS, withConsent, type Analytics } from './observability';
import type { EntitlementRecord, PurchaseRecord, Repos, UserRecord, WalletRecord } from './repos/types';

export type WalletErrorCode = 'insufficient' | 'owned' | 'not_for_sale' | 'invalid' | 'not_found' | 'unauthorised' | 'rate_limited' | 'unavailable' | 'store_unreachable';

const WALLET_STATUS: Record<WalletErrorCode, number> = {
  insufficient: 409,
  owned: 409,
  not_for_sale: 404,
  not_found: 404,
  invalid: 400,
  unauthorised: 401,
  rate_limited: 429,
  unavailable: 503,
  store_unreachable: 502,
};

/** A refused wallet, store or support operation, with the HTTP status the API answers. */
export class WalletError extends Error {
  readonly status: number;
  constructor(
    readonly code: WalletErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WalletError';
    this.status = WALLET_STATUS[code];
  }
}

/** The store notifications we act on (RevenueCat's event types; another vendor maps onto these). */
export const STORE_EVENT_TYPES = [
  'INITIAL_PURCHASE',
  'RENEWAL',
  'NON_RENEWING_PURCHASE',
  'CANCELLATION',
  'UNCANCELLATION',
  'EXPIRATION',
  'BILLING_ISSUE',
  'PRODUCT_CHANGE',
  'TRANSFER',
  'SUBSCRIPTION_PAUSED',
  'SUBSCRIPTION_EXTENDED',
  'TEST',
] as const;
export type StoreEventType = (typeof STORE_EVENT_TYPES)[number];

/** A store notification after the vendor's payload has been read (revenuecat.ts builds these). */
export interface StoreEvent {
  vendor: string;
  eventId: string;
  /** A type we do not know is stored and acknowledged, with no effect. */
  type: StoreEventType | string;
  /** Candidate user ids, most specific first (app user id, original id, aliases). */
  userIds: string[];
  /** The store's product id (`coach.gold.month`, or Play's `coach.gold:month`). */
  storeProductId: string | null;
  transactionId: string | null;
  /**
   * The subscription's first transaction (`original_transaction_id`), when given: every renewal and
   * refund of one subscription carries it, so it finds the purchase a TRANSFER moved (see
   * `applyStoreEvent`).
   */
  originalTransactionId?: string | null;
  /**
   * True for an event read from the store's current record of the account it names (reconcile.ts):
   * it is applied to that account as named, never routed through the purchases on record.
   */
  fromSync?: boolean;
  /** Subscription end as the store reports it (ms), when given. */
  expiresAt: number | null;
  purchasedAt: number | null;
  /** When the store sent the event (ms), when given (`event_timestamp_ms`). */
  eventAt?: number | null;
  price: number | null;
  currency: string | null;
  /** `app_store`, `play_store`, … */
  store: string;
  environment: string | null;
  /** CANCELLATION reason; `CUSTOMER_SUPPORT` means a refund. */
  cancelReason: string | null;
  transferredFrom: string[];
  transferredTo: string[];
  raw: unknown;
}

export type StoreOutcome =
  | 'credited'
  | 'entitled'
  | 'extended'
  | 'expired'
  | 'refunded'
  | 'transferred'
  | 'recorded'
  | 'test'
  | 'duplicate'
  | 'ignored_unknown_user'
  | 'ignored_unknown_product'
  | 'ignored_sandbox'
  | 'ignored_stale'
  | 'ignored_type'
  | 'ignored_invalid';

/**
 * Longest a store event may grant ahead: a subscription end more than this after the event (its
 * `event_timestamp_ms`, when given) or after now is refused as invalid. A yearly plan runs 365
 * or 366 days, so this leaves a month for grace periods and late delivery.
 */
export const MAX_STORE_EXPIRY_MS = 400 * 86_400_000;

/**
 * Prices a purchase row records are below this: `purchases.price` is `numeric(14, 4)`, which holds
 * less than 10^10 once rounded to four decimals. A price outside 0 to that is recorded as null (on
 * memory too), so a figure the column cannot hold never stops a credit.
 */
export const PRICE_LIMIT = 1e10;

/** The price a purchase row records: the event's price when it is a number from 0 and below `PRICE_LIMIT` at four decimals, else null. */
export function recordablePrice(price: unknown): number | null {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
  // Postgres rounds to four decimals before it checks the range, so check the rounded figure.
  return Math.round(price * 10_000) < PRICE_LIMIT * 10_000 ? price : null;
}

export interface StoreResult {
  outcome: StoreOutcome;
  userId: string | null;
  duplicate: boolean;
}

export interface WalletSummary {
  wallet: { diamonds: number; bonusDiamonds: number };
  entitlements: Array<{ entitlement: string; expiresAt: number | null; active: boolean }>;
  /** Product ids of the cosmetics the user owns (`theme.jade`). */
  cosmetics: string[];
  /** The best tier among the plans currently live (`fourwinds` is The Four Winds Club). */
  coachTier: CoachTier;
}

export interface WalletServiceOptions {
  now?: () => number;
  analytics?: Analytics;
  log?: (line: string) => void;
  /**
   * Accounts whose sandbox purchases (TestFlight, Play testing) are granted. Everyone else's
   * sandbox events are recorded as `ignored_sandbox`. Default: `TESTER_USER_IDS` from the
   * environment (comma-separated user ids). Ids are compared in lower case.
   */
  testerUserIds?: Iterable<string>;
}

type Env = Record<string, string | undefined>;

/** The tester allowlist in `TESTER_USER_IDS` (comma-separated user ids). */
export function testerIdsFromEnv(env: Env = process.env): Set<string> {
  return new Set(
    (env.TESTER_USER_IDS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True for an event from a store's test environment (App Store sandbox, Play test tracks). */
export const isSandbox = (e: Pick<StoreEvent, 'environment'>): boolean => (e.environment ?? '').trim().toUpperCase() === 'SANDBOX';

/** Source written on entitlements granted by store events (TRANSFER moves only these). */
export const STORE_SOURCE = 'store';
const SPEND_SOURCE = 'diamonds';
/** Source of entitlements granted by support (`POST /api/admin/grant`). */
export const SUPPORT_SOURCE = 'support';

const isLive = (e: Pick<EntitlementRecord, 'expiresAt'>, at: number) => e.expiresAt === null || e.expiresAt > at;

export class WalletService {
  private readonly now: () => number;
  private readonly analytics: Analytics;
  private readonly log: (line: string) => void;
  private readonly testers: ReadonlySet<string>;
  /** One chain per user, so two spends from one player cannot both pass the ownership check. */
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly repos: Repos,
    opts: WalletServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    // Purchase events reach analytics only for players who allowed analytics in the app.
    this.analytics = withConsent(opts.analytics ?? NO_ANALYTICS, (id) => repos.users.getAnalyticsConsent(id));
    this.log = opts.log ?? ((line) => console.log(line));
    // A Set is kept as given (so a caller can add testers later); anything else is read once.
    this.testers = opts.testerUserIds instanceof Set ? opts.testerUserIds : opts.testerUserIds ? new Set([...opts.testerUserIds].map((id) => id.trim().toLowerCase())) : testerIdsFromEnv();
  }

  /**
   * True when this event may grant: a production event, or a sandbox event whose grant goes to an
   * account on the tester list. Only the account that would receive the grant counts (for a
   * TRANSFER, the account the purchases move to): another id in the event, such as an alias the
   * store attached, lends nobody a tester's sandbox purchases.
   */
  private grantable(e: StoreEvent, recipient: UserRecord | null): boolean {
    return !isSandbox(e) || (recipient !== null && this.testers.has(recipient.id.toLowerCase()));
  }

  /** The outcome of a sandbox event that may not grant, with a log line. */
  private sandboxRefused(e: StoreEvent, recipient: UserRecord | null): { outcome: StoreOutcome; userId: string | null } {
    this.log(`[signal] sandbox store event ${e.eventId} (${e.type}) for an account not on TESTER_USER_IDS; recorded only`);
    return { outcome: 'ignored_sandbox', userId: recipient?.id ?? null };
  }

  /**
   * Run `fn` while nothing else in this process touches these users' wallets: store events and
   * spends for them wait. The API runs an account merge under it, so a store event for the guest
   * either lands before the merge (and moves with the wallet) or after it (and follows
   * `mergedInto` to the account).
   */
  exclusive<T>(userIds: string[], fn: () => Promise<T>): Promise<T> {
    return this.serialise(userIds, fn);
  }

  private serialise<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)].sort();
    const before = Promise.all(unique.map((k) => this.locks.get(k)?.catch(() => {}) ?? Promise.resolve()));
    const run = before.then(fn);
    const settled = run.catch(() => {});
    for (const k of unique) this.locks.set(k, settled);
    void settled.then(() => {
      for (const k of unique) if (this.locks.get(k) === settled) this.locks.delete(k);
    });
    return run;
  }

  async summary(userId: string): Promise<WalletSummary> {
    const [w, ents] = await Promise.all([this.repos.wallet.get(userId), this.repos.wallet.getEntitlements(userId)]);
    const at = this.now();
    const live = ents.filter((e) => isLive(e, at));
    // A plan held from the store and from support is one line for the app: the later expiry.
    const byName = new Map<string, { entitlement: string; expiresAt: number | null }>();
    for (const e of ents) {
      const entitlement = planOfEntitlement(e.entitlement);
      const seen = byName.get(entitlement);
      if (!seen) byName.set(entitlement, { entitlement, expiresAt: e.expiresAt });
      else seen.expiresAt = seen.expiresAt === null || e.expiresAt === null ? null : Math.max(seen.expiresAt, e.expiresAt);
    }
    return {
      wallet: { diamonds: w.diamonds, bonusDiamonds: w.bonusDiamonds },
      entitlements: [...byName.values()].map((e) => ({ ...e, active: isLive(e, at) })),
      cosmetics: live.filter((e) => COSMETIC_ENTITLEMENTS.has(e.entitlement)).map((e) => e.entitlement).sort(),
      coachTier: tierOfEntitlements(live.map((e) => e.entitlement)),
    };
  }

  /** The user's tier now: the best subscription plan still live. */
  async tierOf(userId: string): Promise<CoachTier> {
    const at = this.now();
    return tierOfEntitlements((await this.repos.wallet.getEntitlements(userId)).filter((e) => isLive(e, at)).map((e) => e.entitlement));
  }

  /** True while the user has Coach Gold or The Four Winds Club (unlimited ranked Puzzle Rush; the server's Rush meter calls this). */
  async hasCoachGold(userId: string): Promise<boolean> {
    return TIER_RANK[await this.tierOf(userId)] >= TIER_RANK.gold;
  }

  /** True while the user has The Four Winds Club (the club-ownership gate calls this). */
  async hasFourWinds(userId: string): Promise<boolean> {
    return TIER_RANK[await this.tierOf(userId)] >= TIER_RANK.fourwinds;
  }

  /** Add diamonds (and optionally bonus diamonds) with a ledger entry. */
  async credit(userId: string, diamonds: number, reason: string, ref: string | null = null, bonus = 0): Promise<WalletRecord> {
    if (!Number.isInteger(diamonds) || !Number.isInteger(bonus) || diamonds < 0 || bonus < 0 || diamonds + bonus === 0) {
      throw new WalletError('invalid', 'A credit must be a positive whole number of diamonds');
    }
    return this.serialise([userId], async () => {
      const res = await this.repos.wallet.apply({ userId, delta: diamonds, bonus, reason, ref, createdAt: this.now() });
      if (!res) throw new WalletError('invalid', 'Credit refused');
      return res.wallet;
    });
  }

  /**
   * A support grant of an entitlement (`POST /api/admin/grant`): written with source `support`,
   * never shortening a grant the user already has, and noted on the ledger as a zero entry. A
   * plan is kept in its own row (`support:<plan>`), apart from the row store events write for
   * the same plan, so refunding or transferring a store purchase never takes support's time and
   * the grant never hides a store subscription. A look is one permanent row either way.
   */
  async grantSupport(userId: string, entitlement: string, expiresAt: number | null, note: string): Promise<void> {
    const key = tierOfEntitlement(entitlement) ? supportPlanKey(entitlement) : entitlement;
    await this.serialise([userId], () =>
      this.repos.transaction(async (tx) => {
        const at = this.now();
        const current = (await tx.wallet.getEntitlements(userId)).find((e) => e.entitlement === key);
        const keeps = current && (current.expiresAt === null || (expiresAt !== null && current.expiresAt >= expiresAt));
        if (!keeps) await tx.wallet.setEntitlement({ userId, entitlement: key, expiresAt, source: SUPPORT_SOURCE, updatedAt: at });
        await tx.wallet.apply({ userId, delta: 0, bonus: 0, reason: 'support', ref: `support:${entitlement}:${note}`.slice(0, 255), createdAt: at });
      }),
    );
  }

  /**
   * Buy a cosmetic with diamonds: debit and permanent entitlement together, or neither. A bundle
   * grants each of its items the player does not own yet, at `bundlePrice` (the share still
   * missing), and is refused as owned when nothing is missing.
   */
  async spend(userId: string, productId: unknown): Promise<{ wallet: WalletRecord; entitlement: string; spent: number; granted: string[] }> {
    const product = serverProduct(productId);
    if (!product || product.kind !== 'cosmetic') throw new WalletError('not_for_sale', 'That item is not sold for diamonds');
    return this.serialise([userId], () =>
      this.repos.transaction(async (tx) => {
        const at0 = this.now();
        const ownedNow = new Set((await tx.wallet.getEntitlements(userId)).filter((e) => isLive(e, at0)).map((e) => e.entitlement));
        const grants = product.contains ? product.contains.filter((id) => !ownedNow.has(id)) : ownedNow.has(product.entitlement) ? [] : [product.entitlement];
        if (grants.length === 0) throw new WalletError('owned', 'You already own that item');
        const w = await tx.wallet.get(userId);
        const price = product.contains ? bundlePrice(product, (e) => ownedNow.has(e)) : product.diamondPrice;
        // A refund can leave purchased diamonds below zero: nothing is spent until they are back above.
        if (w.diamonds < 0 || w.diamonds + w.bonusDiamonds < price) throw new WalletError('insufficient', 'Not enough diamonds');
        const fromBonus = Math.min(w.bonusDiamonds, price);
        const at = this.now();
        const res = await tx.wallet.apply({ userId, delta: -(price - fromBonus), bonus: -fromBonus, reason: 'spend', ref: product.id, createdAt: at });
        if (!res) throw new WalletError('insufficient', 'Not enough diamonds');
        for (const entitlement of grants) await tx.wallet.setEntitlement({ userId, entitlement, expiresAt: null, source: SPEND_SOURCE, updatedAt: at });
        return { wallet: res.wallet, entitlement: product.entitlement, spent: price, granted: grants };
      }),
    );
  }

  /** The id of the live account this user id stands for now (following merges); null for a deleted, purged or unknown one. */
  async liveAccount(userId: string): Promise<string | null> {
    return (await this.resolveUser([userId]))?.id ?? null;
  }

  /** The live account a store user id refers to (following merges), or null. */
  private async resolveUser(candidates: string[], repos: Repos = this.repos, includeDeleted = false): Promise<UserRecord | null> {
    for (const id of candidates) {
      let user = await repos.users.get(id);
      for (let hops = 0; user && user.mergedInto && hops < 5; hops++) user = await repos.users.get(user.mergedInto);
      if (user && (user.deletedAt === null || (includeDeleted && user.mergedInto === null))) return user;
    }
    return null;
  }

  /**
   * The account that holds the purchase recorded for this store transaction: the one it was
   * credited to, or the account that one was merged into. A deleted account still counts until
   * its rows are purged; null when no purchase is recorded or its account is gone.
   */
  private async purchaseHolder(repos: Repos, transactionId: string): Promise<UserRecord | null> {
    const purchase = await repos.wallet.findPurchase(transactionId);
    return purchase ? this.resolveUser([purchase.userId], repos, true) : null;
  }

  /** The ledger ref that records a refund of this store transaction, whether or not it was ever credited. */
  private static refundRef(transactionId: string): string {
    return `refund:${transactionId}`;
  }

  /** True when a refund for this transaction has been processed (so a late purchase or renewal event must not grant it). */
  private async refunded(tx: Repos, userId: string, transactionId: string): Promise<boolean> {
    const ref = WalletService.refundRef(transactionId);
    return (await tx.wallet.listLedger(userId)).some((l) => l.ref === ref);
  }

  /**
   * Record that a transaction was refunded: a zero ledger entry under `refund:<transaction>`.
   * Written even when the refund arrives before the purchase it undoes (deliveries are retried
   * out of order), so that purchase, when it comes, is not granted.
   */
  private async markRefunded(tx: Repos, userId: string, transactionId: string, at: number): Promise<void> {
    if (await this.refunded(tx, userId, transactionId)) return;
    await tx.wallet.apply({ userId, delta: 0, bonus: 0, reason: 'refund', ref: WalletService.refundRef(transactionId), createdAt: at });
  }

  /** The ledger ref that records that a TRANSFER moved this purchase away from the account it is written on. */
  private static transferRef(transactionId: string): string {
    return `transfer:${transactionId}`;
  }

  /**
   * The account a subscription event goes to instead of the one it names, or null to apply it as
   * named. Its purchase is the one on record for its transaction, or else for its original
   * transaction (`originalTransactionId`, the subscription's first purchase). The event goes to
   * the account that holds that purchase now when a TRANSFER moved the purchase, or the
   * subscription's first purchase, away from the account the event names (that account carries
   * `transferRef`), or when the event names no account we know. Otherwise the named account is the
   * store's word: after a TRANSFER that never reached us, for one, the store names the new owner
   * while the purchase is still on the old one. An event read from the store's current record
   * (`fromSync`) is never routed.
   */
  private async routedHolder(repos: Repos, e: StoreEvent, named: UserRecord | null): Promise<UserRecord | null> {
    if (e.fromSync || e.type === 'TRANSFER' || productForStoreId(e.storeProductId)?.kind !== 'subscription') return null;
    const found: PurchaseRecord[] = [];
    for (const id of new Set([e.transactionId, e.originalTransactionId])) {
      const purchase = id ? await repos.wallet.findPurchase(id) : null;
      if (purchase) found.push(purchase);
    }
    if (found.length === 0) return null;
    const holder = await this.resolveUser([found[0].userId], repos);
    if (!holder || holder.id === named?.id) return null;
    if (!named) return holder;
    const refs = new Set((await repos.wallet.listLedger(named.id)).map((l) => l.ref));
    return found.some((p) => refs.has(WalletService.transferRef(p.transactionId))) ? holder : null;
  }

  /** Apply a store notification once. A redelivery answers `duplicate` and changes nothing. */
  async applyStoreEvent(e: StoreEvent): Promise<StoreResult> {
    // A TRANSFER can move the purchase between the look before the lock and the work under it:
    // the event is then started again, so it locks the account it is applied to.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.applyStoreEventOnce(e);
      } catch (err) {
        if (!(err instanceof Rerouted) || attempt >= 3) throw err;
      }
    }
  }

  private async applyStoreEventOnce(e: StoreEvent): Promise<StoreResult> {
    const seen = await this.repos.storeEvents.get(e.eventId);
    if (seen) return { outcome: 'duplicate', userId: seen.userId, duplicate: true };
    const product = productForStoreId(e.storeProductId);
    const resolved = e.type === 'TRANSFER' ? null : await this.resolveUser(e.userIds);
    const routed = await this.routedHolder(this.repos, e, resolved);
    const keys = [resolved?.id ?? '', routed?.id ?? '', ...e.transferredFrom, ...e.transferredTo].filter(Boolean);
    if (product?.kind === 'diamonds' && e.transactionId) {
      // One store transaction is worked on by one event at a time, whichever account each event
      // names, and the account that holds its purchase waits too (a refund debits that account).
      keys.push(`txn:${e.transactionId}`);
      const holder = await this.purchaseHolder(this.repos, e.transactionId);
      if (holder) keys.push(holder.id);
    }
    try {
      return await this.serialise(keys, () =>
        this.repos.transaction(async (tx) => {
          // Resolved again under the lock: the account may have been merged away (or deleted) while this event waited.
          const named = resolved && (await this.resolveUser([resolved.id], tx));
          const holder = await this.routedHolder(tx, e, named);
          if (holder && !keys.includes(holder.id)) throw new Rerouted();
          if (holder) this.log(`[signal] store event ${e.eventId} (${e.type}) names ${named?.id ?? 'no account we know'}; a TRANSFER moved its purchase to ${holder.id}, which it is applied to`);
          const user = holder ?? named;
          const fresh = await tx.storeEvents.record({
            eventId: e.eventId,
            vendor: e.vendor,
            type: e.type,
            userId: user?.id ?? null,
            productId: product?.id ?? e.storeProductId,
            environment: e.environment,
            outcome: 'received',
            raw: e.raw,
            receivedAt: this.now(),
          });
          if (!fresh) return { outcome: 'duplicate' as const, userId: user?.id ?? null, duplicate: true };
          const { outcome, userId } = await this.applyEffects(tx, e, product, user);
          await tx.storeEvents.setOutcome(e.eventId, outcome, userId);
          return { outcome, userId, duplicate: false };
        }),
      );
    } catch (err) {
      // Postgres rolled the event row back with everything else; memory cannot, so forget it here
      // and let the store's retry process the event again. (A rerouted event wrote nothing.)
      if (this.repos.kind === 'memory' && !(err instanceof Rerouted)) await this.repos.storeEvents.delete(e.eventId);
      throw err;
    }
  }

  private async applyEffects(tx: Repos, e: StoreEvent, product: ServerProduct | undefined, user: UserRecord | null): Promise<{ outcome: StoreOutcome; userId: string | null }> {
    const at = this.now();
    if (e.type === 'TEST') return { outcome: 'test', userId: user?.id ?? null };
    // A TRANSFER names its accounts itself, and applies the sandbox rule to the one that receives.
    if (e.type === 'TRANSFER') return this.transfer(tx, e, at);
    // Sandbox purchases cost nothing: only accounts on the tester list get them.
    if (!this.grantable(e, user)) return this.sandboxRefused(e, user);
    if (!(STORE_EVENT_TYPES as readonly string[]).includes(e.type)) return { outcome: 'ignored_type', userId: user?.id ?? null };
    if (!user) {
      // A refunded pack is still taken back from the account that holds it when the event names
      // an account we no longer know (the store moved the purchase to one that was since deleted).
      if (product?.kind === 'diamonds' && e.type === 'CANCELLATION' && e.transactionId) {
        const refund = await this.refundDiamonds(tx, null, product, e.transactionId, e.cancelReason, at);
        if (refund.userId) return refund;
      }
      this.log(`[signal] store event ${e.eventId} (${e.type}) names no account we know; recorded only`);
      return { outcome: 'ignored_unknown_user', userId: null };
    }
    const userId = user.id;
    if (!product) {
      this.log(`[signal] store event ${e.eventId} (${e.type}) is for ${String(e.storeProductId)}, which the catalogue does not sell; recorded only`);
      return { outcome: 'ignored_unknown_product', userId };
    }
    const transactionId = e.transactionId ?? `${e.vendor}:${e.eventId}`;

    if (product.kind === 'diamonds') {
      if (e.type === 'CANCELLATION') return this.refundDiamonds(tx, userId, product, transactionId, e.cancelReason, at);
      if (e.type !== 'NON_RENEWING_PURCHASE' && e.type !== 'INITIAL_PURCHASE') return { outcome: 'recorded', userId };
      // A transaction already on record is never credited again, whichever account holds it: after
      // a Restore the store lists the old account's packs under the new one.
      if (await tx.wallet.findPurchase(transactionId)) return { outcome: 'duplicate', userId };
      if (await this.refunded(tx, userId, transactionId)) {
        // The refund got here first: keep the purchase on record, grant nothing.
        await this.recordPurchase(tx, e, userId, product.id, transactionId, at);
        return { outcome: 'refunded', userId };
      }
      // Credit first, then record the purchase: if the credit fails nothing is written, even in memory.
      const res = await tx.wallet.apply({ userId, delta: product.diamonds, bonus: product.bonus, reason: 'purchase', ref: `${e.store}:${transactionId}`, createdAt: at });
      if (!res) throw new Error('Diamond credit refused');
      const { inserted } = await this.recordPurchase(tx, e, userId, product.id, transactionId, at);
      // Only another process can have recorded this transaction since the check above (this one
      // holds the transaction's lock): roll the credit back and let the retry answer `duplicate`.
      if (!inserted) throw new Error(`Transaction ${transactionId} was recorded by another process meanwhile`);
      this.analytics.capture(userId, 'purchase_credited', { productId: product.id, diamonds: product.diamonds + product.bonus, store: e.store, environment: e.environment });
      return { outcome: 'credited', userId };
    }

    if (product.kind === 'cosmetic') {
      // Cosmetics are sold for diamonds only; a store purchase of one is not a product we sell.
      return { outcome: 'ignored_unknown_product', userId };
    }

    // Subscriptions.
    const ents = await tx.wallet.getEntitlements(userId);
    const current = ents.find((x) => x.entitlement === product.entitlement) ?? null;
    switch (e.type) {
      case 'INITIAL_PURCHASE':
      case 'RENEWAL':
      case 'UNCANCELLATION':
      case 'SUBSCRIPTION_EXTENDED': {
        if (e.expiresAt !== null && Math.min(e.eventAt ?? at, at) + MAX_STORE_EXPIRY_MS < e.expiresAt) {
          this.log(`[signal] store event ${e.eventId} (${e.type}) expires ${new Date(e.expiresAt).toISOString()}, more than 400 days ahead; recorded as invalid, nothing granted`);
          return { outcome: 'ignored_invalid', userId };
        }
        const until = e.expiresAt ?? (e.purchasedAt ?? at) + PERIOD_MS[product.period];
        // The period end is kept only under the store's own transaction id, which a refund names.
        if (e.type === 'INITIAL_PURCHASE' || e.type === 'RENEWAL') await this.recordPurchase(tx, e, userId, product.id, transactionId, at, e.transactionId ? until : null);
        // Events can arrive out of order: a period refunded before its purchase or renewal event
        // got here is never granted, and a subscription a later event extended is never shortened.
        if (await this.refunded(tx, userId, transactionId)) return { outcome: 'refunded', userId };
        if (current && current.expiresAt !== null && current.expiresAt >= until) return { outcome: 'ignored_stale', userId };
        await tx.wallet.setEntitlement({ userId, entitlement: product.entitlement, expiresAt: until, source: STORE_SOURCE, updatedAt: at });
        if (e.type === 'INITIAL_PURCHASE' || e.type === 'RENEWAL') {
          this.analytics.capture(userId, 'purchase_credited', { productId: product.id, entitlement: product.entitlement, store: e.store, environment: e.environment });
        }
        return { outcome: current && isLive(current, at) ? 'extended' : 'entitled', userId };
      }
      case 'CANCELLATION': {
        // Auto-renew off: access continues to the end of the period. A refund ends the refunded
        // period now, and is remembered so that the period's own event cannot grant it later.
        if (e.cancelReason !== 'CUSTOMER_SUPPORT') return { outcome: 'recorded', userId };
        await this.markRefunded(tx, userId, transactionId, at);
        // Only time the store sold is taken back: a row that support wrote under the plan's own
        // name (before support grants had their own row) stays as it is.
        if (!current || current.source !== STORE_SOURCE) return { outcome: 'refunded', userId };
        // A refund names one transaction and takes back that transaction's time only. Another
        // period of the plan that was paid for and not refunded still stands: the running period
        // when last month's charge is refunded, or the rest of this month when the renewal the
        // store charged a day early is refunded. A refund that names no transaction ends the plan.
        const stands = e.transactionId ? await this.paidUntil(tx, userId, product.entitlement, transactionId) : 0;
        const end = Math.max(Math.min(e.expiresAt ?? at, at), stands);
        if (current.expiresAt === null || current.expiresAt > end) await tx.wallet.setEntitlement({ ...current, expiresAt: end, updatedAt: at });
        return { outcome: 'refunded', userId };
      }
      case 'EXPIRATION': {
        if (!current) return { outcome: 'recorded', userId };
        const end = e.expiresAt ?? at;
        // A renewal processed earlier already carried the entitlement past this expiry.
        if (current.expiresAt !== null && current.expiresAt > end) return { outcome: 'ignored_stale', userId };
        await tx.wallet.setEntitlement({ ...current, expiresAt: Math.min(end, at), updatedAt: at });
        return { outcome: 'expired', userId };
      }
      // BILLING_ISSUE (the store retries; a grace period arrives as a later event), PRODUCT_CHANGE
      // (the new product is granted by the RENEWAL that follows) and SUBSCRIPTION_PAUSED (it
      // takes effect at the period's end, reported by EXPIRATION) change nothing now.
      default:
        return { outcome: 'recorded', userId };
    }
  }

  /** `periodEndsAt`: for a subscription's first purchase or renewal, the end of the period it paid for. */
  private recordPurchase(tx: Repos, e: StoreEvent, userId: string, productId: string, transactionId: string, at: number, periodEndsAt: number | null = null) {
    const currency = e.currency && /^[A-Z]{3}$/.test(e.currency) ? e.currency : null;
    // A purchase has no negative (or non-numeric) price, and one the column cannot hold is not
    // recorded as given either: the credit never fails over the price.
    const price = recordablePrice(e.price);
    return tx.wallet.recordPurchase({
      userId,
      store: e.store,
      transactionId,
      productId,
      price,
      currency: price === null ? null : currency,
      eventId: `${e.vendor}:${e.eventId}`,
      raw: e.raw,
      createdAt: at,
      periodEndsAt,
    });
  }

  /**
   * How far this account's paid periods of a plan reach once `refundedTransaction` is left out:
   * the latest period end among its recorded purchases of that plan that were not refunded
   * themselves; 0 when there is none. Only purchases on record count (the first purchase and each
   * renewal the store reported), so a refund never leaves more than was demonstrably paid for.
   */
  private async paidUntil(tx: Repos, userId: string, entitlement: string, refundedTransaction: string): Promise<number> {
    const refunds = new Set((await tx.wallet.listLedger(userId)).filter((l) => l.reason === 'refund').map((l) => l.ref));
    let until = 0;
    for (const p of await tx.wallet.listPurchases(userId)) {
      if (p.periodEndsAt === null || p.transactionId === refundedTransaction) continue;
      const product = serverProduct(p.productId);
      if (product?.kind !== 'subscription' || product.entitlement !== entitlement) continue;
      if (refunds.has(WalletService.refundRef(p.transactionId))) continue;
      until = Math.max(until, p.periodEndsAt);
    }
    return until;
  }

  /**
   * A refunded diamond pack: take back everything it credited, from the account that holds the
   * purchase. That is not always the account the refund names: after a Restore on another account
   * the store reports the purchase (and its refund) under the new app user id, while the diamonds
   * stayed where they were credited. Bonus diamonds come back first as far as they go; the rest
   * comes off purchased diamonds, which may go below zero when the pack was already spent. A
   * negative balance blocks every spend until a purchase covers it, so a buy, spend, refund cycle
   * never ends with free looks. A refund that arrives before the purchase is remembered on the
   * account it names, so the purchase is not credited when it comes. `namedUserId` is null when
   * the event names no account we know: the result then has a user only if a holder was debited.
   */
  private async refundDiamonds(
    tx: Repos,
    namedUserId: string | null,
    product: Extract<ServerProduct, { kind: 'diamonds' }>,
    transactionId: string,
    cancelReason: string | null,
    at: number,
  ): Promise<{ outcome: StoreOutcome; userId: string | null }> {
    if (cancelReason !== 'CUSTOMER_SUPPORT') return { outcome: 'recorded', userId: namedUserId };
    const purchase = await tx.wallet.findPurchase(transactionId);
    if (!purchase) {
      if (!namedUserId) return { outcome: 'ignored_unknown_user', userId: null };
      if (await this.refunded(tx, namedUserId, transactionId)) return { outcome: 'duplicate', userId: namedUserId };
      await this.markRefunded(tx, namedUserId, transactionId, at);
      return { outcome: 'refunded', userId: namedUserId };
    }
    const holder = await this.resolveUser([purchase.userId], tx, true);
    // The account that was credited has been purged: its wallet went with it, so nothing is left to take back.
    if (!holder) return { outcome: 'recorded', userId: namedUserId };
    const userId = holder.id;
    if (await this.refunded(tx, userId, transactionId)) return { outcome: 'duplicate', userId };
    const w = await tx.wallet.get(userId);
    const bonus = Math.min(Math.max(0, w.bonusDiamonds), product.bonus);
    const delta = -(product.diamonds + product.bonus - bonus);
    const res = await tx.wallet.apply({ userId, delta, bonus: -bonus, reason: 'refund', ref: WalletService.refundRef(transactionId), createdAt: at }, { allowNegative: true });
    if (!res) throw new Error('Diamond refund refused');
    if (userId !== namedUserId) this.log(`[signal] refund ${transactionId} names ${namedUserId ?? 'no account we know'}; the purchase is held by ${userId}, which was debited`);
    if (res.wallet.diamonds < 0) this.log(`[signal] refund ${transactionId} left ${userId} at ${res.wallet.diamonds} diamonds; spends are blocked until it is covered`);
    return { outcome: 'refunded', userId };
  }

  /**
   * The store moved purchases between app user ids (a Restore signed into another account).
   * Store-granted plans bought on the store the event came from move to the first known
   * recipient, the later expiry winning; a plan the old account bought on another store stays (a
   * Restore on an iPad moves App Store receipts, not a Google Play subscription), and a plan with
   * no purchase on record, or an event that names no store, moves as before. Diamonds already
   * credited stay where they were spent or credited. A deleted account's subscriptions move too
   * (until its rows are purged), so a player who deleted an account with a live subscription gets
   * it back with Restore on a new one; after the purge, reconciliation (reconcile.ts) reads the
   * subscription from the store instead.
   */
  private async transfer(tx: Repos, e: StoreEvent, at: number): Promise<{ outcome: StoreOutcome; userId: string | null }> {
    const to = await this.resolveUser(e.transferredTo, tx);
    if (!this.grantable(e, to)) return this.sandboxRefused(e, to);
    if (!to) return { outcome: 'ignored_unknown_user', userId: null };
    const theirs = new Map((await tx.wallet.getEntitlements(to.id)).map((x) => [x.entitlement, x]));
    const eventStore = e.store && e.store !== 'unknown' ? e.store : null;
    let moved = 0;
    for (const fromId of e.transferredFrom) {
      const from = await this.resolveUser([fromId], tx, true);
      if (!from || from.id === to.id) continue;
      const purchases = await tx.wallet.listPurchases(from.id);
      // The store each plan was last bought or renewed on (purchases are listed oldest first).
      const boughtOn = new Map<string, string>();
      for (const p of purchases) {
        const product = serverProduct(p.productId);
        if (product?.kind === 'subscription') boughtOn.set(product.entitlement, p.store);
      }
      const plans = new Set<string>();
      for (const ent of await tx.wallet.getEntitlements(from.id)) {
        if (ent.source !== STORE_SOURCE) continue;
        const store = boughtOn.get(ent.entitlement);
        if (eventStore && store && store !== eventStore) continue;
        const mine = theirs.get(ent.entitlement);
        const expiresAt = !mine ? ent.expiresAt : mine.expiresAt === null || ent.expiresAt === null ? null : Math.max(mine.expiresAt, ent.expiresAt);
        const next: EntitlementRecord = { userId: to.id, entitlement: ent.entitlement, expiresAt, source: STORE_SOURCE, updatedAt: at };
        await tx.wallet.setEntitlement(next);
        theirs.set(ent.entitlement, next);
        await tx.wallet.deleteEntitlement(from.id, ent.entitlement);
        plans.add(ent.entitlement);
        moved++;
      }
      await this.movePlanPurchases(tx, from.id, to.id, purchases, plans, eventStore, at);
    }
    return { outcome: moved ? 'transferred' : 'recorded', userId: to.id };
  }

  /**
   * The purchases behind the plans a TRANSFER moved (those bought on the event's store, when it
   * names one) go with them: the new account holds them, so the refund of a period it now holds
   * ends its plan and only the periods paid for stand (`paidUntil`). The old account keeps a zero
   * ledger entry per purchase (`transferRef`), so a late event that still names it is applied to
   * the new holder (`routedHolder`), and a refund already taken on a moved purchase is noted on
   * the new account too.
   */
  private async movePlanPurchases(tx: Repos, fromId: string, toId: string, purchases: PurchaseRecord[], plans: ReadonlySet<string>, eventStore: string | null, at: number): Promise<void> {
    const rows = purchases.filter((p) => {
      const product = serverProduct(p.productId);
      return product?.kind === 'subscription' && plans.has(product.entitlement) && (!eventStore || p.store === eventStore);
    });
    if (rows.length === 0) return;
    await tx.wallet.movePurchases(fromId, toId, rows.map((p) => p.transactionId));
    const fromRefs = new Set((await tx.wallet.listLedger(fromId)).map((l) => l.ref));
    const toRefs = new Set((await tx.wallet.listLedger(toId)).map((l) => l.ref));
    for (const p of rows) {
      const moved = WalletService.transferRef(p.transactionId);
      if (!fromRefs.has(moved)) await tx.wallet.apply({ userId: fromId, delta: 0, bonus: 0, reason: 'transfer', ref: moved, createdAt: at });
      const refund = WalletService.refundRef(p.transactionId);
      if (fromRefs.has(refund) && !toRefs.has(refund)) await tx.wallet.apply({ userId: toId, delta: 0, bonus: 0, reason: 'refund', ref: refund, createdAt: at });
    }
  }
}

/** Thrown under the lock when a TRANSFER moved the event's purchase to an account the event did not lock: the event starts again. */
class Rerouted extends Error {
  constructor() {
    super('The purchase moved to another account; the event starts again');
    this.name = 'Rerouted';
  }
}
