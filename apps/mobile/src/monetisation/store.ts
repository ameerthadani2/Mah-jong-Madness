/**
 * The store and the cached wallet for this build. The rules live in pure modules:
 * ./store-mode.ts (which store), ./providers.ts (the store providers), ./wallet.ts (the
 * server-wallet mirror and meters) and ./sync.ts (purchase, spend and restore flows).
 *
 * Build-time values (inlined by Expo from EXPO_PUBLIC_* at bundle time; all optional):
 * EXPO_PUBLIC_REVENUECAT_IOS_KEY, EXPO_PUBLIC_REVENUECAT_ANDROID_KEY, and
 * EXPO_PUBLIC_STORE_MODE=mock for a development build's mock store.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { MockStoreProvider, RevenueCatStoreProvider, UnavailableStoreProvider, type StoreProvider } from './providers';
import { nativePurchases } from './revenuecat-native';
import { selectStoreMode, type StoreEnv, type StoreMode } from './store-mode';
import { EMPTY_WALLET, migrateWallet, type Wallet } from './wallet';

export * from './wallet';
export type { PurchaseOutcome, StoreProvider } from './providers';

/** Each name is written out in full so the bundler can inline it. */
export function readStoreEnv(): StoreEnv {
  return {
    mode: process.env.EXPO_PUBLIC_STORE_MODE,
    iosKey: process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY,
    androidKey: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_KEY,
  };
}

export const STORE_MODE: StoreMode = selectStoreMode(readStoreEnv(), Platform.OS, __DEV__);

function makeStore(mode: StoreMode): StoreProvider {
  // `__DEV__ &&` lets a release bundle drop the mock entirely; the proof check is the type-level guard.
  if (__DEV__ && mode.kind === 'mock') return new MockStoreProvider(mode.proof);
  if (mode.kind === 'revenuecat') {
    try {
      return new RevenueCatStoreProvider(nativePurchases(), mode.apiKey);
    } catch {
      return new UnavailableStoreProvider('platform');
    }
  }
  return new UnavailableStoreProvider(mode.kind === 'unavailable' ? mode.reason : 'mock_in_release');
}

export const store: StoreProvider = makeStore(STORE_MODE);

const KEY = 'mjm.wallet';

/** The last server copy (shown offline); see ./wallet.ts for what survives a load. */
export async function loadWallet(): Promise<Wallet> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? migrateWallet(JSON.parse(raw)) : EMPTY_WALLET;
  } catch {
    return EMPTY_WALLET;
  }
}

export async function saveWallet(w: Wallet): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify(w));
  } catch {
    /* best effort */
  }
}
