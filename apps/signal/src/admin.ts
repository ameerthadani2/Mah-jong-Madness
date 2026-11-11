/**
 * Store and support routes, registered into the API's router by `storeRoutes(r, deps)` (api.ts
 * passes its own route factory, so these share its body parsing, error mapping and rate limits):
 *
 * - `POST /api/wallet/sync` (bearer session): after Restore, read the player's purchases from the
 *   store (reconcile.ts) and apply anything the webhook missed, then answer the wallet like
 *   `POST /api/wallet/spend` does, with `applied` (purchases that were missing) and `failed`
 *   (purchases that could not be applied this time; the rest still were). Without
 *   REVENUECAT_SECRET_KEY it only answers the wallet (`synced: false`). `502 store_unreachable`
 *   when the store itself cannot be read. Limited to a few calls a minute per account.
 * - `POST /api/admin/grant` (`Authorization: Bearer <ADMIN_TOKEN>`, compared in constant time):
 *   support grants diamonds (a ledger entry with reason `support`) or an entitlement (source
 *   `support`, also noted on the ledger) to one account, with a required note. Without
 *   ADMIN_TOKEN the route answers 503.
 *
 * Errors are WalletErrors, which api.ts already turns into `{ error, message }` with their status.
 */
import type { IncomingMessage } from 'node:http';
import { cleanText } from '@mjm/net';
import { COSMETIC_ENTITLEMENTS, tierOfEntitlement } from './catalog';
import { BucketTable } from './limits';
import { Reconciler, revenueCatClientFromEnv } from './reconcile';
import type { Repos } from './repos/types';
import { webhookAuthorised } from './revenuecat';
import { WalletError, type WalletService } from './wallet';

type Env = Record<string, string | undefined>;

/** What a store route reads from the API's request context (a subset of api.ts's Ctx). */
export interface StoreRouteCtx {
  body: Record<string, unknown>;
  req: IncomingMessage;
  caller(): Promise<{ userId: string }>;
}

export type RouteFactory<R> = (method: string, path: string, handler: (ctx: StoreRouteCtx) => unknown) => R;

export interface StoreRouteDeps {
  repos: Repos;
  wallet: WalletService;
  now?: () => number;
  /** Default: a Reconciler over a RevenueCat client from REVENUECAT_SECRET_KEY (none without it). */
  reconciler?: Reconciler;
  /** Default: ADMIN_TOKEN from the environment; absent or blank turns the admin routes off. */
  adminToken?: string | null;
  /** Where the defaults are read from (default `process.env`). */
  env?: Env;
}

/** Constant-time check of `Authorization: Bearer <ADMIN_TOKEN>`; false whenever no token is configured. */
export function adminAuthorised(header: string | string[] | undefined, token: string | null | undefined): boolean {
  return !!token && webhookAuthorised(header, token);
}

/** Store syncs one account may ask for per minute. */
export const SYNC_PER_MINUTE = 4;
/** Longest support grant of a subscription, in days. */
export const MAX_GRANT_DAYS = 400;
/** Largest single support grant of diamonds. */
export const MAX_GRANT_DIAMONDS = 100_000;

const wholeIn = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export function storeRoutes<R>(r: RouteFactory<R>, deps: StoreRouteDeps): R[] {
  const { repos, wallet } = deps;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const reconciler = deps.reconciler ?? new Reconciler({ repos, wallet, client: revenueCatClientFromEnv(env), now });
  const adminToken = deps.adminToken !== undefined ? deps.adminToken : (env.ADMIN_TOKEN ?? '').trim() || null;
  const syncs = new BucketTable<string>(SYNC_PER_MINUTE, SYNC_PER_MINUTE / 60, { now });

  const walletReply = async (userId: string) => {
    const s = await wallet.summary(userId);
    return { wallet: s.wallet, cosmetics: s.cosmetics, coachTier: s.coachTier };
  };

  return [
    r('POST', '/api/wallet/sync', async (ctx) => {
      const me = await ctx.caller();
      if (!syncs.take(me.userId)) throw new WalletError('rate_limited', 'Too many store syncs; try again in a minute');
      let synced = false;
      let applied = 0;
      let failed = 0;
      if (reconciler.enabled) {
        try {
          const res = await reconciler.syncUser(me.userId);
          synced = res.checked;
          applied = res.applied;
          failed = res.failed;
        } catch (e) {
          throw new WalletError('store_unreachable', `The store could not be reached: ${(e as Error).message}`);
        }
      }
      return { synced, applied, failed, ...(await walletReply(me.userId)) };
    }),

    r('POST', '/api/admin/grant', async (ctx) => {
      if (!adminToken) throw new WalletError('unavailable', 'Support grants are not configured on this server');
      if (!adminAuthorised(ctx.req.headers.authorization, adminToken)) throw new WalletError('unauthorised', 'Bad admin token');
      const { body } = ctx;
      const userId = typeof body.userId === 'string' ? body.userId : '';
      const note = cleanText(body.note, 200);
      if (!note) throw new WalletError('invalid', 'A note saying why is required');
      const user = userId ? await repos.users.get(userId) : null;
      if (!user || user.deletedAt !== null) throw new WalletError('not_found', 'No such account');
      const at = now();
      const granted: Record<string, unknown> = {};

      if (body.diamonds !== undefined || body.bonus !== undefined) {
        const diamonds = body.diamonds ?? 0;
        const bonus = body.bonus ?? 0;
        if (!wholeIn(diamonds, 0, MAX_GRANT_DIAMONDS) || !wholeIn(bonus, 0, MAX_GRANT_DIAMONDS) || diamonds + bonus === 0) {
          throw new WalletError('invalid', `diamonds and bonus must be whole numbers from 0 to ${MAX_GRANT_DIAMONDS}, not both 0`);
        }
        await wallet.credit(user.id, diamonds, 'support', `support:${note}`, bonus);
        granted.diamonds = diamonds;
        granted.bonus = bonus;
      }

      if (body.entitlement !== undefined) {
        const entitlement = typeof body.entitlement === 'string' ? body.entitlement : '';
        const tier = tierOfEntitlement(entitlement);
        if (!tier && !COSMETIC_ENTITLEMENTS.has(entitlement)) throw new WalletError('invalid', 'Unknown entitlement');
        let expiresAt: number | null = null;
        if (tier) {
          if (!wholeIn(body.days, 1, MAX_GRANT_DAYS)) throw new WalletError('invalid', `A plan needs days from 1 to ${MAX_GRANT_DAYS}`);
          expiresAt = at + body.days * 86_400_000;
        }
        await wallet.grantSupport(user.id, entitlement, expiresAt, note);
        granted.entitlement = entitlement;
        granted.expiresAt = expiresAt === null ? null : new Date(expiresAt).toISOString();
      }

      if (Object.keys(granted).length === 0) throw new WalletError('invalid', 'Nothing to grant: give diamonds, bonus or an entitlement');
      return { ok: true, userId: user.id, granted, ...(await walletReply(user.id)) };
    }),
  ];
}
