/**
 * Repository interfaces: the only way server code reads or writes durable state. Two
 * implementations exist, `memory.ts` (tests, and servers without DATABASE_URL) and `pg.ts`.
 * Both must pass the same contract in `test/repos.test.ts`.
 *
 * Conventions: every method is async; times are epoch milliseconds; a missing row is `null`
 * (never an exception); records returned are copies, so mutating one changes nothing stored.
 */
import type { Club, Identity } from '../clubs';

// ---------------------------------------------------------------------------------------------
// Users and sign-in
// ---------------------------------------------------------------------------------------------

export type UserKind = 'guest' | 'account';

export interface UserRecord {
  id: string;
  kind: UserKind;
  displayName: string;
  avatar: string | null;
  email: string | null;
  birthYear: number | null;
  locale: string | null;
  createdAt: number;
  lastSeenAt: number;
  deletedAt: number | null;
  mergedInto: string | null;
}

export interface NewUser {
  id: string;
  kind: UserKind;
  displayName?: string;
  avatar?: string | null;
  email?: string | null;
  birthYear?: number | null;
  locale?: string | null;
  createdAt: number;
}

export type UserPatch = Partial<Omit<UserRecord, 'id' | 'createdAt'>>;

export interface UsersRepo {
  create(user: NewUser): Promise<UserRecord>;
  get(id: string): Promise<UserRecord | null>;
  /** Applies the patch and returns the updated row, or null when there is no such user. */
  update(id: string, patch: UserPatch): Promise<UserRecord | null>;
  /** The player's analytics choice (`PATCH /api/me` analyticsConsent); null when the app has not said, which counts as no. */
  getAnalyticsConsent(id: string): Promise<boolean | null>;
  /** Stores the choice; false when there is no such user. */
  setAnalyticsConsent(id: string, consent: boolean | null): Promise<boolean>;
  /**
   * Hard-deletes users soft-deleted (or merged away) before `before`, with everything that
   * references them (identities, sessions, devices, wallet, entitlements, puzzle results, club
   * rows). Ledger, purchases, store events and reports keep their user ids as records. A user who
   * still owns a club is kept. Returns how many rows went.
   */
  purgeDeleted(before: number): Promise<number>;
}

export const IDENTITY_PROVIDERS = ['guest', 'apple', 'google', 'facebook'] as const;
export type IdentityProvider = (typeof IDENTITY_PROVIDERS)[number];

export interface IdentityRecord {
  provider: IdentityProvider;
  subject: string;
  userId: string;
  /** Peppered hash of the guest secret; null for the external providers. */
  secretHash: string | null;
  email: string | null;
  createdAt: number;
}

export interface IdentitiesRepo {
  get(provider: IdentityProvider, subject: string): Promise<IdentityRecord | null>;
  listForUser(userId: string): Promise<IdentityRecord[]>;
  /** Inserts the identity; false (and nothing written) when (provider, subject) already exists. */
  create(identity: IdentityRecord): Promise<boolean>;
  updateSecretHash(provider: IdentityProvider, subject: string, secretHash: string): Promise<void>;
  delete(provider: IdentityProvider, subject: string): Promise<boolean>;
  deleteForUser(userId: string): Promise<number>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  rotatedFrom: string | null;
  /** When the session stops working. A time in the future marks the grace window after a rotation. */
  revokedAt: number | null;
}

export type SessionPatch = Partial<Pick<SessionRecord, 'expiresAt' | 'revokedAt' | 'tokenHash'>>;

