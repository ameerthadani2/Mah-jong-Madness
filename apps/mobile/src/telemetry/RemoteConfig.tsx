/**
 * Reads `GET /api/config` at launch and whenever the app returns to the foreground, and exposes
 * the update gate (`minBuild`), the maintenance message and `pushEnabled`. With no server
 * reachable the config stays null and nothing is shown.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { useApp } from '../app-state';
import { globalFetch, httpBase } from '../api/http';
import { NATIVE_BUILD } from '../config';
import { fetchRemoteConfig, gateState, type GateState, type RemoteConfig } from './remote-config';

interface RemoteConfigValue {
  config: RemoteConfig | null;
  gate: GateState;
}

const Ctx = createContext<RemoteConfigValue>({ config: null, gate: { kind: 'open', maintenance: null } });

export function RemoteConfigProvider({ children }: { children: React.ReactNode }) {
  const { loaded, signalUrl } = useApp();
  const [config, setConfig] = useState<RemoteConfig | null>(null);

  useEffect(() => {
    if (!loaded) return;
    const base = httpBase(signalUrl);
    let live = true;
    const load = () =>
      void fetchRemoteConfig(globalFetch, base).then((c) => {
        // A failed refresh keeps what the server said last: a flaky network never lifts a block.
        if (live && c) setConfig(c);
      });
    load();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') load();
    });
    return () => {
      live = false;
      sub.remove();
    };
  }, [loaded, signalUrl]);

  const value = useMemo(() => ({ config, gate: gateState(config, NATIVE_BUILD) }), [config]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRemoteConfig(): RemoteConfigValue {
  return useContext(Ctx);
}
