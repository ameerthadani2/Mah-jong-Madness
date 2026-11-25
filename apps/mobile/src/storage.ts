import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_RULES, type BotSkill, type RuleSet } from '@mjm/engine';
import type { SerializedClient, SerializedHost } from '@mjm/net';
import { clampDailyToToday, effectiveStreak as streakOn } from './logic/daily';
import { localDateKey, previousDateKey } from './logic/dates';
import { staleOnlineSession, validActiveSession } from './logic/activeSession';
import { migrateSettings } from './logic/settings';
import { DEFAULT_PROFILE, migrateProfile, type Profile } from './logic/profile';
import type { LocalePreference } from './i18n/resolve';
import { migrateAgeRecord, type AgeRecord } from './legal/age';
import { DEFAULT_PUZZLE_RATING, migratePuzzleProgress, type RatingEntry } from './logic/rating';
import { validArchive, type ArchivedTable } from './logic/tableArchive';
import { validRed, type KeptRed } from './logic/redHands';
import { validJournal, type MoveJournal } from './logic/moveJournal';

export { DEFAULT_PROFILE, type Profile } from './logic/profile';

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
  /** Puzzle rush: most puzzles solved in one run, runs played, and the best run's `rushScore`. */
  rushBest: number;
  rushRuns: number;
  rushBestScore: number;
  /** Elo-style puzzle rating (logic/rating.ts) and the last answers that moved it, newest last. */
  puzzleRating: number;
  ratingHistory: RatingEntry[];
  /** Rolling review accuracy (last 20 reviewed hands). */
  reviewAccuracies: number[];
  /** `${matchId}:${handNumber}` keys already counted / reviewed, so remounts never double-count. */
  lastCountedHand: string | null;
  reviewedHands: string[];
}

/**
 * The table the player was last seated at, so a crash or relaunch can resume it. Online, `client`
 * is the table client's verification record (its ceremony record, chain and audits), so a resumed
 * client goes on checking the deal where it left off instead of starting with no history.
 */
export type ActiveSession =
  | {
      kind: 'online';
      signalUrl: string;
      roomCode: string;
      token: string;
      name: string;
      avatar: string;
      clubCode?: string;
      /** A quick-match table: resumed as one (no share code, no start button; it runs by itself). */
      quickMatch?: boolean;
      client?: SerializedClient;
      savedAt: number;
    }
  | {
      kind: 'local';
      host: SerializedHost;
      token: string;
      name: string;
      avatar: string;
      savedAt: number;
      /** Set when it is read back: both saved copies of the table's rules were damaged, so the defaults are used. */
      rulesReset?: boolean;
    };

const KEYS = { profile: 'mjm.profile', settings: 'mjm.settings', progress: 'mjm.progress', session: 'mjm.activeSession', archive: 'mjm.tableArchive', red: 'mjm.redHands', journal: 'mjm.moveJournal', age: 'mjm.age' } as const;

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
  rushBestScore: 0,
  puzzleRating: DEFAULT_PUZZLE_RATING,
  ratingHistory: [],
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

/** Write `value` under `key`; resolves true once it is written, false when the write failed (storage is best-effort). */
async function save<T>(key: string, value: T): Promise<boolean> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** The browser's own storage, on the web (AsyncStorage keeps its keys there too); null on a phone or where it is barred. */
function webStorage(): Pick<Storage, 'setItem' | 'removeItem'> | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    return ls && typeof ls.setItem === 'function' ? ls : null;
  } catch {
    return null;
  }
}

/** The journal's writes on a phone, one after another in the order they were asked for. */
let journalWrites: Promise<unknown> = Promise.resolve();

/**
 * Write the journal of moves (logic/moveJournal.ts) before a move goes out. On the web it is written at once
 * (localStorage), so the move leaves in the same turn of the event loop; on a phone through AsyncStorage, and the move
 * leaves once the write is done (the promise). A write that fails takes the journal off the device instead, so that a
 * record restored later vouches as one without a journal does, and the move still goes; only when that fails too is the
 * move kept back (this throws, or the promise is rejected: the table client then does not send it).
 */
function writeJournal(j: MoveJournal): void | Promise<void> {
  const text = JSON.stringify(j);
  const web = webStorage();
  if (web) {
    try {
      web.setItem(KEYS.journal, text);
    } catch {
      web.removeItem(KEYS.journal);
    }
    return;
  }
  const done = journalWrites.then(
    () => AsyncStorage.setItem(KEYS.journal, text),
    () => AsyncStorage.setItem(KEYS.journal, text),
  );
  const out = done.catch(() => AsyncStorage.removeItem(KEYS.journal));
  journalWrites = out.catch(() => undefined);
  return out;
}

