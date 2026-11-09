/**
 * Moderation: the name check, player blocks, and the moderators' tools.
 *
 * - `nameAllowed(name)`: a small English and Chinese blocklist (slurs, profanity, and names that
 *   pose as the game's staff such as "Admin" or 官方), applied after `cleanText` to display names
 *   and club names. The API answers 400 `name_not_allowed`. Short or common words only match as a
 *   whole word, so names such as "Badminton Bob" or "Stafford" pass.
 * - `blockRoutes`: `GET /api/blocks`, `POST /api/blocks {userId}`, `DELETE /api/blocks/:userId`
 *   (bearer). The app hides a blocked player's chat and emotes; quick match never seats the two
 *   together (either direction).
 * - `adminModerationRoutes` (`Authorization: Bearer <ADMIN_TOKEN>`, compared in constant time;
 *   503 without ADMIN_TOKEN): the open report queue, resolving a report (dismiss, warn, ban,
 *   mute), banning and unbanning an account, muting one.
 *
 * A ban revokes every session of the account, closes its sockets with 4403 and keeps it out of
 * sign-in, refresh and the queue (auth answers 403 `banned`). A mute drops the account's chat
 * lines and emotes at every table until it ends (`MuteList`, which the room registry asks).
 */
import type { IncomingMessage } from 'node:http';
import { cleanText } from '@mjm/net';
import { adminAuthorised } from './admin';
import { DELETED_PLAYER_NAME, REPORT_RESOLUTIONS, type ReportRecord, type ReportResolution, type Repos, type UserRecord } from './repos/types';

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** The `error` code for a display name or club name the blocklist refuses. */
export const NAME_NOT_ALLOWED = 'name_not_allowed';

/** Names that pose as the game's staff: refused as a whole word (after digits are stripped). */
const STAFF_WORDS = [
  'admin',
  'admins',
  'administrator',
  'sysadmin',
  'mod',
  'mods',
  'moderator',
  'moderators',
  'official',
  'officials',
  'staff',
  'support',
  'gm',
  'gamemaster',
  'helpdesk',
  'customerservice',
  'system',
];
/** Staff words also refused at the start or end of a name written as one word ("AdminMei", "mahjongofficial"). */
const STAFF_AFFIXES = ['admin', 'administrator', 'moderator', 'official'];

/** Refused as a whole word: common enough inside innocent words that a substring match would misfire. */
const RUDE_WORDS = [
  'ass',
  'asshole',
  'bastard',
  'bitch',
  'bitches',
  'chink',
  'cock',
  'cunt',
  'dick',
  'dildo',
  'fag',
  'kike',
  'nazi',
  'hitler',
  'penis',
  'porn',
  'pussy',
  'rape',
  'rapist',
  'retard',
  'shit',
  'slut',
  'spic',
  'twat',
  'vagina',
  'wank',
  'wanker',
  'whore',
];
/** Refused anywhere in a name: these do not occur inside innocent words. */
const RUDE_FRAGMENTS = ['fuck', 'nigger', 'nigga', 'faggot', 'motherf', 'shithead', 'bullshit', 'asshole', 'bitchass', 'cocksuck', 'jerkoff'];
/** Chinese (Traditional and Simplified) refused anywhere in a name: profanity, slurs, and staff titles. */
const CHINESE_FRAGMENTS = [
  '官方',
  '管理員',
  '管理员',
  '客服',
  '版主',
  '系統管理',
  '系统管理',
  '幹你',
  '幹恁',
  '幹林娘',
  '操你',
  '肏',
  '他媽的',
  '他妈的',
  '你媽的',
  '你妈的',
  '靠北',
  '雞掰',
  '機掰',
  '雞巴',
  '鸡巴',
  '屌',
  '婊子',
  '賤人',
  '贱人',
  '王八蛋',
  '智障',
  '腦殘',
  '脑残',
  '支那',
  '去死',
  '白痴',
  '白癡',
];

/** Digits and symbols written for letters ("4dm1n", "f@ck"). */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', $: 's', '!': 'i' };

/** "fuuuck" and "fuck" alike: runs of one letter collapse to a single letter. */
const squeeze = (s: string) => s.replace(/(.)\1+/gu, '$1');

