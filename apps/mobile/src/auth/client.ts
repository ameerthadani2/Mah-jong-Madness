/**
 * The app's side of the account API (docs/API.md): guest bootstrap, session upkeep, provider
 * sign-in and account deletion. Pure TypeScript with `fetch` and the secure store injected, so
 * the whole state machine runs in tests with fakes; React wiring lives in ./AuthProvider.tsx.
 *
 * Nothing here talks to the server until something asks for a session (`ensureSession`), so the
 * app launches and plays offline without ever bootstrapping.
 */
import { ApiError, authorisedJson, globalFetch, requestJson, type Authoriser, type FetchLike } from '../api/http';
import type { ApiSession, ApiUser, DeviceInfo, Me, MePatch, Provider, SecureStore, ServerConfig, StoredAuth } from './types';

export { ApiError } from '../api/http';

/** Refresh the session once it is this old (the server's expiry slides by 30 days on each refresh). */
export const REFRESH_AFTER_MS = 24 * 3600_000;
export const AUTH_REQUEST_TIMEOUT_MS = 15_000;

export type AuthStatus = 'offline' | 'guest' | 'account';

export interface AuthSnapshot {
  /** 'offline' until this device has a server identity (nothing is created until the app first needs the server). */
  status: AuthStatus;
  userId: string | null;
  displayName: string | null;
  hasSession: boolean;
}

export interface AuthClientOptions {
  /** HTTP base of the game server (`httpBase(signalUrl)`). */
  base: string;
  store: SecureStore;
  device: () => DeviceInfo | Promise<DeviceInfo>;
  fetch?: FetchLike;
  /** Name and avatar sent with a new guest so the server knows them from the start. */
  profile?: () => { displayName?: string; avatar?: string };
  now?: () => number;
  timeoutMs?: number;
}

