import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { DEFAULT_PROFILE, DEFAULT_PROGRESS, DEFAULT_SETTINGS, storage, type Profile, type Progress, type Settings } from './storage';
import type { Session } from './game/session';

export type Screen =
  | { name: 'home' }
  | { name: 'online' }
  | { name: 'lobby' }
  | { name: 'table' }
  | { name: 'learn' }
  | { name: 'lesson'; id: string }
  | { name: 'drill'; kind: 'discard' | 'waits' }
  | { name: 'settings' };

interface AppState {
  screen: Screen;
  go(screen: Screen): void;
  back(): void;
  profile: Profile;
  setProfile(p: Profile): void;
  settings: Settings;
  setSettings(s: Settings): void;
  progress: Progress;
  setProgress(p: Progress | ((prev: Progress) => Progress)): void;
  session: Session | null;
  setSession(s: Session | null): void;
  loaded: boolean;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [stack, setStack] = useState<Screen[]>([{ name: 'home' }]);
  const [profile, setProfileState] = useState<Profile>(DEFAULT_PROFILE);
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [progress, setProgressState] = useState<Progress>(DEFAULT_PROGRESS);
  const [session, setSessionState] = useState<Session | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void Promise.all([storage.loadProfile(), storage.loadSettings(), storage.loadProgress()]).then(([p, s, pr]) => {
      setProfileState(p);
      setSettingsState(s);
      setProgressState(pr);
      setLoaded(true);
    });
  }, []);

  const value = useMemo<AppState>(
    () => ({
      screen: stack[stack.length - 1],
      go: (screen) => setStack((st) => [...st, screen]),
      back: () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st)),
      profile,
      setProfile: (p) => {
        setProfileState(p);
        void storage.saveProfile(p);
      },
      settings,
      setSettings: (s) => {
        setSettingsState(s);
        void storage.saveSettings(s);
      },
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
      loaded,
    }),
    [stack, profile, settings, progress, session, loaded],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
