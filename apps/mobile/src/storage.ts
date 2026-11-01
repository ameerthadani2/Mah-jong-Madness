import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_RULES, type BotSkill, type RuleSet } from '@mjm/engine';
import { randomHex, type SerializedHost } from '@mjm/net';
import Constants from 'expo-constants';

export interface Profile {
  /** Stable, client-generated id used by clubs until real sign-in lands. */
  userId: string;
  name: string;
  avatar: string;
}

export interface Settings {
  rules: RuleSet;
  coach: boolean;
  signalUrl: string;
  hostedTables: boolean;
  botSkill: BotSkill;
  sound: boolean;
  tableTheme: string;
}

export interface Progress {
  lessonsDone: Record<string, boolean>;
  drillsPlayed: number;
  drillsCorrect: number;
  handsPlayed: number;
  handsWon: number;
  /** Daily puzzle */
  dailySolved: Record<string, boolean>;
  dailyStreak: number;
  dailyLastDate: string | null;
  /** Puzzle rush */
  rushBest: number;
  rushRuns: number;
  /** Rolling review accuracy (last 20 reviewed hands). */
  reviewAccuracies: number[];
}

/** The table the player was last seated at, so a crash or relaunch can resume it. */
export type ActiveSession =
  | { kind: 'online'; signalUrl: string; roomCode: string; token: string; name: string; avatar: string; clubCode?: string; savedAt: number }
  | { kind: 'local'; host: SerializedHost; token: string; name: string; avatar: string; savedAt: number };

const KEYS = { profile: 'mjm.profile', settings: 'mjm.settings', progress: 'mjm.progress', session: 'mjm.activeSession' } as const;

const extra = (Constants.expoConfig?.extra ?? {}) as { signalUrl?: string };

export const DEFAULT_PROFILE: Profile = { userId: '', name: '', avatar: '🀄' };
export const DEFAULT_SETTINGS: Settings = { rules: DEFAULT_RULES, coach: true, signalUrl: extra.signalUrl ?? 'ws://localhost:8787', hostedTables: false, botSkill: 'club', sound: true, tableTheme: 'classic' };
export const DEFAULT_PROGRESS: Progress = {
  lessonsDone: {},
  drillsPlayed: 0,
  drillsCorrect: 0,
  handsPlayed: 0,
  handsWon: 0,
  dailySolved: {},
  dailyStreak: 0,
  dailyLastDate: null,
  rushBest: 0,
  rushRuns: 0,
  reviewAccuracies: [],
};

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
  loadProfile: async (): Promise<Profile> => {
    const p = await load(KEYS.profile, DEFAULT_PROFILE);
    if (!p.userId) {
      p.userId = `user-${randomHex(12)}`;
      await save(KEYS.profile, p);
    }
    return p;
  },
  saveProfile: (p: Profile) => save(KEYS.profile, p),
  loadSettings: async (): Promise<Settings> => {
    const s = await load(KEYS.settings, DEFAULT_SETTINGS);
    return { ...s, rules: { ...DEFAULT_RULES, ...s.rules } };
  },
  saveSettings: (s: Settings) => save(KEYS.settings, s),
  loadProgress: () => load(KEYS.progress, DEFAULT_PROGRESS),
  saveProgress: (p: Progress) => save(KEYS.progress, p),
  loadActiveSession: async (): Promise<ActiveSession | null> => {
    try {
      const raw = await AsyncStorage.getItem(KEYS.session);
      if (!raw) return null;
      const s = JSON.parse(raw) as ActiveSession;
      // Sessions older than 12 hours are stale.
      if (Date.now() - s.savedAt > 12 * 3600_000) return null;
      return s;
    } catch {
      return null;
    }
  },
  saveActiveSession: (s: ActiveSession) => save(KEYS.session, s),
  clearActiveSession: async () => {
    try {
      await AsyncStorage.removeItem(KEYS.session);
    } catch {
      /* noop */
    }
  },
};

export const AVATARS = ['🀄', '🐉', '🐼', '🦊', '🐯', '🦁', '🐸', '🐵', '🌸', '🍵', '🧧', '🎋', '🦄', '🐙', '🦉', '🐧'];

export function todayKey(d = new Date()): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
