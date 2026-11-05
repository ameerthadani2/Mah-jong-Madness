import { describe, expect, it } from 'vitest';
import { DISPLAY_KEY } from './scale';
import { DisplayScaleStore, type KeyValueStore } from './store';

function memory(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: async (k) => data[k] ?? null,
    setItem: async (k, v) => {
      data[k] = v;
    },
  };
}

describe('DisplayScaleStore', () => {
  it('starts at Normal and persists a choice under its own key', async () => {
    const kv = memory();
    const s = new DisplayScaleStore(kv);
    expect(s.get()).toEqual({ tileScale: 1, textScale: 1 });
    await s.set({ tileScale: 1.5 });
    await s.set({ textScale: 1.15 });
    expect(s.get()).toEqual({ tileScale: 1.5, textScale: 1.15 });
    expect(JSON.parse(kv.data[DISPLAY_KEY])).toEqual({ tileScale: 1.5, textScale: 1.15 });
    // Nothing else is written: the saved Settings shape is untouched.
    expect(Object.keys(kv.data)).toEqual([DISPLAY_KEY]);
  });

  it('loads the saved choice on the next launch', async () => {
    const s = new DisplayScaleStore(memory({ [DISPLAY_KEY]: '{"tileScale":1.25,"textScale":1.3}' }));
    expect(await s.load()).toEqual({ tileScale: 1.25, textScale: 1.3 });
  });

  it('clamps out-of-range values on load and on set', async () => {
    const s = new DisplayScaleStore(memory({ [DISPLAY_KEY]: '{"tileScale":4,"textScale":0}' }));
    expect(await s.load()).toEqual({ tileScale: 1.5, textScale: 1 });
    await s.set({ textScale: 2 as never });
    expect(s.get().textScale).toBe(1.3);
  });

  it('survives broken storage', async () => {
    const broken: KeyValueStore = { getItem: () => Promise.reject(new Error('nope')), setItem: () => Promise.reject(new Error('nope')) };
    const s = new DisplayScaleStore(broken);
    expect(await s.load()).toEqual({ tileScale: 1, textScale: 1 });
    await s.set({ tileScale: 1.25 });
    expect(s.get().tileScale).toBe(1.25);
  });

  it('notifies listeners on change only, and a choice made before the first read wins', async () => {
    let release: (v: string | null) => void = () => undefined;
    const slow: KeyValueStore = { getItem: () => new Promise((r) => (release = r)), setItem: async () => undefined };
    const s = new DisplayScaleStore(slow);
    const seen: number[] = [];
    s.subscribe((v) => seen.push(v.tileScale));
    const loading = s.load();
    await s.set({ tileScale: 1.5 });
    await s.set({ tileScale: 1.5 });
    release('{"tileScale":1.25}');
    await loading;
    expect(s.get().tileScale).toBe(1.5);
    expect(seen).toEqual([1.5]);
  });
});
