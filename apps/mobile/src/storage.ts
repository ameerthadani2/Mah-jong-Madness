import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_RULES, type BotSkill, type RuleSet } from '@mjm/engine';
import { randomHex, type SerializedHost } from '@mjm/net';
import { clampDailyToToday, effectiveStreak as streakOn } from './logic/daily';
import { localDateKey, previousDateKey } from './logic/dates';
import { migrateSettings } from './logic/settings';
import type { LocalePreference } from './i18n/resolve';

export interface Profile {
  /** Stable, client-generated id used by clubs until real sign-in lands. */
  userId: string;
  /** Device-held secret that proves ownership of userId to the club API (trust on first use). */
  userSecret: string;
  name: string;
  avatar: string;
}

export interface Settings {
  rules: RuleSet;
  coach: boolean;
  /**
   * Development builds only: a signalling server to use instead of the build's own.
   * Release builds ignore it; the build's server address is never stored.
   */
  devSignalUrl?: string;
  botSkill: BotSkill;
  sound: boolean;
  tableTheme: string;
  /** UI language: 'auto' follows the device; saved settings from before this field read as 'auto'. */
  locale: LocalePreference;
}

export interface Progress {
  lessonsDone: Record<string, boolean>;
  drillsPlayed: number;
  drillsCorrect: number;
  handsPlayed: number;
  handsWon: number;
  /** Daily puzzle: one attempt per local calendar day, recorded as correct or wrong. */
  dailySolved: Record<string, 'correct' | 'wrong'>;
  dailyStreak: number;
  dailyLastDate: string | null;
  /** Puzzle rush */
  rushBest: number;
  rushRuns: number;
  /** Rolling review accuracy (last 20 reviewed hands). */
  reviewAccuracies: number[];
  /** `${matchId}:${handNumber}` keys already counted / reviewed, so remounts never double-count. */
  lastCountedHand: string | null;
  reviewedHands: string[];
}

/** The table the player was last seated at, so a crash or relaunch can resume it. */
export type ActiveSession =
  | { kind: 'online'; signalUrl: string; roomCode: string; token: string; name: string; avatar: string; clubCode?: string; savedAt: number }
  | { kind: 'local'; host: SerializedHost; token: string; name: string; avatar: string; savedAt: number };

const KEYS = { profile: 'mjm.profile', settings: 'mjm.settings', progress: 'mjm.progress', session: 'mjm.activeSession' } as const;

export const DEFAULT_PROFILE: Profile = { userId: '', userSecret: '', name: '', avatar: 'lady' };
export const DEFAULT_SETTINGS: Settings = { rules: DEFAULT_RULES, coach: true, botSkill: 'beginner', sound: true, tableTheme: 'classic', locale: 'auto' };
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
  lastCountedHand: null,
  reviewedHands: [],
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
    if (!p.userId || !p.userSecret) {
      p.userId = p.userId || `user-${randomHex(12)}`;
      p.userSecret = p.userSecret || randomHex(24);
      await save(KEYS.profile, p);
    }
    return p;
  },
  saveProfile: (p: Profile) => save(KEYS.profile, p),
  // Older saves are migrated (see logic/settings.ts): stale fields dropped, rules sanitised, locale defaulted.
  loadSettings: async (): Promise<Settings> => migrateSettings(await load(KEYS.settings, DEFAULT_SETTINGS), DEFAULT_SETTINGS),
  saveSettings: (s: Settings) => save(KEYS.settings, s),
  loadProgress: async (): Promise<Progress> => clampDailyToToday(await load(KEYS.progress, DEFAULT_PROGRESS), todayKey()),
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

/** Avatar ids (≤ 8 chars, the host trims longer values); drawn by components/Avatars.tsx. */
export const AVATARS = ['auntie', 'uncle', 'grandma', 'boss', 'lady', 'shades', 'hoops', 'cowboy', 'student', 'chef', 'sporty', 'gent'];

/** Local calendar date key (`YYYY-MM-DD`): daily puzzles and streaks roll over at local midnight. */
export function todayKey(d = new Date()): string {
  return localDateKey(d);
}

export function yesterdayKey(d = new Date()): string {
  return previousDateKey(localDateKey(d));
}

/** Streak as it should be displayed: it dies once a day has been missed. */
export function effectiveStreak(p: Progress, d = new Date()): number {
  return streakOn(p, localDateKey(d));
}
