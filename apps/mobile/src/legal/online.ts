/**
 * The one rule for reaching the game server with a seat or a club: every way in (the Online and
 * Clubs screens, resuming a table from Home, a club screen, a notification tap or a deep link)
 * asks this before it connects, so none of them can skip the age gate, the 'Update required'
 * block or a sign-in the server now demands. Pure; src/legal/useOnlineGuard.ts wires it to React
 * and src/push/PushBridge.tsx reads the same inputs outside a render.
 */
import type { AuthStatus } from '../auth/client';
import type { AgeStatus } from './age';

export type OnlineEntry =
  /** The age answer has not loaded yet: wait, never connect. */
  | 'wait'
  /** This build is below the server's minimum: nothing online, the update screen is up. */
  | 'update'
  /** No birth year yet: show the age gate first. */
  | 'ask'
  /** Under the age limit: the blocked screen, nothing online. */
  | 'blocked'
  /** The stored account needs a fresh sign-in before the server lets it in. */
  | 'sign_in'
  | 'ok';

export interface OnlineEntryInputs {
  ageLoaded: boolean;
  ageStatus: AgeStatus;
  /** `gate.kind` from the remote config ('open' when no server has answered). */
  gateKind: 'open' | 'update';
  authStatus: AuthStatus;
}

export function onlineEntry(o: OnlineEntryInputs): OnlineEntry {
  if (o.gateKind === 'update') return 'update';
  if (!o.ageLoaded) return 'wait';
  if (o.ageStatus === 'blocked') return 'blocked';
  if (o.ageStatus !== 'allowed') return 'ask';
  if (o.authStatus === 'signed_out') return 'sign_in';
  return 'ok';
}

/** Which screen shows the gate for a refused entry: Online for tables, Clubs for a club. */
export function gatingScreen(entry: OnlineEntry, target: 'table' | 'club'): 'online' | 'clubs' | null {
  if (entry === 'ok' || entry === 'wait' || entry === 'update') return null;
  return target === 'club' ? 'clubs' : 'online';
}
