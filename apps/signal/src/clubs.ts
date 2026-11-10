/**
 * Club registry: PokerBros-style private clubs, each with a code, an owner,
 * members, house rules, open tables and standings.
 *
 * The registry keeps every club in memory (reads and membership checks are synchronous) and
 * writes each changed club behind it through the injected store, one club at a time and in order
 * (`repos.clubs` in the server: memory or Postgres). `load()` reads every club at boot; `flush()`
 * waits for the writes still in flight.
 *
 * A member's identity is the account id from their session; their name and avatar come from the
 * user record and are refreshed whenever their membership changes (and when they edit their profile).
 *
 * Every value that arrives from the API is typed `unknown` here and checked
 * before it is stored, so a malformed request becomes a `ClubError` (HTTP 4xx), not a crash.
 */
import { BOT_SKILLS, randomHex, sanitizeRules, type BotSkill, type RuleSet } from '@mjm/engine';
import type { HostEvent } from '@mjm/net';
import { uniqueCode, type HexSource } from './codes';
import { BucketTable, cleanField } from './limits';
import { DELETED_PLAYER_NAME } from './repos/types';
import type { ClubGate } from './rooms';

export interface Identity {
  userId: string;
  name: string;
  avatar?: string;
}

export const CLUB_ROLES = ['owner', 'admin', 'member'] as const;
export type ClubRole = (typeof CLUB_ROLES)[number];

export function isClubRole(v: unknown): v is ClubRole {
  return typeof v === 'string' && (CLUB_ROLES as readonly string[]).includes(v);
}

export interface ClubMember extends Identity {
  role: ClubRole;
  joinedAt: number;
  /** Lifetime points across club tables. */
  points: number;
  /** Points this season; `startSeason` archives and resets them. Absent in rows written before seasons existed (read as `points`). */
  seasonPoints?: number;
  matchesPlayed: number;
  matchesWon: number;
  handsWon: number;
}

export interface ClubTablePlayer {
  seat: number;
  name: string;
  userId?: string;
  isBot: boolean;
  connected: boolean;
}

export interface ClubTable {
  code: string;
  label: string;
  rules: RuleSet;
  createdBy: string;
  createdAt: number;
  status: 'open' | 'playing' | 'finished';
  players: ClubTablePlayer[];
  handNumber: number;
  scores: number[];
  /**
   * Opened by an owner or admin with rules other than the club's house rules. A variant table never
   * counts toward the standings. Absent in listings written before variants existed (read as false).
   */
  variant?: boolean;
  /**
   * The club members seated when the match started (written once, when play begins). The match
   * counts toward the standings by these, and each is charged their seat's result, whatever
   * happens to their membership or their seat before the end. Absent while the table is open, and
   * in listings written before it existed.
   */
  startedWith?: Array<{ seat: number; userId: string }>;
}

/**
 * Standings kept on file for an account that is no longer a member (it left, or was removed or
 * banned). Hidden from the standings and from every view; added back if the account rejoins, so
 * leaving and rejoining never wipes a score.
 */
export interface FormerMember {
  userId: string;
  leftAt: number;
  /** The season `seasonPoints` were scored in; they return only while that season is still running. */
  season: number;
  points: number;
  seasonPoints: number;
  matchesPlayed: number;
  matchesWon: number;
  handsWon: number;
}

export interface ClubSettings {
  membersCanOpenTables: boolean;
  joinRequiresApproval: boolean;
  /**
   * Strength of the bots at every table of this club (the opener's choice is not used). Always set
   * by `sanitizeSettings`; optional only so settings written before it existed still type-check.
   */
  botSkill?: BotSkill;
}

export const DEFAULT_CLUB_SETTINGS: ClubSettings = { membersCanOpenTables: true, joinRequiresApproval: false, botSkill: 'club' };

/** An account banned from a club: it cannot rejoin, ask to join, or join the club's tables. */
export interface ClubBan extends Identity {
  bannedAt: number;
  /** The owner or admin who banned them. */
  by: string;
}

/** A request to join a club that waits for the owner or an admin. */
export interface PendingRequest extends Identity {
  /** When it was made; it expires `CLUB_LIMITS.pendingRequestMs` later. Absent in rows written before requests expired (read as the time they were loaded). */
  requestedAt?: number;
}

export interface Club {
  code: string;
  name: string;
  description: string;
  ownerId: string;
  createdAt: number;
  rules: RuleSet;
  settings: ClubSettings;
  members: ClubMember[];
  pending: PendingRequest[];
  tables: ClubTable[];
  /** The current season number (from 1). Absent in clubs stored before seasons existed (read as 1). */
  season?: number;
  seasonStartedAt?: number;
  /** Finished seasons, oldest first (at most `CLUB_LIMITS.seasonsKept`). */
  seasons?: SeasonRecord[];
  /** Banned accounts (absent in clubs stored before bans existed). Shown to the owner and admins only. */
  bans?: ClubBan[];
  /**
   * When the server first saw that the owner no longer holds The Four Winds Club, while the store
   * is live; null or absent while their plan is active. After `CLUB_LIMITS.ownerGraceMs` the club
   * may have only `CLUB_LIMITS.lapsedOpenTables` open table until the owner renews or passes it on.
   */
  ownerLapsedAt?: number | null;
  /**
   * Accounts that owned this club while without the plan, and when each one's lapse began. A lapse
   * belongs to the account, so handing the club to a subscriber and taking it back does not start
   * a new grace. Never sent to clients.
   */
  ownerLapses?: OwnerLapse[];
  /** Standings on file for accounts that left the club (decision 5). Never sent to clients. */
  former?: FormerMember[];
}

/** One account's lapse as an owner of a club. */
export interface OwnerLapse {
  userId: string;
  /** When the server first saw this account own a club without the plan. */
  lapsedAt: number;
  /** When the club passed on from this account; null while it is still the owner. */
  until: number | null;
}

/** A finished season: its final standings by season points. Points only; they have no monetary value. */
export interface SeasonRecord {
  season: number;
  startedAt: number;
  endedAt: number;
  standings: Array<{ userId: string; name: string; points: number }>;
}

/** Something a club did that other parts of the server react to (push notifications). */
export type ClubEvent =
  | { type: 'table_opened'; club: Club; table: ClubTable; by: string }
  | { type: 'member_approved'; club: Club; userId: string; by: string };

/** Per-club persistence (the shape of `ClubsRepo`). */
export interface ClubStore {
  save(club: Club): Promise<void>;
  delete(code: string): Promise<boolean>;
  get(code: string): Promise<Club | null>;
  loadAll(): Promise<Club[]>;
}

/** What a non-member may see of a club. */
export interface ClubPublicView {
  code: string;
  name: string;
  description: string;
  memberCount: number;
  joinRequiresApproval: boolean;
}

const DAY_MS = 86_400_000;
/** First retry after a failed club write; each further failure doubles it (up to a minute). */
const RETRY_DELAY_MS = 1_000;

export class ClubError extends Error {
  constructor(
    public readonly code: 'not_found' | 'forbidden' | 'exists' | 'invalid' | 'pending' | 'limit' | 'unavailable' | 'rate_limited',
    message: string,
  ) {
    super(message);
    this.name = 'ClubError';
  }
}

/** Caps that keep one account or club from growing the store without limit. */
export const CLUB_LIMITS = {
  /** Clubs one user can belong to or have pending requests for, including clubs they own. */
  clubsPerUser: 10,
  /** Members per club. Pending requests have the same cap. */
  membersPerClub: 200,
  /** A join request nobody answered is dropped after this long, so old ones cannot fill the queue for good. */
  pendingRequestMs: 30 * DAY_MS,
  /**
   * New members and join requests one address may add per hour over the API, across all clubs
   * (accounts are free to make, addresses less so).
   */
  joinsPerHourPerIp: 10,
  /** New members and join requests one club takes per hour over the API, whoever sends them. */
  joinsPerHourPerClub: 60,
  /** Tables per club that have not finished. */
  openTablesPerClub: 5,
  /** Clubs one account may own (decision 5: a Four Winds Club subscriber may run up to 3). */
  ownedClubsPerUser: 3,
  /** How long a club keeps its full table cap after the owner's plan lapses. */
  ownerGraceMs: 7 * DAY_MS,
  /** Open tables a club may have once the owner's plan has lapsed past the grace. */
  lapsedOpenTables: 1,
  /**
   * How long a lapse stays attached to the club after it passed on from the lapsed owner: an
   * account that takes the club over without a plan within this time continues that lapse (no new
   * grace). The lapsed account's own record does not expire.
   */
  lapseMemoryMs: 30 * DAY_MS,
  /** Owner lapses kept on file per club. */
  ownerLapsesPerClub: 20,
  /** Banned accounts kept per club. */
  bansPerClub: 500,
  /** Departed members whose standings are kept on file per club (the longest gone are dropped first). */
  formerMembersPerClub: 1000,
  nameLength: 40,
  descriptionLength: 280,
  labelLength: 40,
  /** Finished tables stay in a club's listing for this long. */
  finishedTableMs: DAY_MS,
  /** Finished seasons kept in a club's history. */
  seasonsKept: 24,
} as const;

