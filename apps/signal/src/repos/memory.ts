/**
 * In-memory repositories: used by the tests and by a server started without DATABASE_URL
 * (development, or a single machine whose clubs live in the JSON file). Every read and write
 * copies, so callers can never mutate stored state by accident. Nothing here survives a restart.
 *
 * All state lives in one `MemoryState` record so that `transaction()` can behave like Postgres:
 * transactions run one at a time, a snapshot is taken before `fn`, and a throw restores it. The
 * repositories always read the state through `s.<field>`, never through a captured reference,
 * so a restore (which replaces the fields) is visible to every one of them.
 */
import { anonymiseUserIn, moveMembershipsIn, type Club } from '../clubs';
import {
  type BlockRecord,
  type BlocksRepo,
  type ClubMembership,
  type ClubsRepo,
  type DevicePatch,
  type DeviceRecord,
  type DevicesRepo,
  type EntitlementRecord,
  type IdentitiesRepo,
  type IdentityProvider,
  type IdentityRecord,
  type LedgerEntry,
  type MatchResultRecord,
  type MatchResultsRepo,
  type ModerationRepo,
  type ModerationStatus,
  type PurchaseRecord,
  type PushTarget,
  type PuzzleResultRecord,
  type PuzzleResultsRepo,
  type ReportRecord,
  type ReportsRepo,
  type Repos,
  type SessionPatch,
  type SessionRecord,
  type SessionsRepo,
  type StoreEventRecord,
  type StoreEventsRepo,
  type TableSnapshotRecord,
  type TableSnapshotsRepo,
  type UserPatch,
  type UserRecord,
  type UsersRepo,
  type WalletRecord,
  type WalletRepo,
} from './types';

const copy = <T>(v: T): T => structuredClone(v);

/** Everything the memory repositories hold. Cloneable as one value (`structuredClone`). */
interface MemoryState {
  users: Map<string, UserRecord>;
  identities: Map<string, IdentityRecord>;
  sessions: Map<string, SessionRecord>;
  devices: Map<string, DeviceRecord>;
  storeEvents: Map<string, StoreEventRecord>;
  reports: ReportRecord[];
  reportSeq: number;
  wallets: Map<string, WalletRecord>;
  ledger: LedgerEntry[];
  ledgerSeq: number;
  purchases: PurchaseRecord[];
  purchaseSeq: number;
  entitlements: Map<string, EntitlementRecord>;
  clubs: Map<string, Club>;
  snapshots: Map<string, TableSnapshotRecord>;
  matches: MatchResultRecord[];
  matchSeq: number;
  puzzles: PuzzleResultRecord[];
  puzzleSeq: number;
  /** Each user's analytics choice (users.analytics_consent in Postgres). */
  consent: Map<string, boolean>;
  /** user_blocks, in insertion order. */
  blocks: BlockRecord[];
  /** users.banned_at, ban_reason and muted_until, for accounts that have any of them. */
  moderation: Map<string, ModerationStatus>;
  /** banned_devices: the device ids each banned account covers. */
  bannedDevices: Array<{ deviceId: string; userId: string }>;
}

const emptyState = (): MemoryState => ({
  users: new Map(),
  identities: new Map(),
  sessions: new Map(),
  devices: new Map(),
  storeEvents: new Map(),
  reports: [],
  reportSeq: 0,
  wallets: new Map(),
  ledger: [],
  ledgerSeq: 0,
  purchases: [],
  purchaseSeq: 0,
  entitlements: new Map(),
  clubs: new Map(),
  snapshots: new Map(),
  matches: [],
  matchSeq: 0,
  puzzles: [],
  puzzleSeq: 0,
  consent: new Map(),
  blocks: [],
  moderation: new Map(),
  bannedDevices: [],
});

