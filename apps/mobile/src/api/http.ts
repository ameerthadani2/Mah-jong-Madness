/**
 * The one JSON-over-HTTP helper the app uses to talk to the game server (accounts and
 * clubs). Pure TypeScript: `fetch` is injected, so tests drive it with a fake.
 *
 * Every failure becomes an `ApiError`. Its `message` is English for logs; screens show
 * `friendlyError(e, t)` (src/logic/errors.ts), which reads `code`.
 */

/** The subset of `fetch` this module uses (the global one fits; tests pass a fake). */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/**
 * A failed request. `code` is the server's `error` field (docs/API.md), or one this client
 * sets itself: `<scope>_timeout`, `<scope>_unreachable` or `<scope>_bad_reply`.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
    /** For timeouts: how long the request was given. */
    readonly seconds?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Codes that mean the bearer token is no longer usable (docs/API.md). */
export const SESSION_ERROR_CODES: ReadonlySet<string> = new Set(['invalid_session', 'session_expired', 'session_revoked', 'session_rotated']);

/** True for a 401 whose bearer token should be refreshed or replaced. */
export function isSessionError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401 && (e.code === undefined || SESSION_ERROR_CODES.has(e.code));
}

/** ws://host:port[/path] → http://host:port ; wss → https. */
export function httpBase(signalUrl: string): string {
  return signalUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/\/ws\/?$/, '').replace(/\/$/, '');
}

/** The global fetch, looked up when called (so a test can stub it after import). */
export const globalFetch: FetchLike = (url, init) => (globalThis as unknown as { fetch: FetchLike }).fetch(url, init);

export interface RequestOptions {
  fetch: FetchLike;
  base: string;
  method: string;
  path: string;
  body?: unknown;
  /** Bearer session token. */
  token?: string;
  timeoutMs: number;
  /** Prefix for this client's own failure codes ('club' → 'club_timeout'), so the copy can name the service. */
  scope: string;
  /** What the English log message calls the server. */
  label: string;
}

export async function requestJson<T>(o: RequestOptions): Promise<T> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let status: number;
  let ok: boolean;
  let text: string;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(new Error('timeout'));
      }, o.timeoutMs);
    });
    const res = await Promise.race([
      o.fetch(`${o.base}${o.path}`, { method: o.method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), signal: controller?.signal }),
      timeout,
    ]);
    status = res.status;
    ok = res.ok;
    text = await Promise.race([res.text(), timeout]);
  } catch (e) {
    const seconds = Math.round(o.timeoutMs / 1000);
    if (timedOut) throw new ApiError(`The ${o.label} did not respond within ${seconds} seconds. Check your connection and try again.`, `${o.scope}_timeout`, undefined, seconds);
    throw new ApiError(`Could not reach the ${o.label} (${(e as Error)?.message || 'network error'}).`, `${o.scope}_unreachable`);
  } finally {
    clearTimeout(timer);
  }
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(`The ${o.label} sent an unreadable reply (${status}).`, `${o.scope}_bad_reply`, status);
  }
  if (!ok) {
    const { message, error } = (data ?? {}) as { message?: unknown; error?: unknown };
    throw new ApiError(typeof message === 'string' && message ? message : `Request failed (${status})`, typeof error === 'string' ? error : undefined, status);
  }
  return data as T;
}

/** Supplies a bearer token and is told when the server rejected it (the AuthClient implements this). */
export interface Authoriser {
  /** A usable session token, bootstrapping or refreshing first if needed. */
  token(): Promise<string>;
  /** The server answered 401 (`e`) to `rejected`: drop or refresh that token so the next `token()` is fresh. */
  onUnauthorised(e: ApiError, rejected: string): Promise<void> | void;
}

/** `requestJson` with the bearer token; on a session 401 the token is replaced once and the request retried. */
export async function authorisedJson<T>(auth: Authoriser, o: Omit<RequestOptions, 'token'>): Promise<T> {
  const token = await auth.token();
  try {
    return await requestJson<T>({ ...o, token });
  } catch (e) {
    if (!isSessionError(e)) throw e;
    await auth.onUnauthorised(e as ApiError, token);
    return requestJson<T>({ ...o, token: await auth.token() });
  }
}