/** Keep only the known settings, and only when they are real booleans; anything else keeps `base`'s value. */
export function sanitizeSettings(input: unknown, base: ClubSettings = DEFAULT_CLUB_SETTINGS): ClubSettings {
  const out: ClubSettings = {
    membersCanOpenTables: base.membersCanOpenTables,
    joinRequiresApproval: base.joinRequiresApproval,
    botSkill: isSkill(base.botSkill) ? base.botSkill : 'club',
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  if (typeof src.membersCanOpenTables === 'boolean') out.membersCanOpenTables = src.membersCanOpenTables;
  if (typeof src.joinRequiresApproval === 'boolean') out.joinRequiresApproval = src.joinRequiresApproval;
  if (isSkill(src.botSkill)) out.botSkill = src.botSkill;
  return out;
}

const isSkill = (v: unknown): v is BotSkill => typeof v === 'string' && Object.prototype.hasOwnProperty.call(BOT_SKILLS, v);

/** True when two rule sets are the same in every field. */
function sameRules(a: RuleSet, b: RuleSet): boolean {
  return (Object.keys(a) as Array<keyof RuleSet>).every((k) => a[k] === b[k]);
}

/**
 * A string field from the API, cleaned (`cleanField`: no control or invisible characters, so a NUL
 * can never stop the club being saved) and capped to `max` characters. A value that is not a string
 * is a client error, not a crash. The result may be empty; each caller decides what that means.
 */
function textField(v: unknown, field: string, max: number, multiline = false): string {
  if (typeof v !== 'string') throw new ClubError('invalid', `${field} must be text`);
  return cleanField(v, max, { multiline });
}

/** Clean up a club read from storage: older rows may hold unchecked rules or the retired `neutralHost` setting. */
function normalise(c: Club): Club {
  c.rules = sanitizeRules(c.rules);
  c.settings = sanitizeSettings(c.settings);
  c.members = Array.isArray(c.members) ? c.members : [];
  c.pending = Array.isArray(c.pending) ? c.pending : [];
  c.tables = Array.isArray(c.tables) ? c.tables : [];
  c.description = typeof c.description === 'string' ? c.description : '';
  c.season = Number.isInteger(c.season) && (c.season as number) >= 1 ? c.season : 1;
  c.seasonStartedAt = typeof c.seasonStartedAt === 'number' ? c.seasonStartedAt : c.createdAt;
  c.seasons = Array.isArray(c.seasons) ? c.seasons : [];
  c.bans = Array.isArray(c.bans) ? c.bans : [];
  c.ownerLapsedAt = typeof c.ownerLapsedAt === 'number' ? c.ownerLapsedAt : null;
  c.ownerLapses = Array.isArray(c.ownerLapses) ? c.ownerLapses.filter((l) => l && typeof l.userId === 'string' && typeof l.lapsedAt === 'number') : [];
  c.former = Array.isArray(c.former) ? c.former.filter((f) => f && typeof f.userId === 'string') : [];
  for (const t of c.tables) t.variant = t.variant === true;
  for (const m of c.members) if (typeof m.seasonPoints !== 'number') m.seasonPoints = m.points;
  return c;
}

const newMember = (user: Identity, role: ClubRole, at: number): ClubMember => ({ ...user, role, joinedAt: at, points: 0, seasonPoints: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 });

type Standing = Pick<ClubMember, 'points' | 'matchesPlayed' | 'matchesWon' | 'handsWon'> & { seasonPoints?: number };

/** Add a row of standings on file to another row (a member's, or another one on file). Season points count only for the season `into` is in. */
function addStandings(into: Standing, from: FormerMember, season: number): void {
  into.points += from.points;
  into.seasonPoints = (into.seasonPoints ?? 0) + (from.season === season ? from.seasonPoints : 0);
  into.matchesPlayed += from.matchesPlayed;
  into.matchesWon += from.matchesWon;
  into.handsWon += from.handsWon;
}

/**
 * A member is going (leaving, removed, banned): put their standings on file. Nothing is filed for
 * a member with no results who is not at one of the club's tables either, so accounts that only
 * join and leave cost nothing.
 */
function fileStandings(club: Club, m: ClubMember, at: number): void {
  const seated = club.tables.some((t) => t.status !== 'finished' && ((t.startedWith ?? []).some((s) => s.userId === m.userId) || (t.players ?? []).some((p) => !p.isBot && p.userId === m.userId)));
  if (!seated && m.points === 0 && (m.seasonPoints ?? 0) === 0 && m.matchesPlayed === 0 && m.matchesWon === 0 && m.handsWon === 0) return;
  const season = club.season ?? 1;
  const row: FormerMember = { userId: m.userId, leftAt: at, season, points: m.points, seasonPoints: m.seasonPoints ?? m.points, matchesPlayed: m.matchesPlayed, matchesWon: m.matchesWon, handsWon: m.handsWon };
  const former = (club.former ??= []);
  const old = former.find((f) => f.userId === m.userId);
  if (old) {
    addStandings(row, old, season);
    former.splice(former.indexOf(old), 1);
  }
  former.push(row);
  if (former.length > CLUB_LIMITS.formerMembersPerClub) {
    former.sort((a, b) => a.leftAt - b.leftAt);
    former.splice(0, former.length - CLUB_LIMITS.formerMembersPerClub);
  }
}

/** An account is (back) in the club: whatever standings it has on file return to its member row. */
function restoreStandings(club: Club, m: ClubMember): void {
  const former = club.former ?? [];
  const row = former.find((f) => f.userId === m.userId);
  if (!row) return;
  addStandings(m, row, club.season ?? 1);
  club.former = former.filter((f) => f !== row);
}

/**
 * Account merge, applied in place to clubs held in memory: `fromUserId`'s memberships and pending
 * requests pass to `to` (where both have a row the stronger one stays: member beats pending; on a
 * tie `to`'s row is kept), clubs `fromUserId` owns transfer, and its table listings are re-attributed.
 * The two accounts are one person, so every club passes to `to` even when that takes it past
 * `CLUB_LIMITS.ownedClubsPerUser`: the plan covers only the first three (see `ClubRegistry.covered`),
 * and the rest run as lapsed clubs until they are passed on. A lapse on file for `fromUserId` as an
 * owner follows it too. Standings on file for either account in a club (it had left) are added to
 * the member row `to` ends up with, or stay on file under `to`. Returns the codes of the clubs
 * changed. The memory repository, the Postgres one and the registry all use this, so the rows in
 * the store and the clubs in memory always agree. `at` is the time of the merge.
 */
export function moveMembershipsIn(clubs: Iterable<Club>, fromUserId: string, to: Identity, at: number = Date.now()): string[] {
  const changed: string[] = [];
  const rename = (x: Identity) => {
    x.userId = to.userId;
    x.name = to.name;
    if (to.avatar === undefined) delete x.avatar;
    else x.avatar = to.avatar;
  };
  for (const club of clubs) {
    const fromMember = club.members.find((m) => m.userId === fromUserId);
    const fromPending = club.pending.find((p) => p.userId === fromUserId);
    const ownsIt = club.ownerId === fromUserId;
    const bans = club.bans ?? [];
    const fromBan = bans.find((b) => b.userId === fromUserId);
    const fromLapse = (club.ownerLapses ?? []).find((l) => l.userId === fromUserId);
    const fromFormer = (club.former ?? []).find((f) => f.userId === fromUserId);
    if (!fromMember && !fromPending && !ownsIt && !fromBan && !fromLapse && !fromFormer) continue;
    changed.push(club.code);
    if (fromLapse) {
      const toLapse = club.ownerLapses!.find((l) => l.userId === to.userId);
      if (toLapse) {
        toLapse.lapsedAt = Math.min(toLapse.lapsedAt, fromLapse.lapsedAt);
        if (fromLapse.until === null) toLapse.until = null;
        club.ownerLapses = club.ownerLapses!.filter((l) => l !== fromLapse);
      } else fromLapse.userId = to.userId;
    }
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
      const owner = club.members.find((m) => m.userId === to.userId);
      if (owner) owner.role = 'owner';
    }
    for (const t of club.tables) {
      if (t.createdBy === fromUserId) t.createdBy = to.userId;
      for (const s of t.startedWith ?? []) if (s.userId === fromUserId) s.userId = to.userId;
    }
    // Standings on file: one person, one row. They join the member row, or stay on file under `to`.
    const nowMember = club.members.find((m) => m.userId === to.userId);
    const toFormer = (club.former ?? []).find((f) => f.userId === to.userId);
    if (nowMember) {
      restoreStandings(club, nowMember);
      if (fromFormer) {
        addStandings(nowMember, fromFormer, club.season ?? 1);
        club.former = (club.former ?? []).filter((f) => f !== fromFormer);
      }
    } else if (fromFormer) {
      if (toFormer) {
        const season = Math.max(toFormer.season, fromFormer.season);
        if (toFormer.season !== season) toFormer.seasonPoints = 0;
        toFormer.season = season;
        addStandings(toFormer, fromFormer, season);
        toFormer.leftAt = Math.max(toFormer.leftAt, fromFormer.leftAt);
        club.former = (club.former ?? []).filter((f) => f !== fromFormer);
      } else fromFormer.userId = to.userId;
    }
    // A ban follows the account it was moved into, and beats any membership there (the owner's excepted).
    if (fromBan) {
      if (bans.some((b) => b.userId === to.userId)) club.bans = bans.filter((b) => b !== fromBan);
      else {
        fromBan.userId = to.userId;
        fromBan.name = to.name;
      }
    }
    if ((club.bans ?? []).some((b) => b.userId === to.userId)) {
      for (const m of club.members) if (m.userId === to.userId && m.role !== 'owner') fileStandings(club, m, at);
      club.members = club.members.filter((m) => m.userId !== to.userId || m.role === 'owner');
      club.pending = club.pending.filter((p) => p.userId !== to.userId);
    }
  }
  return changed;
}