function memoryUsers(s: MemoryState): UsersRepo {
  return {
    async create(u) {
      if (s.users.has(u.id)) throw new Error(`User ${u.id} already exists`);
      const row: UserRecord = {
        id: u.id,
        kind: u.kind,
        displayName: u.displayName ?? '',
        avatar: u.avatar ?? null,
        email: u.email ?? null,
        birthYear: u.birthYear ?? null,
        locale: u.locale ?? null,
        createdAt: u.createdAt,
        lastSeenAt: u.createdAt,
        deletedAt: null,
        mergedInto: null,
      };
      s.users.set(row.id, row);
      return copy(row);
    },
    async get(id) {
      const row = s.users.get(id);
      return row ? copy(row) : null;
    },
    async update(id, patch: UserPatch) {
      const row = s.users.get(id);
      if (!row) return null;
      Object.assign(row, copy(patch));
      return copy(row);
    },
    async getAnalyticsConsent(id) {
      return s.users.has(id) ? (s.consent.get(id) ?? null) : null;
    },
    async setAnalyticsConsent(id, consent) {
      if (!s.users.has(id)) return false;
      if (consent === null) s.consent.delete(id);
      else s.consent.set(id, consent);
      return true;
    },
    async purgeDeleted(before) {
      return (await this.purgeDeletedIds(before)).length;
    },
    async purgeDeletedIds(before) {
      const purged: string[] = [];
      for (const [id, u] of [...s.users]) {
        if (u.deletedAt === null || u.deletedAt >= before) continue;
        if ([...s.clubs.values()].some((c) => c.ownerId === id)) continue;
        s.users.delete(id);
        for (const [k, r] of [...s.identities]) if (r.userId === id) s.identities.delete(k);
        for (const [k, r] of [...s.sessions]) if (r.userId === id) s.sessions.delete(k);
        for (const [k, r] of [...s.devices]) if (r.userId === id) s.devices.delete(k);
        s.wallets.delete(id);
        s.consent.delete(id);
        for (const [k, e] of [...s.entitlements]) if (e.userId === id) s.entitlements.delete(k);
        s.puzzles = s.puzzles.filter((p) => p.userId !== id);
        s.blocks = s.blocks.filter((b) => b.blockerId !== id && b.blockedId !== id);
        s.moderation.delete(id);
        s.bannedDevices = s.bannedDevices.filter((b) => b.userId !== id);
        for (const u2 of s.users.values()) if (u2.mergedInto === id) u2.mergedInto = null;
        for (const club of s.clubs.values()) {
          club.members = club.members.filter((m) => m.userId !== id);
          club.pending = club.pending.filter((p) => p.userId !== id);
          if (club.former) club.former = club.former.filter((f) => f.userId !== id);
        }
        purged.push(id);
      }
      return purged;
    },
  };
}

function memoryIdentities(s: MemoryState): IdentitiesRepo {
  const key = (provider: IdentityProvider, subject: string) => `${provider}\u0000${subject}`;
  return {
    async get(provider, subject) {
      const row = s.identities.get(key(provider, subject));
      return row ? copy(row) : null;
    },
    async listForUser(userId) {
      return [...s.identities.values()].filter((r) => r.userId === userId).map(copy);
    },
    async create(identity) {
      const k = key(identity.provider, identity.subject);
      if (s.identities.has(k)) return false;
      s.identities.set(k, copy(identity));
      return true;
    },
    async updateSecretHash(provider, subject, secretHash) {
      const row = s.identities.get(key(provider, subject));
      if (row) row.secretHash = secretHash;
    },
    async delete(provider, subject) {
      return s.identities.delete(key(provider, subject));
    },
    async deleteForUser(userId) {
      let n = 0;
      for (const [k, r] of [...s.identities]) if (r.userId === userId && s.identities.delete(k)) n++;
      return n;
    },
  };
}

function memorySessions(s: MemoryState): SessionsRepo {
  return {
    async create(session) {
      if (s.sessions.has(session.id) || [...s.sessions.values()].some((r) => r.tokenHash === session.tokenHash)) throw new Error('Duplicate session');
      s.sessions.set(session.id, copy(session));
    },
    async get(id) {
      const row = s.sessions.get(id);
      return row ? copy(row) : null;
    },
    async findByHash(tokenHash) {
      for (const r of s.sessions.values()) if (r.tokenHash === tokenHash) return copy(r);
      return null;
    },
    async update(id, patch: SessionPatch) {
      const row = s.sessions.get(id);
      if (row) Object.assign(row, copy(patch));
    },
    async revokeIfActive(id, at) {
      const row = s.sessions.get(id);
      if (!row || row.revokedAt !== null) return false;
      row.revokedAt = at;
      return true;
    },
    async revokeAllForUser(userId, at, exceptId) {
      let n = 0;
      for (const r of s.sessions.values()) {
        if (r.userId !== userId || r.id === exceptId) continue;
        if (r.revokedAt === null || r.revokedAt > at) {
          r.revokedAt = at;
          n++;
        }
      }
      return n;
    },
    async deleteForUser(userId) {
      let n = 0;
      for (const [id, r] of [...s.sessions]) if (r.userId === userId && s.sessions.delete(id)) n++;
      return n;
    },
    async pruneEnded(at) {
      let n = 0;
      for (const [id, r] of [...s.sessions]) if ((r.expiresAt <= at || (r.revokedAt !== null && r.revokedAt <= at)) && s.sessions.delete(id)) n++;
      return n;
    },
  };
}

