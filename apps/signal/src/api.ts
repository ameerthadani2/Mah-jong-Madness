/**
 * The JSON HTTP API (accounts, sessions, configuration and clubs), written without a framework:
 * a small router over node:http, so the server stays one small process. The contract is
 * docs/API.md.
 *
 * Request bodies are untrusted. Handlers check every field (or pass the raw values to the club
 * registry, which validates and sanitises them), and malformed input comes back as a 4xx, never
 * a 500. Errors are `{ error: <code>, message }`: AuthError carries its own status, ClubError
 * maps through STATUS, and rate limits answer 429 `rate_limited`.
 *
 * Every route except `/health`, `/api/config` and the guest bootstrap routes takes
 * `Authorization: Bearer <session token>`. Club members are identified by the session's user id,
 * and their name and avatar come from the user record.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizeRules } from '@mjm/engine';
import {
  AuthError,
  createGuest,
  deleteAccount,
  enabledProviders,
  isProvider,
  link,
  login,
  loginGuest,
  unlink,
  verifyProviderToken,
  type Peppers,
  type ProviderConfig,
  type SessionService,
} from './auth';
import { ClubError, ClubRegistry, type Club, type Identity } from './clubs';
import { LIMITS, type SignalConfig } from './config';
import { BucketTable, clientIp } from './limits';
import type { Repos, UserRecord } from './repos/types';
import { isBotSkill, RoomLimitError, type RoomRegistry } from './rooms';

export interface ApiDeps {
  clubs: ClubRegistry;
  rooms: RoomRegistry;
  repos: Repos;
  sessions: SessionService;
  /** Sign-in providers; absent or empty means guest accounts only. */
  providers?: ProviderConfig;
  /** What `GET /api/config` reports beyond the providers. */
  config?: Partial<Pick<SignalConfig, 'minBuild' | 'maintenance'>>;
  /** `memory` or `pg`, shown on `/health`. */
  storage?: Repos['kind'];
  /** Database check for `/health` (absent: not reported). */
  healthy?: () => Promise<boolean>;
  now?: () => number;
}

export interface ApiOptions {
  /** Browser origins allowed to call the API. Empty (the default) sends no CORS headers, so only same-origin pages can call it; `*` allows any origin. */
  corsOrigins?: string[];
  /** Per-IP request bucket for every route. When it runs dry the request gets a 429. */
  limiter?: BucketTable<string>;
  /** Per-IP bucket for the `/api/auth/*` routes (default 5 a minute). */
  authIpLimiter?: BucketTable<string>;
  /** Per-user bucket for the `/api/auth/*` routes (default 5 a minute). */
  authUserLimiter?: BucketTable<string>;
  /** Number of trusted reverse proxies; the client IP is that many `x-forwarded-for` entries from the right (see `clientIp`). */
  trustProxy?: number | boolean;
}

/** An error with an HTTP status and an `error` code for the body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** A handler's answer with a status other than 200 (201, or 204 with no body). */
export class Reply {
  constructor(
    readonly status: number,
    readonly body?: unknown,
  ) {}
}

/** The caller behind a verified bearer token. */
export interface Caller {
  token: string;
  sessionId: string;
  userId: string;
  deviceId: string | null;
  expiresAt: number;
  user: UserRecord;
}

interface Ctx {
  params: Record<string, string>;
  body: Record<string, unknown>;
  req: IncomingMessage;
  /** Verify the bearer token (once per request); throws a 401 AuthError. */
  caller(): Promise<Caller>;
  /** Spend from this user's auth bucket; throws 429 when it is empty. */
  limitUser(key: string): void;
}

type Handler = (ctx: Ctx) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  /** An `/api/auth/*` route: it also spends from the per-IP auth bucket. */
  auth: boolean;
}

const iso = (ms: number) => new Date(ms).toISOString();

/** `User` in docs/API.md. */
export function userJson(u: UserRecord) {
  return { id: u.id, kind: u.kind, displayName: u.displayName, avatar: u.avatar, locale: u.locale, birthYear: u.birthYear, createdAt: iso(u.createdAt) };
}