/**
 * Account deletion, applied in place: the user's member rows become "Deleted player" with no
 * avatar, pending requests are dropped, and a club they owned passes to its senior admin (the
 * earliest-joined one), else its earliest member, skipping accounts that already own
 * `CLUB_LIMITS.ownedClubsPerUser` clubs and members who have deleted their own account. When
 * everyone left is at the cap the senior one takes it all the same (a club needs an owner), and it
 * runs as a lapsed club until they pass it on (`ClubRegistry.covered`). A club with nobody else
 * left in it is removed from `clubs`. Returns the codes of the clubs changed, the removed ones
 * included. Shared by the memory repository, the Postgres one and the registry, like
 * `moveMembershipsIn`. `ownedCount` says how many clubs an account owns when `clubs` is not every
 * club there is (Postgres loads only the ones this user is in).
 */
export function anonymiseUserIn(clubs: Map<string, Club>, userId: string, ownedCount?: (userId: string) => number): string[] {
  const changed: string[] = [];
  const handedOver = new Map<string, number>();
  const owned = (id: string) => (ownedCount ? ownedCount(id) + (handedOver.get(id) ?? 0) : [...clubs.values()].filter((c) => c.ownerId === id).length);
  for (const club of [...clubs.values()]) {
    let touched = false;
    for (const m of club.members) {
      if (m.userId !== userId) continue;
      m.name = DELETED_PLAYER_NAME;
      delete m.avatar;
      touched = true;
    }
    const before = club.pending.length;
    club.pending = club.pending.filter((p) => p.userId !== userId);
    for (const b of club.bans ?? []) {
      if (b.userId !== userId) continue;
      b.name = DELETED_PLAYER_NAME;
      touched = true;
    }
    if (club.ownerId === userId) {
      touched = true;
      const candidates = club.members
        .filter((m) => m.userId !== userId && m.name !== DELETED_PLAYER_NAME)
        .sort((a, b) => Number(b.role === 'admin') - Number(a.role === 'admin') || a.joinedAt - b.joinedAt || a.userId.localeCompare(b.userId));
      const successor = candidates.find((m) => owned(m.userId) < CLUB_LIMITS.ownedClubsPerUser) ?? candidates[0];
      if (!successor) {
        clubs.delete(club.code);
        changed.push(club.code);
        continue;
      }
      club.ownerId = successor.userId;
      successor.role = 'owner';
      handedOver.set(successor.userId, (handedOver.get(successor.userId) ?? 0) + 1);
      for (const m of club.members) if (m.userId === userId) m.role = 'member';
    }
    if (touched || club.pending.length !== before) changed.push(club.code);
  }
  return changed;
}

export class ClubRegistry {
  private clubs = new Map<string, Club>();
  private readonly now: () => number;
  private readonly hex: HexSource;
  private readonly store: ClubStore | null;
  /** The write chain per club; each link writes the club as it is when the link runs. */
  private readonly writes = new Map<string, Promise<void>>();
  /** Clubs with a write queued that has not started yet (further changes ride along with it). */
  private readonly queued = new Set<string>();
  /** Clubs whose last write failed: how many times in a row, and the retry timer. They are written again with backoff, and by `flush()`. */
  private readonly dirty = new Map<string, { failures: number; timer: ReturnType<typeof setTimeout> | null }>();
  /** Number of writes requested (tests use it to check that no-op updates write nothing). */
  writeCount = 0;
  private readonly listeners = new Set<(ev: ClubEvent) => void>();
  private readonly retryDelayMs: number;
  /** Whether a club owner holds The Four Winds Club; null while the store is not live (no check). */
  private ownerPlan: ((userId: string) => Promise<boolean>) | null = null;
  private planCheck: Promise<void> | null = null;
  /** Joins and join requests over the API, per client address and per club (see `joinClub`). */
  private readonly joinsByIp: BucketTable<string>;
  private readonly joinsByClub: BucketTable<string>;

