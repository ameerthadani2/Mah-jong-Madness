/**
 * Import first in a render test that needs a Shop with prices: the development mock store (src/monetisation/store-mode.ts)
 * is chosen when the store module loads, and it quotes each product's planning price ($0.99, $4.99, …).
 */
process.env.EXPO_PUBLIC_STORE_MODE = 'mock';
export {};
