/**
 * The store's other server calls (docs/API.md): `POST /api/wallet/sync`, which makes the server
 * read this account's purchases from the store after Restore, and the player's analytics choice,
 * sent with `PATCH /api/me` so the server's own analytics skip players who said no.
 */
import { authorisedJson, globalFetch, type Authoriser, type FetchLike } from '../api/http';

export interface StoreServerContext {
  base: string;
  auth: Authoriser;
  fetch?: FetchLike;
}

export interface SyncReply {
  /** False when the server has no store key (nothing was read from the store). */
  synced: boolean;
  applied: number;
  /** Purchases the server read but could not apply this time (absent on older servers). */
  failed?: number;
  wallet: { diamonds: number; bonusDiamonds: number };
  cosmetics?: string[];
}

export const STORE_SYNC_TIMEOUT_MS = 20_000;

export const storeServer = {
  /** Ask the server to apply any purchase the store webhook missed. */
  sync: (ctx: StoreServerContext) =>
    authorisedJson<SyncReply>(ctx.auth, { fetch: ctx.fetch ?? globalFetch, base: ctx.base, method: 'POST', path: '/api/wallet/sync', body: {}, timeoutMs: STORE_SYNC_TIMEOUT_MS, scope: 'auth', label: 'game server' }),

  /**
   * Tell the server whether this player allows product analytics. The consent screen calls this
   * whenever the toggle changes (and once after sign-in); the server stores it per account.
   */
  sendAnalyticsConsent: (ctx: StoreServerContext, consent: boolean) =>
    authorisedJson<unknown>(ctx.auth, { fetch: ctx.fetch ?? globalFetch, base: ctx.base, method: 'PATCH', path: '/api/me', body: { analyticsConsent: consent }, timeoutMs: 10_000, scope: 'auth', label: 'game server' }),
};
