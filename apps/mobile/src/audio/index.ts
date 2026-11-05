/**
 * The app's sound: one SfxEngine backed by expo-audio, players created once, plus hooks that keep it in
 * step with Settings → Sound and the voice choice. See ./cues.ts for which table events make which sound,
 * assets/audio/manifest.json for the files, and docs/CREDITS.md for replacing the placeholders.
 */
import { useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import manifest from '../../assets/audio/manifest.json';
import { useApp } from '../app-state';
import { SfxEngine, type AudioBackend } from './engine';
import { AUDIO_SOURCES } from './sources';
import { VoicePrefStore } from './voicePref';
import type { VoicePreference } from './cues';

export { type CallKind, type SfxCue, type TableEvent, type VoicePreference, VOICE_PREFERENCES, tableEvents, shouldTick } from './cues';

const expoBackend: AudioBackend = {
  load(source) {
    const player = createAudioPlayer(source);
    return {
      play(volume) {
        player.volume = volume;
        // Rewind so a cue that already finished plays again from the start.
        void player.seekTo(0).catch(() => undefined);
        player.play();
      },
      release() {
        player.remove();
      },
    };
  },
};

export const sfx = new SfxEngine(expoBackend, AUDIO_SOURCES, manifest.cues);
export const voicePrefs = new VoicePrefStore(AsyncStorage);

let modeSet = false;
function prepare() {
  if (modeSet) return;
  modeSet = true;
  // Game sounds mix with the player's music and respect the silent switch.
  void setAudioModeAsync({ playsInSilentMode: false, interruptionMode: 'mixWithOthers' }).catch(() => undefined);
  sfx.preload();
}

/** The saved voice for table calls; loads it once and re-renders when it changes. */
export function useVoicePreference(): VoicePreference {
  useEffect(() => void voicePrefs.load(), []);
  return useSyncExternalStore(
    (l) => voicePrefs.subscribe(l),
    () => voicePrefs.get(),
    () => voicePrefs.get(),
  );
}

/** The shared sound engine, configured from the current settings; players are created on first use. */
export function useSfx(): SfxEngine {
  const app = useApp();
  const voice = useVoicePreference();
  sfx.setOptions({ sound: app.settings.sound, voice });
  useEffect(() => {
    if (app.settings.sound) prepare();
  }, [app.settings.sound]);
  return sfx;
}
