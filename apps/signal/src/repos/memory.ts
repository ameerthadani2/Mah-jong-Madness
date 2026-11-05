/**
 * In-memory repositories: used by the tests and by a server started without DATABASE_URL
 * (development, or a single machine whose clubs live in the JSON file). Every read and write
 * copies, so callers can never mutate stored state by accident. Nothing here survives a restart.
 */
import type { Club, ClubMember, Identity } from '../clubs';
import {
  DELETED_PLAYER_NAME,
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
  type PurchaseRecord,
  type PuzzleResultRecord,
  type PuzzleResultsRepo,
  type Repos,
  type SessionPatch,
  type SessionRecord,
  type SessionsRepo,
  type TableSnapshotRecord,
  type TableSnapshotsRepo,
  type UserPatch,
  type UserRecord,
  type UsersRepo,
  type WalletRecord,
  type WalletRepo,
} from './types';

const copy = <T>(v: T): T => structuredClone(v);

function memoryUsers(): UsersRepo {
  const rows = new Map<string, UserRecord>();
  return {
    async create(u) {
      if (rows.has(u.id)) throw new Error(`User ${u.id} already exists`);
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
      rows.set(row.id, row);
      return copy(row);
    },
    async get(id) {
      const row = rows.get(id);
      return row ? copy(row) : null;
    },
    async update(id, patch: UserPatch) {
      const row = rows.get(id);
      if (!row) return null;
      Object.assign(row, copy(patch));
      return copy(row);
    },
  };
}

function memoryIdentities(): IdentitiesRepo {
  const rows = new Map<string, IdentityRecord>();
  const key = (provider: IdentityProvider, subject: string) => `${provider}\u0000${subject}`;
  return {
    async get(provider, subject) {
      const row = rows.get(key(provider, subject));
      return row ? copy(row) : null;
    },
    async listForUser(userId) {
      return [...rows.values()].filter((r) => r.userId === userId).map(copy);
    },
    async create(identity) {
      const k = key(identity.provider, identity.subject);
      if (rows.has(k)) return false;
      rows.set(k, copy(identity));
      return true;
    },
    async updateSecretHash(provider, subject, secretHash) {
      const row = rows.get(key(provider, subject));
      if (row) row.secretHash = secretHash;
    },
    async delete(provider, subject) {
      return rows.delete(key(provider, subject));
    },
    async deleteForUser(userId) {
      let n = 0;
      for (const [k, r] of rows) if (r.userId === userId && rows.delete(k)) n++;
      return n;
    },
  };
}