function memoryDevices(s: MemoryState): DevicesRepo {
  return {
    async create(device) {
      // As in Postgres (INSERT ... ON CONFLICT DO NOTHING): a taken id writes nothing and says so.
      if (s.devices.has(device.id)) return false;
      const row = copy(device);
      if (!row.installId) delete row.installId;
      s.devices.set(device.id, row);
      return true;
    },
    async get(id) {
      const row = s.devices.get(id);
      return row ? copy(row) : null;
    },
    async update(id, patch: DevicePatch) {
      const row = s.devices.get(id);
      if (row) Object.assign(row, copy(patch));
    },
    async listForUser(userId) {
      return [...s.devices.values()].filter((r) => r.userId === userId).map(copy);
    },
    async moveToUser(fromUserId, toUserId) {
      let n = 0;
      for (const r of s.devices.values()) {
        if (r.userId !== fromUserId) continue;
        r.userId = toUserId;
        n++;
      }
      return n;
    },
    async deleteForUser(userId) {
      let n = 0;
      for (const [id, r] of [...s.devices]) if (r.userId === userId && s.devices.delete(id)) n++;
      return n;
    },
    async clearPushToken(token, exceptDeviceId) {
      let n = 0;
      for (const r of s.devices.values()) {
        if (r.pushToken !== token || r.id === exceptDeviceId) continue;
        r.pushToken = null;
        n++;
      }
      return n;
    },
    async pushTargets(userIds) {
      const wanted = new Set(userIds);
      return [...s.devices.values()]
        .filter((r) => wanted.has(r.userId) && r.pushToken)
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        .map((r): PushTarget => ({ userId: r.userId, deviceId: r.id, token: r.pushToken as string, platform: r.platform, locale: r.locale }));
    },
  };
}

function memoryStoreEvents(s: MemoryState): StoreEventsRepo {
  return {
    async record(e) {
      if (s.storeEvents.has(e.eventId)) return false;
      s.storeEvents.set(e.eventId, copy(e));
      return true;
    },
    async get(eventId) {
      const row = s.storeEvents.get(eventId);
      return row ? copy(row) : null;
    },
    async setOutcome(eventId, outcome, userId) {
      const row = s.storeEvents.get(eventId);
      if (row) Object.assign(row, { outcome, userId });
    },
    async delete(eventId) {
      return s.storeEvents.delete(eventId);
    },
    async usersActiveSince(since) {
      const ids = new Set<string>();
      for (const e of s.storeEvents.values()) if (e.userId && e.receivedAt >= since) ids.add(e.userId);
      return [...ids].sort();
    },
  };
}

function memoryReports(s: MemoryState): ReportsRepo {
  return {
    async create(r) {
      const row: ReportRecord = { ...copy(r), id: ++s.reportSeq, status: 'open' };
      s.reports.push(row);
      return copy(row);
    },
    async countByReporterSince(reporterId, since) {
      return s.reports.filter((r) => r.reporterId === reporterId && r.createdAt >= since).length;
    },
    async listAbout(reportedUserId, limit = 100) {
      return s.reports
        .filter((r) => r.reportedUserId === reportedUserId)
        .sort((a, b) => b.createdAt - a.createdAt || b.id - a.id)
        .slice(0, limit)
        .map(copy);
    },
    async moveToUser(fromUserId, toUserId) {
      const before = s.reports.length;
      s.reports = s.reports.filter((r) => !((r.reporterId === fromUserId && r.reportedUserId === toUserId) || (r.reporterId === toUserId && r.reportedUserId === fromUserId)));
      let n = before - s.reports.length;
      for (const r of s.reports) {
        if (r.reporterId !== fromUserId && r.reportedUserId !== fromUserId) continue;
        if (r.reporterId === fromUserId) r.reporterId = toUserId;
        if (r.reportedUserId === fromUserId) r.reportedUserId = toUserId;
        n++;
      }
      return n;
    },
    async get(id) {
      const row = s.reports.find((r) => r.id === id);
      return row ? copy(row) : null;
    },
    async listByStatus(status, limit = 100) {
      return s.reports
        .filter((r) => r.status === status)
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
        .slice(0, limit)
        .map(copy);
    },
    async claim(id, resolution, at) {
      const row = s.reports.find((r) => r.id === id);
      if (!row || row.status !== 'open') return null;
      row.status = resolution === 'dismiss' ? 'dismissed' : 'actioned';
      row.resolution = resolution;
      row.resolvedAt = at;
      return copy(row);
    },
    async resolve(id, resolution, at) {
      return (await this.claim(id, resolution, at)) !== null;
    },
  };
}

