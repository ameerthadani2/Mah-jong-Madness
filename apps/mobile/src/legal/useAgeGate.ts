/**
 * The age gate's state, shared by every screen that checks it (Home, Shop, Clubs). The
 * record loads once from storage; `confirm` saves it and, when the device has a server
 * session, gets it to the server by the rules in ./ageSync.ts: the server takes a birth year
 * once, so the year is sent only when the account has none (GET /api/me) or after quick match
 * answered `age_missing` (`sendToServer`), and `birth_year_locked` counts as already on file.
 */
import { markConsentGiven } from '../telemetry';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useAuth } from '../auth/AuthProvider';
import { storage } from '../storage';
import { ageStatus, needsServerSync, type AgeRecord, type AgeStatus } from './age';
import { ageSyncDone, sendBirthYear, syncBirthYear, type AgeSyncResult, type AgeSyncServer } from './ageSync';

let state: { loaded: boolean; record: AgeRecord | null } = { loaded: false, record: null };
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
/** One routine sync at a time, however many screens are showing the gate. */
let syncing: Promise<void> | null = null;

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
  syncing = null;
}

/** The server has this answer (or one of its own): remember that, unless the player has answered again since. */
async function markSynced(record: AgeRecord): Promise<void> {
  if (state.record && state.record.birthYear !== record.birthYear) return;
  const synced = { ...record, synced: true };
  set({ loaded: true, record: synced });
  await storage.saveAgeRecord(synced);
}

export interface AgeGateState {
  loaded: boolean;
  record: AgeRecord | null;
  status: AgeStatus;
  confirm(birthYear: number): void;
  /**
   * After quick match answered `age_missing`: send this device's year now, without asking first.
   * 'failed' also when the device has no year or no session.
   */
  sendToServer(): Promise<AgeSyncResult>;
}

export function useAgeGate(): AgeGateState {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const auth = useAuth();
  const client = auth.client;
  useEffect(ensureLoaded, []);

  const server = useMemo<AgeSyncServer>(
    () => ({
      birthYearOnFile: async () => (await client.getMe()).user.birthYear ?? null,
      sendBirthYear: (year) => client.updateMe({ birthYear: year }),
    }),
    [client],
  );

  const syncToServer = useCallback(
    (record: AgeRecord | null): Promise<void> => {
      if (!record || !needsServerSync(record, client.snapshot().hasSession)) return Promise.resolve();
      syncing ??= (async () => {
        // 'failed' (offline, or the server is down) leaves the record unsent for a later visit.
        if (ageSyncDone(await syncBirthYear(server, record.birthYear))) await markSynced(record);
      })().finally(() => {
        syncing = null;
      });
      return syncing;
    },
    [client, server],
  );

  const sendToServer = useCallback(async (): Promise<AgeSyncResult> => {
    const record = state.record;
    if (!record || !client.snapshot().hasSession) return 'failed';
    const result = await sendBirthYear(server, record.birthYear);
    if (ageSyncDone(result)) await markSynced(record);
    return result;
  }, [client, server]);

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
    sendToServer,
  };
}
