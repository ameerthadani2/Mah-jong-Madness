/**
 * Thin client for the club API served by the game server (docs/API.md, "Clubs").
 */
import type { BotSkill, RuleSet } from '@mjm/engine';
import { authorisedJson, globalFetch, type Authoriser, type FetchLike } from './http';
import type { ReportPayload } from '../legal/reports';
import type { Message } from '../logic/translate';
import { rulesStakes } from '../logic/rules-text';

export { ApiError as ClubApiError, httpBase } from './http';

export interface ClubMember {
  userId: string;
  name: string;
  avatar?: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: number;
  /** All-time points (older servers send only this). */
  points: number;
  /** Points this season (since the owner last started a new season). */
  seasonPoints?: number;
  /** All-time points, when the server keeps seasons. */
  lifetimePoints?: number;
  matchesPlayed: number;
  matchesWon: number;
  handsWon: number;
}

export interface ClubTable {
  code: string;
  label: string;
  rules: RuleSet;
  createdBy: string;
  createdAt: number;
  status: 'open' | 'playing' | 'finished';
  players: Array<{ seat: number; name: string; userId?: string; isBot: boolean; connected: boolean }>;
  handNumber: number;
  scores: number[];
  /** Opened by an owner or admin with rules other than the house rules: it never counts toward the standings. */
  variant?: boolean;
}

/** An account banned from the club (only the owner and admins see the list). */
export interface ClubBan {
  userId: string;
  name: string;
  bannedAt: number;
  by: string;
}

export interface ClubSettings {
  membersCanOpenTables: boolean;
  joinRequiresApproval: boolean;
  /** Strength of the bots at every club table (servers before it existed send none: Club). */
  botSkill?: BotSkill;
}

/**
 * A club as the server shows it to this player. Members get everything; non-members get the
 * public view only (`code`, `name`, `description`, `memberCount`, `joinRequiresApproval`), so the
 * member-only fields are optional.
 */
export interface Club {
  code: string;
  name: string;
  description: string;
  ownerId?: string;
  createdAt?: number;
  /** Current season number (1 until the owner starts a new one). */
  season?: number;
  rules: RuleSet;
  settings: ClubSettings;
  memberCount?: number;
  joinRequiresApproval?: boolean;
  members?: ClubMember[];
  /** Join requests waiting for the owner or an admin; one nobody answers expires 30 days after `requestedAt`. */
  pending?: Array<{ userId: string; name: string; avatar?: string; requestedAt?: number }>;
  tables?: ClubTable[];
  /** Banned accounts; present for the owner and admins only. */
  bans?: ClubBan[];
  /** When the server saw the owner's Four Winds Club plan lapse (null or absent while it is active). */
  ownerLapsedAt?: number | null;
}

/**
 * A club in "My clubs": the member's view, or, for a club this player has only asked to join, the public
 * view, which carries no rules, settings, members or tables.
 */
export type ClubListing = Omit<Club, 'rules' | 'settings'> & { rules?: RuleSet; settings?: ClubSettings };

/** The line under a club's name in "My clubs": members, open tables and stakes, or the member count alone for a pending request. */
export function clubListLine(c: ClubListing): Message {
  const members = c.members?.length ?? c.memberCount ?? 0;
  if (!c.rules) return { key: 'clubs.memberCount', params: { n: members } };
  return { key: 'clubs.summary', params: { members, tables: (c.tables ?? []).filter((tb) => tb.status !== 'finished').length, stakes: rulesStakes(c.rules) } };
}

/**
 * The club server's owner-tool and Four Winds refusals as translated copy (`clubs.errors.*` and
 * `clubs.create.fourWindsTitle`); null for anything else, which the generic error mapping handles.
 */
