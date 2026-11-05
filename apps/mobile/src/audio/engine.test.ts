import { describe, expect, it } from 'vitest';
import { SfxEngine, type AudioBackend } from './engine';
import { VoicePrefStore, VOICE_KEY, type KeyValueStore } from './voicePref';

const CUES = [
  { id: 'sfx.discard', file: 'sfx/discard.wav', volume: 0.8, placeholder: true },
  { id: 'sfx.tick', file: 'sfx/tick.wav', volume: 0.6, placeholder: true },
  { id: 'voice.mandarin.pong', file: 'voice/mandarin/pong.wav', volume: 1, placeholder: true },
  { id: 'voice.taiwanese.pong', file: 'voice/taiwanese/pong.wav', volume: 1, placeholder: false },
];
// The Taiwanese line is not recorded: it has no bundled source.
const SOURCES = { 'sfx.discard': 1, 'sfx.tick': 2, 'voice.mandarin.pong': 3 };

function fake() {
  const loads: number[] = [];
  const plays: Array<[number, number]> = [];
  const backend: AudioBackend = {
    load(src) {
      loads.push(src);
      return { play: (v) => plays.push([src, v]) };
    },
  };
  return { backend, loads, plays };
}

describe('SfxEngine', () => {
  it('creates each player once and replays it at the manifest volume', () => {
    const f = fake();
    const e = new SfxEngine(f.backend, SOURCES, CUES);
    e.preload();
    e.sfx('discard');
    e.sfx('discard');
    expect(f.loads.sort()).toEqual([1, 2, 3]);
    expect(f.plays).toEqual([
      [1, 0.8],
      [1, 0.8],
    ]);
  });

  it('is silent when Settings → Sound is off', () => {
    const f = fake();
    const e = new SfxEngine(f.backend, SOURCES, CUES);
    e.setOptions({ sound: false, voice: 'mandarin' });
    expect(e.sfx('discard')).toBe(false);
    expect(e.call('pong')).toBe(false);
    expect(f.plays).toEqual([]);
  });

  it('speaks calls in the chosen voice, and degrades to banner-only when a line is missing or voice is off', () => {
    const f = fake();
    const e = new SfxEngine(f.backend, SOURCES, CUES);
    expect(e.call('pong')).toBe(true);
    e.setOptions({ sound: true, voice: 'taiwanese' });
    expect(e.hasVoice('pong', 'taiwanese')).toBe(false);
    expect(e.call('pong')).toBe(false);
    e.setOptions({ sound: true, voice: 'off' });
    expect(e.call('pong')).toBe(false);
    expect(f.plays).toEqual([[3, 1]]);
  });

  it('never throws when the backend fails or is absent', () => {
    const throwing: AudioBackend = {
      load: () => ({
        play: () => {
          throw new Error('autoplay blocked');
        },
      }),
    };
    expect(new SfxEngine(throwing, SOURCES, CUES).sfx('tick')).toBe(false);
    expect(new SfxEngine({ load: () => { throw new Error('no file'); } }, SOURCES, CUES).sfx('tick')).toBe(false);
    expect(new SfxEngine(null, SOURCES, CUES).sfx('tick')).toBe(false);
  });

  it('plays one clack for a batch however many ponds grew, and speaks each call', () => {
    const f = fake();
    const e = new SfxEngine(f.backend, SOURCES, CUES);
    e.playEvents([{ type: 'sfx', cue: 'discard' }, { type: 'sfx', cue: 'discard' }, { type: 'call', call: 'pong', seat: 1 }]);
    expect(f.plays).toEqual([
      [1, 0.8],
      [3, 1],
    ]);
  });
});

describe('VoicePrefStore', () => {
  const mem = (initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } => {
    const data = { ...initial };
    return { data, getItem: async (k) => data[k] ?? null, setItem: async (k, v) => void (data[k] = v) };
  };

  it('defaults to Mandarin, loads a saved choice and ignores junk', async () => {
    expect(await new VoicePrefStore(mem()).load()).toBe('mandarin');
    expect(await new VoicePrefStore(mem({ [VOICE_KEY]: 'taiwanese' })).load()).toBe('taiwanese');
    expect(await new VoicePrefStore(mem({ [VOICE_KEY]: 'klingon' })).load()).toBe('mandarin');
    const broken: KeyValueStore = { getItem: () => Promise.reject(new Error('io')), setItem: () => Promise.reject(new Error('io')) };
    const s = new VoicePrefStore(broken);
    expect(await s.load()).toBe('mandarin');
    await s.set('off');
    expect(s.get()).toBe('off');
  });

  it('saves under its own key and tells subscribers', async () => {
    const store = mem();
    const s = new VoicePrefStore(store);
    const seen: string[] = [];
    s.subscribe((v) => seen.push(v));
    await s.set('off');
    expect(store.data[VOICE_KEY]).toBe('off');
    expect(seen).toEqual(['off']);
  });
});
