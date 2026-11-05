/**
 * Installed before the app loads (see index.js). The engine's shuffle shares and
 * rejoin tokens come from `crypto.getRandomValues` and fail closed without it.
 * React Native's Hermes runtime has no Web Crypto, so expo-crypto's synchronous,
 * OS-backed implementation fills the gap. Browsers already have one and keep it.
 */
import * as ExpoCrypto from 'expo-crypto';

type RandomFill = (array: Uint8Array) => Uint8Array;
const g = globalThis as unknown as { crypto?: { getRandomValues?: RandomFill } };

if (typeof g.crypto?.getRandomValues !== 'function') {
  const getRandomValues: RandomFill = (array) => ExpoCrypto.getRandomValues(array);
  try {
    if (g.crypto) g.crypto.getRandomValues = getRandomValues;
    else Object.defineProperty(globalThis, 'crypto', { value: { getRandomValues }, configurable: true, writable: true });
  } catch {
    // A read-only global: leave it. App.tsx checks for a working source at boot and says so.
  }
}
