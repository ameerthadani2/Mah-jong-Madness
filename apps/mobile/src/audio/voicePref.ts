/**
 * The voice used for table calls ('mandarin' | 'taiwanese' | 'off'), kept in its own small storage key so it
 * does not change the saved Settings shape. The storage is injected so this stays testable.
 */
import { DEFAULT_VOICE, isVoicePreference, type VoicePreference } from './cues';

export const VOICE_KEY = 'mjm.audio.voice';

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

export class VoicePrefStore {
  private value: VoicePreference = DEFAULT_VOICE;
  private readonly listeners = new Set<(v: VoicePreference) => void>();
  private loaded: Promise<VoicePreference> | null = null;

  constructor(private readonly store: KeyValueStore) {}

  get(): VoicePreference {
    return this.value;
  }

  /** Reads the saved choice once; anything unreadable or unknown reads as the default. */
  load(): Promise<VoicePreference> {
    this.loaded ??= this.store
      .getItem(VOICE_KEY)
      .then((raw) => {
        if (isVoicePreference(raw)) this.apply(raw);
        return this.value;
      })
      .catch(() => this.value);
    return this.loaded;
  }

  async set(v: VoicePreference): Promise<void> {
    if (!isVoicePreference(v)) return;
    this.apply(v);
    try {
      await this.store.setItem(VOICE_KEY, v);
    } catch {
      /* kept for this launch only */
    }
  }

  subscribe(l: (v: VoicePreference) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private apply(v: VoicePreference) {
    if (v === this.value) return;
    this.value = v;
    for (const l of this.listeners) l(v);
  }
}
