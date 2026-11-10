/**
 * Shared by the table tests. Deals come from random secrets, so a test that needs a particular
 * situation (a hand that lasts ten turns, a seat that gets a third turn) would now and then not
 * find it. `seededDeals` makes every run of a test see the same hands; `scenario` deals again when
 * the situation still does not come up (after a change to the bots, say).
 */
import { afterEach, beforeEach, vi } from 'vitest';

/** Replace the random source with a fixed sequence, restarted before each test. */
export function seededDeals(seed = 20261110): void {
  let state = seed;
  beforeEach(() => {
    state = seed;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((buf: Uint8Array) => {
      for (let i = 0; i < buf.length; i++) {
        // xorshift32
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        buf[i] = (state >>> 0) & 0xff;
      }
      return buf;
    }) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}

/** The situation a test needs did not come up in this deal. */
export class Missed extends Error {
  constructor(what = 'the situation the test needs did not come up') {
    super(what);
  }
}

/** Run `fn` on fresh deals until the situation it needs comes up (it throws `Missed` when it does not). */
export function scenario<T>(fn: (attempt: number) => T, tries = 25): T {
  for (let i = 0; ; i++) {
    try {
      return fn(i);
    } catch (e) {
      if (!(e instanceof Missed) || i + 1 >= tries) throw e;
    }
  }
}

/** The same for tests that wait on the event loop. */
export async function scenarioAsync<T>(fn: (attempt: number) => Promise<T>, tries = 25): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn(i);
    } catch (e) {
      if (!(e instanceof Missed) || i + 1 >= tries) throw e;
    }
  }
}
