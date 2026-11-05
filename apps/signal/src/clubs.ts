/**
 * Club registry: PokerBros-style private clubs, each with a code, an owner,
 * members, house rules, open tables and standings. It holds data and logic only.
 * Persistence is injected so the registry can be unit-tested and later backed by a database.
 *
 * Every value that arrives from the API is typed `unknown` here and checked
 * before it is stored, so a malformed request becomes a `ClubError` (HTTP 4xx), not a crash.
 */
import { randomHex, sanitizeRules, type RuleSet } from '@mjm/engine';
import { sha256Hex, type HostEvent } from '@mjm/net';
import { uniqueCode, type HexSource } from './codes';

export interface Identity {
  userId: string;
  name: string;
  avatar?: string;
}

/** What a client presents: its identity plus a secret held on the device. */
export interface Credentials extends Identity {
  secret: string;
}

export interface ClubData {
  clubs: Club[];
  /**
   * Maps userId to sha256(secret). A user's secret is bound by their first successful request
   * that leaves them holding a membership or a pending request. Oldest first, so the oldest
   * unused entry is evicted when the table is full.
   */
  credentials: Record<string, string>;
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

export interface ClubStore {
  load(): ClubData;
  save(data: ClubData): void;
}

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
  /**
   * Bound identities kept in the store. Past this, the least recently used identity that holds
   * no membership or pending request is forgotten (its next request binds it afresh).
   * Identities still in a club are never evicted, so the table can exceed this only by as
   * many users as the clubs themselves hold.
   */
  identities: 50_000,
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

export class ClubRegistry {
  private clubs = new Map<string, Club>();
  private credentials = new Map<string, string>();
  private readonly now: () => number;
  private readonly hex: HexSource;
  private readonly store: ClubStore | null;
  private readonly maxCredentials: number;

  constructor(opts: { store?: ClubStore; now?: () => number; randomHex?: HexSource; maxCredentials?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.hex = opts.randomHex ?? randomHex;
    this.store = opts.store ?? null;
    this.maxCredentials = opts.maxCredentials ?? CLUB_LIMITS.identities;
    if (this.store) {
      const data = this.store.load();
      let closedStale = false;
      for (const c of data.clubs) {
        // Older stores may hold unchecked rules or the retired `neutralHost` setting.
        c.rules = sanitizeRules(c.rules);
        c.settings = sanitizeSettings(c.settings);
        c.tables = Array.isArray(c.tables) ? c.tables : [];
        // Hosted rooms live only in memory, so no table survives a restart and no event will ever
        // arrive to close one. Left as 'open' or 'playing', they would count against the club's
        // open-table cap for good.
        for (const t of c.tables) {
          if (t.status === 'finished') continue;
          t.status = 'finished';
          t.players = (t.players ?? []).map((p) => ({ ...p, connected: false }));
          closedStale = true;
        }
        this.clubs.set(c.code, c);
      }
      for (const [k, v] of Object.entries(data.credentials ?? {})) this.credentials.set(k, v);
      if (closedStale) this.persist();
    }
  }

  private persist(): void {
    this.store?.save({ clubs: [...this.clubs.values()], credentials: Object.fromEntries(this.credentials) });
  }

  private credentialHash(creds: Credentials): string {
    if (!creds.userId || typeof creds.secret !== 'string' || creds.secret.length < 16 || creds.secret.length > 128) throw new ClubError('invalid', 'Credentials required');
    return sha256Hex(`mjm-user:${creds.userId}:${creds.secret}`);
  }

  /**
   * Trust-on-first-use authentication: a bound userId must present the same secret again.
   * An unbound userId passes but is not bound here; call `bindCredential` once the request
   * has succeeded, so failed or junk requests never grow the store. Replace this with Sign
   * in with Apple or Google tokens before launch; it only stops casual impersonation of
   * visible user ids.
   */
  authenticate(creds: Credentials): Identity {
    const hash = this.credentialHash(creds);
    const known = this.credentials.get(creds.userId);
    if (known && known !== hash) throw new ClubError('forbidden', 'Identity check failed for this user id');
    if (known) {
      // Keep the map in least-recently-used order for eviction. Not worth a write on its own.
      this.credentials.delete(creds.userId);
      this.credentials.set(creds.userId, known);
    }
    return { userId: creds.userId, name: creds.name, avatar: creds.avatar };
  }

  /**
   * Bind an unbound userId to its secret after a successful request, but only when the user
   * now holds a membership or a pending request (creating or joining a club). Anyone else has
   * nothing to protect, so nothing is stored. Returns true when a new binding was written.
   */
  bindCredential(creds: Credentials): boolean {
    if (this.credentials.has(creds.userId)) return false;
    if (!this.holdsMembership(creds.userId)) return false;
    this.credentials.set(creds.userId, this.credentialHash(creds));
    this.evictCredentials();
    this.persist();
    return true;
  }

  /** Number of bound identities. */
  credentialCount(): number {
    return this.credentials.size;
  }

  private holdsMembership(userId: string): boolean {
    for (const c of this.clubs.values()) if (c.members.some((m) => m.userId === userId) || c.pending.some((p) => p.userId === userId)) return true;
    return false;
  }

  /** Forget the least recently used identities that hold no membership until the table is back under its cap. */
  private evictCredentials(): void {
    if (this.credentials.size <= this.maxCredentials) return;
    const inUse = new Set<string>();
    for (const c of this.clubs.values()) {
      for (const m of c.members) inUse.add(m.userId);
      for (const p of c.pending) inUse.add(p.userId);
    }
    for (const userId of this.credentials.keys()) {
      if (this.credentials.size <= this.maxCredentials) break;
      if (!inUse.has(userId)) this.credentials.delete(userId);
    }
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
    this.persist();
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
      this.persist();
      return { club, status: 'pending' };
    }
    this.requireMemberRoom(club);
    club.members.push({ ...user, role: 'member', joinedAt: this.now(), points: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 });
    this.persist();
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
    this.persist();
    return club;
  }

  removeMember(code: string, actorId: string, userId: string): Club {
    const club = this.get(code);
    if (actorId !== userId) this.requireRole(club, actorId, ['owner', 'admin']);
    if (userId === club.ownerId) throw new ClubError('forbidden', 'The owner cannot leave; transfer ownership first');
    club.members = club.members.filter((m) => m.userId !== userId);
    club.pending = club.pending.filter((p) => p.userId !== userId);
    this.persist();
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
    this.persist();
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
    this.persist();
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
    this.persist();
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
    this.persist();
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
    club.tables = club.tables.filter((t) => t.code !== tableCode);
    this.persist();
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
    this.persist();
  }

  standings(code: string): ClubMember[] {
    const club = this.get(code);
    return [...club.members].sort((a, b) => b.points - a.points || b.matchesWon - a.matchesWon || a.joinedAt - b.joinedAt);
  }

  /** Public projection for API responses. Nothing is secret yet, but this keeps redaction in one place. */
  static publicView(club: Club): Club {
    return club;
  }
}
