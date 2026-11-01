/**
 * Club registry: PokerBros-style private clubs with a code, an owner, members,
 * house rules, open tables and standings. Pure data + logic; persistence is
 * injected so it can be unit-tested and swapped for a database later.
 */
import { DEFAULT_RULES, type RuleSet } from '@mjm/engine';
import { sha256Hex } from '@mjm/net';

export interface Identity {
  userId: string;
  name: string;
  avatar?: string;
}

/** What a client presents: identity plus a device-held secret. */
export interface Credentials extends Identity {
  secret: string;
}

export interface ClubData {
  clubs: Club[];
  /** userId → sha256(secret), bound on first use. */
  credentials: Record<string, string>;
}

export type ClubRole = 'owner' | 'admin' | 'member';

export interface ClubMember extends Identity {
  role: ClubRole;
  joinedAt: number;
  /** Lifetime points across club tables (chips won/lost). */
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
  /** Server hosts all club tables (neutral dealer) rather than a member's phone. */
  neutralHost: boolean;
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
  pending: Identity[];
  tables: ClubTable[];
}

export interface ClubStore {
  load(): ClubData;
  save(data: ClubData): void;
}

export class ClubError extends Error {
  constructor(
    public readonly code: 'not_found' | 'forbidden' | 'exists' | 'invalid' | 'pending',
    message: string,
  ) {
    super(message);
    this.name = 'ClubError';
  }
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export class ClubRegistry {
  private clubs = new Map<string, Club>();
  private credentials = new Map<string, string>();
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly store: ClubStore | null;

  constructor(opts: { store?: ClubStore; now?: () => number; random?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.store = opts.store ?? null;
    if (this.store) {
      const data = this.store.load();
      for (const c of data.clubs) this.clubs.set(c.code, c);
      for (const [k, v] of Object.entries(data.credentials ?? {})) this.credentials.set(k, v);
    }
  }

  private persist(): void {
    this.store?.save({ clubs: [...this.clubs.values()], credentials: Object.fromEntries(this.credentials) });
  }

  /**
   * Trust-on-first-use authentication: the first request for a userId binds its secret;
   * later requests must present the same secret. Replace with Sign in with Apple/Google
   * tokens before launch — this only stops casual impersonation of visible user ids.
   */
  authenticate(creds: Credentials): Identity {
    if (!creds.userId || typeof creds.secret !== 'string' || creds.secret.length < 16 || creds.secret.length > 128) throw new ClubError('invalid', 'Credentials required');
    const hash = sha256Hex(`mjm-user:${creds.userId}:${creds.secret}`);
    const known = this.credentials.get(creds.userId);
    if (known && known !== hash) throw new ClubError('forbidden', 'Identity check failed for this user id');
    if (!known) {
      this.credentials.set(creds.userId, hash);
      this.persist();
    }
    return { userId: creds.userId, name: creds.name, avatar: creds.avatar };
  }

  private newCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < 6; i++) code += ALPHABET[Math.floor(this.random() * ALPHABET.length)];
      if (!this.clubs.has(code)) return code;
    }
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

  createClub(owner: Identity, name: string, rules: Partial<RuleSet> = {}, settings: Partial<ClubSettings> = {}): Club {
    const trimmed = name.trim().slice(0, 40);
    if (!trimmed) throw new ClubError('invalid', 'Club name is required');
    if (!owner.userId || !owner.name) throw new ClubError('invalid', 'Owner identity is required');
    const club: Club = {
      code: this.newCode(),
      name: trimmed,
      description: '',
      ownerId: owner.userId,
      createdAt: this.now(),
      rules: { ...DEFAULT_RULES, ...rules },
      settings: { membersCanOpenTables: true, joinRequiresApproval: false, neutralHost: true, ...settings },
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
    if (club.settings.joinRequiresApproval) {
      if (!club.pending.some((p) => p.userId === user.userId)) club.pending.push(user);
      this.persist();
      return { club, status: 'pending' };
    }
    club.members.push({ ...user, role: 'member', joinedAt: this.now(), points: 0, matchesPlayed: 0, matchesWon: 0, handsWon: 0 });
    this.persist();
    return { club, status: 'joined' };
  }

  approve(code: string, actorId: string, userId: string): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    const idx = club.pending.findIndex((p) => p.userId === userId);
    if (idx < 0) throw new ClubError('not_found', 'No pending request for that user');
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

  setRole(code: string, actorId: string, userId: string, role: ClubRole): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner']);
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

  update(code: string, actorId: string, patch: { name?: string; description?: string; rules?: Partial<RuleSet>; settings?: Partial<ClubSettings> }): Club {
    const club = this.get(code);
    this.requireRole(club, actorId, ['owner', 'admin']);
    if (patch.name !== undefined) club.name = patch.name.trim().slice(0, 40) || club.name;
    if (patch.description !== undefined) club.description = patch.description.slice(0, 280);
    if (patch.rules) club.rules = { ...club.rules, ...patch.rules };
    if (patch.settings) club.settings = { ...club.settings, ...patch.settings };
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

  /** Register a table (room) opened for this club. The caller creates the room. */
  addTable(code: string, actorId: string, table: { code: string; label?: string; rules?: Partial<RuleSet> }): ClubTable {
    const club = this.get(code);
    const m = this.member(club, actorId);
    if (!m) throw new ClubError('forbidden', 'Join the club first');
    if (!club.settings.membersCanOpenTables && m.role === 'member') throw new ClubError('forbidden', 'Only admins can open tables in this club');
    const t: ClubTable = {
      code: table.code,
      label: (table.label ?? `${m.name}'s table`).slice(0, 40),
      rules: { ...club.rules, ...(table.rules ?? {}) },
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

  updateTable(code: string, tableCode: string, patch: Partial<Pick<ClubTable, 'status' | 'players' | 'handNumber' | 'scores'>>): ClubTable | undefined {
    const club = this.clubs.get(code.toUpperCase());
    const t = club?.tables.find((x) => x.code === tableCode);
    if (!t) return undefined;
    Object.assign(t, patch);
    this.persist();
    return t;
  }

  removeTable(code: string, tableCode: string): void {
    const club = this.clubs.get(code.toUpperCase());
    if (!club) return;
    club.tables = club.tables.filter((t) => t.code !== tableCode);
    this.persist();
  }

  /** Fold a finished match into member standings. `results` carry final points per seat. */
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

  /** Public projection for API responses (no secrets today, but keep one place to redact). */
  static publicView(club: Club): Club {
    return club;
  }
}
