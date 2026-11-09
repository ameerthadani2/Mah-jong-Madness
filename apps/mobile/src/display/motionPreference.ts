/**
 * A tiny shared store for the reduce-motion setting, over an injected source (React Native's AccessibilityInfo
 * in the app, a fake in tests): the first subscriber reads the setting once and listens for changes; every
 * later subscriber shares that one read and listener. Pure TypeScript.
 */
export interface MotionSource {
  /** The current setting (may reject; then motion stays on). */
  read(): Promise<boolean>;
  /** Calls `on` with each new value; returns an unsubscribe. */
  listen(on: (reduced: boolean) => void): () => void;
}

export interface MotionPreference {
  get(): boolean;
  subscribe(listener: () => void): () => void;
}

export function createMotionPreference(source: MotionSource): MotionPreference {
  let value = false;
  let started = false;
  let stop: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const set = (v: boolean) => {
    if (v === value) return;
    value = v;
    for (const l of listeners) l();
  };
  const start = () => {
    if (started) return;
    started = true;
    try {
      stop = source.listen((v) => set(!!v));
    } catch {
      stop = null;
    }
    void source
      .read()
      .then((v) => set(!!v))
      .catch(() => undefined);
  };
  return {
    get: () => value,
    subscribe(listener) {
      start();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && stop) {
          stop();
          stop = null;
          started = false;
        }
      };
    },
  };
}
