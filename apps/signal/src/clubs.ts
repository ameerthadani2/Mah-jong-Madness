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
import { randomHex, sanitizeRules, type RuleSet } from '@mjm/engine';
import type { HostEvent } from '@mjm/net';
import { uniqueCode, type HexSource } from './codes';
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
}

export interface ClubSettings {
  membersCanOpenTables: boolean;
  joinRequiresApproval: boolean;
}

export const DEFAULT_CLUB_SETTINGS: ClubSettings = { membersCanOpenTables: true, joinRequiresApproval: false };

export interface Club {
  code: string;
  name: string;
  description: string;
  ownerId: string;
  createdAt: number;
  rules: RuleSet;
  settings: ClubSettings;
  members: ClubMember[];
  pending: Identity[];
  tables: ClubTable[];
}

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

export class ClubError extends Error {
  constructor(
    public readonly code: 'not_found' | 'forbidden' | 'exists' | 'invalid' | 'pending' | 'limit' | 'unavailable',
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
  /** Tables per club that have not finished. */
  openTablesPerClub: 5,
  nameLength: 40,
  descriptionLength: 280,
  labelLength: 40,
  /** Finished tables stay in a club's listing for this long. */
  finishedTableMs: DAY_MS,
} as const;

/** Keep only the known settings, and only when they are real booleans; anything else keeps `base`'s value. */
export function sanitizeSettings(input: unknown, base: ClubSettings = DEFAULT_CLUB_SETTINGS): ClubSettings {
  const out: ClubSettings = { membersCanOpenTables: base.membersCanOpenTables, joinRequiresApproval: base.joinRequiresApproval };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  const src = input as Record<string, unknown>;
  if (typeof src.membersCanOpenTables === 'boolean') out.membersCanOpenTables = src.membersCanOpenTables;
  if (typeof src.joinRequiresApproval === 'boolean') out.joinRequiresApproval = src.joinRequiresApproval;
  return out;
}

/** A string field from the API, trimmed and capped to `max` characters. A value that is not a string is a client error, not a crash. */
function textField(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string') throw new ClubError('invalid', `${field} must be text`);
  return v.trim().slice(0, max);
}

/** Clean up a club read from storage: older rows may hold unchecked rules or the retired `neutralHost` setting. */
function normalise(c: Club): Club {
  c.rules = sanitizeRules(c.rules);
  c.settings = sanitizeSettings(c.settings);
  c.members = Array.isArray(c.members) ? c.members : [];
  c.pending = Array.isArray(c.pending) ? c.pending : [];
  c.tables = Array.isArray(c.tables) ? c.tables : [];
  c.description = typeof c.description === 'string' ? c.description : '';
  return c;
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
  /** Number of writes requested (tests use it to check that no-op updates write nothing). */
  writeCount = 0;

  constructor(opts: { store?: ClubStore; now?: () => number; randomHex?: HexSource } = {}) {
    this.now = opts.now ?? Date.now;
    this.hex = opts.randomHex ?? randomHex;
    this.store = opts.store ?? null;
  }

  /** Read every club from the store (once, at boot, before the registry is used). */
  async load(): Promise<void> {
    if (!this.store) return;
    for (const c of await this.store.loadAll()) this.clubs.set(c.code, normalise(c));
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

  /** Drop finished table listings created before `before` (run daily). */
  pruneFinishedTables(before: number): void {
    for (const club of this.clubs.values()) {
      const kept = club.tables.filter((t) => t.status !== 'finished' || t.createdAt >= before);
      if (kept.length === club.tables.length) continue;
      club.tables = kept;
      this.persist(club);
    }
  }

  /** Queue a write of this club. Writes for one club run in order; a burst of changes becomes one write. */
  private persist(club: Club): void {
    this.writeCount++;
    const store = this.store;
    if (!store) return;
    const code = club.code;
    if (this.queued.has(code)) return;
    this.queued.add(code);
    const prev = this.writes.get(code) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        this.queued.delete(code);
        const current = this.clubs.get(code);
        if (current) await store.save(structuredClone(current));
        else await store.delete(code);
      })
      .catch((e: Error) => console.error(`[signal] club ${code} not saved:`, e.message));
    this.writes.set(code, next);
    void next.then(() => {
      if (this.writes.get(code) === next) this.writes.delete(code);
    });
  }

