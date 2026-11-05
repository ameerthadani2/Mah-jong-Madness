import { describe, expect, it } from 'vitest';
import { CONSENT_KEY, ConsentStore, DEFAULT_CONSENT, consentReducer, effectiveConsent, parseConsent, type KeyValueStore } from './consent';

function memoryKv(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

describe('consent state machine', () => {
  it('keeps analytics off before the age gate and crash reports on', () => {
    expect(effectiveConsent(DEFAULT_CONSENT)).toEqual({ analytics: false, crash: true });
  });

  it('turns analytics on by default once consent is given, but not for a minor', () => {
    expect(effectiveConsent(consentReducer(DEFAULT_CONSENT, { type: 'given' }))).toEqual({ analytics: true, crash: true });
    expect(effectiveConsent(consentReducer(DEFAULT_CONSENT, { type: 'given', minor: true })).analytics).toBe(false);
  });

  it('lets an explicit choice win over either default', () => {
    let s = consentReducer(DEFAULT_CONSENT, { type: 'given' });
    s = consentReducer(s, { type: 'analytics', on: false });
    s = consentReducer(s, { type: 'crash', on: false });
    expect(effectiveConsent(s)).toEqual({ analytics: false, crash: false });
    // Re-running the age gate does not undo the player's choice.
    expect(effectiveConsent(consentReducer(s, { type: 'given' })).analytics).toBe(false);
    // A minor who switches analytics on has chosen it.
    expect(effectiveConsent(consentReducer(consentReducer(DEFAULT_CONSENT, { type: 'given', minor: true }), { type: 'analytics', on: true })).analytics).toBe(true);
    expect(consentReducer(s, { type: 'reset' })).toEqual(DEFAULT_CONSENT);
  });

  it('reads stored records defensively', () => {
    expect(parseConsent(null)).toEqual(DEFAULT_CONSENT);
    expect(parseConsent('not json')).toEqual(DEFAULT_CONSENT);
    expect(parseConsent('{"v":2,"given":true}')).toEqual(DEFAULT_CONSENT);
    expect(parseConsent('{"v":1,"given":true,"analytics":"yes","crash":false}')).toEqual({ v: 1, given: true, minor: false, analytics: null, crash: false });
  });

  it('persists every change under its own key and tells subscribers', async () => {
    const kv = memoryKv({ [CONSENT_KEY]: JSON.stringify({ v: 1, given: true, minor: false, analytics: null, crash: null }) });
    const store = new ConsentStore(kv);
    const seen: boolean[] = [];
    store.subscribe((c) => seen.push(c.analytics));
    expect(store.loaded).toBe(false);
    await store.load();
    expect(store.loaded).toBe(true);
    store.dispatch({ type: 'analytics', on: false });
    expect(seen).toEqual([true, false]);
    await Promise.resolve();
    expect(JSON.parse(kv.data[CONSENT_KEY]).analytics).toBe(false);
    // A fresh store (the next launch) sees the saved choice.
    const next = new ConsentStore(kv);
    await next.load();
    expect(next.effective.analytics).toBe(false);
  });

  it('keeps a choice made while the stored record is still loading', async () => {
    let release: (v: string | null) => void = () => undefined;
    const kv: KeyValueStore = { getItem: () => new Promise((r) => (release = r)), setItem: async () => undefined };
    const store = new ConsentStore(kv);
    const loading = store.load();
    store.dispatch({ type: 'crash', on: false });
    release(JSON.stringify({ v: 1, given: false, crash: true }));
    await loading;
    expect(store.effective.crash).toBe(false);
  });

  it('survives a storage that throws', async () => {
    const store = new ConsentStore({ getItem: () => Promise.reject(new Error('blocked')), setItem: () => Promise.reject(new Error('full')) });
    await store.load();
    expect(store.effective).toEqual({ analytics: false, crash: true });
    expect(() => store.dispatch({ type: 'given' })).not.toThrow();
  });
});