const LONG_FRAGMENTS = RUDE_FRAGMENTS.map(squeeze);

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The spellings of a name the lists are matched against: its words as typed (camelCase split),
 * with digits stripped from their ends, with digits and symbols read as letters, and runs of
 * single characters joined ("a d m i n").
 */
function spellings(name: string): { words: Set<string>; joined: string[] } {
  const base = name.normalize('NFKC').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').toLowerCase();
  const leet = [...base].map((c) => LEET[c] ?? c).join('');
  const out = new Set<string>();
  const joined: string[] = [];
  for (const text of [base, leet]) {
    const ws = words(text);
    for (const w of ws) {
      out.add(w);
      const stripped = w.replace(/^\p{N}+|\p{N}+$/gu, '');
      if (stripped) out.add(stripped);
    }
    // Single characters spaced out spell a word too.
    let run = '';
    for (const w of [...ws, '']) {
      if (w.length === 1) run += w;
      else {
        if (run.length > 1) out.add(run);
        run = '';
      }
    }
    joined.push(ws.join(''));
  }
  return { words: out, joined };
}

/**
 * Whether a display name or club name may be used. Call it on the cleaned name (`cleanText`);
 * an empty name is the caller's business and passes here.
 */
export function nameAllowed(name: string): boolean {
  const { words: ws, joined } = spellings(name);
  for (const w of ws) {
    if (STAFF_WORDS.includes(w) || RUDE_WORDS.includes(w)) return false;
    const sq = squeeze(w);
    if (sq.length >= 4 && RUDE_WORDS.some((r) => r.length >= 4 && squeeze(r) === sq)) return false;
  }
  for (const j of joined) {
    const letters = j.replace(/\p{N}+/gu, '');
    if (STAFF_AFFIXES.some((a) => letters.startsWith(a) || letters.endsWith(a))) return false;
    const sq = squeeze(j);
    if (LONG_FRAGMENTS.some((f) => sq.includes(f))) return false;
  }
  const compact = name.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
  return !CHINESE_FRAGMENTS.some((f) => compact.includes(f));
}

// ---------------------------------------------------------------------------------------------
// Mutes, as the tables see them
// ---------------------------------------------------------------------------------------------

/** Accounts whose chat and emotes are dropped at every table, until when. Kept in memory, loaded at boot. */
export class MuteList {
  private readonly until = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  set(userId: string, until: number | null): void {
    if (until === null || until <= this.now()) this.until.delete(userId);
    else this.until.set(userId, until);
  }

  isMuted(userId: string | undefined): boolean {
    if (!userId) return false;
    const until = this.until.get(userId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.until.delete(userId);
    return false;
  }

  /** Load every mute still running (at boot). */
  async load(repos: Pick<Repos, 'moderation'>): Promise<void> {
    for (const m of await repos.moderation.mutedAfter(this.now())) this.set(m.userId, m.mutedUntil);
  }
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

/** An error with an HTTP status and an `error` code; api.ts answers it as `{ error, message }`. */
export class ModerationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ModerationError';
  }
}

/** What a moderation route reads from the API's request context (a subset of api.ts's Ctx). */
export interface ModerationCtx {
  params: Record<string, string>;
  body: Record<string, unknown>;
  req: IncomingMessage;
  caller(): Promise<{ userId: string }>;
}

export type ModerationRouteFactory<R> = (method: string, path: string, handler: (ctx: ModerationCtx) => unknown) => R;

export interface ModerationDeps {
  repos: Repos;
  now?: () => number;
  /** Turns a status and body into the API's non-200 answer (api.ts's Reply). */
  reply: (status: number, body?: unknown) => unknown;
  /** The tables' mute list, updated by a mute. */
  mutes?: MuteList;
  /** Ends a banned account's table sockets (close code 4403). */
  closeSockets?: (userId: string) => void;
  /** Tells quick match a player's blocks changed, or that the account was banned. */
  onBlocksChanged?: (userId: string) => void;
  onBanned?: (userId: string) => void;
  /** Default: ADMIN_TOKEN from the environment; absent or blank answers 503 on every admin route. */
  adminToken?: string | null;
  env?: Record<string, string | undefined>;
}

