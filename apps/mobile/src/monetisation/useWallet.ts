/**
 * React wiring for the wallet: keeps `app.wallet` in step with `GET /api/me`, signs the store
 * SDK into the server account, and exposes the Shop's purchase, spend and restore actions.
 * The flows themselves are in ./sync.ts (pure, tested).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomHex } from '@mjm/net';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { httpBase } from '../api/http';
import { walletApi } from '../api/wallet';
import type { Product } from './catalog';
import { buyWithDiamonds, buyWithMoney, restorePurchases, syncWallet, type BuyResult, type SpendResult, type WalletDeps } from './sync';
import { store } from './store';
import type { Wallet } from './wallet';

export function useWallet(options: { loadPrices?: boolean } = {}): {
  wallet: Wallet;
  storeKind: typeof store.kind;
  /** Store price strings by product id (empty until loaded, or when the store has none). */
  prices: Record<string, string>;
  pricesLoaded: boolean;
  /** 'synced', 'offline' (the server could not be reached; the cached copy stays) or 'no_session'. */
  refresh(): Promise<'synced' | 'offline' | 'no_session'>;
  buy(p: Product): Promise<BuyResult>;
  spend(p: Product): Promise<SpendResult>;
  restore(): ReturnType<typeof restorePurchases>;
} {
  const app = useApp();
  const auth = useAuth();
  const walletRef = useRef(app.wallet);
  walletRef.current = app.wallet;
  // app.setWallet changes identity on every wallet change; a ref keeps `refresh` stable for effects.
  const setWalletRef = useRef(app.setWallet);
  setWalletRef.current = app.setWallet;
  const client = auth.client;
  const base = httpBase(app.signalUrl);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [pricesLoaded, setPricesLoaded] = useState(store.kind === 'unavailable');

  const deps = useMemo<WalletDeps>(
    () => ({
      ensureUser: async () => {
        await client.ensureSession();
        const id = client.snapshot().userId;
        if (!id) throw new Error('No account');
        return id;
      },
      fetchMe: () => client.getMe(),
      spend: (productId, requestId) => walletApi.spend({ base, auth: client }, productId, requestId),
      requestId: () => randomHex(16),
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    }),
    [client, base],
  );

  const commit = useCallback(
    (w: Wallet) => {
      walletRef.current = w;
      setWalletRef.current(w);
    },
    [],
  );

  /** Re-read the server wallet when this device already has a session (never bootstraps one). */
  const refresh = useCallback(async (): Promise<'synced' | 'offline' | 'no_session'> => {
    if (!client.snapshot().hasSession) return 'no_session';
    try {
      commit(await syncWallet(walletRef.current, deps));
      return 'synced';
    } catch {
      return 'offline';
    }
  }, [client, deps, commit]);

  // Purchases.logIn(server user id) once the account is known.
  const userId = auth.user?.id;
  useEffect(() => {
    if (userId && store.kind !== 'unavailable') void store.identify(userId).catch(() => undefined);
  }, [userId]);

  const loadPrices = options.loadPrices !== false;
  useEffect(() => {
    let live = true;
    if (!loadPrices || store.kind === 'unavailable') return;
    void store
      .prices()
      .then((p) => live && setPrices(p))
      .catch(() => undefined)
      .finally(() => live && setPricesLoaded(true));
    return () => {
      live = false;
    };
  }, [loadPrices]);

  return {
    wallet: app.wallet,
    storeKind: store.kind,
    prices,
    pricesLoaded,
    refresh,
    buy: async (p) => {
      const r = await buyWithMoney(p, walletRef.current, store, deps);
      commit(r.wallet);
      return r;
    },
    spend: async (p) => {
      const r = await buyWithDiamonds(p, walletRef.current, deps);
      commit(r.wallet);
      return r;
    },
    restore: async () => {
      const r = await restorePurchases(walletRef.current, store, deps);
      commit(r.wallet);
      return r;
    },
  };
}