export function clubErrorMessage(e: unknown): Message | null {
  const code = e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '';
  const message = e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : '';
  if (code === 'fourwinds_required') return { key: 'clubs.create.fourWindsTitle' };
  const own = /^You can own at most (\d+) clubs/i.exec(message);
  if (own) return { key: 'clubs.errors.ownLimit', params: { max: Number(own[1]) } };
  const theirs = /^That member already owns (\d+) clubs/i.exec(message);
  if (theirs) return { key: 'clubs.errors.transferLimit', params: { max: Number(theirs[1]) } };
  const known: Array<[RegExp, string]> = [
    [/^You cannot join this club/i, 'clubs.errors.cannotJoin'],
    [/open table until its owner renews/i, 'clubs.errors.lapsedCap'],
    [/^Type the club's name to confirm/i, 'clubs.errors.confirmName'],
    [/^Table not found/i, 'clubs.errors.tableNotFound'],
    [/^That account is not banned/i, 'clubs.errors.notBanned'],
    [/^Only the owner can remove an admin/i, 'clubs.errors.adminOnAdmin'],
    [/^The owner cannot be removed/i, 'clubs.errors.ownerProtected'],
    [/^You cannot do that to yourself/i, 'clubs.errors.notYourself'],
    [/^Too many clubs joined from this connection/i, 'clubs.errors.joinRateIp'],
    [/a lot of join requests/i, 'clubs.errors.joinRateClub'],
    [/too many pending requests/i, 'clubs.errors.queueFull'],
  ];
  const hit = known.find(([re]) => re.test(message));
  return hit ? { key: hit[1] } : null;
}

/** A link to share a club: `https://<domain>/c/<CODE>` with a link domain (the form `push/deeplink.ts` opens), else `<scheme>://club/<CODE>`. */
export function clubLink(code: string, opts: { scheme: string; domain?: string }): string {
  const c = encodeURIComponent(code.trim().toUpperCase());
  return opts.domain ? `https://${opts.domain}/c/${c}` : `${opts.scheme}://club/${c}`;
}

/** Days a club keeps its full table cap after the owner's plan lapses (the server's `CLUB_LIMITS.ownerGraceMs`). */
export const OWNER_GRACE_DAYS = 7;

/** True when the club is down to one open table because its owner's plan lapsed past the grace. */
export function ownerRestricted(club: Pick<Club, 'ownerLapsedAt'>, now = Date.now()): boolean {
  return typeof club.ownerLapsedAt === 'number' && now - club.ownerLapsedAt >= OWNER_GRACE_DAYS * 86_400_000;
}

/**
 * What every club call needs: the server's HTTP base and the signed-in session. The bearer
 * token replaces the old trust-on-first-use `user` field; on a 401 the session is refreshed
 * (or the guest signed in again) once and the call retried.
 */
export interface ClubContext {
  base: string;
  auth: Authoriser;
  /** Defaults to the global fetch. */
  fetch?: FetchLike;
}

/** How long a club request may take before it is abandoned. */
export const CLUB_REQUEST_TIMEOUT_MS = 15_000;

/** Failures carry 'club_timeout', 'club_unreachable' or 'club_bad_reply' from this client, else the server's code. */
function call<T>(ctx: ClubContext, method: string, path: string, body?: unknown): Promise<T> {
  return authorisedJson<T>(ctx.auth, { fetch: ctx.fetch ?? globalFetch, base: ctx.base, method, path, body, timeoutMs: CLUB_REQUEST_TIMEOUT_MS, scope: 'club', label: 'club server' });
}

const enc = encodeURIComponent;

export const clubsApi = {
  /** Once the store is live the server answers 403 `fourwinds_required` unless the player holds The Four Winds Club. */
  create: (ctx: ClubContext, name: string, rules: Partial<RuleSet>, settings?: Partial<ClubSettings>) => call<Club>(ctx, 'POST', '/api/clubs', { name, rules, settings }),
  join: (ctx: ClubContext, code: string) => call<{ club: Club; status: 'joined' | 'pending' | 'already' }>(ctx, 'POST', `/api/clubs/${enc(code)}/join`, {}),
  get: (ctx: ClubContext, code: string) => call<Club>(ctx, 'GET', `/api/clubs/${enc(code)}`),
  /** The signed-in player's clubs; `userId` is the server account id. */
  mine: (ctx: ClubContext, userId: string) => call<ClubListing[]>(ctx, 'GET', `/api/users/${enc(userId)}/clubs`),
  update: (ctx: ClubContext, code: string, patch: { name?: string; description?: string; rules?: Partial<RuleSet>; settings?: Partial<ClubSettings> }) => call<Club>(ctx, 'PATCH', `/api/clubs/${enc(code)}`, patch),
  approve: (ctx: ClubContext, code: string, userId: string) => call<Club>(ctx, 'POST', `/api/clubs/${enc(code)}/members/${enc(userId)}/approve`, {}),
  /** Owner or admin: turn down a pending request. */
  reject: (ctx: ClubContext, code: string, userId: string) => call<Club>(ctx, 'POST', `/api/clubs/${enc(code)}/members/${enc(userId)}/reject`, {}),
  /** Owner or admin: turn down every request in `userIds` (the ones on screen) in one call. */
  rejectAll: (ctx: ClubContext, code: string, userIds: string[]) => call<{ club: Club; rejected: number }>(ctx, 'POST', `/api/clubs/${enc(code)}/pending/reject-all`, { userIds }),
  /** Owner or admin removing a member (they also leave the club's live tables; their standings stay on file), or a member leaving (their own id). */
  remove: (ctx: ClubContext, code: string, userId: string) => call<Club>(ctx, 'DELETE', `/api/clubs/${enc(code)}/members/${enc(userId)}`, {}),
  /** Leave the club (the owner must pass it on first). */
  leave: (ctx: ClubContext, code: string, myUserId: string) => call<Club>(ctx, 'DELETE', `/api/clubs/${enc(code)}/members/${enc(myUserId)}`, {}),
  /** Owner only: make a member an admin or a plain member, or pass the club on (`owner`). */
  setRole: (ctx: ClubContext, code: string, userId: string, role: ClubMember['role']) => call<Club>(ctx, 'POST', `/api/clubs/${enc(code)}/members/${enc(userId)}/role`, { role }),
  /** Owner or admin: ban an account (it leaves the club and its tables and cannot come back). */
  ban: (ctx: ClubContext, code: string, userId: string) => call<Club>(ctx, 'POST', `/api/clubs/${enc(code)}/bans`, { userId }),
  unban: (ctx: ClubContext, code: string, userId: string) => call<Club>(ctx, 'DELETE', `/api/clubs/${enc(code)}/bans/${enc(userId)}`, {}),
  /** Owner or admin: end a table at once (nothing counts toward the standings). */
  closeTable: (ctx: ClubContext, code: string, table: string) => call<Club>(ctx, 'POST', `/api/clubs/${enc(code)}/tables/${enc(table)}/close`, {}),
  /** Owner or admin: take a player off a table (a bot plays their seat; they cannot come back to it). */
  evict: (ctx: ClubContext, code: string, table: string, userId: string) => call<{ seats: number }>(ctx, 'POST', `/api/clubs/${enc(code)}/tables/${enc(table)}/evict`, { userId }),
  /** Owner only: delete the club; `confirm` repeats its name. Its tables close. */
  deleteClub: (ctx: ClubContext, code: string, confirm: string) => call<unknown>(ctx, 'DELETE', `/api/clubs/${enc(code)}`, { confirm }),
  openTable: (ctx: ClubContext, code: string, opts: { label?: string; rules?: Partial<RuleSet>; botSkill?: BotSkill }) => call<ClubTable>(ctx, 'POST', `/api/clubs/${enc(code)}/tables`, opts),
  standings: (ctx: ClubContext, code: string) => call<ClubMember[]>(ctx, 'GET', `/api/clubs/${enc(code)}/standings`),
  /** Owner only: archive this season's points and start the next season from zero (re-read the club afterwards). */
  startSeason: (ctx: ClubContext, code: string) => call<{ club?: Partial<Club> }>(ctx, 'POST', `/api/clubs/${enc(code)}/season`, {}),
  /** Report a player to moderation (any signed-in player; see src/legal/reports.ts). */
  report: (ctx: ClubContext, payload: ReportPayload) => call<{ id?: string }>(ctx, 'POST', '/api/reports', payload),
};
