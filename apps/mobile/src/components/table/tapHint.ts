/**
 * The "Tap a tile, tap again to discard" pill is a first-game tutorial: it retires after the player's first
 * few discards, remembered on the device (TAP_HINT_KEY), so it stops covering their own pond for good.
 * The storage is injected so this stays testable: the app passes AsyncStorage, tests an in-memory map.
 */
export const TAP_HINT_KEY = 'mjm.tapHint';
/** Discards after which the pill is no longer shown. */
export const TAP_HINT_DISCARDS = 3;

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export function tapHintVisible(discards: number): boolean {
  return discards < TAP_HINT_DISCARDS;
}

export class TapHintStore {
  private count = 0;
  private loaded = false;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly store: KeyValueStore) {}

  get(): number {
    return this.count;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    void this.store
      .getItem(TAP_HINT_KEY)
      .then((raw) => {
        const n = Number(raw);
        if (Number.isFinite(n) && n > this.count) this.set(Math.floor(n));
      })
      .catch(() => undefined);
  }

  /** The player discarded a tile by hand: one step closer to retiring the pill. */
  discarded(): void {
    if (!tapHintVisible(this.count)) return;
    this.set(this.count + 1);
    void this.store.setItem(TAP_HINT_KEY, String(this.count)).catch(() => undefined);
  }

  subscribe(l: () => void): () => void {
    this.load();
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private set(n: number) {
    this.count = n;
    for (const l of this.listeners) l();
  }
}
