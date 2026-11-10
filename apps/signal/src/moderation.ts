/**
 * Moderation: the name check, player blocks, and the moderators' tools.
 *
 * - `nameAllowed(name)`: a small English and Chinese blocklist (slurs, profanity, and names that
 *   pose as the game's staff such as "Admin" or 官方), applied after `cleanText` to display names,
 *   club names and seat names. Accents, look-alike letters of other scripts ("Аdmin" with a
 *   Cyrillic А), digits and symbols written for letters and a blanked-out letter ("f*ck") are read
 *   as the letters they stand for. Short or common words only match as a whole word and staff
 *   words only within one word, so "Badminton Bob", "Stafford", "Brad Min" and "G. M. Lee" pass.
 *   `PATCH /api/me` answers 400 `name_not_allowed`; a new guest is created without the name.
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
  'administrators',
  'sysadmin',
  'sysop',
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
/** Staff words also refused at the start or end of any one word of a name ("AdminMei", "mahjongofficial"). */
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
/**
 * Listed words that are also a first name. One is allowed as the first word of a longer name
 * ("Dick Wong", "Dick Van Dyke") unless a word after it gives the joke away.
 */
const GIVEN_NAMES = new Set(['dick']);
const NOT_A_SURNAME = new Set(['head', 'heads', 'face', 'sucker', 'suck', 'sucks', 'licker', 'pic', 'pics', 'pix', 'big', 'long', 'hard', 'tiny', 'small', 'my', 'your', 'ur', 'his', 'her', 'me']);
/**
 * The listed words whose stretched spellings are refused too ("shiiit", "biitch", "addmin"). Only
 * these: squeezing every doubled letter turned the surnames Rappe and Nazzi into listed words.
 */
const STRETCHED_WORDS = ['shit', 'bitch', 'cunt', 'slut', 'whore', 'pussy', 'dick', 'cock', 'dildo', 'wank', 'wanker', 'retard', 'bastard', 'asshole', 'penis', 'vagina', 'chink', 'admin', 'moderator', 'official', 'staff', 'support'];
/** Refused anywhere in a name: these do not occur inside innocent words. */
const RUDE_FRAGMENTS = ['fuck', 'fvck', 'phuck', 'nigger', 'nigga', 'faggot', 'motherf', 'shithead', 'dickhead', 'bullshit', 'asshole', 'bitchass', 'cocksuck', 'jerkoff'];
/**
 * Chinese refused anywhere in a name: profanity, slurs, and staff titles. Every entry is listed
 * in its Traditional and its Simplified form (and with the look-alike characters people swap
 * in), because a name is matched as written.
 */
