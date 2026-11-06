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

/**
 * 'offline' until this device has a server identity; 'signed_out' when it remembers an account (or a
 * guest) the server will no longer let in without a fresh sign-in: nothing here replaces that identity
 * with a new guest on its own, the player chooses (a provider sign-in, or `startFresh`).
 */
export type AuthStatus = 'offline' | 'guest' | 'account' | 'signed_out';

export interface AuthSnapshot {
  /** 'offline' until this device has a server identity (nothing is created until the app first needs the server). */
  status: AuthStatus;
  userId: string | null;
  displayName: string | null;
  /** What the stored identity is, whatever its session state (null offline). */
  kind: 'guest' | 'account' | null;
  hasSession: boolean;
}

export const SIGNED_OUT_MESSAGE = 'Signed out: sign in again to play online.';

/** Thrown by `ensureSession` when the stored identity needs the player to sign in again (status 'signed_out'). */
export class SignedOutError extends ApiError {
  constructor() {
    super(SIGNED_OUT_MESSAGE, 'signed_out', 401);
    this.name = 'SignedOutError';
  }
}

export function isSignedOut(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'signed_out';
}

/** The stored identity cannot get itself a session: no token and no guest secret, or the server has refused it. */
function signedOut(s: StoredAuth): boolean {
  return !!s.signedOut || (!s.session && !s.guestSecret);
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
  /** Bumped by every clear(): a session attempt that started before a sign-out must not store its result. */
  private generation = 0;
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
    return { status: s ? (signedOut(s) ? 'signed_out' : s.kind) : 'offline', userId: s?.userId ?? null, displayName: s?.displayName ?? null, kind: s?.kind ?? null, hasSession: !!s?.session };
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

  /**
   * Stores the outcome of a session attempt that began in `generation`. After a sign-out in the
   * meantime the result is dropped (and its token revoked, best effort) so the account never comes back.
   */
  private async commit(generation: number, s: StoredAuth): Promise<StoredAuth> {
    if (generation === this.generation) return this.save(s);
    if (s.session) void this.request('POST', '/api/auth/logout', undefined, s.session.token).catch(() => undefined);
    throw new SignedOutError();
  }

  private async clear(): Promise<void> {
    this.generation++;
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
      signedOut: false,
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
   * expired; a guest login when it is gone; a new guest only when nothing is stored.
   * Concurrent callers share one attempt.
   *
   * A stored identity the server refuses (an account whose session was revoked, a guest whose
   * secret is no longer accepted) is never replaced on its own: the record keeps the user id and
   * name, its status becomes 'signed_out' and this throws a SignedOutError, so a screen can
   * offer a provider sign-in or `startFresh()`.
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
    const generation = this.generation;
    let s = await this.load();
    if (s?.session) {
      const now = this.now();
      const pastExpiry = Date.parse(s.session.expiresAt) <= now;
      if (!s.expired && !pastExpiry && now - s.session.refreshedAt < REFRESH_AFTER_MS) return s.session.token;
      try {
        const r = await this.request<{ session: ApiSession }>('POST', '/api/auth/refresh', undefined, s.session.token);
        return (await this.commit(generation, this.withSession(s, r.session))).session!.token;
      } catch (e) {
        if (isSignedOut(e)) throw e;
        const rejected = e instanceof ApiError && e.status === 401;
        // A refresh that merely failed to arrive leaves a still-valid token usable.
        if (!rejected && !s.expired && !pastExpiry) return s.session.token;
        if (!rejected) throw e;
        s = await this.commit(generation, { ...s, session: null, expired: false });
      }
    }
    if (s?.guestSecret) {
      try {
        const r = await this.request<{ session: ApiSession; user: ApiUser }>('POST', '/api/auth/guest/login', { userId: s.userId, guestSecret: s.guestSecret, device: await this.opts.device() });
        return (await this.commit(generation, this.withSession(s, r.session, r.user))).session!.token;
      } catch (e) {
        if (!(e instanceof ApiError && (e.status === 401 || e.status === 404))) throw e;
        // The server refused the only way back into this guest (deleted, merged away, or a server-side
        // problem): the record and its secret stay, so nothing is overwritten, and the player is asked.
      }
    }
    if (s) {
      if (!s.signedOut) await this.commit(generation, { ...s, session: null, expired: false, signedOut: true });
      throw new SignedOutError();
    }
    return (await this.bootstrapGuest()).session!.token;
  }

  /** Creates a guest account on the server and stores its id, secret and session. */
  async bootstrapGuest(device?: DeviceInfo): Promise<StoredAuth> {
    const generation = this.generation;
    const p = this.opts.profile?.() ?? {};
    const body: Record<string, unknown> = { device: device ?? (await this.opts.device()) };
    if (p.displayName) body.displayName = p.displayName;
    if (p.avatar) body.avatar = p.avatar;
    const r = await this.request<{ userId: string; guestSecret: string; session: ApiSession; user?: ApiUser }>('POST', '/api/auth/guest', body);
    const fresh: StoredAuth = { v: 1, userId: r.userId, guestSecret: r.guestSecret, kind: 'guest', displayName: r.user?.displayName, session: null };
    return this.commit(generation, this.withSession(fresh, r.session, r.user));
  }

  /**
   * The player chose to leave a signed-out identity behind: it is kept under a side key (nothing
   * stored here is ever overwritten) and a new guest takes its place.
   */
  async startFresh(): Promise<StoredAuth> {
    const s = await this.load();
    if (s) {
      try {
        await this.opts.store.setItem(`${this.key}.previous`, JSON.stringify({ ...s, session: null }));
      } catch {
        /* best effort */
      }
    }
    await this.clear();
    return this.bootstrapGuest();
  }

  /**
   * Revokes this device's session and forgets the account here (a guest cannot be recovered
   * afterwards). A session attempt in flight is dropped by `commit`, so it cannot bring the account back.
   */
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
   * Otherwise the server may rotate the guest secret (`guestSecret` in the reply) so that only
   * this device keeps that way back in; an older server leaves it as it was.
   */
  async link(provider: Provider, token: string, nonce: string, email?: string): Promise<{ user: ApiUser; merged: boolean }> {
    const body: Record<string, unknown> = { provider, token, nonce };
    if (email) body.email = email;
    const r = await this.authorised<{ session: ApiSession; user: ApiUser; merged: boolean; guestSecret?: string }>('POST', '/api/auth/link', body);
    const s = (await this.load())!;
    const next = this.withSession(s, r.session, r.user);
    const rotated = typeof r.guestSecret === 'string' && r.guestSecret ? r.guestSecret : null;
    await this.save(r.merged ? { ...next, guestSecret: null } : rotated ? { ...next, guestSecret: rotated } : next);
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
