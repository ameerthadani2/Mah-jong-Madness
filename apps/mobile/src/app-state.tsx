import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler } from 'react-native';
import { DEFAULT_PROFILE, DEFAULT_PROGRESS, DEFAULT_SETTINGS, storage, type ActiveSession, type Profile, type Progress, type Settings } from './storage';
import type { Session } from './game/session';
import { resolveSignalUrl } from './config';
import { EMPTY_WALLET, loadWallet, saveWallet, type Wallet } from './monetisation/store';
import { setLocalePreference } from './i18n';

export type Screen =
  | { name: 'home' }
  | { name: 'online' }
  | { name: 'clubs' }
  | { name: 'club'; code: string }
  | { name: 'lobby' }
  | { name: 'table' }
  | { name: 'review' }
  | { name: 'fairness' }
  | { name: 'learn' }
  | { name: 'lesson'; id: string }
  | { name: 'drill'; kind: 'discard' | 'waits' }
  | { name: 'daily' }
  | { name: 'rush' }
  | { name: 'shop' }
  | { name: 'settings' };

interface AppState {
  screen: Screen;
  go(screen: Screen): void;
  back(): void;
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
  setSession(s: Session | null): void;
  /** Persisted pointer to a table that can be resumed after a crash/relaunch. */
  activeSession: ActiveSession | null;
  setActiveSession(s: ActiveSession | null): void;
  wallet: Wallet;
  setWallet(w: Wallet): void;
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
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // Android hardware back pops the screen stack instead of leaving the app.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      let handled = false;
      setStack((st) => {
        handled = st.length > 1;
        return handled ? st.slice(0, -1) : st;
      });
      return handled;
    });
    return () => sub.remove();
  }, []);

  // Keep the resumable-session record in sync with whatever table we are at.
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
          ? { kind: 'local', host: session.host!.serialize(), token: st.token, name: profile.name, avatar: profile.avatar, savedAt: Date.now() }
          : { kind: 'online', signalUrl: session.serverUrl ?? signalUrl, roomCode: session.roomCode, token: st.token, name: profile.name, avatar: profile.avatar, clubCode: session.clubCode, savedAt: Date.now() };
      setActiveSessionState(record);
      void storage.saveActiveSession(record);
    };
    const schedule = () => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(save, 400);
    };
    // The session forwards state from whichever client is current (a reconnect swaps it).
    const unsubClient = session.onChange(schedule);
    const unsubHost = session.host?.onChange(schedule);
    schedule();
    return () => {
      unsubClient();
      unsubHost?.();
      if (persistTimer.current) clearTimeout(persistTimer.current);
    };
  }, [session, profile.name, profile.avatar, signalUrl]);

  const value = useMemo<AppState>(
    () => ({
      screen: stack[stack.length - 1],
      go: (screen) => setStack((st) => [...st, screen]),
      back: () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)),
      reset: (screen) => setStack([screen]),
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
      setSession: (s) => {
        setSessionState((prev) => {
          if (prev && prev !== s) prev.close();
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
      loaded,
    }),
    [stack, profile, settings, signalUrl, progress, session, activeSession, wallet, loaded],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