const CHINESE_FRAGMENTS = [
  // Staff titles.
  '官方',
  '管理員',
  '管理员',
  '管理者',
  '管理人員',
  '管理人员',
  '工作人員',
  '工作人员',
  '客服',
  '版主',
  '板主',
  '站長',
  '站长',
  '系統管理',
  '系统管理',
  '系統公告',
  '系统公告',
  '系統訊息',
  '系统消息',
  // Profanity and slurs.
  '幹你',
  '干你',
  '幹恁',
  '干恁',
  '幹林娘',
  '干林娘',
  '操你',
  '肏',
  '他媽的',
  '他妈的',
  '他馬的',
  '他马的',
  '你媽的',
  '你妈的',
  '你馬的',
  '你马的',
  '靠北',
  '靠杯',
  '雞掰',
  '鸡掰',
  '機掰',
  '机掰',
  '雞巴',
  '鸡巴',
  '機巴',
  '机巴',
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

/**
 * Letters of other scripts and letter-like symbols that read as a Latin letter ("Аdmin" with a
 * Cyrillic А, "Mοderator" with a Greek omicron, "ᴀᴅᴍɪɴ" in small capitals), folded to that
 * letter before matching. Looked up by the character as typed and then by its lowercase, so an
 * entry for a capital is only needed where the capital reads differently (Greek Η is an H, η an n).
 * Accents never reach this table: they are stripped first.
 */
const LOOKALIKES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: 'a',
  б: 'b',
  в: 'b',
  г: 'r',
  д: 'd',
  е: 'e',
  з: 'e',
  и: 'u',
  И: 'n',
  к: 'k',
  л: 'n',
  м: 'm',
  н: 'h',
  о: 'o',
  п: 'n',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  ц: 'u',
  ш: 'w',
  щ: 'w',
  ь: 'b',
  э: 'e',
  я: 'r',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  һ: 'h',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  ҝ: 'k',
  ү: 'y',
  // Greek
  α: 'a',
  β: 'b',
  γ: 'y',
  δ: 'd',
  ε: 'e',
  ζ: 'z',
  η: 'n',
  Η: 'h',
  θ: 'o',
  ι: 'i',
  κ: 'k',
  μ: 'u',
  Μ: 'm',
  ν: 'v',
  Ν: 'n',
  ο: 'o',
  π: 'n',
  ρ: 'p',
  σ: 'o',
  ς: 's',
  Σ: 'e',
  τ: 't',
  υ: 'u',
  Υ: 'y',
  χ: 'x',
  ω: 'w',
  // Small capitals and other Latin letter forms
  ᴀ: 'a',
  ʙ: 'b',
  ᴄ: 'c',
  ᴅ: 'd',
  ᴇ: 'e',
  ꜰ: 'f',
  ɢ: 'g',
  ʜ: 'h',
  ɪ: 'i',
  ᴊ: 'j',
  ᴋ: 'k',
  ʟ: 'l',
  ᴍ: 'm',
  ɴ: 'n',
  ᴏ: 'o',
  ᴘ: 'p',
  ǫ: 'q',
  ʀ: 'r',
  ꜱ: 's',
  ᴛ: 't',
  ᴜ: 'u',
  ᴠ: 'v',
  ᴡ: 'w',
  ʏ: 'y',
  ᴢ: 'z',
  ı: 'i',
  ȷ: 'j',
  ł: 'l',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'p',
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ƒ: 'f',
  ɑ: 'a',
  ɡ: 'g',
  ɛ: 'e',
  ɔ: 'o',
  ǝ: 'e',
};

/** Digits and symbols written for letters ("4dm1n", "f@ck", "$hit"). */
const LEET: Readonly<Record<string, string>> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g', '@': 'a', $: 's', '!': 'i', '¡': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l', '¢': 'c' };
/** The same with 1 and | read as an L ("officia1"). */
const LEET_L: Readonly<Record<string, string>> = { ...LEET, '1': 'l', '|': 'l' };

/**
 * A letter blanked out with an asterisk ("f*ck", "sh*t") stands for any one letter. Inside the
 * check it is written as this character, which counts as a letter when a name is split in words.
 */
const ANY = 'ǂ';

/** Collapses every run of one letter to a single letter ("fuuuck" to "fuck"); blanked-out letters are left alone. */
const squeeze = (s: string) => s.replace(/([^ǂ])\1+/gu, '$1');
/** Collapses a run of three or more of one letter to two ("niggger" to "nigger"). */
const soften = (s: string) => s.replace(/([^ǂ])\1{2,}/gu, '$1$1');

const STRETCHED = STRETCHED_WORDS.map(squeeze);
/** Fragments with a doubled letter are matched as written ("Niger" is a country); the others also in their squeezed spelling. */
const SQUEEZABLE_FRAGMENTS = RUDE_FRAGMENTS.filter((f) => squeeze(f) === f);
/** Words long enough to be refused when a name spells them across its spaces ("Ad Min", "of fi cial"). */
const SPELLED_OUT = [...STAFF_WORDS, ...RUDE_WORDS].filter((w) => w.length >= 5);

/** Whether `text` reads `word` from `at` on, a blanked-out letter matching any letter (at least two real letters must match). */
function readsAt(text: string, at: number, word: string): boolean {
  if (at < 0 || at + word.length > text.length) return false;
  let real = 0;
  for (let i = 0; i < word.length; i++) {
    const c = text[at + i];
    if (c === word[i]) real++;
    else if (c !== ANY) return false;
  }
  return real >= Math.min(2, word.length);
}
const reads = (text: string, word: string) => text.length === word.length && readsAt(text, 0, word);
const readsAny = (text: string, list: readonly string[]) => list.some((w) => reads(text, w));
function contains(text: string, fragment: string): boolean {
  for (let at = 0; at + fragment.length <= text.length; at++) if (readsAt(text, at, fragment)) return true;
  return false;
}