function memoryBlocks(s: MemoryState): BlocksRepo {
  return {
    async add(blockerId, blockedId, at) {
      if (blockerId === blockedId || !s.users.has(blockerId) || !s.users.has(blockedId)) return false;
      if (s.blocks.some((b) => b.blockerId === blockerId && b.blockedId === blockedId)) return false;
      s.blocks.push({ blockerId, blockedId, createdAt: at });
      return true;
    },
    async remove(blockerId, blockedId) {
      const before = s.blocks.length;
      s.blocks = s.blocks.filter((b) => !(b.blockerId === blockerId && b.blockedId === blockedId));
      return s.blocks.length < before;
    },
    async list(blockerId) {
      return s.blocks
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.blockerId === blockerId)
        .sort((x, y) => y.b.createdAt - x.b.createdAt || y.i - x.i)
        .map(({ b }) => copy(b));
    },
    async blockersOf(blockedId) {
      return s.blocks.filter((b) => b.blockedId === blockedId).map((b) => b.blockerId);
    },
    async moveToUser(fromUserId, toUserId) {
      const involves = (b: BlockRecord) => b.blockerId === fromUserId || b.blockedId === fromUserId;
      // Rows already on `toUserId` win over the ones moved onto it.
      const ordered = [...s.blocks.filter((b) => !involves(b)), ...s.blocks.filter(involves)];
      const kept: BlockRecord[] = [];
      const seen = new Set<string>();
      let n = 0;
      for (const b of ordered) {
        const moved = involves(b);
        const row = moved ? { ...b, blockerId: b.blockerId === fromUserId ? toUserId : b.blockerId, blockedId: b.blockedId === fromUserId ? toUserId : b.blockedId } : b;
        if (moved) n++;
        const key = `${row.blockerId}>${row.blockedId}`;
        if (row.blockerId === row.blockedId || seen.has(key)) continue;
        seen.add(key);
        kept.push(row);
      }
      s.blocks = kept;
      return n;
    },
    async deleteForUser(userId) {
      const before = s.blocks.length;
      s.blocks = s.blocks.filter((b) => b.blockerId !== userId && b.blockedId !== userId);
      return before - s.blocks.length;
    },
  };
}

function memoryModeration(s: MemoryState): ModerationRepo {
  const row = (userId: string): ModerationStatus => {
    let m = s.moderation.get(userId);
    if (!m) s.moderation.set(userId, (m = { bannedAt: null, banReason: null, mutedUntil: null }));
    return m;
  };
  return {
    async status(userId) {
      if (!s.users.has(userId)) return null;
      return copy(s.moderation.get(userId) ?? { bannedAt: null, banReason: null, mutedUntil: null });
    },
    async ban(userId, at, reason) {
      if (!s.users.has(userId)) return false;
      const m = row(userId);
      m.bannedAt ??= at;
      m.banReason = reason;
      for (const d of s.devices.values()) {
        if (d.userId !== userId) continue;
        for (const deviceId of new Set([d.id, d.installId ?? d.id])) {
          if (!s.bannedDevices.some((b) => b.deviceId === deviceId && b.userId === userId)) s.bannedDevices.push({ deviceId, userId });
        }
      }
      return true;
    },
    async unban(userId) {
      if (!s.users.has(userId)) return false;
      const m = row(userId);
      m.bannedAt = null;
      m.banReason = null;
      s.bannedDevices = s.bannedDevices.filter((b) => b.userId !== userId);
      return true;
    },
    async deviceBanned(deviceId) {
      const id = deviceId.toLowerCase();
      return s.bannedDevices.some((b) => b.deviceId === id);
    },
    async mute(userId, until) {
      if (!s.users.has(userId)) return false;
      row(userId).mutedUntil = until;
      return true;
    },
    async mutedAfter(at) {
      const out: Array<{ userId: string; mutedUntil: number }> = [];
      for (const [userId, m] of s.moderation) if (m.mutedUntil !== null && m.mutedUntil > at) out.push({ userId, mutedUntil: m.mutedUntil });
      return out;
    },
  };
}