/** Most players one account may block. */
export const MAX_BLOCKS = 500;
/** Longest mute, in days. */
export const MAX_MUTE_DAYS = 365;

const DAY_MS = 86_400_000;
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function publicName(u: UserRecord | null): string {
  if (!u || u.deletedAt !== null) return DELETED_PLAYER_NAME;
  return cleanText(u.displayName, 24) || `Player ${u.id.replace(/-/g, '').slice(0, 4).toUpperCase()}`;
}

export function blockRoutes<R>(r: ModerationRouteFactory<R>, deps: ModerationDeps): R[] {
  const { repos } = deps;
  const now = deps.now ?? Date.now;
  return [
    r('GET', '/api/blocks', async (ctx) => {
      const me = await ctx.caller();
      const rows = await repos.blocks.list(me.userId);
      const users = await Promise.all(rows.map((b) => repos.users.get(b.blockedId)));
      return { blocks: rows.map((b, i) => ({ userId: b.blockedId, displayName: publicName(users[i]), avatar: users[i]?.deletedAt === null ? users[i]?.avatar ?? null : null, createdAt: iso(b.createdAt) })) };
    }),
    r('POST', '/api/blocks', async (ctx) => {
      const me = await ctx.caller();
      const userId = ctx.body.userId;
      if (typeof userId !== 'string' || !USER_ID.test(userId)) throw new ModerationError(400, 'invalid', 'userId is required');
      if (userId === me.userId) throw new ModerationError(400, 'invalid', 'You cannot block yourself');
      const target = await repos.users.get(userId);
      if (!target || target.deletedAt !== null) throw new ModerationError(404, 'not_found', 'No such player');
      const existing = await repos.blocks.list(me.userId);
      if (!existing.some((b) => b.blockedId === target.id) && existing.length >= MAX_BLOCKS) throw new ModerationError(409, 'limit', `You can block at most ${MAX_BLOCKS} players`);
      const at = now();
      const added = await repos.blocks.add(me.userId, target.id, at);
      deps.onBlocksChanged?.(me.userId);
      return deps.reply(added ? 201 : 200, { userId: target.id, displayName: publicName(target), avatar: target.avatar, createdAt: iso(added ? at : (existing.find((b) => b.blockedId === target.id)?.createdAt ?? at)) });
    }),
    r('DELETE', '/api/blocks/:userId', async (ctx) => {
      const me = await ctx.caller();
      await repos.blocks.remove(me.userId, ctx.params.userId);
      deps.onBlocksChanged?.(me.userId);
      return deps.reply(204);
    }),
  ];
}

/** Report statuses the queue can be listed by. */
const REPORT_STATUSES: ReadonlyArray<ReportRecord['status']> = ['open', 'actioned', 'dismissed'];

