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
  spent?: number;
  entitlement?: string;
  wallet: { diamonds: number; bonusDiamonds: number };
  cosmetics?: string[];
}

export const WALLET_REQUEST_TIMEOUT_MS = 15_000;

export const walletApi = {
  /**
   * Spend diamonds on a table look. A repeat is safe: an owned look answers `409 owned`.
   * Errors: `insufficient` (409), `owned` (409), `not_for_sale` (400).
   */
  spend: (ctx: WalletContext, productId: string) =>
    authorisedJson<SpendReply>(ctx.auth, {
      fetch: ctx.fetch ?? globalFetch,
      base: ctx.base,
      method: 'POST',
      path: '/api/wallet/spend',
      body: { productId },
      timeoutMs: WALLET_REQUEST_TIMEOUT_MS,
      scope: 'auth',
      label: 'game server',
    }),
};
