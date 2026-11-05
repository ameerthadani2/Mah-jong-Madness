/**
 * Which store this build talks to. Pure, so the rule is unit-tested:
 *
 * - `EXPO_PUBLIC_STORE_MODE=mock` in a development build → the mock store (instant, free,
 *   local grants that the next server sync replaces). A release build never gets it.
 * - Otherwise RevenueCat, with `EXPO_PUBLIC_REVENUECAT_IOS_KEY` on iOS and
 *   `EXPO_PUBLIC_REVENUECAT_ANDROID_KEY` on Android.
 * - No key for this platform (or the web build) → unavailable: the Shop says so and grants nothing.
 *
 * The mock is also guarded at type level: `MockStoreProvider` cannot be constructed without a
 * `DevBuildProof`, and the only way to obtain one is `devBuildProof(__DEV__)`, which yields
 * null in a release build. Code that skips the check does not compile.
 */

declare const DEV_BUILD: unique symbol;

/** Evidence that this is a development build; only `devBuildProof(true)` makes one. */
export type DevBuildProof = { readonly [DEV_BUILD]: true };

export function devBuildProof(isDev: boolean): DevBuildProof | null {
  return isDev === true ? (Object.freeze({}) as DevBuildProof) : null;
}

export interface StoreEnv {
  mode?: string;
  iosKey?: string;
  androidKey?: string;
}

export type UnavailableReason = 'no_key' | 'platform' | 'mock_in_release';

export type StoreMode = { kind: 'revenuecat'; apiKey: string } | { kind: 'mock'; proof: DevBuildProof } | { kind: 'unavailable'; reason: UnavailableReason };

const clean = (v: string | undefined): string => (typeof v === 'string' ? v.trim() : '');

export function selectStoreMode(env: StoreEnv, platform: string, isDev: boolean): StoreMode {
  if (clean(env.mode).toLowerCase() === 'mock') {
    const proof = devBuildProof(isDev);
    return proof ? { kind: 'mock', proof } : { kind: 'unavailable', reason: 'mock_in_release' };
  }
  const key = platform === 'ios' ? clean(env.iosKey) : platform === 'android' ? clean(env.androidKey) : null;
  if (key === null) return { kind: 'unavailable', reason: 'platform' };
  if (!key) return { kind: 'unavailable', reason: 'no_key' };
  return { kind: 'revenuecat', apiKey: key };
}
