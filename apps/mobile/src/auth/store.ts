/** A `SecureStore` held in memory: for tests, and the fallback when the platform store is unusable. */
import type { SecureStore } from './types';

export function memoryStore(initial: Record<string, string> = {}): SecureStore {
  const data = new Map(Object.entries(initial));
  return {
    getItem: async (k) => data.get(k) ?? null,
    setItem: async (k, v) => {
      data.set(k, v);
    },
    deleteItem: async (k) => {
      data.delete(k);
    },
  };
}
