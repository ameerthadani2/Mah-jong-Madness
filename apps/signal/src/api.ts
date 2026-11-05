/**
 * A minimal JSON HTTP API for clubs, written without a framework: a small router
 * over node:http, so the server stays one small process.
 *
 * Request bodies are untrusted. Handlers pass the raw values to the club registry,
 * which validates and sanitises them, and malformed input comes back as a 4xx, never a 500.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizeRules } from '@mjm/engine';
import { ClubError, ClubRegistry, type Identity } from './clubs';
import { clientIp, type BucketTable } from './limits';
import { isBotSkill, RoomLimitError, type RoomRegistry } from './rooms';

export interface ApiDeps {
  clubs: ClubRegistry;
  rooms: RoomRegistry;
}

export interface ApiOptions {
  /** Browser origins allowed to call the API. Empty (the default) sends no CORS headers, so only same-origin pages can call it; `*` allows any origin. */
  corsOrigins?: string[];
  /** Per-IP request bucket. When it runs dry the request gets a 429. */
  limiter?: BucketTable<string>;
  /** Take the client IP from `x-forwarded-for` (only behind a trusted proxy). */
  trustProxy?: boolean;
}

type Handler = (params: Record<string, string>, body: Record<string, unknown>, req: IncomingMessage) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function parseUser(body: Record<string, unknown>): { userId: string; name: string; avatar?: string; secret: string } {
  const u = body.user as Partial<{ userId: string; name: string; avatar: string; secret: string }> | undefined;
  if (!u || typeof u !== 'object' || typeof u.userId !== 'string' || typeof u.name !== 'string' || !/^[\w-]{6,64}$/.test(u.userId) || typeof u.secret !== 'string') {
    throw new ClubError('invalid', 'user {userId, name, secret} is required');
  }
  return { userId: u.userId, name: u.name.slice(0, 24), avatar: typeof u.avatar === 'string' ? u.avatar.slice(0, 8) : undefined, secret: u.secret };
}

export function buildRoutes(deps: ApiDeps): Route[] {
  const { clubs, rooms } = deps;
  const identity = (body: Record<string, unknown>): Identity => clubs.authenticate(parseUser(body));
  const r = (method: string, path: string, handler: Handler): Route => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '/?$');
    return { method, pattern, keys, handler };
  };
  return [
    r('GET', '/health', () => ({ ok: true, ...rooms.stats() })),
    r('POST', '/api/clubs', (_p, body) => clubs.createClub(identity(body), body.name ?? '', body.rules ?? {}, body.settings ?? {})),
    r('GET', '/api/clubs/:code', (p) => clubs.club(p.code)),
    r('POST', '/api/clubs/:code/join', (p, body) => clubs.joinClub(p.code, identity(body))),
    r('PATCH', '/api/clubs/:code', (p, body) => clubs.update(p.code, identity(body).userId, { name: body.name, description: body.description, rules: body.rules, settings: body.settings })),
    r('POST', '/api/clubs/:code/members/:userId/approve', (p, body) => clubs.approve(p.code, identity(body).userId, p.userId)),
    r('POST', '/api/clubs/:code/members/:userId/role', (p, body) => clubs.setRole(p.code, identity(body).userId, p.userId, body.role)),
    r('DELETE', '/api/clubs/:code/members/:userId', (p, body) => clubs.removeMember(p.code, identity(body).userId, p.userId)),
    r('GET', '/api/clubs/:code/standings', (p) => clubs.standings(p.code)),
    r('GET', '/api/users/:userId/clubs', (p) => clubs.clubsForUser(p.userId)),
    r('POST', '/api/clubs/:code/tables', (p, body) => {
      const user = identity(body);
      if (body.botSkill !== undefined && !isBotSkill(body.botSkill)) throw new ClubError('invalid', 'Unknown bot skill');
      if (body.label !== undefined && typeof body.label !== 'string') throw new ClubError('invalid', 'Table label must be text');
      // Check permission and the open-table cap before a room exists, so a refusal leaves nothing behind.
      clubs.assertCanOpenTable(p.code, user.userId);
      const rules = sanitizeRules(body.rules, clubs.club(p.code).rules);
      let code: string;
      try {
        code = rooms.createHostedRoom({ rules, botSkill: body.botSkill });
      } catch (e) {
        if (e instanceof RoomLimitError) throw new ClubError('unavailable', e.message);
        throw e;
      }
      try {
        return clubs.addTable(p.code, user.userId, { code, label: body.label, rules });
      } catch (e) {
        rooms.closeRoomByCode(code);
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
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
}

export function createApiHandler(deps: ApiDeps, opts: ApiOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const routes = buildRoutes(deps);
  const origins = opts.corsOrigins ?? [];
  return async (req, res) => {
    if (opts.limiter && !opts.limiter.take(clientIp(req, opts.trustProxy ?? false))) {
      res.setHeader('retry-after', '1');
      return send(res, 429, { error: 'rate_limited', message: 'Too many requests; please slow down' });
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
        const params: Record<string, string> = {};
        route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        let body: Record<string, unknown> = {};
        if (req.method !== 'GET') {
          const raw = await readBody(req, 64 * 1024);
          if (raw) {
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return send(res, 400, { error: 'invalid', message: 'Body must be a JSON object' });
            body = parsed as Record<string, unknown>;
          }
        }
        const result = route.handler(params, body, req);
        return send(res, 200, result ?? {});
      } catch (e) {
        if (e instanceof ClubError) return send(res, STATUS[e.code] ?? 400, { error: e.code, message: e.message });
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