function memorySessions(): SessionsRepo {
  const rows = new Map<string, SessionRecord>();
  return {
    async create(session) {
      if (rows.has(session.id) || [...rows.values()].some((r) => r.tokenHash === session.tokenHash)) throw new Error('Duplicate session');
      rows.set(session.id, copy(session));
    },
    async get(id) {
      const row = rows.get(id);
      return row ? copy(row) : null;
    },
    async findByHash(tokenHash) {
      for (const r of rows.values()) if (r.tokenHash === tokenHash) return copy(r);
      return null;
    },
    async update(id, patch: SessionPatch) {
      const row = rows.get(id);
      if (row) Object.assign(row, copy(patch));
    },
    async revokeIfActive(id, at) {
      const row = rows.get(id);
      if (!row || row.revokedAt !== null) return false;
      row.revokedAt = at;
      return true;
    },
    async revokeAllForUser(userId, at, exceptId) {
      let n = 0;
      for (const r of rows.values()) {
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
      for (const [id, r] of rows) if (r.userId === userId && rows.delete(id)) n++;
      return n;
    },
  };
}

function memoryDevices(): DevicesRepo {
  const rows = new Map<string, DeviceRecord>();
  return {
    async create(device) {
      if (rows.has(device.id)) throw new Error(`Device ${device.id} already exists`);
      rows.set(device.id, copy(device));
    },
    async get(id) {
      const row = rows.get(id);
      return row ? copy(row) : null;
    },
    async update(id, patch: DevicePatch) {
      const row = rows.get(id);
      if (row) Object.assign(row, copy(patch));
    },
    async listForUser(userId) {
      return [...rows.values()].filter((r) => r.userId === userId).map(copy);
    },
    async moveToUser(fromUserId, toUserId) {
      let n = 0;
      for (const r of rows.values()) {
        if (r.userId !== fromUserId) continue;
        r.userId = toUserId;
        n++;
      }
      return n;
    },
    async deleteForUser(userId) {
      let n = 0;
      for (const [id, r] of rows) if (r.userId === userId && rows.delete(id)) n++;
      return n;
    },
  };
}

function memoryWallet(): WalletRepo {
  const wallets = new Map<string, WalletRecord>();
  const ledger: LedgerEntry[] = [];
  const purchases: PurchaseRecord[] = [];
  const entitlements = new Map<string, EntitlementRecord>();
  let ledgerId = 0;
  let purchaseId = 0;
  const entKey = (userId: string, entitlement: string) => `${userId}\u0000${entitlement}`;
  const wallet = (userId: string): WalletRecord => wallets.get(userId) ?? { userId, diamonds: 0, bonusDiamonds: 0, updatedAt: 0 };
  return {
    async get(userId) {
      return copy(wallet(userId));
    },
    async apply(e) {
      const w = wallet(e.userId);
      const bonus = e.bonus ?? 0;
      if (w.diamonds + e.delta < 0 || w.bonusDiamonds + bonus < 0) return null;
      const next: WalletRecord = { userId: e.userId, diamonds: w.diamonds + e.delta, bonusDiamonds: w.bonusDiamonds + bonus, updatedAt: e.createdAt };
      const entry: LedgerEntry = { id: ++ledgerId, userId: e.userId, delta: e.delta, bonus, reason: e.reason, ref: e.ref ?? null, createdAt: e.createdAt };
      wallets.set(e.userId, next);
      ledger.push(entry);
      return { wallet: copy(next), entry: copy(entry) };
    },
    async listLedger(userId) {
      return ledger.filter((l) => l.userId === userId).map(copy);
    },
    async recordPurchase(p) {
      const existing = purchases.find((x) => x.transactionId === p.transactionId || (p.eventId !== null && x.eventId === p.eventId));
      if (existing) return { purchase: copy(existing), inserted: false };
      const row: PurchaseRecord = { ...copy(p), id: ++purchaseId };
      purchases.push(row);
      return { purchase: copy(row), inserted: true };
    },
    async listPurchases(userId) {
      return purchases.filter((p) => p.userId === userId).map(copy);
    },
    async getEntitlements(userId) {
      return [...entitlements.values()].filter((e) => e.userId === userId).map(copy);
    },
    async setEntitlement(e) {
      entitlements.set(entKey(e.userId, e.entitlement), copy(e));
    },
    async mergeInto(fromUserId, toUserId, at) {
      const from = wallets.get(fromUserId);
      if (from) {
        const to = wallet(toUserId);
        wallets.set(toUserId, { userId: toUserId, diamonds: to.diamonds + from.diamonds, bonusDiamonds: to.bonusDiamonds + from.bonusDiamonds, updatedAt: at });
        wallets.delete(fromUserId);
      }
      for (const l of ledger) if (l.userId === fromUserId) l.userId = toUserId;
      for (const p of purchases) if (p.userId === fromUserId) p.userId = toUserId;
      for (const [k, e] of [...entitlements]) {
        if (e.userId !== fromUserId) continue;
        entitlements.delete(k);
        const theirs = entitlements.get(entKey(toUserId, e.entitlement));
        const expiresAt = !theirs ? e.expiresAt : theirs.expiresAt === null || e.expiresAt === null ? null : Math.max(theirs.expiresAt, e.expiresAt);
        const source = !theirs || (e.expiresAt !== null && theirs.expiresAt !== null && e.expiresAt > theirs.expiresAt) || (e.expiresAt === null && theirs.expiresAt !== null) ? e.source : theirs.source;
        entitlements.set(entKey(toUserId, e.entitlement), { userId: toUserId, entitlement: e.entitlement, expiresAt, source, updatedAt: at });
      }
    },
  };
}

function memoryClubs(): ClubsRepo {
  const rows = new Map<string, Club>();
  return {
    async save(club) {
      rows.set(club.code, copy(club));
    },
    async delete(code) {
      return rows.delete(code);
    },
    async get(code) {
      const club = rows.get(code);
      return club ? copy(club) : null;
    },
    async loadAll() {
      return [...rows.values()].map(copy);
    },
    async isMember(clubCode, userId) {
      return rows.get(clubCode)?.members.some((m) => m.userId === userId) ?? false;
    },
    async clubsForUser(userId) {
      const out: ClubMembership[] = [];
      for (const club of rows.values()) {
        const m = club.members.find((x) => x.userId === userId);
        if (m) out.push({ clubCode: club.code, role: m.role, status: 'member' });
        else if (club.pending.some((p) => p.userId === userId)) out.push({ clubCode: club.code, role: 'member', status: 'pending' });
      }
      return out;
    },
    async moveMemberships(fromUserId, to: Identity) {
      const changed: string[] = [];
      const rename = (x: Identity) => {
        x.userId = to.userId;
        x.name = to.name;
        if (to.avatar === undefined) delete x.avatar;
        else x.avatar = to.avatar;
      };
      for (const club of rows.values()) {
        const fromMember = club.members.find((m) => m.userId === fromUserId);
        const fromPending = club.pending.find((p) => p.userId === fromUserId);
        const ownsIt = club.ownerId === fromUserId;
        if (!fromMember && !fromPending && !ownsIt) continue;
        changed.push(club.code);
        const toMember = club.members.find((m) => m.userId === to.userId);
        if (fromMember) {
          if (toMember) club.members = club.members.filter((m) => m !== fromMember);
          else {
            rename(fromMember);
            club.pending = club.pending.filter((p) => p.userId !== to.userId);
          }
        }
        if (fromPending) {
          const toHasRow = club.members.some((m) => m.userId === to.userId) || club.pending.some((p) => p !== fromPending && p.userId === to.userId);
          if (toHasRow) club.pending = club.pending.filter((p) => p !== fromPending);
          else rename(fromPending);
        }
        if (ownsIt) {
          club.ownerId = to.userId;
          const owner = club.members.find((m) => m.userId === to.userId) as ClubMember | undefined;
          if (owner) owner.role = 'owner';
        }
        for (const t of club.tables) if (t.createdBy === fromUserId) t.createdBy = to.userId;
      }
      return changed;
    },
    async anonymiseUser(userId) {
      const changed: string[] = [];
      for (const club of rows.values()) {
        let touched = false;
        for (const m of club.members) {
          if (m.userId !== userId) continue;
          m.name = DELETED_PLAYER_NAME;
          delete m.avatar;
          touched = true;
        }
        const before = club.pending.length;
        club.pending = club.pending.filter((p) => p.userId !== userId);
        if (touched || club.pending.length !== before) changed.push(club.code);
      }
      return changed;
    },
  };
}

function memoryTableSnapshots(): TableSnapshotsRepo {
  const rows = new Map<string, TableSnapshotRecord>();
  return {
    async save(s) {
      rows.set(s.roomCode, copy(s));
    },
    async get(roomCode) {
      const row = rows.get(roomCode);
      return row ? copy(row) : null;
    },
    async listActive() {
      return [...rows.values()].filter((r) => r.status !== 'finished').map(copy);
    },
    async delete(roomCode) {
      return rows.delete(roomCode);
    },
    async pruneFinished(before) {
      let n = 0;
      for (const [k, r] of rows) if (r.status === 'finished' && r.updatedAt < before && rows.delete(k)) n++;
      return n;
    },
  };
}

function memoryMatchResults(): MatchResultsRepo {
  const rows: MatchResultRecord[] = [];
  let nextId = 0;
  return {
    async record(r) {
      const row: MatchResultRecord = { ...copy(r), id: ++nextId };
      rows.push(row);
      return copy(row);
    },
    async listForClub(clubCode, limit = 50) {
      return rows
        .filter((r) => r.clubCode === clubCode)
        .sort((a, b) => b.finishedAt - a.finishedAt || b.id - a.id)
        .slice(0, limit)
        .map(copy);
    },
    async listForRoom(roomCode) {
      return rows.filter((r) => r.roomCode === roomCode).map(copy);
    },
  };
}

function memoryPuzzleResults(): PuzzleResultsRepo {
  const rows: PuzzleResultRecord[] = [];
  let nextId = 0;
  return {
    async record(r) {
      const row: PuzzleResultRecord = { ...copy(r), id: ++nextId };
      rows.push(row);
      return copy(row);
    },
    async listForUser(userId, limit = 500) {
      return rows
        .filter((r) => r.userId === userId)
        .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
        .slice(0, limit)
        .map(copy);
    },
    async moveToUser(fromUserId, toUserId) {
      let n = 0;
      for (const r of rows) {
        if (r.userId !== fromUserId) continue;
        r.userId = toUserId;
        n++;
      }
      return n;
    },
  };
}

export function createMemoryRepos(): Repos {
  const repos: Repos = {
    kind: 'memory',
    users: memoryUsers(),
    identities: memoryIdentities(),
    sessions: memorySessions(),
    devices: memoryDevices(),
    wallet: memoryWallet(),
    clubs: memoryClubs(),
    tableSnapshots: memoryTableSnapshots(),
    matchResults: memoryMatchResults(),
    puzzleResults: memoryPuzzleResults(),
    transaction: (fn) => fn(repos),
  };
  return repos;
}
