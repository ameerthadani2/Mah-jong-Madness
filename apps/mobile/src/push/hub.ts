/**
 * Where the rest of the app reaches push. <PushBridge> (inside the auth provider) attaches the
 * registrar for the current game server; everything else only says when a good moment to ask has come.
 */
import type { PushRegistrar, PushResult } from './registration';

let current: PushRegistrar | null = null;

/** PushBridge attaches the registrar for the current server; the returned function detaches it. */
export function attachRegistrar(r: PushRegistrar): () => void {
  current = r;
  return () => {
    if (current === r) current = null;
  };
}

/** Just after creating or joining a club: ask for notification permission once, then register. */
export function requestPushAfterClub(): Promise<PushResult> {
  return current ? current.requestAfterClub() : Promise.resolve('no-session');
}

/** After a sign-out or account deletion: the token registered for that account is forgotten here, so the next account re-sends it. */
export function forgetPushRegistration(): Promise<void> {
  return current ? current.forget() : Promise.resolve();
}
