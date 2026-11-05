/**
 * Linking a verified provider identity (P) to the signed-in user (U), signing in with one, and
 * deleting an account. The rules:
 *
 * 1. P is linked to nobody: link it to U, and U becomes an account. U's other sessions end.
 * 2. P is linked to V and U is a guest: merge U into V. U's wallet, purchases, entitlements,
 *    puzzle history, devices and club memberships move to V (where both are in a club, the
 *    stronger row stays; clubs U owns transfer); U's sessions end; U is soft-deleted with
 *    merged_into = V; the device gets a V session.
 * 3. P is linked to V and U already has a provider: 409 identity_in_use (two real accounts are
 *    never merged automatically).
 * 4. Unlinking needs another provider to remain; signing in with an unlinked P is 404 not_linked
 *    (the client then offers to attach P to the current guest, which is rule 1).
 *
 * Deletion is soft: profile fields are scrubbed, identities, sessions and devices (with their
 * push tokens) are deleted, club rows become "Deleted player", and purchases and the wallet
 * ledger stay as financial records. A daily job hard-deletes the row after 30 days.
 */
import type { Repos, UserRecord } from '../repos/types';
import { DELETED_PLAYER_NAME } from '../repos/types';
import { AuthError } from './errors';
import type { VerifiedIdentity } from './providers';
import type { SessionService } from './tokens';

export interface MergeOptions {
  sessions: SessionService;
  /** The caller's own session, which survives the revocation in rule 1. */
  currentSessionId?: string;
  /** The device making the request; a session issued here is bound to it. */
  deviceId?: string | null;
  now?: () => number;
}

export interface LinkResult {
  /** The account the device now belongs to (V after a merge, otherwise U). */
  userId: string;
  merged: boolean;
  /** The guest that was merged away, when `merged`. */
  mergedFrom?: string;
  /** A new session for `userId`, issued only after a merge (the old token belonged to the guest). */
  token?: string;
  sessionId?: string;
  /** Clubs whose rows changed, so a club cache can reload them. */
  affectedClubs: string[];
}

async function liveUser(repos: Repos, userId: string): Promise<UserRecord> {
  const user = await repos.users.get(userId);
  if (!user || user.deletedAt !== null) throw new AuthError('not_found', 'No such user');
  return user;
}

async function hasProvider(repos: Repos, userId: string): Promise<boolean> {
  return (await repos.identities.listForUser(userId)).some((i) => i.provider !== 'guest');
}

export async function link(repos: Repos, userId: string, identity: VerifiedIdentity, opts: MergeOptions): Promise<LinkResult> {
  const now = (opts.now ?? Date.now)();
  const user = await liveUser(repos, userId);

  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await repos.identities.get(identity.provider, identity.subject);
    if (!existing) {
      // Rule 1. The insert is the arbiter: if another request linked P a moment ago, it returns false and we re-read.
      const linked = await repos.transaction(async (tx) => {
        const ok = await tx.identities.create({
          provider: identity.provider,
          subject: identity.subject,
          userId,
          secretHash: null,
          email: identity.email ?? null,
          createdAt: now,
        });
        if (ok) await tx.users.update(userId, { kind: 'account', email: user.email ?? identity.email ?? null, lastSeenAt: now });
        return ok;
      });
      if (!linked) continue;
      await opts.sessions.revokeAll(userId, opts.currentSessionId);
      return { userId, merged: false, affectedClubs: [] };
    }
    if (existing.userId === userId) return { userId, merged: false, affectedClubs: [] };

    const target = await repos.users.get(existing.userId);
    if (!target || target.deletedAt !== null) throw new AuthError('identity_in_use', 'Identity belongs to a closed account');
    // Rule 3.
    if (user.kind !== 'guest' || (await hasProvider(repos, userId))) throw new AuthError('identity_in_use', 'Identity is linked to another account');

    // Rule 2.
    const affectedClubs = await repos.transaction(async (tx) => {
      await tx.wallet.mergeInto(user.id, target.id, now);
      const clubs = await tx.clubs.moveMemberships(user.id, target.avatar ? { userId: target.id, name: target.displayName, avatar: target.avatar } : { userId: target.id, name: target.displayName });
      await tx.puzzleResults.moveToUser(user.id, target.id);
      await tx.devices.moveToUser(user.id, target.id);
      await tx.sessions.revokeAllForUser(user.id, now);
      await tx.identities.deleteForUser(user.id);
      await tx.users.update(user.id, { deletedAt: now, mergedInto: target.id });
      await tx.users.update(target.id, { lastSeenAt: now });
      return clubs;
    });
    const { token, session } = await opts.sessions.create(target.id, opts.deviceId ?? null);
    return { userId: target.id, merged: true, mergedFrom: user.id, token, sessionId: session.id, affectedClubs };
  }
  throw new AuthError('identity_in_use', 'Identity changed hands while linking');
}

/** Signs in with a provider identity. The session is bound to the device only if the device already belongs to that account. */
export async function login(repos: Repos, identity: VerifiedIdentity, opts: MergeOptions): Promise<{ userId: string; token: string; sessionId: string }> {
  const existing = await repos.identities.get(identity.provider, identity.subject);
  if (!existing) throw new AuthError('not_linked', 'This sign-in is not linked to an account');
  const user = await repos.users.get(existing.userId);
  if (!user || user.deletedAt !== null) throw new AuthError('not_linked', 'This sign-in is not linked to an account');
  let deviceId: string | null = null;
  if (opts.deviceId) {
    const device = await repos.devices.get(opts.deviceId);
    if (device && device.userId === user.id) deviceId = device.id;
  }
  await repos.users.update(user.id, { lastSeenAt: (opts.now ?? Date.now)() });
  const { token, session } = await opts.sessions.create(user.id, deviceId);
  return { userId: user.id, token, sessionId: session.id };
}

/** Rule 4: removes a provider identity, provided another provider still signs the account in. */
export async function unlink(repos: Repos, userId: string, provider: VerifiedIdentity['provider']): Promise<void> {
  await liveUser(repos, userId);
  const identities = (await repos.identities.listForUser(userId)).filter((i) => i.provider !== 'guest');
  const target = identities.find((i) => i.provider === provider);
  if (!target) throw new AuthError('not_found', 'That sign-in is not linked');
  if (identities.length < 2) throw new AuthError('last_identity', 'Link another sign-in method before removing this one');
  await repos.identities.delete(target.provider, target.subject);
}

export async function deleteAccount(repos: Repos, userId: string, opts: { now?: () => number } = {}): Promise<{ affectedClubs: string[] }> {
  const user = await repos.users.get(userId);
  if (!user) throw new AuthError('not_found', 'No such user');
  const now = (opts.now ?? Date.now)();
  const affectedClubs = await repos.transaction(async (tx) => {
    await tx.sessions.deleteForUser(userId);
    await tx.devices.deleteForUser(userId);
    await tx.identities.deleteForUser(userId);
    const clubs = await tx.clubs.anonymiseUser(userId);
    await tx.users.update(userId, {
      deletedAt: user.deletedAt ?? now,
      displayName: DELETED_PLAYER_NAME,
      avatar: null,
      email: null,
      birthYear: null,
    });
    return clubs;
  });
  return { affectedClubs };
}
