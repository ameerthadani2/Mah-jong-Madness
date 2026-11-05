/**
 * Thin client for the club API served by the signaling server.
 */
import type { BotSkill, RuleSet } from '@mjm/engine';

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

export interface Club {
  code: string;
  name: string;
  description: string;
  ownerId: string;
  createdAt: number;
  rules: RuleSet;
  settings: { membersCanOpenTables: boolean; joinRequiresApproval: boolean };
  members: ClubMember[];
  pending: Array<{ userId: string; name: string; avatar?: string }>;
  tables: ClubTable[];
}

export interface ApiUser {
  userId: string;
  name: string;
  avatar?: string;
  /** Device secret bound to userId on first use (see signaling server ClubRegistry.authenticate). */
  secret: string;
}

/** ws://host:port[/path] → http://host:port ; wss → https. */
export function httpBase(signalUrl: string): string {
  return signalUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws\/?$/, '').replace(/\/$/, '');
}

/** How long a club request may take before it is abandoned. */
export const CLUB_REQUEST_TIMEOUT_MS = 15_000;

async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLUB_REQUEST_TIMEOUT_MS);
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    text = await res.text();
  } catch (e) {
    if (controller.signal.aborted) throw new Error('The club server did not respond within 15 seconds. Check your connection and try again.');
    throw new Error(`Could not reach the club server (${(e as Error).message || 'network error'}).`);
  } finally {
    clearTimeout(timer);
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`The club server sent an unreadable reply (${res.status}).`);
  }
  if (!res.ok) {
    const message = (data as { message?: unknown } | null)?.message;
    throw new Error(typeof message === 'string' && message ? message : `Request failed (${res.status})`);
  }
  return data as T;
}

export const clubsApi = {
  create: (base: string, user: ApiUser, name: string, rules: Partial<RuleSet>, settings?: Partial<Club['settings']>) => call<Club>(base, 'POST', '/api/clubs', { user, name, rules, settings }),
  join: (base: string, code: string, user: ApiUser) => call<{ club: Club; status: 'joined' | 'pending' | 'already' }>(base, 'POST', `/api/clubs/${code}/join`, { user }),
  get: (base: string, code: string) => call<Club>(base, 'GET', `/api/clubs/${code}`),
  mine: (base: string, userId: string) => call<Club[]>(base, 'GET', `/api/users/${userId}/clubs`),
  update: (base: string, code: string, user: ApiUser, patch: { name?: string; description?: string; rules?: Partial<RuleSet>; settings?: Partial<Club['settings']> }) => call<Club>(base, 'PATCH', `/api/clubs/${code}`, { user, ...patch }),
  approve: (base: string, code: string, user: ApiUser, userId: string) => call<Club>(base, 'POST', `/api/clubs/${code}/members/${userId}/approve`, { user }),
  remove: (base: string, code: string, user: ApiUser, userId: string) => call<Club>(base, 'DELETE', `/api/clubs/${code}/members/${userId}`, { user }),
  openTable: (base: string, code: string, user: ApiUser, opts: { label?: string; rules?: Partial<RuleSet>; botSkill?: BotSkill }) => call<ClubTable>(base, 'POST', `/api/clubs/${code}/tables`, { user, ...opts }),
  standings: (base: string, code: string) => call<ClubMember[]>(base, 'GET', `/api/clubs/${code}/standings`),
};