/** A user as a club member: the user record's name (or a placeholder for a guest who has not picked one) and avatar. */
export function memberIdentity(u: UserRecord): Identity {
  const name = u.displayName.trim().slice(0, 24) || `Player ${u.id.replace(/-/g, '').slice(0, 4).toUpperCase()}`;
  return u.avatar ? { userId: u.id, name, avatar: u.avatar } : { userId: u.id, name };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The `device` object of an auth body; anything that is not an object reads as no device. */
function deviceOf(body: Record<string, unknown>): Record<string, unknown> {
  return isObject(body.device) ? body.device : {};
}

/** An optional text field: undefined when absent, trimmed and capped when text, otherwise 400. */
function optionalText(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string') throw new AuthError('invalid', `${field} must be text`);
  return v.trim().slice(0, max);
}

export function buildRoutes(deps: ApiDeps): Route[] {
  const { clubs, rooms, repos, sessions } = deps;
  const now = deps.now ?? Date.now;
  const providers = deps.providers ?? {};
  const peppers: Peppers = { current: sessions.pepper, previous: sessions.previousPepper };

  const r = (method: string, path: string, handler: Handler, auth = false): Route => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '/?$');
    return { method, pattern, keys, handler, auth };
  };

  const sessionJson = async (token: string, sessionId: string) => {
    const s = await repos.sessions.get(sessionId);
    return { token, expiresAt: iso(s?.expiresAt ?? now()) };
  };
  const liveUser = async (id: string): Promise<UserRecord> => {
    const u = await repos.users.get(id);
    if (!u || u.deletedAt !== null) throw new AuthError('not_found', 'No such user');
    return u;
  };
  /** The caller as a club member, with their rows in every club brought up to date with the user record. */
  const member = async (ctx: Ctx): Promise<Identity> => {
    const identity = memberIdentity((await ctx.caller()).user);
    clubs.refreshMember(identity);
    return identity;
  };
  /** Members see the whole club; everyone else sees the public view. */
  const view = (club: Club, userId: string) => (clubs.isMember(club.code, userId) ? club : ClubRegistry.publicView(club));

  return [
    r('GET', '/health', async () => {
      const db = deps.healthy ? await deps.healthy().then((ok) => (ok ? 'ok' : 'down'), () => 'down') : undefined;
      return { ok: true, ...rooms.stats(), storage: deps.storage ?? repos.kind, ...(db ? { db } : {}) };
    }),
    r('GET', '/api/config', () => ({
      authProviders: enabledProviders(providers),
      storeEnabled: false,
      pushEnabled: false,
      minBuild: deps.config?.minBuild ?? 0,
      maintenance: deps.config?.maintenance ?? null,
      serverNow: iso(now()),
    })),

    // ------------------------------------------------------------------ accounts and sessions
    r(
      'POST',
      '/api/auth/guest',
      async ({ body }) => {
        const device = deviceOf(body);
        const displayName = optionalText(body.displayName, 'displayName', 24);
        const avatar = optionalText(body.avatar, 'avatar', 16);
        const g = await createGuest(repos, peppers, device, { sessions, now, displayName, avatar, deviceId: device.id });
        const user = await liveUser(g.userId);
        return new Reply(201, { userId: g.userId, guestSecret: g.guestSecret, session: await sessionJson(g.token, g.sessionId), user: userJson(user) });
      },
      true,
    ),
    r(
      'POST',
      '/api/auth/guest/login',
      async (ctx) => {
        if (typeof ctx.body.userId === 'string') ctx.limitUser(ctx.body.userId);
        const g = await loginGuest(repos, peppers, ctx.body.userId, ctx.body.guestSecret, { sessions, now, deviceId: deviceOf(ctx.body).id });
        return { session: await sessionJson(g.token, g.sessionId), user: userJson(await liveUser(g.userId)) };
      },
      true,
    ),
    r(
      'POST',
      '/api/auth/refresh',
      async (ctx) => {
        const me = await ctx.caller();
        ctx.limitUser(me.userId);
        const { token, session } = await sessions.rotate(me.token);
        return { session: { token, expiresAt: iso(session.expiresAt) } };
      },
      true,
    ),
    r(
      'POST',
      '/api/auth/logout',
      async (ctx) => {
        const me = await ctx.caller();
        ctx.limitUser(me.userId);
        await sessions.revoke(me.sessionId);
        return new Reply(204);
      },
      true,
    ),
    r(
      'POST',
      '/api/auth/link',
      async (ctx) => {
        const me = await ctx.caller();
        ctx.limitUser(me.userId);
        const { provider, token, nonce } = ctx.body;
        if (nonce !== undefined && typeof nonce !== 'string') throw new AuthError('invalid', 'nonce must be text');
        const identity = await verifyProviderToken(provider, token, { ...providers, nonce });
        const result = await link(repos, me.userId, identity, { sessions, currentSessionId: me.sessionId, deviceId: me.deviceId, now });
        if (result.affectedClubs.length) await clubs.reload(result.affectedClubs);
        const user = await liveUser(result.userId);
        clubs.refreshMember(memberIdentity(user));
        const session = result.token && result.sessionId ? await sessionJson(result.token, result.sessionId) : { token: me.token, expiresAt: iso(me.expiresAt) };
        return { session, user: userJson(user), merged: result.merged };
      },
      true,
    ),
    r(
      'POST',
      '/api/auth/login',
      async (ctx) => {
        // A guest may send its bearer; it only counts towards that user's limit.
        if (bearerToken(ctx.req)) {
          const guest = await ctx.caller().catch(() => null);
          if (guest) ctx.limitUser(guest.userId);
        }
        const { provider, token, nonce } = ctx.body;
        if (nonce !== undefined && typeof nonce !== 'string') throw new AuthError('invalid', 'nonce must be text');
        const identity = await verifyProviderToken(provider, token, { ...providers, nonce });
        ctx.limitUser(`${identity.provider}:${identity.subject}`);
        const result = await login(repos, identity, { sessions, deviceId: typeof deviceOf(ctx.body).id === 'string' ? (deviceOf(ctx.body).id as string) : null, now });
        return { session: await sessionJson(result.token, result.sessionId), user: userJson(await liveUser(result.userId)) };
      },
      true,
    ),
    r(
      'DELETE',
      '/api/auth/identities/:provider',
      async (ctx) => {
        const me = await ctx.caller();
        ctx.limitUser(me.userId);
        if (!isProvider(ctx.params.provider)) throw new AuthError('invalid', 'Unknown provider');
        await unlink(repos, me.userId, ctx.params.provider);
        return new Reply(204);
      },
      true,
    ),
    r('GET', '/api/me', async (ctx) => {
      const me = await ctx.caller();
      const [wallet, entitlements, identities] = await Promise.all([repos.wallet.get(me.userId), repos.wallet.getEntitlements(me.userId), repos.identities.listForUser(me.userId)]);
      return {
        user: userJson(me.user),
        wallet: { diamonds: wallet.diamonds, bonusDiamonds: wallet.bonusDiamonds },
        entitlements: entitlements.map((e) => ({ entitlement: e.entitlement, expiresAt: e.expiresAt === null ? null : iso(e.expiresAt) })),
        identities: identities.filter((i) => i.provider !== 'guest').map((i) => (i.email ? { provider: i.provider, email: i.email } : { provider: i.provider })),
        serverNow: iso(now()),
      };
    }),
    r('PATCH', '/api/me', async (ctx) => {
      const me = await ctx.caller();
      const { body } = ctx;
      const patch: Partial<Pick<UserRecord, 'displayName' | 'avatar' | 'locale' | 'birthYear'>> = {};
      const displayName = optionalText(body.displayName, 'displayName', 24);
      if (displayName !== undefined) patch.displayName = displayName;
      if (body.avatar !== undefined) patch.avatar = body.avatar === null ? null : (optionalText(body.avatar, 'avatar', 16) ?? null) || null;
      if (body.locale !== undefined) {
        const locale = body.locale === null ? null : optionalText(body.locale, 'locale', 16);
        if (locale !== null && !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale ?? '')) throw new AuthError('invalid', 'locale must be a language tag');
        patch.locale = locale ?? null;
      }
      if (body.birthYear !== undefined) {
        const y = body.birthYear;
        if (y !== null && !(Number.isInteger(y) && (y as number) >= 1900 && (y as number) <= new Date(now()).getUTCFullYear())) throw new AuthError('invalid', 'birthYear must be a year');
        patch.birthYear = y as number | null;
      }
      const user = (await repos.users.update(me.userId, patch)) ?? me.user;
      clubs.refreshMember(memberIdentity(user));
      return { user: userJson(user) };
    }),
    r('DELETE', '/api/me', async (ctx) => {
      const me = await ctx.caller();
      const { affectedClubs } = await deleteAccount(repos, me.userId, { now });
      if (affectedClubs.length) await clubs.reload(affectedClubs);
      return new Reply(204);
    }),

    // ------------------------------------------------------------------ clubs
    r('POST', '/api/clubs', async (ctx) => clubs.createClub(await member(ctx), ctx.body.name ?? '', ctx.body.rules ?? {}, ctx.body.settings ?? {})),
    r('GET', '/api/clubs/:code', async (ctx) => view(clubs.club(ctx.params.code), (await ctx.caller()).userId)),
    r('POST', '/api/clubs/:code/join', async (ctx) => {
      const me = await member(ctx);
      const { club, status } = clubs.joinClub(ctx.params.code, me);
      return { club: view(club, me.userId), status };
    }),
    r('PATCH', '/api/clubs/:code', async (ctx) => {
      const me = await member(ctx);
      const { body } = ctx;
      return clubs.update(ctx.params.code, me.userId, { name: body.name, description: body.description, rules: body.rules, settings: body.settings });
    }),
    r('POST', '/api/clubs/:code/members/:userId/approve', async (ctx) => {
      const me = await member(ctx);
      // The request was made under the name the user had then; approve them as they are now.
      const target = await repos.users.get(ctx.params.userId);
      if (target && target.deletedAt === null) clubs.refreshMember(memberIdentity(target));
      return clubs.approve(ctx.params.code, me.userId, ctx.params.userId);
    }),
    r('POST', '/api/clubs/:code/members/:userId/role', async (ctx) => clubs.setRole(ctx.params.code, (await member(ctx)).userId, ctx.params.userId, ctx.body.role)),
    r('DELETE', '/api/clubs/:code/members/:userId', async (ctx) => {
      const me = await member(ctx);
      return view(clubs.removeMember(ctx.params.code, me.userId, ctx.params.userId), me.userId);
    }),
    r('GET', '/api/clubs/:code/standings', async (ctx) => {
      const me = await ctx.caller();
      const club = clubs.club(ctx.params.code);
      if (!clubs.isMember(club.code, me.userId)) throw new ClubError('forbidden', 'Join the club first');
      return clubs.standings(club.code);
    }),
    r('GET', '/api/users/:userId/clubs', async (ctx) => {
      const me = await ctx.caller();
      if (ctx.params.userId !== 'me' && ctx.params.userId !== me.userId) throw new ClubError('forbidden', 'You can only list your own clubs');
      return clubs.clubsForUser(me.userId).map((c) => view(c, me.userId));
    }),
    r('POST', '/api/clubs/:code/tables', async (ctx) => {
      const me = await member(ctx);
      const { body } = ctx;
      const code = ctx.params.code;
      if (body.botSkill !== undefined && !isBotSkill(body.botSkill)) throw new ClubError('invalid', 'Unknown bot skill');
      if (body.label !== undefined && typeof body.label !== 'string') throw new ClubError('invalid', 'Table label must be text');
      // Check permission and the open-table cap before a room exists, so a refusal leaves nothing behind.
      clubs.assertCanOpenTable(code, me.userId);
      const club = clubs.club(code);
      const rules = sanitizeRules(body.rules, club.rules);
      let room: string;
      try {
        room = rooms.createHostedRoom({ rules, botSkill: body.botSkill, clubCode: club.code });
      } catch (e) {
        if (e instanceof RoomLimitError) throw new ClubError('unavailable', e.message);
        throw e;
      }
      try {
        return clubs.addTable(code, me.userId, { code: room, label: body.label, rules });
      } catch (e) {
        rooms.closeRoomByCode(room);
        throw e;
      }
    }),
  ];
}