export function adminModerationRoutes<R>(r: ModerationRouteFactory<R>, deps: ModerationDeps): R[] {
  const { repos } = deps;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const adminToken = deps.adminToken !== undefined ? deps.adminToken : (env.ADMIN_TOKEN ?? '').trim() || null;

  /** Every admin route: 503 when no token is configured, 401 for a wrong one. */
  const admin = (ctx: ModerationCtx) => {
    if (!adminToken) throw new ModerationError(503, 'unavailable', 'Moderation is not configured on this server');
    if (!adminAuthorised(ctx.req.headers.authorization, adminToken)) throw new ModerationError(401, 'unauthorised', 'Bad admin token');
  };
  const target = async (id: string): Promise<UserRecord> => {
    const user = USER_ID.test(id) ? await repos.users.get(id) : null;
    if (!user) throw new ModerationError(404, 'not_found', 'No such account');
    return user;
  };
  const days = (v: unknown, min: number): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > MAX_MUTE_DAYS) throw new ModerationError(400, 'invalid', `days must be a whole number from ${min} to ${MAX_MUTE_DAYS}`);
    return v;
  };

  const ban = async (user: UserRecord, reason: string | null) => {
    const at = now();
    await repos.moderation.ban(user.id, at, reason);
    await repos.sessions.revokeAllForUser(user.id, at);
    deps.closeSockets?.(user.id);
    deps.onBanned?.(user.id);
  };
  const mute = async (user: UserRecord, d: number) => {
    const until = d === 0 ? null : now() + d * DAY_MS;
    await repos.moderation.mute(user.id, until);
    deps.mutes?.set(user.id, until);
    return until;
  };
  const accountJson = async (u: UserRecord) => {
    const status = await repos.moderation.status(u.id);
    return { id: u.id, kind: u.kind, displayName: publicName(u), deleted: u.deletedAt !== null, bannedAt: iso(status?.bannedAt ?? null), banReason: status?.banReason ?? null, mutedUntil: iso(status?.mutedUntil ?? null) };
  };

  return [
    r('GET', '/api/admin/reports', async (ctx) => {
      admin(ctx);
      const query = new URL(ctx.req.url ?? '/', 'http://localhost').searchParams;
      const status = (query.get('status') ?? 'open') as ReportRecord['status'];
      if (!REPORT_STATUSES.includes(status)) throw new ModerationError(400, 'invalid', `status must be one of ${REPORT_STATUSES.join(', ')}`);
      const limit = Math.max(1, Math.min(500, Number.parseInt(query.get('limit') ?? '100', 10) || 100));
      const reports = await repos.reports.listByStatus(status, limit);
      const ids = [...new Set(reports.flatMap((x) => [x.reporterId, x.reportedUserId]))];
      const accounts = new Map<string, unknown>();
      for (const id of ids) {
        const u = await repos.users.get(id);
        accounts.set(id, u ? await accountJson(u) : { id, deleted: true, displayName: DELETED_PLAYER_NAME });
      }
      return {
        reports: reports.map((x) => ({
          id: x.id,
          status: x.status,
          reason: x.reason,
          details: x.details,
          room: x.roomCode,
          createdAt: iso(x.createdAt),
          reporter: accounts.get(x.reporterId),
          reported: accounts.get(x.reportedUserId),
        })),
      };
    }),
    r('POST', '/api/admin/reports/:id/resolve', async (ctx) => {
      admin(ctx);
      const id = /^\d{1,15}$/.test(ctx.params.id) ? Number(ctx.params.id) : NaN;
      const report = Number.isSafeInteger(id) ? await repos.reports.get(id) : null;
      if (!report) throw new ModerationError(404, 'not_found', 'No such report');
      const action = ctx.body.action;
      if (typeof action !== 'string' || !(REPORT_RESOLUTIONS as readonly string[]).includes(action)) throw new ModerationError(400, 'invalid', `action must be one of ${REPORT_RESOLUTIONS.join(', ')}`);
      if (report.status !== 'open') throw new ModerationError(409, 'resolved', 'This report has already been resolved');
      const resolution = action as ReportResolution;
      const muteDays = resolution === 'mute' ? days(ctx.body.days, 1) : 0;
      const reported = await repos.users.get(report.reportedUserId);
      let mutedUntil: number | null = null;
      if (reported && resolution === 'ban') await ban(reported, cleanText(ctx.body.reason, 500) || `report ${report.id}: ${report.reason}`);
      if (reported && resolution === 'mute') mutedUntil = await mute(reported, muteDays);
      if (!(await repos.reports.resolve(report.id, resolution, now()))) throw new ModerationError(409, 'resolved', 'This report has already been resolved');
      return { ok: true, id: report.id, status: resolution === 'dismiss' ? 'dismissed' : 'actioned', action: resolution, ...(mutedUntil !== null ? { mutedUntil: iso(mutedUntil) } : {}) };
    }),
    r('POST', '/api/admin/users/:id/ban', async (ctx) => {
      admin(ctx);
      const user = await target(ctx.params.id);
      await ban(user, cleanText(ctx.body.reason, 500) || null);
      return { ok: true, account: await accountJson(user) };
    }),
    r('DELETE', '/api/admin/users/:id/ban', async (ctx) => {
      admin(ctx);
      const user = await target(ctx.params.id);
      await repos.moderation.unban(user.id);
      return { ok: true, account: await accountJson(user) };
    }),
    r('POST', '/api/admin/users/:id/mute', async (ctx) => {
      admin(ctx);
      const user = await target(ctx.params.id);
      await mute(user, days(ctx.body.days, 0));
      return { ok: true, account: await accountJson(user) };
    }),
  ];
}
