/**
 * Small fakes of the app's context providers for render tests (*.render.test.tsx, jest.config.js). A screen under test
 * reads the app state and the sign-in state from these instead of the real providers, which load storage and talk to
 * the server. The fake app state keeps the table, the saved table, the wallet and the screen in React state, so a screen
 * re-renders when it changes them, and hands every change to the override of the same name when a test passes one.
 */
import React, { useMemo, useState } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppStateContext, type AppState, type Screen } from '../app-state';
import { AuthContext, type AuthContextValue } from '../auth/AuthProvider';
import type { AuthClient, AuthSnapshot } from '../auth/client';
import type { Session } from '../game/session';
import { DEFAULT_PROFILE, DEFAULT_PROGRESS, DEFAULT_SETTINGS, type ActiveSession } from '../storage';
import { EMPTY_WALLET, type Wallet } from '../monetisation/wallet';

const done = async () => true;

/** A phone in portrait with no notch, so the safe area adds nothing (the real provider wraps the app in App.tsx). */
const PHONE = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } };

/**
 * The sign-in client of a device that has never reached the server: it says so when asked, and any call that would
 * reach the server is a test mistake, so it fails loudly.
 */
const OFFLINE: AuthSnapshot = { status: 'offline', userId: null, displayName: null, kind: null, hasSession: false, banned: false };
const offlineClient = new Proxy(
  { snapshot: () => OFFLINE, subscribe: () => () => undefined },
  { get: (known, key) => (key in known ? known[key as keyof typeof known] : () => Promise.reject(new Error(`fake auth client: ${String(key)} called`))) },
) as unknown as AuthClient;

/**
 * The sign-in client of a guest with a session on the server: it hands out a token for requests, which a test answers
 * with its own stand-in for the server (globalThis.fetch).
 */
export function sessionClient(userId: string): AuthClient {
  const snap: AuthSnapshot = { status: 'guest', userId, displayName: null, kind: 'guest', hasSession: true, banned: false };
  const known = { snapshot: () => snap, subscribe: () => () => undefined, token: async () => 'test-token', onUnauthorised: async () => undefined };
  return new Proxy(known, {
    get: (k, key) => (key in k ? k[key as keyof typeof k] : () => Promise.reject(new Error(`fake auth client: ${String(key)} called`))),
  }) as unknown as AuthClient;
}

/** A device with no server session: offline, no account, nothing linked. */
export function fakeAuth(over: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    status: 'offline',
    banned: false,
    user: null,
    providers: [],
    linkedCount: 0,
    busy: false,
    error: null,
    client: offlineClient,
    ensure: async () => false,
    signInApple: done,
    signInGoogle: done,
    unlink: done,
    signOut: done,
    deleteAccount: done,
    startFresh: done,
    refresh: async () => undefined,
    syncProfile: () => undefined,
    tableAuth: { auth: async () => 'token', onUnauthorised: async () => undefined, onBanned: async () => undefined },
    ...over,
  };
}

export function FakeProviders({ app = {}, auth = {}, children }: { app?: Partial<AppState>; auth?: Partial<AuthContextValue>; children: React.ReactNode }) {
  const [screen, setScreen] = useState<Screen>(app.screen ?? { name: 'home' });
  const [session, setSession] = useState<Session | null>(app.session ?? null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(app.activeSession ?? null);
  const [wallet, setWallet] = useState<Wallet>(app.wallet ?? EMPTY_WALLET);
  const [profile, setProfile] = useState(app.profile ?? DEFAULT_PROFILE);
  const [settings, setSettings] = useState(app.settings ?? DEFAULT_SETTINGS);
  const [progress, setProgress] = useState(app.progress ?? DEFAULT_PROGRESS);
  const value = useMemo<AppState>(
    () => ({
      backAsked: 0,
      signalUrl: 'http://127.0.0.1:1',
      loaded: true,
      hardwareBack: () => false,
      back: () => undefined,
      clubJoined: () => undefined,
      ...app,
      screen,
      go: (s) => {
        setScreen(s);
        app.go?.(s);
      },
      reset: (s) => {
        setScreen(s);
        app.reset?.(s);
      },
      session,
      setSession: (s, closing) => {
        setSession(s);
        app.setSession?.(s, closing);
      },
      activeSession,
      setActiveSession: (s) => {
        setActiveSession(s);
        app.setActiveSession?.(s);
      },
      wallet,
      setWallet: (w) => {
        setWallet(w);
        app.setWallet?.(w);
      },
      profile,
      setProfile,
      settings,
      setSettings,
      progress,
      setProgress,
    }),
    // The overrides are fixed for a test's render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [screen, session, activeSession, wallet, profile, settings, progress],
  );
  const authValue = useMemo(() => fakeAuth(auth), [auth]);
  return (
    <SafeAreaProvider initialMetrics={PHONE}>
      <AuthContext.Provider value={authValue}>
        <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>
      </AuthContext.Provider>
    </SafeAreaProvider>
  );
}
