/**
 * The age gate's state, shared by every screen that checks it (Home, Shop, Clubs). The
 * record loads once from storage; `confirm` saves it and, when the device has a server
 * session, sends it with PATCH /api/me (retried by `syncToServer` on later visits).
 */
import { markConsentGiven } from '../telemetry';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { storage } from '../storage';
import { ageStatus, needsServerSync, type AgeRecord, type AgeStatus } from './age';

let state: { loaded: boolean; record: AgeRecord | null } = { loaded: false, record: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(next: typeof state): void {
  state = next;
  for (const l of listeners) l();
}

function ensureLoaded(): void {
  loading ??= storage.loadAgeRecord().then((record) => set({ loaded: true, record: state.record ?? record }));
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const snapshot = () => state;

/** The gate's answer outside a render (a deep link or notification handler): loads it if nothing has yet. */
export function ageGateState(): { loaded: boolean; status: AgeStatus } {
  ensureLoaded();
  return { loaded: state.loaded, status: ageStatus(state.record, new Date().getFullYear()) };
}

/** Resolves once the stored answer has been read (at once when it already has). */
export function ageGateLoaded(): Promise<{ loaded: boolean; status: AgeStatus }> {
  ensureLoaded();
  return loading!.then(ageGateState);
}

/** For tests: forget the loaded answer so the next read starts again from storage. */
export function resetAgeGateForTests(): void {
  state = { loaded: false, record: null };
  loading = null;
}

export function useAgeGate(): { loaded: boolean; record: AgeRecord | null; status: AgeStatus; confirm(birthYear: number): void } {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const auth = useAuth();
  const client = auth.client;
  useEffect(ensureLoaded, []);

  const syncToServer = useCallback(
    async (record: AgeRecord | null) => {
      if (!needsServerSync(record, client.snapshot().hasSession)) return;
      try {
        await client.updateMe({ birthYear: record!.birthYear });
        const synced = { ...record!, synced: true };
        set({ loaded: true, record: synced });
        await storage.saveAgeRecord(synced);
      } catch {
        /* offline: try again on a later visit */
      }
    },
    [client],
  );

  // Send an unsent answer once the device has an account.
  const userId = auth.user?.id;
  useEffect(() => {
    if (userId) void syncToServer(state.record);
  }, [userId, s.loaded, syncToServer]);

  return {
    loaded: s.loaded,
    record: s.record,
    status: ageStatus(s.record, new Date().getFullYear()),
    confirm: (birthYear) => {
      const record: AgeRecord = { birthYear, at: Date.now(), synced: false };
      // Analytics may start only after this answer; under-18s keep it off by default.
      markConsentGiven({ minor: new Date().getFullYear() - birthYear < 18 });
      set({ loaded: true, record });
      void storage.saveAgeRecord(record).then(() => syncToServer(record));
    },
  };
}