const STATUS: Record<ClubError['code'], number> = {
  not_found: 404,
  forbidden: 403,
  exists: 409,
  limit: 409,
  invalid: 400,
  pending: 400,
  unavailable: 503,
};

/** Set CORS headers only for an origin on the allow-list. Other browser origins are blocked by the browser. */
function applyCors(req: IncomingMessage, res: ServerResponse, origins: string[]): void {
  const origin = req.headers.origin;
  if (!origin || origins.length === 0) return;
  const any = origins.includes('*');
  if (!any && !origins.includes(origin)) return;
  res.setHeader('access-control-allow-origin', any ? '*' : origin);
  if (!any) res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-headers', 'content-type, authorization');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
}

/** The token of an `Authorization: Bearer …` header, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m ? m[1] : null;
}

/** A bucket of `perMinute` tokens refilling over a minute, per key. */
export const perMinute = (perMinute: number, now?: () => number) => new BucketTable<string>(perMinute, perMinute / 60, { now });

const RATE_LIMITED = 'Too many requests; please slow down';

export function createApiHandler(deps: ApiDeps, opts: ApiOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const routes = buildRoutes(deps);
  const origins = opts.corsOrigins ?? [];
  const authIp = opts.authIpLimiter ?? perMinute(LIMITS.authPerMinute, deps.now);
  const authUser = opts.authUserLimiter ?? perMinute(LIMITS.authPerMinute, deps.now);
  return async (req, res) => {
    const ip = clientIp(req, opts.trustProxy ?? 0);
    if (opts.limiter && !opts.limiter.take(ip)) {
      res.setHeader('retry-after', '1');
      return send(res, 429, { error: 'rate_limited', message: RATE_LIMITED });
    }
    const url = new URL(req.url ?? '/', 'http://localhost');
    applyCors(req, res, origins);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      try {
        if (route.auth && !authIp.take(ip)) throw new HttpError(429, 'rate_limited', RATE_LIMITED);
        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        let body: Record<string, unknown> = {};
        if (req.method !== 'GET') {
          const raw = await readBody(req, 64 * 1024);
          if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (!isObject(parsed)) return send(res, 400, { error: 'invalid', message: 'Body must be a JSON object' });
            body = parsed;
          }
        }
        let caller: Promise<Caller> | null = null;
        const ctx: Ctx = {
          params,
          body,
          req,
          caller: () => (caller ??= verifyCaller(deps, req)),
          limitUser: (key) => {
            if (!authUser.take(key)) throw new HttpError(429, 'rate_limited', RATE_LIMITED);
          },
        };
        const result = await route.handler(ctx);
        if (result instanceof Reply) {
          if (result.status === 204 || result.body === undefined) {
            res.writeHead(result.status);
            res.end();
            return true;
          }
          return send(res, result.status, result.body);
        }
        return send(res, 200, result ?? {});
      } catch (e) {
        if (e instanceof AuthError) return send(res, e.status, { error: e.code, message: e.message });
        if (e instanceof ClubError) return send(res, STATUS[e.code] ?? 400, { error: e.code, message: e.message });
        if (e instanceof HttpError) {
          if (e.status === 429) res.setHeader('retry-after', '12');
          return send(res, e.status, { error: e.code, message: e.message });
        }
        if (e instanceof SyntaxError || e instanceof URIError || (e as Error).message === 'Body too large') {
          return send(res, 400, { error: 'invalid', message: 'Malformed request' });
        }
        console.error('[signal] api error', (e as Error).message);
        return send(res, 500, { error: 'internal', message: 'Internal error' });
      }
    }
    return false;
  };
}

async function verifyCaller(deps: ApiDeps, req: IncomingMessage): Promise<Caller> {
  const token = bearerToken(req);
  if (!token) throw new AuthError('invalid_session', 'Missing bearer token');
  const s = await deps.sessions.verify(token);
  const user = await deps.repos.users.get(s.userId);
  if (!user || user.deletedAt !== null) throw new AuthError('session_revoked', 'Account no longer exists');
  return { token, sessionId: s.sessionId, userId: s.userId, deviceId: s.deviceId, expiresAt: s.expiresAt, user };
}

function send(res: ServerResponse, status: number, body: unknown): boolean {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

/** Read the request body, capped at `limit` bytes (not characters, so multi-byte text cannot get past the cap). */
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
