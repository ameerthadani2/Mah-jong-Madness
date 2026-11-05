/**
 * Purchase, spend and restore flows. Pure: the account, the server and timers are injected,
 * so every path is unit-tested. The rule throughout: nothing is granted on the device. A
 * purchase is credited by the server (store webhook) and only shows once `GET /api/me`
 * says so; a diamond spend is debited and granted by the server.
 */
import type { Product } from './catalog';
import type { StoreProvider } from './providers';
import { mirrorMe, showsPurchase, type MeWallet, type Wallet } from './wallet';

export interface WalletDeps {
  /** A usable session; resolves to the server user id (bootstraps a guest the first time). */
  ensureUser(): Promise<string>;
  fetchMe(): Promise<MeWallet>;
  /** POST /api/wallet/spend. */
  spend(productId: string, requestId: string): Promise<unknown>;
  requestId(): string;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** How long to wait for the store webhook to reach the server, as successive pauses (about 8 s). */
export const CREDIT_POLL_MS = [500, 1000, 1500, 2000, 3000];

export type BuyResult =
  | { status: 'credited'; wallet: Wallet }
  /** The store took the money but the server has not seen it yet; it arrives on a later sync. */
  | { status: 'pending'; wallet: Wallet }
  | { status: 'cancelled'; wallet: Wallet }
  | { status: 'unavailable'; wallet: Wallet }
  | { status: 'failed'; wallet: Wallet; error: unknown };

export async function syncWallet(wallet: Wallet, deps: Pick<WalletDeps, 'fetchMe' | 'now'>): Promise<Wallet> {
  return mirrorMe(wallet, await deps.fetchMe(), deps.now());
}

/** Poll `/api/me` until the product shows, or give up (the purchase then stays pending). */
export async function waitForCredit(before: Wallet, productId: string, deps: Pick<WalletDeps, 'fetchMe' | 'now' | 'sleep'>, pauses: number[] = CREDIT_POLL_MS): Promise<{ credited: boolean; wallet: Wallet }> {
  let latest = before;
  for (const ms of pauses) {
    await deps.sleep(ms);
    try {
      latest = await syncWallet(latest, deps);
    } catch {
      continue;
    }
    if (showsPurchase(before, latest, productId)) return { credited: true, wallet: latest };
  }
  return { credited: false, wallet: latest };
}

export async function buyWithMoney(product: Product, wallet: Wallet, store: StoreProvider, deps: WalletDeps): Promise<BuyResult> {
  if (store.kind === 'unavailable') return { status: 'unavailable', wallet };
  let base = wallet;
  try {
    const userId = await deps.ensureUser();
    await store.identify(userId);
    // A fresh baseline, so a credit that lands during the purchase is still recognised.
    base = await syncWallet(wallet, deps).catch(() => wallet);
  } catch (error) {
    return { status: 'failed', wallet, error };
  }
  const outcome = await store.purchase(product);
  if (outcome.status === 'cancelled' || outcome.status === 'unavailable') return { status: outcome.status, wallet: base };
  if (outcome.status === 'failed') return { status: 'failed', wallet: base, error: outcome.error };
  if (outcome.grant) return { status: 'credited', wallet: outcome.grant(base) };
  const { credited, wallet: after } = await waitForCredit(base, product.id, deps);
  return { status: credited ? 'credited' : 'pending', wallet: after };
}

export type SpendResult = { status: 'credited'; wallet: Wallet } | { status: 'need_diamonds'; wallet: Wallet; short: number } | { status: 'failed'; wallet: Wallet; error: unknown };

function errorCode(e: unknown): string | undefined {
  return e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : undefined;
}

/** Spend diamonds on a cosmetic: the server debits and grants; the app then mirrors `/api/me`. */
export async function buyWithDiamonds(product: Product, wallet: Wallet, deps: WalletDeps): Promise<SpendResult> {
  if (!product.diamondPrice) return { status: 'failed', wallet, error: new Error('not_for_diamonds') };
  try {
    await deps.ensureUser();
    await deps.spend(product.id, deps.requestId());
  } catch (error) {
    const code = errorCode(error);
    if (code === 'insufficient_diamonds') {
      const fresh = await syncWallet(wallet, deps).catch(() => wallet);
      return { status: 'need_diamonds', wallet: fresh, short: Math.max(1, product.diamondPrice - fresh.diamonds - fresh.bonusDiamonds) };
    }
    if (code === 'already_owned') return { status: 'credited', wallet: await syncWallet(wallet, deps).catch(() => wallet) };
    return { status: 'failed', wallet, error };
  }
  return { status: 'credited', wallet: await syncWallet(wallet, deps).catch(() => wallet) };
}

/** Restore Purchases: the store re-sends receipts, the server re-grants, the app re-reads `/api/me`. */
export async function restorePurchases(wallet: Wallet, store: StoreProvider, deps: WalletDeps): Promise<{ ok: true; wallet: Wallet } | { ok: false; wallet: Wallet; error: unknown }> {
  try {
    const userId = await deps.ensureUser();
    await store.identify(userId);
    await store.restore();
  } catch (error) {
    return { ok: false, wallet, error };
  }
  let latest = wallet;
  for (const ms of CREDIT_POLL_MS.slice(0, 3)) {
    await deps.sleep(ms);
    latest = await syncWallet(latest, deps).catch(() => latest);
  }
  return { ok: true, wallet: latest };
}