function words(text: string): string[] {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * A name as the lists read it: camelCase split into words, accents and combining marks removed,
 * look-alike letters of other scripts folded to Latin, lowercase, an asterisk kept as "any letter".
 */
function skeleton(name: string): string {
  const split = name.normalize('NFKC').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  let out = '';
  for (const ch of split.normalize('NFKD')) {
    if (/\p{M}/u.test(ch)) continue;
    if (ch === '*') out += ANY;
    else out += LOOKALIKES[ch] ?? LOOKALIKES[ch.toLowerCase()] ?? ch.toLowerCase();
  }
  return out;
}

/** `text` with digits and symbols read as letters; a number standing on its own ("Bob 455") stays a number. */
function leet(text: string, table: Readonly<Record<string, string>>): string {
  return text
    .split(/(\s+)/u)
    .map((chunk) => (/^\p{N}+$/u.test(chunk) ? chunk : [...chunk].map((c) => table[c] ?? c).join('')))
    .join('');
}

/** Whether one spelling of a name (its words in order) hits a list. */
function refused(ws: string[], asTyped: boolean): boolean {
  const bare = ws.map((w) => w.replace(/^\p{N}+|\p{N}+$/gu, '')).filter(Boolean);
  // "Dick Wong": a listed word that is also a first name, followed by what reads as the rest of a name.
  const givenName = asTyped && ws.length >= 2 && GIVEN_NAMES.has(ws[0]) && ws.slice(1).every((w) => /^\p{L}{2,}$/u.test(w) && !NOT_A_SURNAME.has(w) && !RUDE_WORDS.includes(w)) ? ws[0] : null;
  const candidates = new Set([...ws, ...bare]);
  // Single letters spaced out spell a word too, once there are three or more ("a d m i n"; "G. M." is initials).
  let run = '';
  for (const w of [...ws, '']) {
    if ([...w].length === 1) run += w;
    else {
      if ([...run].length >= 3) candidates.add(run);
      run = '';
    }
  }
  for (const w of candidates) {
    if (w === givenName) continue;
    if (readsAny(w, STAFF_WORDS) || readsAny(w, RUDE_WORDS)) return true;
    if (w.length >= 4 && readsAny(squeeze(w), STRETCHED)) return true;
    // Staff words at either end of one word. Per word, never across words: "Brad Min" is a name.
    const letters = w.replace(/\p{N}+/gu, '');
    if (STAFF_AFFIXES.some((a) => readsAt(letters, 0, a) || readsAt(letters, letters.length - a.length, a))) return true;
  }
  // A longer listed word spelled across neighbouring words ("Ad Min", "mo der ator").
  for (let from = 0; from < bare.length; from++) {
    let joined = bare[from];
    for (let to = from + 1; to < bare.length && joined.length < 16; to++) {
      joined += bare[to];
      if (readsAny(joined, SPELLED_OUT)) return true;
    }
  }
  const whole = ws.join('');
  if (RUDE_FRAGMENTS.some((f) => contains(whole, f) || contains(soften(whole), f))) return true;
  const squeezed = squeeze(whole);
  return SQUEEZABLE_FRAGMENTS.some((f) => contains(squeezed, f));
}

/**
 * Whether a display name or club name may be used. Call it on the cleaned name (`cleanText`);
 * an empty name is the caller's business and passes here.
 *
 * The name is read three ways (as typed, and with digits and symbols read as letters, the 1 as an
 * I and as an L), each after accents are removed and look-alike letters are folded to Latin.
 * Staff words and the shorter rude words only match a whole word; staff words also match at
 * either end of a word; the unmistakable ones match anywhere. Chinese is matched as written,
 * ignoring spaces and punctuation.
 */
export function nameAllowed(name: string): boolean {
  const base = skeleton(name);
  const spellings = [...new Set([base, leet(base, LEET), leet(base, LEET_L)])];
  if (spellings.some((s, i) => refused(words(s), i === 0))) return false;
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