/** One secure-store key per game server, so a development override never clobbers the real account. */
export function authStorageKey(base: string): string {
  return `mjm.auth.${base.replace(/^[a-z]+:\/\//i, '').replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

function parseStored(raw: string | null): StoredAuth | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as StoredAuth;
    if (s && s.v === 1 && typeof s.userId === 'string' && s.userId) return s;
  } catch {
    /* unreadable: start again */
  }
  return null;
}

export class AuthClient implements Authoriser {
  private cached: StoredAuth | null = null;
  private loaded = false;
  private pending: Promise<string> | null = null;
  private readonly listeners = new Set<(s: AuthSnapshot) => void>();
  private readonly key: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: AuthClientOptions) {
    this.key = authStorageKey(opts.base);
    this.fetch = opts.fetch ?? globalFetch;
    this.now = opts.now ?? Date.now;
  }

  // ── State ────────────────────────────────────────────────────────────

  /** Reads the stored credentials (no network). */
  async load(): Promise<StoredAuth | null> {
    if (!this.loaded) {
      let raw: string | null = null;
      try {
        raw = await this.opts.store.getItem(this.key);
      } catch {
        raw = null;
      }
      // A write that landed while we were reading wins.
      if (!this.loaded) {
        this.cached = parseStored(raw);
        this.loaded = true;
        this.emit();
      }
    }
    return this.cached;
  }

  snapshot(): AuthSnapshot {
    const s = this.cached;
    return { status: s ? s.kind : 'offline', userId: s?.userId ?? null, displayName: s?.displayName ?? null, hasSession: !!s?.session };
  }

  subscribe(cb: (s: AuthSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const l of this.listeners) l(snap);
  }

  private async save(s: StoredAuth): Promise<StoredAuth> {
    this.cached = s;
    this.loaded = true;
    this.emit();
    await this.opts.store.setItem(this.key, JSON.stringify(s));
    return s;
  }

  private async clear(): Promise<void> {
    this.cached = null;
    this.loaded = true;
    this.pending = null;
    this.emit();
    try {
      await this.opts.store.deleteItem(this.key);
    } catch {
      /* nothing stored */
    }
  }

  private withSession(s: StoredAuth, session: ApiSession, user?: ApiUser): StoredAuth {
    return {
      ...s,
      userId: user?.id ?? s.userId,
      kind: user?.kind ?? s.kind,
      displayName: user?.displayName ?? s.displayName,
      session: { token: session.token, expiresAt: session.expiresAt, refreshedAt: this.now() },
      expired: false,
    };
  }

  // ── HTTP ─────────────────────────────────────────────────────────────

  private request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    return requestJson<T>({ fetch: this.fetch, base: this.opts.base, method, path, body, token, timeoutMs: this.opts.timeoutMs ?? AUTH_REQUEST_TIMEOUT_MS, scope: 'auth', label: 'game server' });
  }

  /** A bearer request; a session 401 replaces the token once and retries. */
  authorised<T>(method: string, path: string, body?: unknown): Promise<T> {
    return authorisedJson<T>(this, { fetch: this.fetch, base: this.opts.base, method, path, body, timeoutMs: this.opts.timeoutMs ?? AUTH_REQUEST_TIMEOUT_MS, scope: 'auth', label: 'game server' });
  }

  // ── Authoriser ───────────────────────────────────────────────────────

  token(): Promise<string> {
    return this.ensureSession();
  }

  /** The server rejected `rejected` with `e`: an expired token is refreshed next time, any other is dropped. */
  async onUnauthorised(e: ApiError, rejected?: string): Promise<void> {
    await this.invalidate(e.code, rejected);
  }

  async invalidate(code?: string, rejected?: string): Promise<void> {
    const s = await this.load();
    if (!s?.session) return;
    // A newer token from a concurrent recovery must not be thrown away.
    if (rejected && s.session.token !== rejected) return;
    await this.save(code === 'session_expired' ? { ...s, expired: true } : { ...s, session: null, expired: false });
  }

  // ── Sessions ─────────────────────────────────────────────────────────

  /**
   * A usable session token: the stored one; refreshed when older than a day or reported
   * expired; a guest login when it is gone; a new guest when nothing usable is stored.
   * Concurrent callers share one attempt.
   */
  ensureSession(): Promise<string> {
    if (!this.pending) {
      this.pending = this.ensureInner().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async ensureInner(): Promise<string> {
    let s = await this.load();
    if (s?.session) {
      const now = this.now();
      const pastExpiry = Date.parse(s.session.expiresAt) <= now;
      if (!s.expired && !pastExpiry && now - s.session.refreshedAt < REFRESH_AFTER_MS) return s.session.token;
      try {
        const r = await this.request<{ session: ApiSession }>('POST', '/api/auth/refresh', undefined, s.session.token);
        return (await this.save(this.withSession(s, r.session))).session!.token;
      } catch (e) {
        const rejected = e instanceof ApiError && e.status === 401;
        // A refresh that merely failed to arrive leaves a still-valid token usable.
        if (!rejected && !s.expired && !pastExpiry) return s.session.token;
        if (!rejected) throw e;
        s = await this.save({ ...s, session: null, expired: false });
      }
    }
    if (s?.guestSecret) {
      try {
        const r = await this.request<{ session: ApiSession; user: ApiUser }>('POST', '/api/auth/guest/login', { userId: s.userId, guestSecret: s.guestSecret, device: await this.opts.device() });
        return (await this.save(this.withSession(s, r.session, r.user))).session!.token;
      } catch (e) {
        // The guest no longer exists (deleted, or merged into an account): start a new one.
        if (!(e instanceof ApiError && (e.status === 401 || e.status === 404))) throw e;
      }
    }
    return (await this.bootstrapGuest()).session!.token;
  }

  /** Creates a guest account on the server and stores its id, secret and session. */
  async bootstrapGuest(device?: DeviceInfo): Promise<StoredAuth> {
    const p = this.opts.profile?.() ?? {};
    const body: Record<string, unknown> = { device: device ?? (await this.opts.device()) };
    if (p.displayName) body.displayName = p.displayName;
    if (p.avatar) body.avatar = p.avatar;
    const r = await this.request<{ userId: string; guestSecret: string; session: ApiSession; user?: ApiUser }>('POST', '/api/auth/guest', body);
    const fresh: StoredAuth = { v: 1, userId: r.userId, guestSecret: r.guestSecret, kind: 'guest', displayName: r.user?.displayName, session: null };
    return this.save(this.withSession(fresh, r.session, r.user));
  }

  /** Revokes this device's session and forgets the account here (a guest cannot be recovered afterwards). */
  async logout(): Promise<void> {
    const s = await this.load();
    if (s?.session) {
      try {
        await this.request('POST', '/api/auth/logout', undefined, s.session.token);
      } catch {
        /* the token dies with the local copy either way */
      }
    }
    await this.clear();
  }

  // ── Providers ────────────────────────────────────────────────────────

  /**
   * Attaches a provider identity to the current account. When the identity already belongs
   * to another account and this one is a guest, the server merges the guest into it
   * (`merged: true`): the device now holds that account's session, and the guest secret is void.
   */
  async link(provider: Provider, token: string, nonce: string, email?: string): Promise<{ user: ApiUser; merged: boolean }> {
    const body: Record<string, unknown> = { provider, token, nonce };
    if (email) body.email = email;
    const r = await this.authorised<{ session: ApiSession; user: ApiUser; merged: boolean }>('POST', '/api/auth/link', body);
    const s = (await this.load())!;
    const next = this.withSession(s, r.session, r.user);
    await this.save(r.merged ? { ...next, guestSecret: null } : next);
    return { user: r.user, merged: !!r.merged };
  }

  /** Signs in to an existing account with a provider token (`404 not_linked` when there is none). */
  async loginWithProvider(provider: Provider, token: string, nonce: string): Promise<ApiUser> {
    const s = await this.load();
    const r = await this.request<{ session: ApiSession; user: ApiUser }>('POST', '/api/auth/login', { provider, token, nonce, device: await this.opts.device() }, s?.session?.token);
    const keepSecret = s && s.userId === r.user.id ? s.guestSecret : null;
    const base: StoredAuth = { v: 1, userId: r.user.id, guestSecret: keepSecret, kind: r.user.kind, displayName: r.user.displayName, session: null };
    await this.save(this.withSession(base, r.session, r.user));
    return r.user;
  }

  /** Removes a provider (`409 last_identity` if it is the only sign-in method). */
  async unlink(provider: Provider): Promise<void> {
    await this.authorised('DELETE', `/api/auth/identities/${provider}`);
  }

  /** Deletes the account on the server, then everything stored here. */
  async deleteAccount(): Promise<void> {
    await this.authorised('DELETE', '/api/me');
    await this.clear();
  }

  // ── Profile ──────────────────────────────────────────────────────────

  async getMe(): Promise<Me> {
    const me = await this.authorised<Me>('GET', '/api/me');
    await this.remember(me.user);
    return me;
  }

  async updateMe(patch: MePatch): Promise<ApiUser> {
    const r = await this.authorised<{ user: ApiUser }>('PATCH', '/api/me', patch);
    await this.remember(r.user);
    return r.user;
  }

  private async remember(user: ApiUser): Promise<void> {
    const s = await this.load();
    if (s && s.userId === user.id && (s.kind !== user.kind || s.displayName !== user.displayName)) await this.save({ ...s, kind: user.kind, displayName: user.displayName });
  }

  /** Public server configuration (no auth). */
  getConfig(): Promise<ServerConfig> {
    return this.request<ServerConfig>('GET', '/api/config');
  }
}
