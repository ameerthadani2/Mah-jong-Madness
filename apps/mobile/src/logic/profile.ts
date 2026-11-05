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
}

export const DEFAULT_PROFILE: Profile = { userId: '', name: '', avatar: 'lady' };

/** Old client-made ids looked like this; server ids are UUIDs. */
const LEGACY_ID = /^user-[0-9a-f]+$/i;

export function migrateProfile(saved: unknown): Profile {
  const raw = saved && typeof saved === 'object' ? (saved as Record<string, unknown>) : {};
  const userId = typeof raw.userId === 'string' && !LEGACY_ID.test(raw.userId) ? raw.userId : '';
  const name = typeof raw.name === 'string' ? raw.name : DEFAULT_PROFILE.name;
  const avatar = typeof raw.avatar === 'string' && raw.avatar ? raw.avatar : DEFAULT_PROFILE.avatar;
  return { userId, name, avatar };
}
