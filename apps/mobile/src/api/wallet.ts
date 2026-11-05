/**
 * Client for the wallet routes (docs/API.md, "Wallet"). Balances themselves are read with
 * `GET /api/me` (AuthClient.getMe); this module only spends diamonds, which the server
 * debits (bonus diamonds first) and turns into the cosmetic entitlement in one step.
 */
import { authorisedJson, globalFetch, type Authoriser, type FetchLike } from './http';

export interface WalletContext {
  base: string;
  auth: Authoriser;
  fetch?: FetchLike;
}

export interface SpendReply {
  wallet: { diamonds: number; bonusDiamonds: number };
  entitlements?: Array<{ entitlement: string; expiresAt: string | null }>;
  cosmetics?: string[];
}

export const WALLET_REQUEST_TIMEOUT_MS = 15_000;

export const walletApi = {
  /**
   * Spend diamonds on a catalogue item. `requestId` makes a retry safe: the server applies a
   * given id at most once. Errors: `insufficient_diamonds` (409), `already_owned` (409),
   * `not_for_diamonds` (400).
   */
  spend: (ctx: WalletContext, productId: string, requestId: string) =>
    authorisedJson<SpendReply>(ctx.auth, {
      fetch: ctx.fetch ?? globalFetch,
      base: ctx.base,
      method: 'POST',
      path: '/api/wallet/spend',
      body: { productId, requestId },
      timeoutMs: WALLET_REQUEST_TIMEOUT_MS,
      scope: 'auth',
      label: 'game server',
    }),
};
