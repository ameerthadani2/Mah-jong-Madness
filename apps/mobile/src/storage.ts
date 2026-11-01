import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_RULES, type RuleSet } from '@mjm/engine';
import Constants from 'expo-constants';

export interface Profile {
  name: string;
  avatar: string;
}

export interface Settings {
  rules: RuleSet;
  coach: boolean;
  signalUrl: string;
  hostedTables: boolean;
}

export interface Progress {
  lessonsDone: Record<string, boolean>;
  drillsPlayed: number;
  drillsCorrect: number;
  handsPlayed: number;
  handsWon: number;
}

const KEYS = { profile: 'mjm.profile', settings: 'mjm.settings', progress: 'mjm.progress' } as const;

const extra = (Constants.expoConfig?.extra ?? {}) as { signalUrl?: string };

export const DEFAULT_PROFILE: Profile = { name: '', avatar: '🀄' };
export const DEFAULT_SETTINGS: Settings = { rules: DEFAULT_RULES, coach: true, signalUrl: extra.signalUrl ?? 'ws://localhost:8787', hostedTables: false };
export const DEFAULT_PROGRESS: Progress = { lessonsDone: {}, drillsPlayed: 0, drillsCorrect: 0, handsPlayed: 0, handsWon: 0 };

async function load<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback;
  } catch {
    return fallback;
  }
}

async function save<T>(key: string, value: T): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage is best-effort */
  }
}

export const storage = {
  loadProfile: () => load(KEYS.profile, DEFAULT_PROFILE),
  saveProfile: (p: Profile) => save(KEYS.profile, p),
  loadSettings: async (): Promise<Settings> => {
    const s = await load(KEYS.settings, DEFAULT_SETTINGS);
    return { ...s, rules: { ...DEFAULT_RULES, ...s.rules } };
  },
  saveSettings: (s: Settings) => save(KEYS.settings, s),
  loadProgress: () => load(KEYS.progress, DEFAULT_PROGRESS),
  saveProgress: (p: Progress) => save(KEYS.progress, p),
};

export const AVATARS = ['🀄', '🐉', '🐼', '🦊', '🐯', '🦁', '🐸', '🐵', '🌸', '🍵', '🧧', '🎋'];