function memoryWallet(s: MemoryState): WalletRepo {
  const entKey = (userId: string, entitlement: string) => `${userId}\u0000${entitlement}`;
  const wallet = (userId: string): WalletRecord => s.wallets.get(userId) ?? { userId, diamonds: 0, bonusDiamonds: 0, updatedAt: 0 };
  return {
    async get(userId) {
      return copy(wallet(userId));
    },
    async apply(e, opts) {
      const w = wallet(e.userId);
      const bonus = e.bonus ?? 0;
      if ((e.delta < 0 && w.diamonds + e.delta < 0 && !opts?.allowNegative) || w.bonusDiamonds + bonus < 0) return null;
      const next: WalletRecord = { userId: e.userId, diamonds: w.diamonds + e.delta, bonusDiamonds: w.bonusDiamonds + bonus, updatedAt: e.createdAt };
      const entry: LedgerEntry = { id: ++s.ledgerSeq, userId: e.userId, delta: e.delta, bonus, reason: e.reason, ref: e.ref ?? null, createdAt: e.createdAt };
      s.wallets.set(e.userId, next);
      s.ledger.push(entry);
      return { wallet: copy(next), entry: copy(entry) };
    },
    async listLedger(userId) {
      return s.ledger.filter((l) => l.userId === userId).map(copy);
    },
    async recordPurchase(p) {
      const existing = s.purchases.find((x) => x.transactionId === p.transactionId || (p.eventId !== null && x.eventId === p.eventId));
      if (existing) return { purchase: copy(existing), inserted: false };
      const row: PurchaseRecord = { ...copy(p), periodEndsAt: p.periodEndsAt ?? null, id: ++s.purchaseSeq };
      s.purchases.push(row);
      return { purchase: copy(row), inserted: true };
    },
    async listPurchases(userId) {
      return s.purchases.filter((p) => p.userId === userId).map(copy);
    },
    async findPurchase(transactionId) {
      const row = s.purchases.find((p) => p.transactionId === transactionId);
      return row ? copy(row) : null;
    },
    async getEntitlements(userId) {
      return [...s.entitlements.values()].filter((e) => e.userId === userId).map(copy);
    },
    async setEntitlement(e) {
      s.entitlements.set(entKey(e.userId, e.entitlement), copy(e));
    },
    async deleteEntitlement(userId, entitlement) {
      return s.entitlements.delete(entKey(userId, entitlement));
    },
    async mergeInto(fromUserId, toUserId, at) {
      const from = s.wallets.get(fromUserId);
      if (from) {
        const to = wallet(toUserId);
        s.wallets.set(toUserId, { userId: toUserId, diamonds: to.diamonds + from.diamonds, bonusDiamonds: to.bonusDiamonds + from.bonusDiamonds, updatedAt: at });
        s.wallets.delete(fromUserId);
      }
      for (const l of s.ledger) if (l.userId === fromUserId) l.userId = toUserId;
      for (const p of s.purchases) if (p.userId === fromUserId) p.userId = toUserId;
      for (const [k, e] of [...s.entitlements]) {
        if (e.userId !== fromUserId) continue;
        s.entitlements.delete(k);
        const theirs = s.entitlements.get(entKey(toUserId, e.entitlement));
        const expiresAt = !theirs ? e.expiresAt : theirs.expiresAt === null || e.expiresAt === null ? null : Math.max(theirs.expiresAt, e.expiresAt);
        const source = !theirs || (e.expiresAt !== null && theirs.expiresAt !== null && e.expiresAt > theirs.expiresAt) || (e.expiresAt === null && theirs.expiresAt !== null) ? e.source : theirs.source;
        s.entitlements.set(entKey(toUserId, e.entitlement), { userId: toUserId, entitlement: e.entitlement, expiresAt, source, updatedAt: at });
      }
    },
  };
}

