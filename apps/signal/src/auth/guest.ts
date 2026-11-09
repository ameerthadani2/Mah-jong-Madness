/**
 * Guest accounts: created on the device's first online use, with no sign-in screen. The server
 * returns a user id and a high-entropy guest secret that the app keeps in secure storage; only
 * sha256(pepper + ':' + secret) is stored, in auth_identities(provider 'guest', subject = user id).
 * A peppered hash is enough here because the secret is 256 random bits, not a password.
 */
import { randomUUID } from 'node:crypto';
import { randomHex } from '@mjm/engine';
import { cleanField } from '../limits';
import type { Repos } from '../repos/types';
import { AuthError } from './errors';
import { digestsEqual, hashToken, SessionService } from './tokens';

/** The current pepper, or the current and previous ones during a rotation. */
export type Peppers = string | { current: string; previous?: string };

const pepperSet = (p: Peppers): { current: string; previous?: string } => (typeof p === 'string' ? { current: p } : p);

export interface GuestDevice {
  platform?: unknown;
  appBuild?: unknown;
  locale?: unknown;
  pushToken?: unknown;
}

export interface GuestOptions {
  /** Session service to issue the token with (default: one built from the pepper). */
  sessions?: SessionService;
  now?: () => number;
  displayName?: string;
  avatar?: string;
  /** The id the app generated for this install; used when it is a UUID not yet registered, otherwise a new one is assigned. */
  deviceId?: unknown;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GuestCreated {
  userId: string;
  deviceId: string;
  guestSecret: string;
  token: string;
  sessionId: string;
}

/** Cleaned text (`cleanField`) capped to `max` characters, or null for anything that is not a string or cleans to nothing. */
function text(v: unknown, max: number): string | null {
  return cleanField(v, max) || null;
}

function sessionsFor(repos: Repos, peppers: Peppers, opts: GuestOptions): SessionService {
  const p = pepperSet(peppers);
  return opts.sessions ?? new SessionService(repos, { pepper: p.current, previousPepper: p.previous, now: opts.now });
}

export async function createGuest(repos: Repos, pepper: Peppers, device: GuestDevice = {}, opts: GuestOptions = {}): Promise<GuestCreated> {
  const now = (opts.now ?? Date.now)();
  const { current } = pepperSet(pepper);
  const userId = randomUUID();
  const wanted = typeof opts.deviceId === 'string' && UUID.test(opts.deviceId) ? opts.deviceId.toLowerCase() : null;
  const deviceId = wanted && !(await repos.devices.get(wanted)) ? wanted : randomUUID();
  const guestSecret = randomHex(32);
  const locale = text(device.locale, 16);
  await repos.transaction(async (tx) => {
    await tx.users.create({ id: userId, kind: 'guest', displayName: cleanField(opts.displayName ?? '', 24), avatar: text(opts.avatar, 16), locale, createdAt: now });
    await tx.devices.create({
      id: deviceId,
      userId,
      platform: text(device.platform, 16) ?? 'unknown',
      appBuild: text(device.appBuild, 32),
      pushToken: text(device.pushToken, 256),
      locale,
      createdAt: now,
      lastSeenAt: now,
    });
    await tx.identities.create({ provider: 'guest', subject: userId, userId, secretHash: hashToken(guestSecret, current), email: null, createdAt: now });
  });
  const { token, session } = await sessionsFor(repos, pepper, opts).create(userId, deviceId);
  return { userId, deviceId, guestSecret, token, sessionId: session.id };
}

/**
 * Replace a user's guest secret with a new one, so that only the caller (who receives it) can sign
 * in with it from now on. Returns null when the user has no guest credential.
 */
export async function rotateGuestSecret(repos: Repos, pepper: Peppers, userId: string): Promise<string | null> {
  const identity = await repos.identities.get('guest', userId);
  if (!identity) return null;
  const guestSecret = randomHex(32);
  await repos.identities.updateSecretHash('guest', userId, hashToken(guestSecret, pepperSet(pepper).current));
  return guestSecret;
}

export interface GuestLoginOptions extends GuestOptions {
  /** The device id the app was given at creation; attached to the session when it belongs to this user. */
  deviceId?: unknown;
  /** Called once the secret has been proven, before a session is issued (the API spends the user's rate limit here; it may throw). */
  verified?: (userId: string) => void;
}

/** A fixed digest compared against when the user is unknown, so a miss takes as long as a wrong secret. */
const DUMMY_DIGEST = '0'.repeat(64);

export async function loginGuest(
  repos: Repos,
  pepper: Peppers,
  userId: unknown,
  guestSecret: unknown,
  opts: GuestLoginOptions = {},
): Promise<{ userId: string; token: string; sessionId: string }> {
  const fail = () => new AuthError('invalid_credentials', 'Guest id or secret does not match');
  if (typeof userId !== 'string' || typeof guestSecret !== 'string' || !userId || !guestSecret || userId.length > 64 || guestSecret.length > 128) throw fail();
  const p = pepperSet(pepper);
  const identity = await repos.identities.get('guest', userId);
  const stored = identity?.secretHash ?? DUMMY_DIGEST;
  let ok = digestsEqual(stored, hashToken(guestSecret, p.current));
  if (!ok && p.previous && digestsEqual(stored, hashToken(guestSecret, p.previous))) {
    ok = true;
    if (identity) await repos.identities.updateSecretHash('guest', userId, hashToken(guestSecret, p.current));
  }
  if (!ok || !identity) throw fail();
  const user = await repos.users.get(identity.userId);
  if (!user || user.deletedAt !== null) throw fail();
  opts.verified?.(user.id);
  let deviceId: string | null = null;
  if (typeof opts.deviceId === 'string' && opts.deviceId) {
    const device = await repos.devices.get(opts.deviceId);
    if (device && device.userId === user.id) deviceId = device.id;
  }
  const now = (opts.now ?? Date.now)();
  await repos.users.update(user.id, { lastSeenAt: now });
  const { token, session } = await sessionsFor(repos, pepper, opts).create(user.id, deviceId);
  return { userId: user.id, token, sessionId: session.id };
}
