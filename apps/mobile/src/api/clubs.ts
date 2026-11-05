/**
 * Thin client for the club API served by the game server (docs/API.md, "Clubs").
 */
import type { BotSkill, RuleSet } from '@mjm/engine';
import { authorisedJson, globalFetch, type Authoriser, type FetchLike } from './http';

export { ApiError as ClubApiError, httpBase } from './http';

export interface ClubMember {
  userId: string;
  name: string;
  avatar?: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: number;
  points: number;
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
  rules: RuleSet;
  settings: { membersCanOpenTables: boolean; joinRequiresApproval: boolean };
  memberCount?: number;
  joinRequiresApproval?: boolean;
  members?: ClubMember[];
  pending?: Array<{ userId: string; name: string; avatar?: string }>;
  tables?: ClubTable[];
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
  create: (ctx: ClubContext, name: string, rules: Partial<RuleSet>, settings?: Partial<Club['settings']>) => call<Club>(ctx, 'POST', '/api/clubs', { name, rules, settings }),
  join: (ctx: ClubContext, code: string) => call<{ club: Club; status: 'joined' | 'pending' | 'already' }>(ctx, 'POST', `/api/clubs/${enc(code)}/join`, {}),
  get: (ctx: ClubContext, code: string) => call<Club>(ctx, 'GET', `/api/clubs/${enc(code)}`),
  /** The signed-in player's clubs; `userId` is the server account id. */
  mine: (ctx: ClubContext, userId: string) => call<Club[]>(ctx, 'GET', `/api/users/${enc(userId)}/clubs`),
  update: (ctx: ClubContext, code: string, patch: { name?: string; description?: string; rules?: Partial<RuleSet>; settings?: Partial<Club['settings']> }) => call<Club>(ctx, 'PATCH', `/api/clubs/${enc(code)}`, patch),
  approve: (ctx: ClubContext, code: string, userId: string) => call<Club>(ctx, 'POST', `/api/clubs/${enc(code)}/members/${enc(userId)}/approve`, {}),
  remove: (ctx: ClubContext, code: string, userId: string) => call<Club>(ctx, 'DELETE', `/api/clubs/${enc(code)}/members/${enc(userId)}`, {}),
  openTable: (ctx: ClubContext, code: string, opts: { label?: string; rules?: Partial<RuleSet>; botSkill?: BotSkill }) => call<ClubTable>(ctx, 'POST', `/api/clubs/${enc(code)}/tables`, opts),
  standings: (ctx: ClubContext, code: string) => call<ClubMember[]>(ctx, 'GET', `/api/clubs/${enc(code)}/standings`),
};