export interface SessionsRepo {
  create(session: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  findByHash(tokenHash: string): Promise<SessionRecord | null>;
  update(id: string, patch: SessionPatch): Promise<void>;
  /** Sets revoked_at only if it is still null; true when this call won (used to rotate exactly once). */
  revokeIfActive(id: string, at: number): Promise<boolean>;
  /** Ends every session of the user at `at` (including ones in a grace window), except `exceptId`. */
  revokeAllForUser(userId: string, at: number, exceptId?: string): Promise<number>;
  deleteForUser(userId: string): Promise<number>;
  /** Removes sessions that have expired or whose revocation (grace window included) is past at `at`. */
  pruneEnded(at: number): Promise<number>;
}

export interface DeviceRecord {
  id: string;
  userId: string;
  platform: string;
  appBuild: string | null;
  pushToken: string | null;
  locale: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export type DevicePatch = Partial<Pick<DeviceRecord, 'platform' | 'appBuild' | 'pushToken' | 'locale' | 'lastSeenAt'>>;

export interface DevicesRepo {
  create(device: DeviceRecord): Promise<void>;
  get(id: string): Promise<DeviceRecord | null>;
  update(id: string, patch: DevicePatch): Promise<void>;
  listForUser(userId: string): Promise<DeviceRecord[]>;
  moveToUser(fromUserId: string, toUserId: string): Promise<number>;
  deleteForUser(userId: string): Promise<number>;
  /** Clears this push token from every device holding it (except `exceptDeviceId`); returns how many. */
  clearPushToken(token: string, exceptDeviceId?: string): Promise<number>;
  /** Devices of these users that have a push token, oldest first. */
  pushTargets(userIds: string[]): Promise<PushTarget[]>;
}

export interface PushTarget {
  userId: string;
  deviceId: string;
  token: string;
  platform: string;
  locale: string | null;
}

// ---------------------------------------------------------------------------------------------
// Wallet, purchases and entitlements
// ---------------------------------------------------------------------------------------------

export interface WalletRecord {
  userId: string;
  /** Purchased diamonds; below zero only after a refund of diamonds already spent (no spend goes through until it is back above). */
  diamonds: number;
  bonusDiamonds: number;
  updatedAt: number;
}

export interface LedgerEntry {
  id: number;
  userId: string;
  /** Change to purchased diamonds. */
  delta: number;
  /** Change to bonus diamonds. */
  bonus: number;
  reason: string;
  ref: string | null;
  createdAt: number;
}

export type NewLedgerEntry = Omit<LedgerEntry, 'id' | 'bonus' | 'ref'> & { bonus?: number; ref?: string | null };

export interface PurchaseRecord {
  id: number;
  userId: string;
  store: string;
  transactionId: string;
  productId: string;
  price: number | null;
  currency: string | null;
  eventId: string | null;
  raw: unknown;
  createdAt: number;
}

export type NewPurchase = Omit<PurchaseRecord, 'id'>;

export interface EntitlementRecord {
  userId: string;
  entitlement: string;
  /** null means it does not expire. */
  expiresAt: number | null;
  source: string;
  updatedAt: number;
}

export interface WalletRepo {
  /** The user's balances; zero balances when the user has never had a wallet. */
  get(userId: string): Promise<WalletRecord>;
  /**
   * Appends a ledger entry and moves the balances by it, atomically. Returns null (and writes
   * nothing) when a debit would take purchased diamonds below zero, or bonus diamonds would go
   * below zero. A credit is always applied, even to a negative balance. `allowNegative` lets a
   * debit take purchased diamonds below zero (a refunded pack whose diamonds were already spent).
   */
  apply(entry: NewLedgerEntry, opts?: { allowNegative?: boolean }): Promise<{ wallet: WalletRecord; entry: LedgerEntry } | null>;
  listLedger(userId: string): Promise<LedgerEntry[]>;
  /** Idempotent on transaction id and event id: a repeat returns the stored row with inserted false. */
  recordPurchase(purchase: NewPurchase): Promise<{ purchase: PurchaseRecord; inserted: boolean }>;
  listPurchases(userId: string): Promise<PurchaseRecord[]>;
  getEntitlements(userId: string): Promise<EntitlementRecord[]>;
  setEntitlement(entitlement: EntitlementRecord): Promise<void>;
  deleteEntitlement(userId: string, entitlement: string): Promise<boolean>;
  /**
   * Account merge: sums the balances into `toUserId`, re-points the ledger and purchases, and
   * unions entitlements (the later expiry wins; no expiry beats any expiry).
   */
  mergeInto(fromUserId: string, toUserId: string, at: number): Promise<void>;
}

/** One store notification (a RevenueCat webhook event), kept raw; the event id makes processing idempotent. */
export interface StoreEventRecord {
  eventId: string;
  vendor: string;
  type: string;
  /** Our user the event was applied to; null when it named no user we know. */
  userId: string | null;
  productId: string | null;
  environment: string | null;
  /** What processing did (`credited`, `entitled`, `ignored_unknown_user`, …). */
  outcome: string;
  raw: unknown;
  receivedAt: number;
}

export interface StoreEventsRepo {
  /** Inserts the event; false (and nothing written) when its id was seen before. */
  record(event: StoreEventRecord): Promise<boolean>;
  get(eventId: string): Promise<StoreEventRecord | null>;
  setOutcome(eventId: string, outcome: string, userId: string | null): Promise<void>;
  /** Forgets an event whose processing failed, so a redelivery is processed (memory only needs it: Postgres rolls back). */
  delete(eventId: string): Promise<boolean>;
  /** Users named by an event received at or after `since` (the nightly store reconciliation's list). */
  usersActiveSince(since: number): Promise<string[]>;
}

// ---------------------------------------------------------------------------------------------
// Player reports
// ---------------------------------------------------------------------------------------------

export const REPORT_REASONS = ['cheating', 'collusion', 'abusive_chat', 'offensive_name', 'stalling', 'other'] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export interface ReportRecord {
  id: number;
  reporterId: string;
  reportedUserId: string;
  roomCode: string | null;
  reason: ReportReason;
  details: string | null;
  status: 'open' | 'actioned' | 'dismissed';
  createdAt: number;
}

export type NewReport = Omit<ReportRecord, 'id' | 'status'>;

export interface ReportsRepo {
  create(report: NewReport): Promise<ReportRecord>;
  /** Reports filed by this user at or after `since`. */
  countByReporterSince(reporterId: string, since: number): Promise<number>;
  /** Reports about this user, newest first (for moderation). */
  listAbout(reportedUserId: string, limit?: number): Promise<ReportRecord[]>;
  /** Account merge: reports filed by or about `fromUserId` now name `toUserId` (a report between the two is dropped). */
  moveToUser(fromUserId: string, toUserId: string): Promise<number>;
  get(id: number): Promise<ReportRecord | null>;
  /** Reports in this status, oldest first (the moderators' queue). */
  listByStatus(status: ReportRecord['status'], limit?: number): Promise<ReportRecord[]>;
  /**
   * Closes an open report with a moderator's decision: `dismiss` leaves it `dismissed`, anything
   * else `actioned`. False when there is no such report or it is no longer open.
   */
  resolve(id: number, resolution: ReportResolution, at: number): Promise<boolean>;
}

export const REPORT_RESOLUTIONS = ['dismiss', 'warn', 'ban', 'mute'] as const;
export type ReportResolution = (typeof REPORT_RESOLUTIONS)[number];

// ---------------------------------------------------------------------------------------------
// Blocks, bans and mutes
// ---------------------------------------------------------------------------------------------

export interface BlockRecord {
  blockerId: string;
  blockedId: string;
  createdAt: number;
}

export interface BlocksRepo {
  /** Records that `blockerId` blocked `blockedId`; false (nothing written) when it already had. */
  add(blockerId: string, blockedId: string, at: number): Promise<boolean>;
  remove(blockerId: string, blockedId: string): Promise<boolean>;
  /** Everyone this user blocked, newest first. */
  list(blockerId: string): Promise<BlockRecord[]>;
  /** The accounts that blocked this user. */
  blockersOf(blockedId: string): Promise<string[]>;
  /**
   * Account merge: blocks made by or naming `fromUserId` now belong to `toUserId`. A block between
   * the two is dropped, and a block both had collapses into one.
   */
  moveToUser(fromUserId: string, toUserId: string): Promise<number>;
  /** Account deletion: every block made by or naming the user. */
  deleteForUser(userId: string): Promise<number>;
}

export interface ModerationStatus {
  bannedAt: number | null;
  banReason: string | null;
  /** The account's chat and emotes are dropped at every table until then. */
  mutedUntil: number | null;
}

export interface ModerationRepo {
  /** The account's ban and mute; null when there is no such user. */
  status(userId: string): Promise<ModerationStatus | null>;
  /** Bans the account (a second ban keeps the first time and takes the new reason); false when there is no such user. */
  ban(userId: string, at: number, reason: string | null): Promise<boolean>;
  unban(userId: string): Promise<boolean>;
  /** Mutes the account until `until` (null lifts the mute); false when there is no such user. */
  mute(userId: string, until: number | null): Promise<boolean>;
  /** Accounts muted past `at`, for the tables to load at boot. */
  mutedAfter(at: number): Promise<Array<{ userId: string; mutedUntil: number }>>;
}

// ---------------------------------------------------------------------------------------------
// Clubs, tables and results
// ---------------------------------------------------------------------------------------------

export interface ClubMembership {
  clubCode: string;
  role: Club['members'][number]['role'];
  status: 'member' | 'pending';
}

export interface ClubsRepo {
  /** Writes one club in full (row, members, pending requests, tables); rows no longer present are removed. */
  save(club: Club): Promise<void>;
  delete(code: string): Promise<boolean>;
  get(code: string): Promise<Club | null>;
  loadAll(): Promise<Club[]>;
  /** True when the user is a full member (not merely pending). */
  isMember(clubCode: string, userId: string): Promise<boolean>;
  clubsForUser(userId: string): Promise<ClubMembership[]>;
  /**
   * Account merge: moves `fromUserId`'s memberships and pending requests to `to`. Where both have
   * a row the stronger one stays (member beats pending; on a tie `to`'s row is kept); clubs
   * owned by `fromUserId` transfer to `to`. Returns the codes of every club changed, so a
   * cache such as ClubRegistry can reload them.
   */
  moveMemberships(fromUserId: string, to: Identity): Promise<string[]>;
  /**
   * Account deletion: renames the user's rows to "Deleted player", clears avatars, drops pending
   * requests. A club the user owned passes to its senior admin, else its earliest member (the
   * deleted row stays as a plain member); one with nobody else in it is deleted. Returns the
   * clubs changed (the dissolved ones included).
   */
  anonymiseUser(userId: string): Promise<string[]>;
}

export type TableStatus = 'open' | 'playing' | 'finished';

export interface TableSnapshotRecord {
  roomCode: string;
  clubCode: string | null;
  status: TableStatus;
  /** The serialised host (SerializedHost); stored as opaque JSON. */
  snapshot: unknown;
  updatedAt: number;
}

export interface TableSnapshotsRepo {
  save(snapshot: TableSnapshotRecord): Promise<void>;
  get(roomCode: string): Promise<TableSnapshotRecord | null>;
  /** Every snapshot whose table has not finished, to restore at boot. */
  listActive(): Promise<TableSnapshotRecord[]>;
  delete(roomCode: string): Promise<boolean>;
  /** Removes finished snapshots last written before `before`. */
  pruneFinished(before: number): Promise<number>;
}

export interface MatchPlayer {
  seat: number;
  name: string;
  userId: string | null;
  isBot: boolean;
}

export interface MatchResultRecord {
  id: number;
  roomCode: string;
  clubCode: string | null;
  handCount: number;
  scores: number[];
  players: MatchPlayer[];
  handsWon: number[];
  finishedAt: number;
}

export interface MatchResultsRepo {
  record(result: Omit<MatchResultRecord, 'id'>): Promise<MatchResultRecord>;
  /** Newest first. */
  listForClub(clubCode: string, limit?: number): Promise<MatchResultRecord[]>;
  listForRoom(roomCode: string): Promise<MatchResultRecord[]>;
}

export interface PuzzleResultRecord {
  id: number;
  userId: string;
  kind: string;
  puzzleKey: string;
  correct: boolean;
  seconds: number;
  ratingAfter: number | null;
  createdAt: number;
}

export interface PuzzleResultsRepo {
  record(result: Omit<PuzzleResultRecord, 'id'>): Promise<PuzzleResultRecord>;
  /** Oldest first. */
  listForUser(userId: string, limit?: number): Promise<PuzzleResultRecord[]>;
  moveToUser(fromUserId: string, toUserId: string): Promise<number>;
}

// ---------------------------------------------------------------------------------------------

export interface Repos {
  readonly kind: 'memory' | 'pg';
  users: UsersRepo;
  identities: IdentitiesRepo;
  sessions: SessionsRepo;
  devices: DevicesRepo;
  wallet: WalletRepo;
  storeEvents: StoreEventsRepo;
  reports: ReportsRepo;
  clubs: ClubsRepo;
  tableSnapshots: TableSnapshotsRepo;
  matchResults: MatchResultsRepo;
  puzzleResults: PuzzleResultsRepo;
  blocks: BlocksRepo;
  moderation: ModerationRepo;
  /**
   * Runs `fn` with repositories that share one transaction (pg: BEGIN/COMMIT, ROLLBACK on a
   * throw; nested calls join the outer transaction). The memory implementation runs one
   * transaction at a time and restores its state when `fn` throws.
   */
  transaction<T>(fn: (tx: Repos) => Promise<T>): Promise<T>;
}

/** Display name written over a deleted user's club rows and profile. */
export const DELETED_PLAYER_NAME = 'Deleted player';
