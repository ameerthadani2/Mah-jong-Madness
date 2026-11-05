/** Shapes from docs/API.md ("Game server API"), as the app reads them. */

export type Provider = 'apple' | 'google' | 'facebook';

export interface ApiUser {
  id: string;
  kind: 'guest' | 'account';
  displayName: string;
  avatar: string;
  locale: string;
  birthYear: number | null;
  createdAt: string;
}

export interface ApiSession {
  token: string;
  expiresAt: string;
}

export interface DeviceInfo {
  id: string;
  platform: 'ios' | 'android' | 'web';
  appBuild: string;
  locale: 'en' | 'zh-TW';
}

export interface ServerConfig {
  authProviders: Provider[];
  storeEnabled: boolean;
  pushEnabled: boolean;
  minBuild: number;
  maintenance: string | null;
  serverNow: string;
}

export interface Me {
  user: ApiUser;
  wallet: { diamonds: number; bonusDiamonds: number };
  entitlements: Array<{ entitlement: string; expiresAt: string | null }>;
  identities: Array<{ provider: string; email?: string }>;
  serverNow: string;
}

export interface MePatch {
  displayName?: string;
  avatar?: string;
  locale?: string;
  birthYear?: number | null;
}

/**
 * What the app keeps in secure storage for one game server (one JSON value, well under 2 KB).
 * `guestSecret` is the only way back into a guest account on a new install; it is dropped once
 * the guest has been merged into another account (it no longer opens anything).
 */
export interface StoredAuth {
  v: 1;
  userId: string;
  guestSecret: string | null;
  kind: 'guest' | 'account';
  displayName?: string;
  session: { token: string; expiresAt: string; refreshedAt: number } | null;
  /** The server said the token expired: try a refresh before anything else. */
  expired?: boolean;
  /**
   * The server refused this identity's session and (for a guest) its secret: it stays here, under
   * the player's name, until they sign in again or choose to start fresh. Never replaced on its own.
   */
  signedOut?: boolean;
}

/** Key-value secure storage (expo-secure-store on native, AsyncStorage on web; an in-memory map in tests). */
export interface SecureStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}