function memoryClubs(s: MemoryState): ClubsRepo {
  return {
    async save(club) {
      s.clubs.set(club.code, copy(club));
    },
    async delete(code) {
      return s.clubs.delete(code);
    },
    async get(code) {
      const club = s.clubs.get(code);
      return club ? copy(club) : null;
    },
    async loadAll() {
      return [...s.clubs.values()].map(copy);
    },
    async isMember(clubCode, userId) {
      return s.clubs.get(clubCode)?.members.some((m) => m.userId === userId) ?? false;
    },
    async clubsForUser(userId) {
      const out: ClubMembership[] = [];
      for (const club of s.clubs.values()) {
        const m = club.members.find((x) => x.userId === userId);
        if (m) out.push({ clubCode: club.code, role: m.role, status: 'member' });
        else if (club.pending.some((p) => p.userId === userId)) out.push({ clubCode: club.code, role: 'member', status: 'pending' });
      }
      return out;
    },
    async moveMemberships(fromUserId, to) {
      return moveMembershipsIn(s.clubs.values(), fromUserId, to);
    },
    async anonymiseUser(userId) {
      return anonymiseUserIn(s.clubs, userId);
    },
  };
}

function memoryTableSnapshots(s: MemoryState): TableSnapshotsRepo {
  return {
    async save(snapshot) {
      s.snapshots.set(snapshot.roomCode, copy(snapshot));
    },
    async get(roomCode) {
      const row = s.snapshots.get(roomCode);
      return row ? copy(row) : null;
    },
    async listActive() {
      return [...s.snapshots.values()].filter((r) => r.status !== 'finished').map(copy);
    },
    async delete(roomCode) {
      return s.snapshots.delete(roomCode);
    },
    async pruneFinished(before) {
      let n = 0;
      for (const [k, r] of [...s.snapshots]) if (r.status === 'finished' && r.updatedAt < before && s.snapshots.delete(k)) n++;
      return n;
    },
  };
}

function memoryMatchResults(s: MemoryState): MatchResultsRepo {
  return {
    async record(r) {
      const row: MatchResultRecord = { ...copy(r), id: ++s.matchSeq };
      s.matches.push(row);
      return copy(row);
    },
    async listForClub(clubCode, limit = 50) {
      return s.matches
        .filter((r) => r.clubCode === clubCode)
        .sort((a, b) => b.finishedAt - a.finishedAt || b.id - a.id)
        .slice(0, limit)
        .map(copy);
    },
    async listForRoom(roomCode) {
      return s.matches.filter((r) => r.roomCode === roomCode).map(copy);
    },
  };
}

function memoryPuzzleResults(s: MemoryState): PuzzleResultsRepo {
  return {
    async record(r) {
      const row: PuzzleResultRecord = { ...copy(r), id: ++s.puzzleSeq };
      s.puzzles.push(row);
      return copy(row);
    },
    async listForUser(userId, limit = 500) {
      return s.puzzles
        .filter((r) => r.userId === userId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
        .slice(0, limit)
        .map(copy);
    },
    async moveToUser(fromUserId, toUserId) {
      let n = 0;
      for (const r of s.puzzles) {
        if (r.userId !== fromUserId) continue;
        r.userId = toUserId;
        n++;
      }
      return n;
    },
  };
}

function build(s: MemoryState, transaction: Repos['transaction']): Repos {
  return {
    kind: 'memory',
    users: memoryUsers(s),
    identities: memoryIdentities(s),
    sessions: memorySessions(s),
    devices: memoryDevices(s),
    wallet: memoryWallet(s),
    storeEvents: memoryStoreEvents(s),
    reports: memoryReports(s),
    clubs: memoryClubs(s),
    tableSnapshots: memoryTableSnapshots(s),
    matchResults: memoryMatchResults(s),
    puzzleResults: memoryPuzzleResults(s),
    blocks: memoryBlocks(s),
    moderation: memoryModeration(s),
    transaction,
  };
}

export function createMemoryRepos(): Repos {
  const state = emptyState();
  // Transactions run one after another; a throw puts every map and counter back as it was.
  let chain: Promise<unknown> = Promise.resolve();
  const transaction: Repos['transaction'] = (fn) => {
    const run = chain.then(async () => {
      const before = structuredClone(state);
      try {
        return await fn(inner);
      } catch (e) {
        Object.assign(state, before);
        throw e;
      }
    });
    chain = run.catch(() => undefined);
    return run;
  };
  const repos = build(state, transaction);
  // Inside a transaction the same repositories are used (so a test that stubs one sees the stub
  // there too); only a nested transaction() differs: it joins the outer one, as in Postgres.
  const inner: Repos = { ...repos, transaction: (fn) => fn(inner) };
  return repos;
}
