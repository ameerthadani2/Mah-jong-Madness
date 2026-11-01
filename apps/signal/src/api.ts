/**
 * Minimal JSON HTTP API for clubs. No framework: a tiny router over node:http
 * so the server stays a single small process.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ClubError, ClubRegistry, type Identity } from './clubs';
import type { RoomRegistry } from './rooms';
import type { RuleSet } from '@mjm/engine';

export interface ApiDeps {
  clubs: ClubRegistry;
  rooms: RoomRegistry;
}

type Handler = (params: Record<string, string>, body: Record<string, unknown>, req: IncomingMessage) => unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

function identity(body: Record<string, unknown>): Identity {
  const u = body.user as Partial<Identity> | undefined;
  if (!u || typeof u.userId !== 'string' || typeof u.name !== 'string' || !/^[\w-]{6,64}$/.test(u.userId)) throw new ClubError('invalid', 'user {userId, name} is required');
  return { userId: u.userId, name: u.name.slice(0, 24), avatar: typeof u.avatar === 'string' ? u.avatar.slice(0, 8) : undefined };
}

export function buildRoutes(deps: ApiDeps): Route[] {
  const { clubs, rooms } = deps;
  const r = (method: string, path: string, handler: Handler): Route => {
    const keys: string[] = [];
    const pattern = new RegExp('^' + path.replace(/:(\w+)/g, (_, k: string) => (keys.push(k), '([^/]+)')) + '/?$');
    return { method, pattern, keys, handler };
  };
  return [
    r('GET', '/health', () => ({ ok: true, ...rooms.stats() })),
    r('POST', '/api/clubs', (_p, body) => clubs.createClub(identity(body), String(body.name ?? ''), (body.rules as Partial<RuleSet>) ?? {}, (body.settings as Record<string, boolean>) ?? {})),
    r('GET', '/api/clubs/:code', (p) => clubs.club(p.code)),
    r('POST', '/api/clubs/:code/join', (p, body) => clubs.joinClub(p.code, identity(body))),
    r('PATCH', '/api/clubs/:code', (p, body) => clubs.update(p.code, identity(body).userId, { name: body.name as string | undefined, description: body.description as string | undefined, rules: body.rules as Partial<RuleSet> | undefined, settings: body.settings as Record<string, boolean> | undefined })),
    r('POST', '/api/clubs/:code/members/:userId/approve', (p, body) => clubs.approve(p.code, identity(body).userId, p.userId)),
    r('POST', '/api/clubs/:code/members/:userId/role', (p, body) => clubs.setRole(p.code, identity(body).userId, p.userId, String(body.role) as 'owner' | 'admin' | 'member')),
    r('DELETE', '/api/clubs/:code/members/:userId', (p, body) => clubs.removeMember(p.code, identity(body).userId, p.userId)),
    r('GET', '/api/clubs/:code/standings', (p) => clubs.standings(p.code)),
    r('GET', '/api/users/:userId/clubs', (p) => clubs.clubsForUser(p.userId)),
    r('POST', '/api/clubs/:code/tables', (p, body) => {
      const user = identity(body);
      const club = clubs.club(p.code);
      const rules: RuleSet = { ...club.rules, ...((body.rules as Partial<RuleSet>) ?? {}) };
      const code = rooms.createHostedRoom({ rules, botSkill: body.botSkill as 'beginner' | 'club' | 'pro' | undefined });
      try {
        return clubs.addTable(p.code, user.userId, { code, label: body.label as string | undefined, rules });
      } catch (e) {
        rooms.closeRoomByCode(code);
        throw e;
      }
    }),
  ];
}

export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const routes = buildRoutes(deps);
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'content-type');
    res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = route.pattern.exec(url.pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let body: Record<string, unknown> = {};
      if (req.method !== 'GET') {
        const raw = await readBody(req, 64 * 1024);
        if (raw) {
          try {
            body = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return send(res, 400, { error: 'invalid', message: 'Body must be JSON' });
          }
        }
      }
      try {
        const result = route.handler(params, body, req);
        return send(res, 200, result ?? {});
      } catch (e) {
        if (e instanceof ClubError) {
          const status = e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : e.code === 'exists' ? 409 : 400;
          return send(res, status, { error: e.code, message: e.message });
        }
        return send(res, 500, { error: 'internal', message: (e as Error).message });
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

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
      if (data.length > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
