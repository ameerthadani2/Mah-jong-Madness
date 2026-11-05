/** Shared fixtures: the real API handler over memory repositories, driven by in-memory requests. */
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiHandler, type ApiDeps, type ApiOptions } from '../src/api';
import { SessionService } from '../src/auth';
import { ClubRegistry } from '../src/clubs';
import { createMemoryRepos } from '../src/repos';
import { RoomRegistry, type RoomRegistryOptions } from '../src/rooms';

export const PEPPER = 'test-pepper-0123456789abcdef';

export interface HttpResult {
  handled: boolean;
  status: number;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown>;
}

/** Run the real HTTP handler against an in-memory request and response. */
export async function request(
  handler: ReturnType<typeof createApiHandler>,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {},
  ip = '10.0.0.1',
): Promise<HttpResult> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, { method, url, headers, socket: { remoteAddress: ip } });
  const out = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    headersSent: false,
    setHeader: (k: string, v: string) => (out.headers[k.toLowerCase()] = v),
    writeHead: (status: number, h: Record<string, string> = {}) => {
      out.status = status;
      for (const [k, v] of Object.entries(h)) out.headers[k.toLowerCase()] = v;
    },
    end: (b?: string) => (out.body = b ?? ''),
  } as unknown as ServerResponse;
  const handled = await handler(req, res);
  return { handled, ...out, json: out.body ? (JSON.parse(out.body) as Record<string, unknown>) : {} };
}

export interface Guest {
  userId: string;
  guestSecret: string;
  token: string;
  /** `Authorization` header for this guest. */
  auth: Record<string, string>;
}

/**
 * The API over fresh memory repositories. Each request comes from a different IP by default so
 * the auth rate limits stay out of the way; pass `ip` to `call` to test them.
 */
export function apiFixture(
  opts: { api?: ApiOptions; rooms?: RoomRegistryOptions; deps?: Partial<ApiDeps>; now?: () => number } = {},
) {
  const now = opts.now ?? Date.now;
  const repos = createMemoryRepos();
  const sessions = new SessionService(repos, { pepper: PEPPER, now });
  const clubs = new ClubRegistry({ store: repos.clubs, now });
  const rooms = new RoomRegistry({ allowHosted: true, now, ...opts.rooms });
  const handler = createApiHandler({ clubs, rooms, repos, sessions, now, ...opts.deps }, opts.api);
  let n = 0;
  const call = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}, ip?: string) =>
    request(handler, method, url, body, headers, ip ?? `10.1.${Math.floor(++n / 250)}.${n % 250}`);
  const guest = async (displayName?: string, avatar?: string): Promise<Guest> => {
    const res = await call('POST', '/api/auth/guest', { device: { id: crypto.randomUUID(), platform: 'ios', appBuild: '1', locale: 'en' }, displayName, avatar });
    if (res.status !== 201) throw new Error(`guest bootstrap failed: ${res.status} ${res.body}`);
    const token = (res.json.session as { token: string }).token;
    return { userId: res.json.userId as string, guestSecret: res.json.guestSecret as string, token, auth: { authorization: `Bearer ${token}` } };
  };
  return { repos, sessions, clubs, rooms, handler, call, guest };
}