  constructor(opts: { store?: ClubStore; now?: () => number; randomHex?: HexSource; retryDelayMs?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.hex = opts.randomHex ?? randomHex;
    this.store = opts.store ?? null;
    this.retryDelayMs = opts.retryDelayMs ?? RETRY_DELAY_MS;
    const hourly = (n: number) => new BucketTable<string>(n, n / 3600, { now: this.now, idleMs: 3_600_000 });
    this.joinsByIp = hourly(CLUB_LIMITS.joinsPerHourPerIp);
    this.joinsByClub = hourly(CLUB_LIMITS.joinsPerHourPerClub);
  }

  /** Clubs whose last write failed and have not been written since (tests and diagnostics). */
  get unsaved(): string[] {
    return [...this.dirty.keys()];
  }

  /**
   * Decision 5: once the store is live, owning a club needs The Four Winds Club. `hasPlan` says
   * whether an account holds it (the wallet); null turns the check off (development, pre-store
   * builds), and every club keeps its full table cap.
   */
  useOwnerPlan(hasPlan: ((userId: string) => Promise<boolean>) | null): void {
    this.ownerPlan = hasPlan;
  }

  /** True while the owner-plan check is on (the store is live). */
  get ownerPlanRequired(): boolean {
    return this.ownerPlan !== null;
  }

  /**
   * Bring one club's record of its owner's plan up to date: cleared while the plan is active and
   * covers this club, set to now the first time it is seen missing (the 7-day grace starts then).
   * A lapse already on record is kept while the plan stays missing, so passing the club back and
   * forth between two accounts without a plan never starts a new grace; and a lapse is filed under
   * the account that had it (`ownerLapses`), so it is still there when the club comes back to that
   * account from a subscriber. A wallet that cannot answer changes nothing.
   */
  async refreshOwnerPlan(code: string): Promise<void> {
    const check = this.ownerPlan;
    const club = this.clubs.get(code.toUpperCase());
    if (!check || !club) return;
    const ownerId = club.ownerId;
    let active: boolean;
    try {
      active = await check(ownerId);
    } catch (e) {
      console.error(`[signal] owner plan check for club ${club.code} failed:`, (e as Error).message);
      return;
    }
    // The club may have been deleted or passed on while the wallet answered.
    if (this.clubs.get(club.code) !== club || club.ownerId !== ownerId) return;
    const now = this.now();
    let next: number | null;
    let changed = false;
    if (active) {
      // The account holds the plan: whatever lapse it had on file anywhere is over.
      this.forgetLapses(ownerId);
      // A plan covers three clubs; one beyond them runs as a lapsed club until it is passed on.
      next = this.covered(club) ? null : (club.ownerLapsedAt ?? now);
    } else {
      const own = this.accountLapse(ownerId);
      next = Math.min(club.ownerLapsedAt ?? now, own ?? now);
      changed = this.fileLapse(club, ownerId, own ?? now, null);
    }
    if (next !== (club.ownerLapsedAt ?? null)) {
      club.ownerLapsedAt = next;
      changed = true;
    }
    if (changed) this.persist(club);
  }

  /**
   * True when this club is one of the `CLUB_LIMITS.ownedClubsPerUser` its owner's plan covers: the
   * first three they own, oldest first. Nobody can create or be handed a fourth, but an account
   * merge, or a deleted owner's club with nobody else to take it, can leave an account with more.
   */
  covered(club: Club): boolean {
    const owned = this.ownedBy(club.ownerId).sort((a, b) => a.createdAt - b.createdAt || a.code.localeCompare(b.code));
    return owned.indexOf(club) < CLUB_LIMITS.ownedClubsPerUser;
  }

  /** When this account's lapse as a club owner began, from every club's file; undefined when it has none. */
  private accountLapse(userId: string): number | undefined {
    let at: number | undefined;
    for (const c of this.clubs.values()) for (const l of c.ownerLapses ?? []) if (l.userId === userId && (at === undefined || l.lapsedAt < at)) at = l.lapsedAt;
    return at;
  }

  /** Record (or bring up to date) an account's lapse in a club's file. Returns whether the file changed. */
  private fileLapse(club: Club, userId: string, lapsedAt: number, until: number | null): boolean {
    const file = (club.ownerLapses ??= []);
    const row = file.find((l) => l.userId === userId);
    if (row) {
      if (row.lapsedAt <= lapsedAt && row.until === until) return false;
      row.lapsedAt = Math.min(row.lapsedAt, lapsedAt);
      row.until = until;
      return true;
    }
    file.push({ userId, lapsedAt, until });
    // Keep the file small: the owner's own row and the most recent departures.
    if (file.length > CLUB_LIMITS.ownerLapsesPerClub) {
      file.sort((a, b) => (a.until ?? Infinity) - (b.until ?? Infinity));
      file.splice(0, file.length - CLUB_LIMITS.ownerLapsesPerClub);
    }
    return true;
  }

  /** The account holds the plan again: drop its lapse from every club's file. */
  private forgetLapses(userId: string): void {
    for (const c of this.clubs.values()) {
      const kept = (c.ownerLapses ?? []).filter((l) => l.userId !== userId);
      if (kept.length === (c.ownerLapses ?? []).length) continue;
      c.ownerLapses = kept;
      this.persist(c);
    }
  }

  /**
   * The club has just passed from `prevOwnerId` to `club.ownerId`. A lapse it was running under
   * is filed under the account that had it, and the new owner starts with the earliest lapse on
   * file: their own from any club, or one this club passed on from within `lapseMemoryMs` (so a
   * chain of accounts without a plan cannot restart the grace through a subscriber). The caller
   * then asks the wallet (`refreshOwnerPlan`), which clears it for an owner whose plan covers it.
   */
  private ownerPassed(club: Club, prevOwnerId: string): void {
    const now = this.now();
    if (typeof club.ownerLapsedAt === 'number') this.fileLapse(club, prevOwnerId, club.ownerLapsedAt, now);
    let onFile = this.accountLapse(club.ownerId);
    for (const l of club.ownerLapses ?? []) {
      if (l.userId === club.ownerId || l.until === null || now - l.until > CLUB_LIMITS.lapseMemoryMs) continue;
      if (onFile === undefined || l.lapsedAt < onFile) onFile = l.lapsedAt;
    }
    if (onFile !== undefined) club.ownerLapsedAt = Math.min(club.ownerLapsedAt ?? onFile, onFile);
  }

  /** Check every club's owner (the hourly pruner runs this). One run at a time. */
  checkOwnerPlans(): Promise<void> {
    if (!this.ownerPlan) return Promise.resolve();
    this.planCheck ??= (async () => {
      try {
        for (const code of [...this.clubs.keys()]) await this.refreshOwnerPlan(code);
      } finally {
        this.planCheck = null;
      }
    })();
    return this.planCheck;
  }

  /**
   * True when the club runs on one open table because its owner's plan lapsed more than
   * `CLUB_LIMITS.ownerGraceMs` ago (only while the store is live).
   */
  ownerRestricted(club: Club): boolean {
    if (!this.ownerPlan || typeof club.ownerLapsedAt !== 'number') return false;
    return this.now() - club.ownerLapsedAt >= CLUB_LIMITS.ownerGraceMs;
  }

  /** Clubs this account owns. */
  ownedBy(userId: string): Club[] {
    return [...this.clubs.values()].filter((c) => c.ownerId === userId);
  }

  /** Subscribe to club events (a table opened, a join request approved). Listeners must not throw. */
  onEvent(cb: (ev: ClubEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(ev: ClubEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error('[signal] club event listener failed', (e as Error).message);
      }
    }
  }

  /** Read every club from the store (once, at boot, before the registry is used). */
  async load(): Promise<void> {
    if (!this.store) return;
    for (const c of await this.store.loadAll()) this.clubs.set(c.code, this.read(c));
  }

  /** A club as read from the store, cleaned up; a join request with no date starts its 30 days now. */
  private read(c: Club): Club {
    const club = normalise(c);
    for (const p of club.pending) if (typeof p.requestedAt !== 'number') p.requestedAt = this.now();
    return club;
  }

  /**
   * Drop join requests made before `before` (default: older than `CLUB_LIMITS.pendingRequestMs`).
   * The server runs this every hour; a club also does it for itself whenever someone asks to join.
   * Returns how many went.
   */
  expirePending(before: number = this.now() - CLUB_LIMITS.pendingRequestMs): number {
    let dropped = 0;
    for (const club of this.clubs.values()) dropped += this.expirePendingIn(club, before);
    return dropped;
  }

  private expirePendingIn(club: Club, before: number): number {
    const kept = club.pending.filter((p) => (p.requestedAt ?? before) >= before);
    const dropped = club.pending.length - kept.length;
    if (dropped === 0) return 0;
    club.pending = kept;
    this.persist(club);
    return dropped;
  }

  /**
   * Reconcile club table listings with the tables actually running after a boot: a table whose
   * room was restored stays listed (its players shown as disconnected until they return); one
   * that was not finished but has no room is a ghost and is removed, so it no longer uses up the
   * club's open-table cap. Finished tables older than `finishedTableMs` are dropped as well.
   */
  reconcileTables(isLive: (roomCode: string) => boolean): void {
    const cutoff = this.now() - CLUB_LIMITS.finishedTableMs;
    for (const club of this.clubs.values()) {
      const before = JSON.stringify(club.tables);
      club.tables = club.tables
        .filter((t) => (t.status === 'finished' ? t.createdAt >= cutoff : isLive(t.code)))
        .map((t) => (t.status === 'finished' ? t : { ...t, players: (t.players ?? []).map((p) => ({ ...p, connected: false })) }));
      if (JSON.stringify(club.tables) !== before) this.persist(club);
    }
  }

  /**
   * Drop finished table listings created before `before` (the server runs this every hour). It
   * also starts a check of every owner's plan while the store is live (see `checkOwnerPlans`).
   */
  pruneFinishedTables(before: number): void {
    void this.checkOwnerPlans();
    for (const club of this.clubs.values()) {
      const kept = club.tables.filter((t) => t.status !== 'finished' || t.createdAt >= before);
      if (kept.length === club.tables.length) continue;
      club.tables = kept;
      this.persist(club);
    }
  }

  /** Queue a write of this club. Writes for one club run in order; a burst of changes becomes one write. */
  private persist(club: Club): void {
    this.persistCode(club.code);
  }

  /**
   * Queue a write of the club with this code as it is when the write runs (a delete when it is no
   * longer in the registry). A write that fails leaves the club dirty: it is tried again after a
   * growing delay, and `flush()` tries once more before giving up.
   */
  private persistCode(code: string): void {
    this.writeCount++;
    const store = this.store;
    if (!store) return;
    if (this.queued.has(code)) return;
    this.queued.add(code);
    const prev = this.writes.get(code) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        this.queued.delete(code);
        const current = this.clubs.get(code);
        if (current) await store.save(structuredClone(current));
        else await store.delete(code);
        this.clean(code);
      })
      .catch((e: Error) => {
        console.error(`[signal] club ${code} not saved:`, e.message);
        this.retryLater(code);
      });
    this.writes.set(code, next);
    void next.then(() => {
      if (this.writes.get(code) === next) this.writes.delete(code);
    });
  }

  private clean(code: string): void {
    const d = this.dirty.get(code);
    if (!d) return;
    if (d.timer) clearTimeout(d.timer);
    this.dirty.delete(code);
  }

  /** A failed write: keep the club dirty and write it again after 1 s, 2 s, 4 s … up to a minute. */
  private retryLater(code: string): void {
    const d = this.dirty.get(code) ?? { failures: 0, timer: null };
    d.failures++;
    if (d.timer) clearTimeout(d.timer);
    d.timer = setTimeout(() => {
      d.timer = null;
      this.persistCode(code);
    }, Math.min(60_000, this.retryDelayMs * 2 ** (d.failures - 1)));
    d.timer.unref?.();
    this.dirty.set(code, d);
  }

  /**
   * Wait until every queued club write has reached the store. A club whose write failed is tried
   * again at once (a few times), so a shutdown does not leave a change behind; what still cannot be
   * written is logged.
   */
  async flush(): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      while (this.writes.size > 0) await Promise.all([...this.writes.values()]);
      if (this.dirty.size === 0) return;
      for (const [code, d] of this.dirty) {
        if (d.timer) clearTimeout(d.timer);
        d.timer = null;
        this.persistCode(code);
      }
    }
    while (this.writes.size > 0) await Promise.all([...this.writes.values()]);
    if (this.dirty.size) console.error(`[signal] clubs still not saved: ${[...this.dirty.keys()].join(' ')}`);
  }

  /**
   * Re-read clubs that changed underneath the registry (an account merge or deletion rewrites
   * club rows in the repositories directly).
   */
  async reload(codes: Iterable<string>): Promise<void> {
    if (!this.store) return;
    await this.flush();
    for (const code of new Set(codes)) {
      const club = await this.store.get(code);
      if (club) this.clubs.set(code, this.read(club));
      else this.clubs.delete(code);
    }
  }

  /**
   * Account merge: move `fromUserId`'s memberships, requests, ownerships and tables to `to` in the
   * registry's own clubs (the same rules as the repositories' `moveMemberships`) and write them.
   * The repositories rewrite their rows in the merge transaction too; applying the change here as
   * well means a write queued by a table event while that transaction ran (which carries the
   * registry's copy) can never put the old rows back, and nothing that happened in memory
   * meanwhile is lost to a reload. Returns the clubs changed.
   */
  moveMemberships(fromUserId: string, to: Identity): string[] {
    const changed = moveMembershipsIn(this.clubs.values(), fromUserId, to, this.now());
    for (const code of changed) {
      this.persistCode(code);
      // Clubs the merged account now owns: its plan decides their table cap (and covers only three).
      if (this.clubs.get(code)?.ownerId === to.userId) void this.refreshOwnerPlan(code);
    }
    return changed;
  }

  /** Account deletion: the in-memory counterpart of the repositories' `anonymiseUser` (see `moveMemberships`). Returns the clubs changed. */
  anonymiseMember(userId: string): string[] {
    const owned = this.ownedBy(userId).map((c) => c.code);
    const changed = anonymiseUserIn(this.clubs, userId);
    for (const code of changed) this.persistCode(code);
    // A club that passed to a successor: the lapse on record follows the rules of a transfer.
    for (const code of owned) {
      const club = this.clubs.get(code);
      if (!club || club.ownerId === userId) continue;
      this.ownerPassed(club, userId);
      void this.refreshOwnerPlan(code);
    }
    return changed;
  }

  /**
   * The hard delete of accounts (30 days after they were deleted) has removed these users, and in
   * Postgres their club rows with them. Drop their member rows and join requests from the clubs in
   * memory too, with any standings on file for them, so the next write of a club matches the store. Bans they made, and bans of them,
   * stay (a ban row names an account, it does not need one). A club one of them still owned (the
   * store refuses to purge an owner, so this is a registry that had fallen behind) passes on as at
   * deletion, or is removed when nobody else is in it. Returns the clubs changed.
   */
  dropPurged(userIds: Iterable<string>): string[] {
    const gone = new Set(userIds);
    if (gone.size === 0) return [];
    const changed = new Set<string>();
    for (const id of gone) {
      if (this.ownedBy(id).length) for (const code of this.anonymiseMember(id)) changed.add(code);
    }
    for (const club of this.clubs.values()) {
      const members = club.members.filter((m) => !gone.has(m.userId));
      const pending = club.pending.filter((p) => !gone.has(p.userId));
      const lapses = (club.ownerLapses ?? []).filter((l) => !gone.has(l.userId));
      const former = (club.former ?? []).filter((f) => !gone.has(f.userId));
      if (members.length === club.members.length && pending.length === club.pending.length && lapses.length === (club.ownerLapses ?? []).length && former.length === (club.former ?? []).length) continue;
      club.members = members;
      club.pending = pending;
      club.ownerLapses = lapses;
      club.former = former;
      changed.add(club.code);
    }
    for (const code of changed) this.persistCode(code);
    return [...changed];
  }

  /**
   * Write a user's current name and avatar over their rows in every club (members and pending
   * requests), so standings show what the user record says. Only clubs that change are written.
   */
  refreshMember(user: Identity): void {
    for (const club of this.clubs.values()) {
      let changed = false;
      for (const row of [...club.members, ...club.pending]) {
        if (row.userId !== user.userId) continue;
        if (row.name !== user.name || row.avatar !== user.avatar) {
          row.name = user.name;
          if (user.avatar === undefined) delete row.avatar;
          else row.avatar = user.avatar;
          changed = true;
        }
      }
      if (changed) this.persist(club);
    }
  }

  /** True when the user is a full member (pending requests do not count). */
  isMember(code: string, userId: string | undefined): boolean {
    if (!userId) return false;
    const club = this.clubs.get(code.toUpperCase());
    return !!club && club.members.some((m) => m.userId === userId);
  }

  /** True when the user is the club's owner or one of its admins. */
  isAdmin(code: string, userId: string | undefined): boolean {
    if (!userId) return false;
    const club = this.clubs.get(code.toUpperCase());
    const m = club?.members.find((x) => x.userId === userId);
    return !!m && (m.role === 'owner' || m.role === 'admin');
  }

  private newCode(): string {
    return uniqueCode((c) => this.clubs.has(c), 6, this.hex);
  }

  private get(code: string): Club {
    const c = this.clubs.get(code.toUpperCase());
    if (!c) throw new ClubError('not_found', 'Club not found');
    return c;
  }

  private member(club: Club, userId: string): ClubMember | undefined {
    return club.members.find((m) => m.userId === userId);
  }

  private requireRole(club: Club, userId: string, roles: ClubRole[]): ClubMember {
    const m = this.member(club, userId);
    if (!m || !roles.includes(m.role)) throw new ClubError('forbidden', 'You do not have permission to do that in this club');
    return m;
  }

  private requireClubRoom(userId: string): void {
    if (this.clubsForUser(userId).length >= CLUB_LIMITS.clubsPerUser) {
      throw new ClubError('limit', `You can belong to at most ${CLUB_LIMITS.clubsPerUser} clubs; leave one first`);
    }
  }

  private requireMemberRoom(club: Club): void {
    if (club.members.length >= CLUB_LIMITS.membersPerClub) throw new ClubError('limit', `This club is full (${CLUB_LIMITS.membersPerClub} members)`);
  }

  createClub(owner: Identity, name: unknown, rules: unknown = {}, settings: unknown = {}): Club {
    const trimmed = textField(name, 'Club name', CLUB_LIMITS.nameLength);
    if (!trimmed) throw new ClubError('invalid', 'Club name is required');
    if (!owner.userId || !owner.name) throw new ClubError('invalid', 'Owner identity is required');
    if (this.ownedBy(owner.userId).length >= CLUB_LIMITS.ownedClubsPerUser) {
      throw new ClubError('limit', `You can own at most ${CLUB_LIMITS.ownedClubsPerUser} clubs`);
    }
    this.requireClubRoom(owner.userId);
    const club: Club = {
      code: this.newCode(),
      name: trimmed,
      description: '',
      ownerId: owner.userId,
      createdAt: this.now(),
      rules: sanitizeRules(rules),
      settings: sanitizeSettings(settings),
      members: [newMember(owner, 'owner', this.now())],
      pending: [],
      tables: [],
      season: 1,
      seasonStartedAt: this.now(),
      seasons: [],
      bans: [],
      ownerLapsedAt: null,
      ownerLapses: [],
      former: [],
    };
    this.clubs.set(club.code, club);
    this.persist(club);
    return club;
  }

  /** True when the account is on this club's ban list. */
  isBanned(code: string, userId: string | undefined): boolean {
    if (!userId) return false;
    return (this.clubs.get(code.toUpperCase())?.bans ?? []).some((b) => b.userId === userId);
  }

  /**
   * Join a club, or ask to (a club that approves its members). `from` is the client address of a
   * request over the API: a new member or request is then charged to that address and to the
   * club (`joinsPerHourPerIp`, `joinsPerHourPerClub`), so throwaway accounts cannot fill a club or
   * its request queue in one go. Asking again while already in, or already waiting, costs nothing.
   */
  joinClub(code: string, user: Identity, from?: { ip: string }): { club: Club; status: 'joined' | 'pending' | 'already' } {
    const club = this.get(code);
    if (this.member(club, user.userId)) return { club, status: 'already' };
    if (this.isBanned(club.code, user.userId)) throw new ClubError('forbidden', 'You cannot join this club');
    this.expirePendingIn(club, this.now() - CLUB_LIMITS.pendingRequestMs);
    if (club.pending.some((p) => p.userId === user.userId)) return { club, status: 'pending' };
    this.requireClubRoom(user.userId);
    if (club.settings.joinRequiresApproval) {
      if (club.pending.length >= CLUB_LIMITS.membersPerClub) throw new ClubError('limit', 'This club has too many pending requests; try again later');
      this.chargeJoin(club, from);
      club.pending.push({ userId: user.userId, name: user.name, ...(user.avatar === undefined ? {} : { avatar: user.avatar }), requestedAt: this.now() });
      this.persist(club);
      return { club, status: 'pending' };
    }
    this.requireMemberRoom(club);
    this.chargeJoin(club, from);
    this.admit(club, user);
    this.persist(club);
    return { club, status: 'joined' };
  }

  /** Spend one join from the address and from the club; 429 `rate_limited` when either has run out. */
  private chargeJoin(club: Club, from?: { ip: string }): void {
    if (!from) return;
    if (!this.joinsByIp.take(from.ip)) throw new ClubError('rate_limited', 'Too many clubs joined from this connection; try again in an hour');
    if (!this.joinsByClub.take(club.code)) throw new ClubError('rate_limited', 'This club is getting a lot of join requests; try again later');
  }

  /** Make an account a member. Standings it left on file here come back with it (decision 5). */
  private admit(club: Club, user: Identity): ClubMember {
    const m = newMember({ userId: user.userId, name: user.name, ...(user.avatar === undefined ? {} : { avatar: user.avatar }) }, 'member', this.now());
    restoreStandings(club, m);
    club.members.push(m);
    return m;
  }

  approve(code: string, actorId: string, userId: string): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    const idx = club.pending.findIndex((p) => p.userId === userId);
    if (idx < 0) throw new ClubError('not_found', 'No pending request for that user');
    this.requireMemberRoom(club);
    const [user] = club.pending.splice(idx, 1);
    this.admit(club, user);
    this.persist(club);
    this.emit({ type: 'member_approved', club, userId, by: actorId });
    return club;
  }

  /**
   * A member leaves, or the owner or an admin removes one. Their standings go on file (hidden) and
   * come back if they rejoin, so leaving never wipes a score; a match they are seated in still
   * counts, and they are still charged their result (decision 5).
   */
  removeMember(code: string, actorId: string, userId: string): Club {
    const club = this.get(code);
    if (userId === club.ownerId) throw new ClubError('forbidden', 'The owner cannot leave; transfer ownership first');
    if (actorId !== userId) this.assertOutranks(club, actorId, userId);
    const leaving = this.member(club, userId);
    if (leaving) fileStandings(club, leaving, this.now());
    club.members = club.members.filter((m) => m.userId !== userId);
    club.pending = club.pending.filter((p) => p.userId !== userId);
    this.persist(club);
    return club;
  }

  /** Owner or admin: turn down a pending join request. */
  reject(code: string, actorId: string, userId: string): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    const before = club.pending.length;
    club.pending = club.pending.filter((p) => p.userId !== userId);
    if (club.pending.length === before) throw new ClubError('not_found', 'No pending request for that user');
    this.persist(club);
    return club;
  }

  /**
   * Owner or admin: turn down every pending join request at once, or only the ones named in
   * `userIds` (the app sends the requests it was showing, so one that arrives while the owner is
   * deciding is not swept away unseen). Clearing a queue also gives the club its hourly join
   * allowance back, so the people the owner does want can ask at once after a flood. Returns the
   * club and how many requests went.
   */
  rejectAll(code: string, actorId: string, userIds?: unknown): { club: Club; rejected: number } {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    if (userIds !== undefined && userIds !== null && (!Array.isArray(userIds) || userIds.length > CLUB_LIMITS.membersPerClub || userIds.some((id) => typeof id !== 'string'))) {
      throw new ClubError('invalid', 'userIds must be a list of account ids');
    }
    const only = Array.isArray(userIds) ? new Set(userIds as string[]) : null;
    const kept = only ? club.pending.filter((p) => !only.has(p.userId)) : [];
    const rejected = club.pending.length - kept.length;
    if (rejected > 0) {
      club.pending = kept;
      this.joinsByClub.forget(club.code);
      this.persist(club);
    }
    return { club, rejected };
  }

  /**
   * Check that `actorId` may act against `userId` in this club (remove, ban, take off a table):
   * the owner may act against anyone but themselves; an admin only against plain members and
   * accounts outside the club. Returns the club.
   */
  private assertOutranks(club: Club, actorId: string, userId: string): ClubMember {
    const actor = this.requireRole(club, actorId, ['owner', 'admin']);
    if (userId === actorId) throw new ClubError('forbidden', 'You cannot do that to yourself');
    if (userId === club.ownerId) throw new ClubError('forbidden', 'The owner cannot be removed; transfer ownership first');
    const target = this.member(club, userId);
    if (actor.role === 'admin' && target?.role === 'admin') throw new ClubError('forbidden', 'Only the owner can remove an admin');
    return actor;
  }

  /**
   * Owner or admin: ban an account. Its membership or pending request goes, and it can no longer
   * join, ask to join, or join the club's tables until it is unbanned. The caller takes it off the
   * club's live tables. `who` names an account that is not in the club (from its user record).
   */
  ban(code: string, actorId: string, userId: unknown, who?: Identity): Club {
    const club = this.get(code);
    if (typeof userId !== 'string' || !/^[\w-]{6,64}$/.test(userId)) throw new ClubError('invalid', 'userId must be an account id');
    const actor = this.assertOutranks(club, actorId, userId);
    const bans = (club.bans ??= []);
    if (!bans.some((b) => b.userId === userId)) {
      if (bans.length >= CLUB_LIMITS.bansPerClub) throw new ClubError('limit', `This club already has ${CLUB_LIMITS.bansPerClub} banned accounts; unban one first`);
      const row = this.member(club, userId) ?? club.pending.find((p) => p.userId === userId) ?? who;
      if (!row) throw new ClubError('not_found', 'Member not found');
      bans.push({ userId, name: row.name, bannedAt: this.now(), by: actor.userId });
    }
    const banned = this.member(club, userId);
    if (banned) fileStandings(club, banned, this.now());
    club.members = club.members.filter((m) => m.userId !== userId);
    club.pending = club.pending.filter((p) => p.userId !== userId);
    this.persist(club);
    return club;
  }

  /** Owner or admin: lift a ban. The account may then ask to join again like anyone else. */
  unban(code: string, actorId: string, userId: string): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    const bans = club.bans ?? [];
    if (!bans.some((b) => b.userId === userId)) throw new ClubError('not_found', 'That account is not banned');
    club.bans = bans.filter((b) => b.userId !== userId);
    this.persist(club);
    return club;
  }

  /**
   * Owner or admin: check that `actorId` may take `userId` off one of this club's tables, and that
   * the table is the club's. The room registry does the rest.
   */
  assertCanEvict(code: string, actorId: string, tableCode: string, userId: unknown): string {
    const club = this.get(code);
    if (typeof userId !== 'string' || !userId) throw new ClubError('invalid', 'userId must be an account id');
    if (!club.tables.some((t) => t.code === tableCode.toUpperCase() && t.status !== 'finished')) throw new ClubError('not_found', 'Table not found');
    this.assertOutranks(club, actorId, userId);
    return userId;
  }

  /**
   * Owner or admin: close one of the club's tables. The listing goes at once and the match counts
   * for nothing; the caller ends the room (`RoomRegistry.closeTable`).
   */
  closeTable(code: string, actorId: string, tableCode: string): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    const wanted = tableCode.toUpperCase();
    if (!club.tables.some((t) => t.code === wanted)) throw new ClubError('not_found', 'Table not found');
    this.removeTable(club.code, wanted);
    return club;
  }

  /**
   * Owner only: delete the club. `confirm` must repeat the club's name or code (the app asks the
   * owner to type it). Returns the codes of its tables that are still live, for the caller to close.
   */
  deleteClub(code: string, actorId: string, confirm: unknown): string[] {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner']);
    const typed = typeof confirm === 'string' ? confirm.trim().toLowerCase() : '';
    if (!typed || (typed !== club.name.trim().toLowerCase() && typed !== club.code.toLowerCase())) {
      throw new ClubError('invalid', "Type the club's name to confirm");
    }
    const live = club.tables.filter((t) => t.status !== 'finished').map((t) => t.code);
    this.clubs.delete(club.code);
    this.persistCode(club.code);
    return live;
  }

  setRole(code: string, actorId: string, userId: string, role: unknown): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner']);
    if (!isClubRole(role)) throw new ClubError('invalid', `Role must be one of ${CLUB_ROLES.join(', ')}`);
    // Without this check an owner could demote themselves and leave the club with no owner.
    if (userId === actorId) throw new ClubError('forbidden', 'The owner cannot change their own role; transfer ownership instead');
    const m = this.member(club, userId);
    if (!m) throw new ClubError('not_found', 'Member not found');
    if (role === 'owner') {
      // Decision 5: one account runs at most three clubs, however it comes by them.
      if (this.ownedBy(userId).length >= CLUB_LIMITS.ownedClubsPerUser) {
        throw new ClubError('limit', `That member already owns ${CLUB_LIMITS.ownedClubsPerUser} clubs, the most one account may own`);
      }
      const prev = this.member(club, club.ownerId);
      if (prev) prev.role = 'admin';
      club.ownerId = userId;
      this.ownerPassed(club, actorId);
    }
    m.role = role;
    this.persist(club);
    return club;
  }

  update(code: string, actorId: string, patch: { name?: unknown; description?: unknown; rules?: unknown; settings?: unknown }): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    // Validate everything before changing anything, so a bad field leaves the club untouched.
    const name = patch.name === undefined ? undefined : textField(patch.name, 'Club name', CLUB_LIMITS.nameLength);
    const description = patch.description === undefined ? undefined : textField(patch.description, 'Description', CLUB_LIMITS.descriptionLength, true);
    if (name) club.name = name;
    if (description !== undefined) club.description = description;
    if (patch.rules !== undefined) club.rules = sanitizeRules(patch.rules, club.rules);
    if (patch.settings !== undefined) club.settings = sanitizeSettings(patch.settings, club.settings);
    this.persist(club);
    return club;
  }

  club(code: string): Club {
    return this.get(code);
  }

  all(): Club[] {
    return [...this.clubs.values()];
  }

  clubForTable(tableCode: string): Club | undefined {
    for (const c of this.clubs.values()) if (c.tables.some((t) => t.code === tableCode)) return c;
    return undefined;
  }

  clubsForUser(userId: string): Club[] {
    return [...this.clubs.values()].filter((c) => c.members.some((m) => m.userId === userId) || c.pending.some((p) => p.userId === userId));
  }

  /**
   * Check that `actorId` may open a table in this club right now. The API calls this before
   * creating the room, so a refusal never leaves an orphaned hosted table behind.
   */
  assertCanOpenTable(code: string, actorId: string): ClubMember {
    const club = this.get(code);
    const m = this.member(club, actorId);
    if (!m) throw new ClubError('forbidden', 'Join the club first');
    if (!club.settings.membersCanOpenTables && m.role === 'member') throw new ClubError('forbidden', 'Only admins can open tables in this club');
    const open = club.tables.filter((t) => t.status !== 'finished').length;
    if (this.ownerRestricted(club) && open >= CLUB_LIMITS.lapsedOpenTables) {
      throw new ClubError('limit', `This club can have only ${CLUB_LIMITS.lapsedOpenTables} open table until its owner renews The Four Winds Club`);
    }
    if (open >= CLUB_LIMITS.openTablesPerClub) {
      throw new ClubError('limit', `This club already has ${CLUB_LIMITS.openTablesPerClub} open tables; finish one first`);
    }
    return m;
  }

  /**
   * The rules and bot strength a new table opened by `actorId` plays with (house rules, decision 1):
   * a member's table always uses the club's rules, whatever they asked for. An owner or admin may
   * ask for other rules; such a table is a variant and never counts toward the standings. The bots
   * are always the club's.
   */
  tableSetup(code: string, actorId: string, requested: unknown): { rules: RuleSet; variant: boolean; botSkill: BotSkill } {
    const club = this.get(code);
    const m = this.member(club, actorId);
    const botSkill = club.settings.botSkill ?? DEFAULT_CLUB_SETTINGS.botSkill!;
    if (!m || m.role === 'member' || requested === undefined || requested === null) return { rules: { ...club.rules }, variant: false, botSkill };
    const rules = sanitizeRules(requested, club.rules);
    return { rules, variant: !sameRules(rules, club.rules), botSkill };
  }

  /** Register a table (room) opened for this club. The caller creates the room with `tableSetup`'s rules. */
  addTable(code: string, actorId: string, table: { code: string; label?: unknown; rules?: unknown }): ClubTable {
    const club = this.get(code);
    const m = this.assertCanOpenTable(code, actorId);
    const label = table.label === undefined ? '' : textField(table.label, 'Table label', CLUB_LIMITS.labelLength);
    const { rules, variant } = this.tableSetup(code, actorId, table.rules);
    const t: ClubTable = {
      code: table.code,
      label: label || cleanField(`${m.name}'s table`, CLUB_LIMITS.labelLength),
      rules,
      variant,
      createdBy: actorId,
      createdAt: this.now(),
      status: 'open',
      players: [],
      handNumber: 0,
      scores: [0, 0, 0, 0],
    };
    club.tables.push(t);
    this.persist(club);
    this.emit({ type: 'table_opened', club, table: t, by: actorId });
    return t;
  }

  /**
   * Mirror a hosted table's status. Host events fire on every move, so a patch that
   * changes nothing is not written to the store.
   */
  updateTable(code: string, tableCode: string, patch: Partial<Pick<ClubTable, 'status' | 'players' | 'handNumber' | 'scores'>>): ClubTable | undefined {
    const club = this.clubs.get(code.toUpperCase());
    const t = club?.tables.find((x) => x.code === tableCode);
    if (!t) return undefined;
    // A finished table stays finished. Events after match_over (a player dropping or leaving)
    // must not turn it back into 'playing', where it would count against the open-table cap again.
    if (t.status === 'finished' && patch.status !== 'finished') return t;
    const keys = Object.keys(patch) as Array<keyof typeof patch>;
    const changed = keys.some((k) => JSON.stringify(t[k]) !== JSON.stringify(patch[k]));
    if (!changed) return t;
    Object.assign(t, patch);
    this.persist(club!);
    return t;
  }

  /**
   * Keep a club's table listing in step with its hosted table, and add a finished match to the
   * standings. Events from rooms that belong to no club are ignored.
   */
  applyRoomEvent(roomCode: string, event: HostEvent): void {
    const club = this.clubForTable(roomCode);
    if (!club) return;
    const players = event.seats.map((s) => ({ seat: s.seat, name: s.name, userId: s.userId, isBot: s.isBot, connected: s.connected }));
    const table = club.tables.find((t) => t.code === roomCode);
    if (event.type === 'match_over' && event.handNumber >= 0) {
      // A match is counted once, however many times its end is reported, and only when it is a real club game.
      if (table && table.status !== 'finished' && countsForStandings(club, table, event.seats)) {
        // Each seat's result goes to the member who held it when the match started, even if they
        // have left the club or the table since (a bot finished for them).
        const roster = startingMembers(club, table, event.seats);
        this.recordMatch(
          club.code,
          event.seats.map((s) => ({ userId: roster.find((r) => r.seat === s.seat)?.userId, points: event.scores[s.seat] ?? 0, handsWon: event.handsWon[s.seat] ?? 0 })),
          { departed: true },
        );
      }
      this.updateTable(club.code, roomCode, { status: 'finished', players, scores: event.scores });
    } else if (event.type === 'match_over') {
      // The room closed: it expired, or every player left for good.
      this.removeTable(club.code, roomCode);
    } else {
      // updateTable ignores these once the table has finished.
      const playing = event.type === 'state' || event.type === 'hand_over' || event.handNumber > 0;
      // Play begins: note which club members are seated. The match counts, and is charged, by them.
      if (playing && table && table.status === 'open' && !table.startedWith) {
        table.startedWith = event.seats.filter((s) => !s.isBot && s.userId && this.member(club, s.userId)).map((s) => ({ seat: s.seat, userId: s.userId! }));
      }
      this.updateTable(club.code, roomCode, { status: playing ? 'playing' : 'open', players, handNumber: event.handNumber, scores: event.scores });
    }
  }

  removeTable(code: string, tableCode: string): void {
    const club = this.clubs.get(code.toUpperCase());
    if (!club) return;
    const kept = club.tables.filter((t) => t.code !== tableCode);
    if (kept.length === club.tables.length) return;
    club.tables = kept;
    this.persist(club);
  }

  /**
   * Add a finished match to member standings. `results` carry each seat's final points. With
   * `departed`, a result for an account that is no longer a member is added to its standings on
   * file (it was a member when the match started); without it such a result is ignored.
   */
  recordMatch(code: string, results: Array<{ userId?: string; points: number; handsWon: number }>, opts: { departed?: boolean } = {}): void {
    const club = this.clubs.get(code.toUpperCase());
    if (!club) return;
    const best = Math.max(...results.map((r) => r.points));
    const season = club.season ?? 1;
    for (const r of results) {
      if (!r.userId) continue;
      const m: Standing | undefined = this.member(club, r.userId) ?? (opts.departed ? onFile(club, r.userId, this.now()) : undefined);
      if (!m) continue;
      if ('season' in m && m.season !== season) Object.assign(m, { season, seasonPoints: 0 });
      m.points += r.points;
      m.seasonPoints = (m.seasonPoints ?? 0) + r.points;
      m.matchesPlayed++;
      m.handsWon += r.handsWon;
      if (r.points === best && best > 0) m.matchesWon++;
    }
    this.persist(club);
  }

  /**
   * Members ranked by this season's points (then lifetime points, wins, seniority). Each row
   * carries both `seasonPoints` and `points` (lifetime) and the season number.
   */
  standings(code: string): Array<ClubMember & { seasonPoints: number; lifetimePoints: number; season: number }> {
    const club = this.get(code);
    const season = club.season ?? 1;
    return club.members
      .map((m) => ({ ...m, seasonPoints: m.seasonPoints ?? m.points, lifetimePoints: m.points, season }))
      .sort((a, b) => b.seasonPoints - a.seasonPoints || b.points - a.points || b.matchesWon - a.matchesWon || a.joinedAt - b.joinedAt);
  }

  /**
   * Owner only: archive this season's standings in the club's history, reset every member's
   * season points to zero and start the next season. Lifetime points and match counts stay.
   */
  startSeason(code: string, actorId: string): { club: Club; archived: SeasonRecord } {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner']);
    const archived: SeasonRecord = {
      season: club.season ?? 1,
      startedAt: club.seasonStartedAt ?? club.createdAt,
      endedAt: this.now(),
      standings: this.standings(club.code).map((m) => ({ userId: m.userId, name: m.name, points: m.seasonPoints })),
    };
    club.seasons = [...(club.seasons ?? []), archived].slice(-CLUB_LIMITS.seasonsKept);
    for (const m of club.members) m.seasonPoints = 0;
    club.season = archived.season + 1;
    club.seasonStartedAt = archived.endedAt;
    this.persist(club);
    return { club, archived };
  }

  /**
   * What a member sees: the whole club, except that only the owner and admins see the ban list,
   * and nobody is sent the server's own records (the owner-lapse file, standings kept for members who left).
   */
  static memberView(club: Club, userId: string): Club {
    const { ownerLapses: _lapses, former: _former, ...shown } = club;
    const m = club.members.find((x) => x.userId === userId);
    if (m && (m.role === 'owner' || m.role === 'admin')) return shown;
    const { bans: _bans, ...rest } = shown;
    return rest;
  }

  /** What anyone may see of a club: no member list, standings or tables. */
  static publicView(club: Club): ClubPublicView {
    return { code: club.code, name: club.name, description: club.description, memberCount: club.members.length, joinRequiresApproval: club.settings.joinRequiresApproval };
  }
}

