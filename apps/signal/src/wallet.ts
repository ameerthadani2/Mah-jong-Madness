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
 *   credited twice even under two event ids.
 *
 * Diamonds and entitlements have no monetary value and cannot be redeemed or transferred between
 * players. Work for one user is serialised in this process (one game server machine), and on
 * Postgres every operation is one transaction.
 */
import { COSMETIC_ENTITLEMENTS, PERIOD_MS, productForStoreId, serverProduct, TIER_RANK, tierOfEntitlements, type CoachTier, type ServerProduct } from './catalog';
import { NO_ANALYTICS, withConsent, type Analytics } from './observability';
import type { EntitlementRecord, Repos, UserRecord, WalletRecord } from './repos/types';

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
  /** Subscription end as the store reports it (ms), when given. */
  expiresAt: number | null;
  purchasedAt: number | null;
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
  | 'ignored_type';

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

  /** True when this event may grant: a production event, or a sandbox event for an account on the tester list. */
  private grantable(e: StoreEvent, user: UserRecord | null): boolean {
    if (!isSandbox(e)) return true;
    const ids = [user?.id, ...e.userIds, ...e.transferredTo].filter((x): x is string => !!x);
    return ids.some((id) => this.testers.has(id.toLowerCase()));
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
    return {
      wallet: { diamonds: w.diamonds, bonusDiamonds: w.bonusDiamonds },
      entitlements: ents.map((e) => ({ entitlement: e.entitlement, expiresAt: e.expiresAt, active: isLive(e, at) })),
      cosmetics: live.filter((e) => COSMETIC_ENTITLEMENTS.has(e.entitlement)).map((e) => e.entitlement).sort(),
      coachTier: tierOfEntitlements(live.map((e) => e.entitlement)),
    };
  }

  /** The user's tier now: the best subscription plan still live. */
  async tierOf(userId: string): Promise<CoachTier> {
    const at = this.now();
    return tierOfEntitlements((await this.repos.wallet.getEntitlements(userId)).filter((e) => isLive(e, at)).map((e) => e.entitlement));
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
   * never shortening one the user already has, and noted on the ledger as a zero entry.
   */
  async grantSupport(userId: string, entitlement: string, expiresAt: number | null, note: string): Promise<void> {
    await this.serialise([userId], () =>
      this.repos.transaction(async (tx) => {
        const at = this.now();
        const current = (await tx.wallet.getEntitlements(userId)).find((e) => e.entitlement === entitlement);
        const keeps = current && (current.expiresAt === null || (expiresAt !== null && current.expiresAt >= expiresAt));
        if (!keeps) await tx.wallet.setEntitlement({ userId, entitlement, expiresAt, source: SUPPORT_SOURCE, updatedAt: at });
        await tx.wallet.apply({ userId, delta: 0, bonus: 0, reason: 'support', ref: `support:${entitlement}:${note}`.slice(0, 255), createdAt: at });
      }),
    );
  }

  /** Buy a cosmetic with diamonds: debit and permanent entitlement together, or neither. */
  async spend(userId: string, productId: unknown): Promise<{ wallet: WalletRecord; entitlement: string; spent: number }> {
    const product = serverProduct(productId);
    if (!product || product.kind !== 'cosmetic') throw new WalletError('not_for_sale', 'That item is not sold for diamonds');
    return this.serialise([userId], () =>
      this.repos.transaction(async (tx) => {
        const owned = (await tx.wallet.getEntitlements(userId)).some((e) => e.entitlement === product.entitlement && isLive(e, this.now()));
        if (owned) throw new WalletError('owned', 'You already own that item');
        const w = await tx.wallet.get(userId);
        const price = product.diamondPrice;
        // A refund can leave purchased diamonds below zero: nothing is spent until they are back above.
        if (w.diamonds < 0 || w.diamonds + w.bonusDiamonds < price) throw new WalletError('insufficient', 'Not enough diamonds');
        const fromBonus = Math.min(w.bonusDiamonds, price);
        const at = this.now();
        const res = await tx.wallet.apply({ userId, delta: -(price - fromBonus), bonus: -fromBonus, reason: 'spend', ref: product.id, createdAt: at });
        if (!res) throw new WalletError('insufficient', 'Not enough diamonds');
        await tx.wallet.setEntitlement({ userId, entitlement: product.entitlement, expiresAt: null, source: SPEND_SOURCE, updatedAt: at });
        return { wallet: res.wallet, entitlement: product.entitlement, spent: price };
      }),
    );
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

  /** Apply a store notification once. A redelivery answers `duplicate` and changes nothing. */
  async applyStoreEvent(e: StoreEvent): Promise<StoreResult> {
    const seen = await this.repos.storeEvents.get(e.eventId);
    if (seen) return { outcome: 'duplicate', userId: seen.userId, duplicate: true };
    const product = productForStoreId(e.storeProductId);
    const resolved = e.type === 'TRANSFER' ? null : await this.resolveUser(e.userIds);
    const keys = [resolved?.id ?? '', ...e.transferredFrom, ...e.transferredTo].filter(Boolean);
    try {
      return await this.serialise(keys, () =>
        this.repos.transaction(async (tx) => {
          // Resolved again under the lock: the account may have been merged away (or deleted) while this event waited.
          const user = resolved && (await this.resolveUser([resolved.id], tx));
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
      // and let the store's retry process the event again.
      if (this.repos.kind === 'memory') await this.repos.storeEvents.delete(e.eventId);
      throw err;
    }
  }

  private async applyEffects(tx: Repos, e: StoreEvent, product: ServerProduct | undefined, user: UserRecord | null): Promise<{ outcome: StoreOutcome; userId: string | null }> {
    const at = this.now();
    if (e.type === 'TEST') return { outcome: 'test', userId: user?.id ?? null };
    // Sandbox purchases cost nothing: only accounts on the tester list get them.
    if (!this.grantable(e, user)) {
      this.log(`[signal] sandbox store event ${e.eventId} (${e.type}) for an account not on TESTER_USER_IDS; recorded only`);
      return { outcome: 'ignored_sandbox', userId: user?.id ?? null };
    }
    if (e.type === 'TRANSFER') return this.transfer(tx, e, at);
    if (!(STORE_EVENT_TYPES as readonly string[]).includes(e.type)) return { outcome: 'ignored_type', userId: user?.id ?? null };
    if (!user) {
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
      if (e.type === 'CANCELLATION') return { outcome: await this.refundDiamonds(tx, userId, product, transactionId, e.cancelReason, at), userId };
      if (e.type !== 'NON_RENEWING_PURCHASE' && e.type !== 'INITIAL_PURCHASE') return { outcome: 'recorded', userId };
      if ((await tx.wallet.listPurchases(userId)).some((p) => p.transactionId === transactionId)) return { outcome: 'duplicate', userId };
      if (await this.refunded(tx, userId, transactionId)) {
        // The refund got here first: keep the purchase on record, grant nothing.
        await this.recordPurchase(tx, e, userId, product.id, transactionId, at);
        return { outcome: 'refunded', userId };
      }
      // Credit first, then record the purchase: if the credit fails nothing is written, even in memory.
      const res = await tx.wallet.apply({ userId, delta: product.diamonds, bonus: product.bonus, reason: 'purchase', ref: `${e.store}:${transactionId}`, createdAt: at });
      if (!res) throw new Error('Diamond credit refused');
      const { inserted } = await this.recordPurchase(tx, e, userId, product.id, transactionId, at);
      // Another delivery recorded this transaction meanwhile: roll back (Postgres) and let the retry see it.
      if (!inserted) throw new Error(`Transaction ${transactionId} was recorded concurrently`);
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
        const until = e.expiresAt ?? (e.purchasedAt ?? at) + PERIOD_MS[product.period];
        if (e.type === 'INITIAL_PURCHASE' || e.type === 'RENEWAL') await this.recordPurchase(tx, e, userId, product.id, transactionId, at);
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
        // Auto-renew off: access continues to the end of the period. A refund ends it now, and is
        // remembered so that the refunded period's own event cannot grant it later.
        if (e.cancelReason !== 'CUSTOMER_SUPPORT') return { outcome: 'recorded', userId };
        await this.markRefunded(tx, userId, transactionId, at);
        if (!current) return { outcome: 'refunded', userId };
        const end = Math.min(e.expiresAt ?? at, at);
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

  private recordPurchase(tx: Repos, e: StoreEvent, userId: string, productId: string, transactionId: string, at: number) {
    const currency = e.currency && /^[A-Z]{3}$/.test(e.currency) ? e.currency : null;
    return tx.wallet.recordPurchase({
      userId,
      store: e.store,
      transactionId,
      productId,
      price: e.price,
      currency: e.price === null ? null : currency,
      eventId: `${e.vendor}:${e.eventId}`,
      raw: e.raw,
      createdAt: at,
    });
  }

  /**
   * A refunded diamond pack: take back everything it credited. Bonus diamonds come back first as
   * far as they go; the rest comes off purchased diamonds, which may go below zero when the pack
   * was already spent. A negative balance blocks every spend until a purchase covers it, so a
   * buy, spend, refund cycle never ends with free looks. A refund that arrives before the purchase
   * is remembered, so the purchase is not credited when it comes.
   */
  private async refundDiamonds(tx: Repos, userId: string, product: Extract<ServerProduct, { kind: 'diamonds' }>, transactionId: string, cancelReason: string | null, at: number): Promise<StoreOutcome> {
    if (cancelReason !== 'CUSTOMER_SUPPORT') return 'recorded';
    if (await this.refunded(tx, userId, transactionId)) return 'duplicate';
    const credited = (await tx.wallet.listPurchases(userId)).some((p) => p.transactionId === transactionId);
    if (!credited) {
      await this.markRefunded(tx, userId, transactionId, at);
      return 'refunded';
    }
    const w = await tx.wallet.get(userId);
    const bonus = Math.min(Math.max(0, w.bonusDiamonds), product.bonus);
    const delta = -(product.diamonds + product.bonus - bonus);
    const res = await tx.wallet.apply({ userId, delta, bonus: -bonus, reason: 'refund', ref: WalletService.refundRef(transactionId), createdAt: at }, { allowNegative: true });
    if (!res) throw new Error('Diamond refund refused');
    if (res.wallet.diamonds < 0) this.log(`[signal] refund ${transactionId} left ${userId} at ${res.wallet.diamonds} diamonds; spends are blocked until it is covered`);
    return 'refunded';
  }

  /**
   * The store moved purchases between app user ids (a Restore signed into another account).
   * Store-granted entitlements move to the first known recipient, the later expiry winning;
   * diamonds already credited stay where they were spent or credited. A deleted account's
   * subscriptions move too (until its rows are purged), so a player who deleted an account with
   * a live subscription gets it back with Restore on a new one; after the purge, reconciliation
   * (reconcile.ts) reads the subscription from the store instead.
   */
  private async transfer(tx: Repos, e: StoreEvent, at: number): Promise<{ outcome: StoreOutcome; userId: string | null }> {
    const to = await this.resolveUser(e.transferredTo, tx);
    if (!to) return { outcome: 'ignored_unknown_user', userId: null };
    const theirs = new Map((await tx.wallet.getEntitlements(to.id)).map((x) => [x.entitlement, x]));
    let moved = 0;
    for (const fromId of e.transferredFrom) {
      const from = await this.resolveUser([fromId], tx, true);
      if (!from || from.id === to.id) continue;
      for (const ent of await tx.wallet.getEntitlements(from.id)) {
        if (ent.source !== STORE_SOURCE) continue;
        const mine = theirs.get(ent.entitlement);
        const expiresAt = !mine ? ent.expiresAt : mine.expiresAt === null || ent.expiresAt === null ? null : Math.max(mine.expiresAt, ent.expiresAt);
        const next: EntitlementRecord = { userId: to.id, entitlement: ent.entitlement, expiresAt, source: STORE_SOURCE, updatedAt: at };
        await tx.wallet.setEntitlement(next);
        theirs.set(ent.entitlement, next);
        await tx.wallet.deleteEntitlement(from.id, ent.entitlement);
        moved++;
      }
    }
    return { outcome: moved ? 'transferred' : 'recorded', userId: to.id };
  }
}
