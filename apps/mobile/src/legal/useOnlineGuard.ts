/**
 * React side of src/legal/online.ts: the entry verdict for the screen rendering, from the age
 * gate, the remote config and the account status. Screens render the gate, the blocked screen or
 * the sign-in prompt for anything but 'ok', and connect only on 'ok'.
 */
import { useAuth } from '../auth/AuthProvider';
import { useRemoteConfig } from '../telemetry/RemoteConfig';
import { onlineEntry, type OnlineEntry } from './online';
import { useAgeGate } from './useAgeGate';

export function useOnlineGuard(): { entry: OnlineEntry; gate: ReturnType<typeof useAgeGate> } {
  const gate = useAgeGate();
  const { gate: remote } = useRemoteConfig();
  const auth = useAuth();
  return { entry: onlineEntry({ ageLoaded: gate.loaded, ageStatus: gate.status, gateKind: remote.kind, authStatus: auth.status }), gate };
}