/** The row of standings on file for an account that has left, made if there is none yet. */
function onFile(club: Club, userId: string, at: number): FormerMember {
  const former = (club.former ??= []);
  let row = former.find((f) => f.userId === userId);
  if (!row) {
    row = { userId, leftAt: at, season: club.season ?? 1, points: 0, seasonPoints: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 };
    former.push(row);
  }
  return row;
}

/**
 * The club members a match at this table started with, by seat (decision 5): the list written
 * when play began. A table with no such list (its match began before the list existed, or no
 * start was ever reported) falls back to the humans seated now who are members, or who left the
 * club after the table was opened.
 */
export function startingMembers(club: Club, table: ClubTable, seats: ReadonlyArray<{ seat?: number; userId?: string; isBot: boolean }>): Array<{ seat: number; userId: string }> {
  if (table.startedWith) return table.startedWith;
  const wasMember = (id: string) => club.members.some((m) => m.userId === id) || (club.former ?? []).some((f) => f.userId === id && f.leftAt >= table.createdAt);
  return seats.flatMap((s, i) => (!s.isBot && s.userId && wasMember(s.userId) ? [{ seat: s.seat ?? i, userId: s.userId }] : []));
}

/**
 * Whether a finished match at a club table moves the standings: not at a variant table (other
 * rules than the house's), only when at least two different club members were seated when it
 * started (`startingMembers`), and never when one account held two seats (the table host refuses
 * that; this guard stays in case it ever slips). A member alone against bots, or a member with a
 * second account outside the club, scores nothing, so standings cannot be farmed against bots.
 * What happens after the start does not change the answer: a member who leaves the club, or is
 * taken off the table, before the end cannot void the others' result.
 */
