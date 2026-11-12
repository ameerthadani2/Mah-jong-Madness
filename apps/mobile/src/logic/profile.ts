/**
 * The saved local profile. `userId` is the game server's account id once the app has
 * bootstrapped a guest (empty before); the display name and avatar stay local and are
 * pushed to the server with PATCH /api/me when online.
 *
 * Builds before accounts made up their own `user-<hex>` id and a device secret for the
 * clubs API (trust on first use). Those are dropped: the server no longer accepts them.
 */
export interface Profile {
  /** Server account id, or '' until the app first needs the server. */
  userId: string;
  name: string;
  avatar: string;
  /**
   * A name the game server refused (its name check, docs/API.md "Names"): set when a guest sign-up
   * answers `nameRefused` or PATCH /api/me answers `name_not_allowed`. While `name` is still that
   * name the account has no display name on the server, so the app does not show it as the player's
   * and asks for another (Settings, Profile).
   */
  refusedName?: string;
}

export const DEFAULT_PROFILE: Profile = { userId: '', name: '', avatar: 'lady' };

/** Old client-made ids looked like this; server ids are UUIDs. */
const LEGACY_ID = /^user-[0-9a-f]+$/i;

export function migrateProfile(saved: unknown): Profile {
  const raw = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
  const userId = typeof raw.userId === 'string' && !LEGACY_ID.test(raw.userId) ? raw.userId : '';
  const name = typeof raw.name === 'string' ? raw.name : DEFAULT_PROFILE.name;
  const avatar = typeof raw.avatar === 'string' && raw.avatar ? raw.avatar : DEFAULT_PROFILE.avatar;
  const refusedName = typeof raw.refusedName === 'string' && raw.refusedName ? raw.refusedName : undefined;
  return refusedName === undefined ? { userId, name, avatar } : { userId, name, avatar, refusedName };
}

/** Whether the saved name is one the server has refused (and the player has not changed it since). */
export function isNameRefused(p: Pick<Profile, 'name' | 'refusedName'>): boolean {
  return p.refusedName !== undefined && p.name.trim() !== '' && p.name.trim() === p.refusedName;
}

/**
 * The name to show as the player's and to send to a server: empty while the saved one is refused, so
 * callers fall back to the generic "Player" exactly as they do for a player who never typed a name.
 */
export function acceptedName(p: Pick<Profile, 'name' | 'refusedName'>): string {
  return isNameRefused(p) ? '' : p.name;
}

/** The server refused `sent`: remember that, unless the player has typed another name in the meantime. */
export function withRefusedName(p: Profile, sent: string): Profile {
  const refused = sent.trim();
  if (!refused || p.name.trim() !== refused || p.refusedName === refused) return p;
  return { ...p, refusedName: refused };
}

/** The server accepted `sent` as the display name: an old refusal of that same name no longer holds. */
export function withAcceptedName(p: Profile, sent: string): Profile {
  if (p.refusedName === undefined || p.refusedName !== sent.trim()) return p;
  const { refusedName: _dropped, ...rest } = p;
  return rest;
}