  /** Wait until every queued club write has reached the store. */
  async flush(): Promise<void> {
    while (this.writes.size > 0) await Promise.all([...this.writes.values()]);
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
      if (club) this.clubs.set(code, normalise(club));
      else this.clubs.delete(code);
    }
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
    this.requireClubRoom(owner.userId);
    const club: Club = {
      code: this.newCode(),
      name: trimmed,
      description: '',
      ownerId: owner.userId,
      createdAt: this.now(),
      rules: sanitizeRules(rules),
      settings: sanitizeSettings(settings),
      members: [{ ...owner, role: 'owner', joinedAt: this.now(), points: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 }],
      pending: [],
      tables: [],
    };
    this.clubs.set(club.code, club);
    this.persist(club);
    return club;
  }

  joinClub(code: string, user: Identity): { club: Club; status: 'joined' | 'pending' | 'already' } {
    const club = this.get(code);
    if (this.member(club, user.userId)) return { club, status: 'already' };
    if (club.pending.some((p) => p.userId === user.userId)) return { club, status: 'pending' };
    this.requireClubRoom(user.userId);
    if (club.settings.joinRequiresApproval) {
      if (club.pending.length >= CLUB_LIMITS.membersPerClub) throw new ClubError('limit', 'This club has too many pending requests; try again later');
      club.pending.push(user);
      this.persist(club);
      return { club, status: 'pending' };
    }
    this.requireMemberRoom(club);
    club.members.push({ ...user, role: 'member', joinedAt: this.now(), points: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 });
    this.persist(club);
    return { club, status: 'joined' };
  }

  approve(code: string, actorId: string, userId: string): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    const idx = club.pending.findIndex((p) => p.userId === userId);
    if (idx < 0) throw new ClubError('not_found', 'No pending request for that user');
    this.requireMemberRoom(club);
    const [user] = club.pending.splice(idx, 1);
    club.members.push({ ...user, role: 'member', joinedAt: this.now(), points: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 });
    this.persist(club);
    return club;
  }

  removeMember(code: string, actorId: string, userId: string): Club {
    const club = this.get(code);
    if (actorId !== userId) this.requireRole(club, actorId, ['owner', 'admin']);
    if (userId === club.ownerId) throw new ClubError('forbidden', 'The owner cannot leave; transfer ownership first');
    club.members = club.members.filter((m) => m.userId !== userId);
    club.pending = club.pending.filter((p) => p.userId !== userId);
    this.persist(club);
    return club;
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
      const prev = this.member(club, club.ownerId);
      if (prev) prev.role = 'admin';
      club.ownerId = userId;
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
    const description = patch.description === undefined ? undefined : textField(patch.description, 'Description', CLUB_LIMITS.descriptionLength);
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
    if (club.tables.filter((t) => t.status !== 'finished').length >= CLUB_LIMITS.openTablesPerClub) {
      throw new ClubError('limit', `This club already has ${CLUB_LIMITS.openTablesPerClub} open tables; finish one first`);
    }
    return m;
  }

  /** Register a table (room) opened for this club. The caller creates the room. */
  addTable(code: string, actorId: string, table: { code: string; label?: unknown; rules?: unknown }): ClubTable {
    const club = this.get(code);
    const m = this.assertCanOpenTable(code, actorId);
    const label = table.label === undefined ? '' : textField(table.label, 'Table label', CLUB_LIMITS.labelLength);
    const t: ClubTable = {
      code: table.code,
      label: label || `${m.name}'s table`.slice(0, CLUB_LIMITS.labelLength),
      rules: sanitizeRules(table.rules, club.rules),
      createdBy: actorId,
      createdAt: this.now(),
      status: 'open',
      players: [],
      handNumber: 0,
      scores: [0, 0, 0, 0],
    };
    club.tables.push(t);
    this.persist(club);
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
    if (event.type === 'match_over' && event.handNumber >= 0) {
      const table = club.tables.find((t) => t.code === roomCode);
      // A match is counted once, however many times its end is reported.
      if (table?.status !== 'finished') {
        this.recordMatch(club.code, event.seats.map((s) => ({ userId: s.userId, points: event.scores[s.seat] ?? 0, handsWon: event.handsWon[s.seat] ?? 0 })));
      }
      this.updateTable(club.code, roomCode, { status: 'finished', players, scores: event.scores });
    } else if (event.type === 'match_over') {
      // The room closed: it expired, or every player left for good.
      this.removeTable(club.code, roomCode);
    } else {
      // updateTable ignores these once the table has finished.
      const playing = event.type === 'state' || event.type === 'hand_over' || event.handNumber > 0;
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

  /** Add a finished match to member standings. `results` carry each seat's final points. */
  recordMatch(code: string, results: Array<{ userId?: string; points: number; handsWon: number }>): void {
    const club = this.clubs.get(code.toUpperCase());
    if (!club) return;
    const best = Math.max(...results.map((r) => r.points));
    for (const r of results) {
      if (!r.userId) continue;
      const m = this.member(club, r.userId);
      if (!m) continue;
      m.points += r.points;
      m.matchesPlayed++;
      m.handsWon += r.handsWon;
      if (r.points === best && best > 0) m.matchesWon++;
    }
    this.persist(club);
  }

  standings(code: string): ClubMember[] {
    const club = this.get(code);
    return [...club.members].sort((a, b) => b.points - a.points || b.matchesWon - a.matchesWon || a.joinedAt - b.joinedAt);
  }

  /** What anyone may see of a club: no member list, standings or tables. */
  static publicView(club: Club): ClubPublicView {
    return { code: club.code, name: club.name, description: club.description, memberCount: club.members.length, joinRequiresApproval: club.settings.joinRequiresApproval };
  }
}

/** The room registry's view of the clubs: who may open and join club tables over the socket. */
export function clubGate(clubs: ClubRegistry): ClubGate {
  return {
    openTable(clubCode, userId, rules) {
      if (!userId) return { error: 'Join the club first' };
      try {
        clubs.assertCanOpenTable(clubCode, userId);
        return { rules: sanitizeRules(rules, clubs.club(clubCode).rules) };
      } catch (e) {
        if (e instanceof ClubError) return { error: e.message };
        throw e;
      }
    },
    tableOpened(clubCode, roomCode, userId, rules) {
      clubs.addTable(clubCode, userId, { code: roomCode, rules });
    },
    mayJoin: (clubCode, userId) => clubs.isMember(clubCode, userId),
  };
}