export function countsForStandings(club: Club, table: ClubTable, seats: ReadonlyArray<{ seat?: number; userId?: string; isBot: boolean }>): boolean {
  if (table.variant) return false;
  const humans = seats.filter((s) => !s.isBot && s.userId).map((s) => s.userId!);
  if (new Set(humans).size !== humans.length) return false;
  const members = startingMembers(club, table, seats).map((s) => s.userId);
  return members.length >= 2 && new Set(members).size === members.length;
}

/** The room registry's view of the clubs: who may open and join club tables over the socket. */
export function clubGate(clubs: ClubRegistry): ClubGate {
  return {
    openTable(clubCode, userId, rules) {
      if (!userId) return { error: 'Join the club first' };
      try {
        clubs.assertCanOpenTable(clubCode, userId);
        const setup = clubs.tableSetup(clubCode, userId, rules);
        return { rules: setup.rules, botSkill: setup.botSkill };
      } catch (e) {
        if (e instanceof ClubError) return { error: e.message };
        throw e;
      }
    },
    tableOpened(clubCode, roomCode, userId, rules) {
      clubs.addTable(clubCode, userId, { code: roomCode, rules });
    },
    mayJoin: (clubCode, userId) => clubs.isMember(clubCode, userId),
    isAdmin: (clubCode, userId) => clubs.isAdmin(clubCode, userId),
  };
}

