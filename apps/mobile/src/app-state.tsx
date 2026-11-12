import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Platform } from 'react-native';
import { DEFAULT_PROFILE, DEFAULT_PROGRESS, DEFAULT_SETTINGS, storage, type ActiveSession, type Profile, type Progress, type Settings } from './storage';
import { saveScheduler } from './game/persist';
import { setSavedClientSource, type CloseOptions, type Session } from './game/session';
import { acceptedName } from './logic/profile';
import { backToDealtTable, betweenHands, hardwareBackPlan } from './logic/back';
import { APP_BUILD, resolveSignalUrl } from './config';
import { EMPTY_WALLET, loadWallet, saveWallet, type Wallet } from './monetisation/store';
import { currentLocale, setLocalePreference } from './i18n';
import { track, trackAll } from './telemetry';
import { EMPTY_TABLE_WATCH, matchMode, matchStartEvent, progressEvents, screenEvents, tableEvents } from './telemetry/events';
import { requestPushAfterClub } from './push/hub';

export type Screen =
  | { name: 'home' }
  | { name: 'online'; /** Why a table link or notification could not be followed, shown once on arrival. */ notice?: string }
  | { name: 'quickmatch' }
  | { name: 'clubs' }
  | { name: 'club'; code: string; /** Why a link to one of the club's tables could not be followed. */ notice?: string }
  | { name: 'lobby' }
  | { name: 'table'; /** Set when the table took the player back from Review or Fair play because the next hand was dealt (src/logic/back.ts). */ returnedAt?: number }
  | { name: 'review' }
  | { name: 'fairness' }
  | { name: 'learn' }
  | { name: 'lesson'; id: string }
  | { name: 'drill'; kind: 'discard' | 'waits' }
  | { name: 'daily' }
  | { name: 'rush' }
  | { name: 'shop'; focus?: 'fourwinds' }
  | { name: 'settings' };

interface AppState {
  screen: Screen;
  go(screen: Screen): void;
  back(): void;
  /**
   * The Android hardware Back key (src/logic/back.ts): pops a screen, or at a live table asks the screen on
   * top to answer it (`useHardwareBack`). Returns false when the system should handle the key.
   */
  hardwareBack(): boolean;
  /** Counts the Back presses handed to the screen on top; `useHardwareBack` follows it. */
  backAsked: number;
  /** Replace the whole stack (e.g. after leaving a table). */
  reset(screen: Screen): void;
  profile: Profile;
  setProfile(p: Profile): void;
  settings: Settings;
  setSettings(s: Settings): void;
  /** The game server for this launch (from the build, or a development override). */
  signalUrl: string;
  progress: Progress;
  setProgress(p: Progress | ((prev: Progress) => Progress)): void;
  session: Session | null;
  /** Replaces the table; the one before it is closed (`closing.keepSeat`: without giving its seat up, game/session.ts). */
  setSession(s: Session | null, closing?: CloseOptions): void;
  /** Persisted pointer to a table that can be resumed after a crash/relaunch. */
  activeSession: ActiveSession | null;
  setActiveSession(s: ActiveSession | null): void;
  wallet: Wallet;
  setWallet(w: Wallet): void;
  /**
   * The player just created or joined a club (call it after the server said yes, including a
   * join waiting for approval): counts the funnel step and, the first time, asks for
   * notification permission so they hear about tables and approvals.
   */
  clubJoined(kind: 'create' | 'join', status?: 'joined' | 'pending' | 'already'): void;
  loaded: boolean;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<Screen[]>([{ name: 'home' }]);
  const [profile, setProfileState] = useState<Profile>(DEFAULT_PROFILE);
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [progress, setProgressState] = useState<Progress>(DEFAULT_PROGRESS);
  const [session, setSessionState] = useState<Session | null>(null);
  const [activeSession, setActiveSessionState] = useState<ActiveSession | null>(null);
  const [wallet, setWalletState] = useState<Wallet>(EMPTY_WALLET);
  const [loaded, setLoaded] = useState(false);
  const signalUrl = resolveSignalUrl(settings.devSignalUrl);

  useEffect(() => {
    void Promise.all([storage.loadProfile(), storage.loadSettings(), storage.loadProgress(), storage.loadActiveSession(), loadWallet()]).then(([p, s, pr, as, w]) => {
      setProfileState(p);
      // Apply the saved language before the first loaded render so the UI never flips.
      setLocalePreference(s.locale);
      setSettingsState(s);
      setProgressState(pr);
      setActiveSessionState(as);
      setWalletState(w);
      setLoaded(true);
    });
  }, []);

  // Funnel: one app_open per launch, once the saved language is known.
  useEffect(() => {
    if (loaded) track('app_open', { platform: Platform.OS, build: APP_BUILD, locale: currentLocale() });
  }, [loaded]);

