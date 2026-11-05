/**
 * Push wiring, mounted once inside the auth provider (renders nothing):
 * - keeps a registrar for the current game server and refreshes the token at launch when
 *   permission is already granted (it never prompts here; the club flow does);
 * - shows notifications that arrive while the app is open (except news of the table the player is at);
 * - follows a tapped notification or a `<scheme>://club|table/...` link to the club or the table.
 * On the web it does nothing.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { httpBase } from '../api/http';
import { APP_SCHEMES } from '../config';
import { createOnlineSession } from '../game/session';
import { currentLocale, t } from '../i18n';
import { gatingScreen, onlineEntry } from '../legal/online';
import { ageGateLoaded, useAgeGate } from '../legal/useAgeGate';
import { useRemoteConfig } from '../telemetry/RemoteConfig';
import { linkFromNotificationData, parseDeepLink, planLink, presentInForeground, type DeepLink } from './deeplink';
import { attachRegistrar } from './hub';
import { pushDevice } from './platform';
import { PushRegistrar } from './registration';

const devicePlatform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'web';

export function PushBridge() {
  const app = useApp();
  const auth = useAuth();
  const { config, gate } = useRemoteConfig();
  const age = useAgeGate();
  const appRef = useRef(app);
  appRef.current = app;
  const authRef = useRef(auth);
  authRef.current = auth;
  const configRef = useRef(config);
  configRef.current = config;
  const gateRef = useRef(gate);
  gateRef.current = gate;
  const pending = useRef<DeepLink[]>([]);
  const base = httpBase(app.signalUrl);
  const client = auth.client;

  const registrar = useMemo(
    () =>
      new PushRegistrar({
        platform: pushDevice,
        kv: { getItem: (k) => AsyncStorage.getItem(k), setItem: (k, v) => AsyncStorage.setItem(k, v) },
        base,
        auth: client,
        hasSession: () => client.snapshot().hasSession,
        userId: () => client.snapshot().userId,
        pushEnabled: () => configRef.current?.pushEnabled ?? null,
        devicePlatform,
        locale: currentLocale,
      }),
    [base, client],
  );

  const follow = useRef(async (l: DeepLink) => {
    const a = appRef.current;
    if (!a.loaded) {
      pending.current.push(l);
      return;
    }
    const plan = planLink(l, { roomCode: a.session?.roomCode ?? null });
    if (plan.kind === 'show-table') {
      if (a.screen.name !== 'table' && a.screen.name !== 'lobby') a.go({ name: 'table' });
      return;
    }
    // The same gate as every screen that goes online (src/legal/online.ts): a tap or a link never seats a player
    // the age gate has not let in, never acts behind the 'Update required' screen, and never bootstraps a guest
    // for a signed-out account. The link waits until the gate opens (the effect below follows it then).
    const ageNow = await ageGateLoaded();
    const entry = onlineEntry({ ageLoaded: ageNow.loaded, ageStatus: ageNow.status, gateKind: gateRef.current.kind, authStatus: authRef.current.status });
    if (entry !== 'ok') {
      pending.current.push(l);
      const screen = gatingScreen(entry, plan.kind === 'open-club' ? 'club' : 'table');
      if (screen && appRef.current.screen.name !== screen) appRef.current.go({ name: screen });
      return;
    }
    if (plan.kind === 'open-club') {
      a.go({ name: 'club', code: plan.club });
      return;
    }
    const fallback = () => a.go(plan.club ? { name: 'club', code: plan.club } : { name: 'online' });
    // Seated at another table: never walk away from it; show the club instead.
    if (a.session) return fallback();
    try {
      const au = authRef.current;
      const session = await createOnlineSession({
        signalUrl: a.signalUrl,
        name: a.profile.name || t('common.player'),
        avatar: a.profile.avatar,
        userId: au.user?.id || a.profile.userId || undefined,
        rules: a.settings.rules,
        action: 'join',
        code: plan.room,
        clubCode: plan.club,
        ...au.tableAuth,
      });
      a.setSession(session);
      a.go({ name: 'lobby' });
    } catch {
      fallback();
    }
  }).current;

  // Links that arrived before the saved state loaded (a cold start from a notification), or while the age gate,
  // the update screen or a sign-in stood in the way: followed once the way is clear.
  const entryNow = onlineEntry({ ageLoaded: age.loaded, ageStatus: age.status, gateKind: gate.kind, authStatus: auth.status });
  useEffect(() => {
    if (!app.loaded || entryNow !== 'ok' || !pending.current.length) return;
    const queued = pending.current;
    pending.current = [];
    for (const l of queued) void follow(l);
  }, [app.loaded, entryNow, follow]);

  useEffect(() => {
    if (!pushDevice.supported) return;
    const detach = attachRegistrar(registrar);
    pushDevice.configure((data) => presentInForeground(linkFromNotificationData(data, APP_SCHEMES), { roomCode: appRef.current.session?.roomCode ?? null }), t('privacy.push.channel'));
    const offOpen = pushDevice.onOpen((data) => {
      const l = linkFromNotificationData(data, APP_SCHEMES);
      if (l) void follow(l);
    });
    const offToken = pushDevice.onTokenRotated(() => void registrar.tokenChanged());
    return () => {
      detach();
      offOpen();
      offToken();
    };
  }, [registrar, follow]);

  // Token refresh at launch (and after signing in), only when permission was already granted.
  const hasServerAccount = auth.status !== 'offline';
  const pushEnabled = config?.pushEnabled;
  useEffect(() => {
    if (!pushDevice.supported || !hasServerAccount || pushEnabled === false) return;
    void registrar.refreshOnStart();
  }, [registrar, hasServerAccount, pushEnabled]);

  // `<scheme>://club/CODE` and `<scheme>://table/ROOM` links from outside the app.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const open = (url: string | null | undefined) => {
      const l = parseDeepLink(url, APP_SCHEMES);
      if (l) void follow(l);
    };
    void Linking.getInitialURL().then(open, () => undefined);
    const sub = Linking.addEventListener('url', (e) => open(e.url));
    return () => sub.remove();
  }, [follow]);

  return null;
}