export const storage = {
  // The server account id arrives with the first guest bootstrap (src/auth); older client-made ids are dropped.
  loadProfile: async (): Promise<Profile> => migrateProfile(await load<Profile>(KEYS.profile, DEFAULT_PROFILE)),
  saveProfile: (p: Profile) => save(KEYS.profile, p),
  // Older saves are migrated (see logic/settings.ts): stale fields dropped, rules sanitised, locale defaulted.
  loadSettings: async (): Promise<Settings> => migrateSettings(await load(KEYS.settings, DEFAULT_SETTINGS), DEFAULT_SETTINGS),
  saveSettings: (s: Settings) => save(KEYS.settings, s),
  // Saves from before the puzzle rating read with its defaults (and damaged rating fields are repaired).
  loadProgress: async (): Promise<Progress> => migratePuzzleProgress(clampDailyToToday(await load(KEYS.progress, DEFAULT_PROGRESS), todayKey())),
  saveProgress: (p: Progress) => save(KEYS.progress, p),
  /**
   * The saved table, or null. A damaged or stale record is deleted, so it is not read again on every launch; a stale
   * online one that holds a match is first handed to `keepStale` (the app keeps it in its archive), and deleted only once
   * that is done.
   */
  loadActiveSession: async (keepStale?: (stale: Extract<ActiveSession, { kind: 'online' }>) => Promise<unknown> | unknown): Promise<ActiveSession | null> => {
    try {
      const raw = await AsyncStorage.getItem(KEYS.session);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      const s = validActiveSession(parsed);
      if (!s) {
        const stale = keepStale ? staleOnlineSession(parsed) : null;
        if (stale) await keepStale!(stale);
        await AsyncStorage.removeItem(KEYS.session);
      }
      return s;
    } catch {
      // Text that is not JSON at all goes the same way.
      await AsyncStorage.removeItem(KEYS.session).catch(() => undefined);
      return null;
    }
  },
  saveActiveSession: (s: ActiveSession) => save(KEYS.session, s),
  /** The records of online tables no longer in the saved-table slot (logic/tableArchive.ts): well-formed, unexpired ones. */
  loadArchive: async (): Promise<ArchivedTable[]> => {
    try {
      const raw = await AsyncStorage.getItem(KEYS.archive);
      return raw ? validArchive(JSON.parse(raw), Date.now()) : [];
    } catch {
      return [];
    }
  },
  /** The hands found red at online tables (logic/redHands.ts), kept apart from the records of the tables. */
  loadRedHands: async (): Promise<KeptRed[]> => {
    try {
      const raw = await AsyncStorage.getItem(KEYS.red);
      return raw ? validRed(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  },
  saveRedHands: (list: readonly KeptRed[]) => save(KEYS.red, list),
  /** The journal of moves (logic/moveJournal.ts): its well-formed lists, or none. */
  loadJournal: async (): Promise<MoveJournal> => {
    try {
      const raw = await AsyncStorage.getItem(KEYS.journal);
      return raw ? validJournal(JSON.parse(raw)) : [];
    } catch {
      return [];
    }
  },
  writeJournal,
  saveArchive: async (list: readonly ArchivedTable[]) => {
    if (list.length > 0) return save(KEYS.archive, list);
    try {
      await AsyncStorage.removeItem(KEYS.archive);
    } catch {
      /* noop */
    }
  },
  /** The age gate's answer (src/legal/age.ts); null until the player has given a birth year. */
  loadAgeRecord: async (): Promise<AgeRecord | null> => {
    try {
      const raw = await AsyncStorage.getItem(KEYS.age);
      return raw ? migrateAgeRecord(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  },
  saveAgeRecord: (r: AgeRecord) => save(KEYS.age, r),
  clearActiveSession: async () => {
    try {
      await AsyncStorage.removeItem(KEYS.session);
    } catch {
      /* noop */
    }
  },
};

/** Avatar ids (≤ 8 chars, the host trims longer values); drawn by components/Avatars.tsx. */
export const AVATARS = ['auntie', 'uncle', 'grandma', 'boss', 'lady', 'shades', 'hoops', 'cowboy', 'student', 'chef', 'sporty', 'gent'] as const;

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
