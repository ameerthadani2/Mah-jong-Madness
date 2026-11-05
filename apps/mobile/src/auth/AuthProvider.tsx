/**
 * React wiring for the AuthClient: one client per game server, exposed through `useAuth()`.
 *
 * Nothing contacts the server at launch. Screens that need it (Online, Clubs, creating or
 * joining a table) call `ensure()`, which bootstraps a guest the first time; when that fails
 * the app carries on offline and the screen shows `friendlyError(auth.error, t)`.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../app-state';
import { httpBase } from '../api/http';
import { GOOGLE_CLIENT_ID } from '../config';
import { visibleProviders, type SignInProvider } from '../logic/auth-config';
import { ApiError, AuthClient, type AuthSnapshot, type AuthStatus } from './client';
import { appleAvailable, deviceInfo, platformStore, signInWithApple, signInWithGoogle, type ProviderCredential } from './platform';
import type { Me, ServerConfig } from './types';

export interface ProviderState {
  id: SignInProvider;
  /** This account already signs in with it. */
  linked: boolean;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: { id: string; displayName: string | null; kind: 'guest' | 'account' } | null;
  /** Sign-in methods this device and server offer (empty offline or when none are configured). */
  providers: ProviderState[];
  /** How many sign-in methods (other than the guest secret) the account has. */
  linkedCount: number;
  busy: boolean;
  /** Last failure (show with friendlyError); cleared by the next success. */
  error: unknown;
  /** The client itself, for club calls and table sockets. */
  client: AuthClient;
  /** A usable session, bootstrapping a guest the first time. False (with `error` set) when the server cannot be reached. */
  ensure(): Promise<boolean>;
  /** These resolve true on success; a failure (not a cancelled sign-in) lands in `error`. */
  signInApple(): Promise<boolean>;
  signInGoogle(): Promise<boolean>;
  unlink(provider: SignInProvider): Promise<boolean>;
  signOut(): Promise<boolean>;
  deleteAccount(): Promise<boolean>;
  /** Re-read the server config and, when signed in, the account. */
  refresh(): Promise<void>;
  /** Push the local name and avatar to the server (debounced; skipped offline). */
  syncProfile(displayName: string, avatar: string): void;
  /** Spread into createOnlineSession: the session token for the table socket, and what to do on a 4401. */
  tableAuth: { auth: () => Promise<string>; onUnauthorised: () => Promise<void> };
}

const Ctx = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const app = useApp();
  const base = httpBase(app.signalUrl);
  const profileRef = useRef(app.profile);
  profileRef.current = app.profile;
  const client = useMemo(
    () => new AuthClient({ base, store: platformStore, device: deviceInfo, profile: () => ({ displayName: profileRef.current.name || undefined, avatar: profileRef.current.avatar }) }),
    [base],
  );
  const [snap, setSnap] = useState<AuthSnapshot>(client.snapshot());
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [apple, setApple] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authLoaded, setAuthLoaded] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setSnap(client.snapshot());
    setConfig(null);
    setMe(null);
    setAuthLoaded(false);
    const unsub = client.subscribe(setSnap);
    void client.load().then(() => setAuthLoaded(true));
    void appleAvailable().then(setApple);
    return unsub;
  }, [client]);

  // Profile.userId is the server id once there is one.
  const { loaded, profile, setProfile } = app;
  useEffect(() => {
    if (!loaded || !authLoaded) return;
    const id = snap.userId ?? '';
    if (id !== profile.userId) setProfile({ ...profile, userId: id });
  }, [loaded, authLoaded, snap.userId, profile, setProfile]);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await client.getConfig());
    } catch {
      /* no buttons until the server answers */
    }
  }, [client]);

  const loadMe = useCallback(async () => {
    try {
      setMe(await client.getMe());
    } catch (e) {
      setError(e);
    }
  }, [client]);

  const ensure = useCallback(async () => {
    try {
      await client.ensureSession();
      setError(null);
      void loadConfig();
      return true;
    } catch (e) {
      setError(e);
      return false;
    }
  }, [client, loadConfig]);

  const refresh = useCallback(async () => {
    await loadConfig();
    if (client.snapshot().status !== 'offline') await loadMe();
  }, [client, loadConfig, loadMe]);

  const run = useCallback(async (job: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    try {
      await job();
      setError(null);
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  /** Guests link (an existing account absorbs the guest); a device with no account yet tries signing in first. */
  const signIn = useCallback(
    (provider: SignInProvider, get: () => Promise<ProviderCredential | null>) =>
      run(async () => {
        const cred = await get();
        if (!cred) return;
        if (client.snapshot().status === 'offline') {
          try {
            await client.loginWithProvider(provider, cred.token, cred.nonce);
            setMe(await client.getMe());
            return;
          } catch (e) {
            if (!(e instanceof ApiError && e.code === 'not_linked')) throw e;
          }
          await client.ensureSession();
        }
        await client.link(provider, cred.token, cred.nonce, cred.email);
        setMe(await client.getMe());
      }),
    [client, run],
  );

  const value = useMemo<AuthContextValue>(() => {
    const linked = new Set((me?.identities ?? []).map((i) => i.provider).filter((p) => p !== 'guest'));
    const providers = visibleProviders({ serverProviders: config?.authProviders ?? null, appleAvailable: apple, googleClientId: GOOGLE_CLIENT_ID }).map((id) => ({ id, linked: linked.has(id) }));
    return {
      status: snap.status,
      user: snap.userId ? { id: snap.userId, displayName: snap.displayName, kind: snap.status === 'account' ? 'account' : 'guest' } : null,
      providers,
      linkedCount: linked.size,
      busy,
      error,
      client,
      ensure,
      refresh,
      tableAuth: { auth: () => client.ensureSession(), onUnauthorised: () => client.invalidate() },
      signInApple: () => signIn('apple', signInWithApple),
      signInGoogle: () => signIn('google', () => (GOOGLE_CLIENT_ID ? signInWithGoogle(GOOGLE_CLIENT_ID) : Promise.resolve(null))),
      unlink: (provider) =>
        run(async () => {
          await client.unlink(provider);
          setMe(await client.getMe());
        }),
      signOut: () =>
        run(async () => {
          await client.logout();
          setMe(null);
        }),
      deleteAccount: () =>
        run(async () => {
          await client.deleteAccount();
          setMe(null);
        }),
      syncProfile: (displayName, avatar) => {
        if (syncTimer.current) clearTimeout(syncTimer.current);
        syncTimer.current = setTimeout(() => {
          if (!client.snapshot().hasSession) return;
          void client.updateMe({ displayName: displayName.trim() || undefined, avatar }).catch(() => undefined);
        }, 800);
      },
    };
  }, [snap, me, config, apple, busy, error, client, ensure, refresh, signIn, run]);

  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
