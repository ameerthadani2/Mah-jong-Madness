/**
 * The saved display scale, kept under its own storage key (DISPLAY_KEY). The storage is injected so this stays
 * testable without React Native: the app passes AsyncStorage, the tests an in-memory map.
 */
import { clampTextScale, clampTileScale, DEFAULT_DISPLAY_SCALE, DISPLAY_KEY, parseDisplayScale, serialiseDisplayScale, type DisplayScale } from './scale';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export class DisplayScaleStore {
  private value: DisplayScale = DEFAULT_DISPLAY_SCALE;
  private readonly listeners = new Set<(v: DisplayScale) => void>();
  private loaded: Promise<DisplayScale> | null = null;
  /** Set once the player picks something, so a slow first read never overwrites a newer choice. */
  private touched = false;

  constructor(private readonly store: KeyValueStore) {}

  get(): DisplayScale {
    return this.value;
  }

  /** Reads the saved choice once; anything unreadable reads as Normal. */
  load(): Promise<DisplayScale> {
    this.loaded ??= this.store
      .getItem(DISPLAY_KEY)
      .then((raw) => {
        if (!this.touched) this.apply(parseDisplayScale(raw));
        return this.value;
      })
      .catch(() => this.value);
    return this.loaded;
  }

  /** Saves a new choice (either half may be given); out-of-range values snap to the nearest step. */
  async set(patch: Partial<DisplayScale>): Promise<void> {
    const next: DisplayScale = {
      tileScale: patch.tileScale === undefined ? this.value.tileScale : clampTileScale(patch.tileScale),
      textScale: patch.textScale === undefined ? this.value.textScale : clampTextScale(patch.textScale),
    };
    this.touched = true;
    this.apply(next);
    try {
      await this.store.setItem(DISPLAY_KEY, serialiseDisplayScale(next));
    } catch {
      /* kept for this launch only */
    }
  }

  subscribe(l: (v: DisplayScale) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private apply(v: DisplayScale) {
    if (v.tileScale === this.value.tileScale && v.textScale === this.value.textScale) return;
    this.value = v;
    for (const l of this.listeners) l(v);
  }
}
