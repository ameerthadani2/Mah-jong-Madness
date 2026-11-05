/**
 * The sound player, independent of any audio library: a backend (expo-audio in the app, a fake in tests)
 * creates one player per cue, once, and replays it on demand.
 *
 * Every failure is swallowed: a missing file, a backend that throws or a browser that blocks autoplay
 * leaves the game silent, never broken.
 */
import { voiceCueId, type CallKind, type SfxCue, type TableEvent, type VoicePreference } from './cues';

export interface AudioHandle {
  play(volume: number): void;
  release?(): void;
}

export interface AudioBackend {
  /** Creates a player for a bundled asset; may throw (the cue is then silent). */
  load(source: number): AudioHandle;
}

export interface ManifestCue {
  id: string;
  file: string;
  volume: number;
  placeholder: boolean;
}

export interface SfxOptions {
  /** The master switch (Settings → Sound). */
  sound: boolean;
  voice: VoicePreference;
}

export class SfxEngine {
  private handles = new Map<string, AudioHandle | null>();
  private readonly volumes = new Map<string, number>();
  private opts: SfxOptions = { sound: true, voice: 'mandarin' };

  constructor(
    private readonly backend: AudioBackend | null,
    /** Manifest id → bundled asset, for the cues whose file exists. */
    private readonly sources: Record<string, number>,
    cues: ManifestCue[],
  ) {
    for (const c of cues) this.volumes.set(c.id, c.volume);
  }

  setOptions(opts: SfxOptions): void {
    this.opts = opts;
  }

  options(): SfxOptions {
    return this.opts;
  }

  /** True when the cue has a sound file in this build. */
  has(id: string): boolean {
    return this.sources[id] !== undefined;
  }

  /** Whether a call would be spoken in a voice set (false → the banner carries it alone). */
  hasVoice(call: CallKind, voice: VoicePreference): boolean {
    const id = voiceCueId(call, voice);
    return id !== null && this.has(id);
  }

  /** Creates every player up front so the first clack is not late. Safe to call more than once. */
  preload(): void {
    for (const id of Object.keys(this.sources)) this.handle(id);
  }

  /** Plays a manifest cue by id. Returns true if a sound was started. */
  playId(id: string): boolean {
    if (!this.opts.sound) return false;
    const h = this.handle(id);
    if (!h) return false;
    try {
      h.play(this.volumes.get(id) ?? 1);
      return true;
    } catch {
      return false;
    }
  }

  sfx(cue: SfxCue): boolean {
    return this.playId(`sfx.${cue}`);
  }

  /** Speaks a call in the chosen voice; false when voice is off or that line is not recorded. */
  call(call: CallKind): boolean {
    const id = voiceCueId(call, this.opts.voice);
    return id !== null && this.playId(id);
  }

  /** Plays the sounds for a batch of table events (calls are spoken; banners are the caller's job). */
  playEvents(events: TableEvent[]): void {
    // One discard clack per batch: a claim arriving with the discard should not double-clack.
    let clacked = false;
    for (const e of events) {
      if (e.type === 'call') this.call(e.call);
      else if (e.cue === 'discard') {
        if (!clacked) this.sfx('discard');
        clacked = true;
      } else this.sfx(e.cue);
    }
  }

  release(): void {
    for (const h of this.handles.values()) {
      try {
        h?.release?.();
      } catch {
        /* already gone */
      }
    }
    this.handles.clear();
  }

  private handle(id: string): AudioHandle | null {
    if (this.handles.has(id)) return this.handles.get(id) ?? null;
    const src = this.sources[id];
    let h: AudioHandle | null = null;
    if (src !== undefined && this.backend) {
      try {
        h = this.backend.load(src);
      } catch {
        h = null;
      }
    }
    this.handles.set(id, h);
    return h;
  }
}
