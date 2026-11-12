/**
 * Opaque session tokens. The client holds `mjs_<64 hex>`; the server stores only
 * sha256(pepper + ':' + token), so a database leak yields nothing usable without the pepper
 * (an environment secret). Sessions last 30 days and slide forward while used; a refresh
 * rotates the token, and the old one keeps working for a short grace window so a request
 * already in flight does not fail. After a pepper rotation the earlier peppers that are still
 * configured are accepted, and a hash found under one is stored again under the current pepper.
 */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { randomHex, sha256Hex } from '@mjm/engine';
import type { Repos, SessionRecord } from '../repos/types';
import { AuthError, assertNotBanned } from './errors';

export const SESSION_TOKEN_PREFIX = 'mjs_';
const TOKEN_SHAPE = /^mjs_[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
/** Sliding expiry is written at most this often per session, not on every request. */
const SLIDE_EVERY_MS = 3_600_000;

export function mintSessionToken(): string {
  return SESSION_TOKEN_PREFIX + randomHex(32);
}

export function hashToken(token: string, pepper: string): string {
  return sha256Hex(pepper + ':' + token);
}

/** Constant-time comparison of two hex digests (false when the lengths differ). */
export function digestsEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The earlier peppers still accepted, newest first: trimmed, without blanks, repeats or the
 * current pepper.
 */
export function previousPepperList(previous: string | readonly string[] | undefined, current: string): string[] {
  const out: string[] = [];
  for (const raw of previous === undefined ? [] : typeof previous === 'string' ? [previous] : previous) {
    const p = typeof raw === 'string' ? raw.trim() : '';
    if (p && p !== current && !out.includes(p)) out.push(p);
  }
  return out;
}

export interface SessionOptions {
  pepper: string;
  /** The pepper, or peppers (newest first), in use before a rotation; tokens hashed with one still verify. */
  previousPepper?: string | readonly string[];
  ttlDays?: number;
  graceMinutes?: number;
  now?: () => number;
}

export interface VerifiedSession {
  sessionId: string;
  userId: string;
  deviceId: string | null;
  expiresAt: number;
  /** True when this token has been rotated and is living out its grace window. */
  inGrace: boolean;
}

export interface IssuedSession {
  token: string;
  session: SessionRecord;
}

export class SessionService {
  readonly pepper: string;
  /** Earlier peppers still accepted, newest first. */
  readonly previousPeppers: readonly string[];
  private readonly ttlMs: number;
  private readonly graceMs: number;
  private readonly now: () => number;

  /** The newest earlier pepper, if any is configured. */
  get previousPepper(): string | undefined {
    return this.previousPeppers[0];
  }

  constructor(
    private readonly repos: Repos,
    opts: SessionOptions,
  ) {
    if (!opts.pepper) throw new Error('SessionService needs a pepper');
    this.pepper = opts.pepper;
    this.previousPeppers = previousPepperList(opts.previousPepper, opts.pepper);
    this.ttlMs = (opts.ttlDays ?? 30) * DAY_MS;
    this.graceMs = (opts.graceMinutes ?? 5) * MINUTE_MS;
    this.now = opts.now ?? Date.now;
  }

  async create(userId: string, deviceId: string | null = null, rotatedFrom: string | null = null): Promise<IssuedSession> {
    const now = this.now();
    const token = mintSessionToken();
    const session: SessionRecord = {
      id: randomUUID(),
      userId,
      deviceId,
      tokenHash: hashToken(token, this.pepper),
      createdAt: now,
      expiresAt: now + this.ttlMs,
      rotatedFrom,
      revokedAt: null,
    };
    await this.repos.sessions.create(session);
    return { token, session };
  }

  /** Resolves the session behind a bearer token, or throws AuthError (always HTTP 401). */
  async verify(token: unknown): Promise<VerifiedSession> {
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) throw new AuthError('invalid_session', 'Malformed session token');
    let session = await this.repos.sessions.findByHash(hashToken(token, this.pepper));
    for (const previous of this.previousPeppers) {
      if (session) break;
      session = await this.repos.sessions.findByHash(hashToken(token, previous));
      if (session) {
        // Stored again under the current pepper: this session no longer needs the earlier one.
        const upgraded = hashToken(token, this.pepper);
        await this.repos.sessions.update(session.id, { tokenHash: upgraded });
        session.tokenHash = upgraded;
      }
    }
    if (!session) throw new AuthError('invalid_session', 'Unknown session token');
    // Before expiry and revocation: a ban revokes every session, and the client should hear why.
    await assertNotBanned(this.repos, session.userId);
    const now = this.now();
    if (now >= session.expiresAt) throw new AuthError('session_expired', 'Session expired');
    if (session.revokedAt !== null && session.revokedAt <= now) throw new AuthError('session_revoked', 'Session revoked');
    const user = await this.repos.users.get(session.userId);
    if (!user || user.deletedAt !== null) throw new AuthError('session_revoked', 'Account no longer exists');
    const inGrace = session.revokedAt !== null;
    let expiresAt = session.expiresAt;
    if (!inGrace && now + this.ttlMs - expiresAt >= SLIDE_EVERY_MS) {
      expiresAt = now + this.ttlMs;
      await this.repos.sessions.update(session.id, { expiresAt });
    }
    return { sessionId: session.id, userId: session.userId, deviceId: session.deviceId, expiresAt, inGrace };
  }

  /**
   * Swaps a live token for a new one. The old token keeps working for the grace window (never
   * beyond its own expiry) and can be rotated only once, so a stolen copy cannot fork the chain.
   */
  async rotate(token: unknown): Promise<IssuedSession> {
    const current = await this.verify(token);
    if (current.inGrace) throw new AuthError('session_rotated', 'Session already rotated');
    const graceEnds = Math.min(current.expiresAt, this.now() + this.graceMs);
    if (!(await this.repos.sessions.revokeIfActive(current.sessionId, graceEnds))) throw new AuthError('session_rotated', 'Session already rotated');
    return this.create(current.userId, current.deviceId, current.sessionId);
  }

  /** Ends every session of the user now, except `exceptSessionId` (the caller's own, usually). */
  revokeAll(userId: string, exceptSessionId?: string): Promise<number> {
    return this.repos.sessions.revokeAllForUser(userId, this.now(), exceptSessionId);
  }

  /** Signs one session out (logout). */
  async revoke(sessionId: string): Promise<void> {
    await this.repos.sessions.update(sessionId, { revokedAt: this.now() });
  }
}
