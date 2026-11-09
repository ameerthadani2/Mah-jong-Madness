import { describe, expect, it } from 'vitest';
import { createMotionPreference, type MotionSource } from './motionPreference';

function fakeSource(initial: boolean) {
  let on: ((v: boolean) => void) | null = null;
  let reads = 0;
  let listening = 0;
  const source: MotionSource = {
    read: () => {
      reads++;
      return Promise.resolve(initial);
    },
    listen: (cb) => {
      listening++;
      on = cb;
      return () => {
        listening--;
        on = null;
      };
    },
  };
  return { source, change: (v: boolean) => on?.(v), stats: () => ({ reads, listening }) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('reduced motion preference', () => {
  it('reads the system setting once and follows changes', async () => {
    const f = fakeSource(true);
    const pref = createMotionPreference(f.source);
    let calls = 0;
    const un1 = pref.subscribe(() => calls++);
    const un2 = pref.subscribe(() => undefined);
    expect(pref.get()).toBe(false);
    await flush();
    expect(pref.get()).toBe(true);
    expect(f.stats()).toEqual({ reads: 1, listening: 1 });
    f.change(false);
    expect(pref.get()).toBe(false);
    expect(calls).toBe(2);
    un1();
    un2();
    expect(f.stats().listening).toBe(0);
  });

  it('keeps motion on when the setting cannot be read', async () => {
    const pref = createMotionPreference({ read: () => Promise.reject(new Error('no')), listen: () => () => undefined });
    pref.subscribe(() => undefined);
    await flush();
    expect(pref.get()).toBe(false);
  });
});