  // Funnel: lessons finished and puzzles answered, from each progress change after the saved progress loaded.
  const lastProgress = useRef<Progress | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const prev = lastProgress.current;
    lastProgress.current = progress;
    if (prev && prev !== progress) trackAll(progressEvents(prev, progress));
  }, [loaded, progress]);

  // Funnel: match_start for each new table, then hand_over and audit_failed as it plays.
  const botSkill = useRef(settings.botSkill);
  botSkill.current = settings.botSkill;
  useEffect(() => {
    if (!session) return;
    trackAll([matchStartEvent(session, botSkill.current)]);
    const mode = matchMode(session);
    // A resumed table already shows its last result: start from it without reporting it again.
    let watch = tableEvents(EMPTY_TABLE_WATCH, session.client.state, mode).watch;
    return session.onChange((st) => {
      const r = tableEvents(watch, st, mode);
      watch = r.watch;
      trackAll(r.events);
    });
  }, [session]);

  // Android hardware back pops the screen stack instead of leaving the app, except at a live table, where the
  // table (or its lobby) answers it: popping would leave the match running unseen (src/logic/back.ts).
  // (The web has no such key and logs an error for the listener.)
  const [backAsked, setBackAsked] = useState(0);
  const backRef = useRef({ stack, session });
  backRef.current = { stack, session };
  const hardwareBack = useRef((): boolean => {
    const plan = hardwareBackPlan(backRef.current.stack, backRef.current.session !== null);
    if (plan === 'ask') setBackAsked((n) => n + 1);
    else if (plan === 'pop') setStack((st) => (st.length > 1 ? st.slice(0, -1) : st));
    return plan !== 'system';
  }).current;
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', hardwareBack);
    return () => sub.remove();
  }, [hardwareBack]);

  // The next hand dealt while Review or Fair play is open over the table: back to the table, where the player's
  // clock is running (src/logic/back.ts). The table says why for a few seconds.
  useEffect(() => {
    if (!session) return;
    let waiting = betweenHands(session.client.state);
    return session.onChange((st) => {
      if (waiting && !betweenHands(st)) setStack((stk) => backToDealtTable(stk, Date.now()) as Screen[]);
      waiting = betweenHands(st);
    });
  }, [session]);

  // A cold resume (Home's Resume card) restores the saved table client's record when it is for the same table and seat.
  const activeRef = useRef<ActiveSession | null>(null);
  activeRef.current = activeSession;
  useEffect(() => {
    setSavedClientSource((url, room, token) => {
      const rec = activeRef.current;
      return rec?.kind === 'online' && rec.signalUrl === url && rec.roomCode === room && rec.token === token ? rec.client : undefined;
    });
    return () => setSavedClientSource(null);
  }, []);

  // Keep the resumable-session record in sync with whatever table we are at. A name the server refused
  // is not carried into it (the resume falls back to "Player").
  const shown = acceptedName(profile);
  useEffect(() => {
    if (!session) return;
    const save = () => {
      const st = session.client.state;
      if (st.matchOver) {
        setActiveSessionState(null);
        void storage.clearActiveSession();
        return;
      }
      if (!st.token) return;
      const record: ActiveSession =
        session.mode === 'local'
          ? { kind: 'local', host: session.host!.serialize(), token: st.token, name: shown, avatar: profile.avatar, savedAt: Date.now() }
          : {
              kind: 'online',
              signalUrl: session.serverUrl ?? signalUrl,
              roomCode: session.roomCode,
              token: st.token,
              name: shown,
              avatar: profile.avatar,
              clubCode: session.clubCode,
              quickMatch: session.quickMatch || undefined,
              client: session.client.serialize(),
              savedAt: Date.now(),
            };
      setActiveSessionState(record);
      void storage.saveActiveSession(record);
    };
    // Saved a moment after a change, or at once while the client is agreeing a deal (src/game/persist.ts).
    const scheduler = saveScheduler(save);
    // The session forwards its client's state (one client per table, kept across reconnects).
    // A local table's record holds its host, not the client's record: nothing there is worth an early write.
    const unsubClient = session.onChange((st) => scheduler.changed(session.mode === 'local' ? undefined : st.ceremony));
    const unsubHost = session.host?.onChange(() => scheduler.changed());
    scheduler.changed();
    return () => {
      unsubClient();
      unsubHost?.();
      scheduler.cancel();
    };
  }, [session, shown, profile.avatar, signalUrl]);

  const value = useMemo<AppState>(
    () => ({
      screen: stack[stack.length - 1],
      go: (screen) => {
        trackAll(screenEvents(screen, stack[stack.length - 1]));
        setStack((st) => [...st, screen]);
      },
      back: () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)),
      hardwareBack,
      backAsked,
      reset: (screen) => {
        trackAll(screenEvents(screen, stack[stack.length - 1]));
        setStack([screen]);
      },
      profile,
      setProfile: (p) => {
        setProfileState(p);
        void storage.saveProfile(p);
      },
      settings,
      setSettings: (s) => {
        if (s.locale !== settings.locale) setLocalePreference(s.locale);
        setSettingsState(s);
        void storage.saveSettings(s);
      },
      signalUrl,
      progress,
      setProgress: (p) => {
        setProgressState((prev) => {
          const next = typeof p === 'function' ? p(prev) : p;
          void storage.saveProgress(next);
          return next;
        });
      },
      session,
      setSession: (s, closing) => {
        setSessionState((prev) => {
          if (prev && prev !== s) prev.close(closing);
          return s;
        });
      },
      activeSession,
      setActiveSession: (s) => {
        setActiveSessionState(s);
        if (s) void storage.saveActiveSession(s);
        else void storage.clearActiveSession();
      },
      wallet,
      setWallet: (w) => {
        setWalletState(w);
        void saveWallet(w);
      },
      clubJoined: (kind, status = 'joined') => {
        if (kind === 'create') track('club_create', {});
        else track('club_join', { status });
        void requestPushAfterClub();
      },
      loaded,
    }),
    [stack, profile, settings, signalUrl, progress, session, activeSession, wallet, loaded, hardwareBack, backAsked],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Answer the hardware Back key on a screen the provider does not pop by itself (a live table and its lobby):
 * `onBack` runs once for each press made while this screen is mounted.
 */
export function useHardwareBack(onBack: () => void): void {
  const { backAsked } = useApp();
  const seen = useRef(backAsked);
  const handler = useRef(onBack);
  handler.current = onBack;
  useEffect(() => {
    if (backAsked === seen.current) return;
    seen.current = backAsked;
    handler.current();
  }, [backAsked]);
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
