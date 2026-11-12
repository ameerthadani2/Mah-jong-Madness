/**
 * Production smoke test: plays one real hand against a running game server, the way a phone would.
 *
 *   npm run smoke -w @mjm/signal -- https://mahjong-signal.fly.dev
 *   npm run smoke -w @mjm/signal -- http://127.0.0.1:8787
 *
 * The address may be http(s):// or ws(s)://; only its origin is used. The socket address is the
 * same origin with ws:// or wss://. In order it:
 *   1. checks /health (ok, the database ok when the server reports one, and with --expect-storage
 *      the storage in use), and notes which image answered and the snapshot writes so far,
 *   2. reads GET /api/config,
 *   3. creates a guest account marked as a smoke test (display name 'Smoke test', a device id and
 *      platform starting with 'smoke'),
 *   4. opens a socket and says hello with that session,
 *   5. opens a server-hosted table, sits down, and adds three bots,
 *   6. plays one full hand for its own seat with the engine's chooseAction through a TableClient,
 *   7. checks that the hand's fairness audit verifies ('ok'),
 *   8. reads /health again: the table must have been written to storage during the hand and no
 *      snapshot write may have failed (a server that stores nothing loses every table at a restart),
 *   9. leaves the table, deletes the account (DELETE /api/me) and checks that its session is dead.
 * The account is deleted even when a step fails. It prints each step's time and exits non-zero
 * with the failing step's message on any failure. Nothing here needs a secret.
 *
 * Options: --hand-timeout <seconds> (default 300: server bots wait about 0.6 s per move),
 * --expect-storage pg|memory (fail unless the server reports that storage; `pg` also requires
 * the database to answer; the deploy workflow passes `pg`; also SMOKE_EXPECT_STORAGE),
 * --json (print the result as JSON as well).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { chooseAction, legalActions } from '@mjm/engine';
import { RelayTransport, SignalingClient, TableClient, transportLink, type WebSocketLike } from '@mjm/net';

export const SMOKE_DISPLAY_NAME = 'Smoke test';
export const SMOKE_DEVICE_PREFIX = 'smoke-';

export interface SmokeStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface SmokeResult {
  ok: boolean;
  base: string;
  wsUrl: string;
  steps: SmokeStep[];
  totalMs: number;
  /** The failing step's message, when `ok` is false. */
  error?: string;
}

export interface SmokeOptions {
  /** How long the hand may take (ms). Default 300 s. */
  handTimeoutMs?: number;
  /** How long each HTTP request and socket step may take (ms). Default 15 s. */
  stepTimeoutMs?: number;
  /** Progress lines (default: none). */
  log?: (line: string) => void;
  /**
   * Fail unless `/health` reports this storage. A deployed server must be on `pg`: one on
   * `memory` plays a perfect hand and loses every account and table at the next restart.
   */
  expectStorage?: SmokeStorage;
}

export type SmokeStorage = 'pg' | 'memory';

/** The storage named by --expect-storage or SMOKE_EXPECT_STORAGE; undefined for none; throws on anything else. */
export function smokeStorage(value: string | undefined): SmokeStorage | undefined {
  const v = (value ?? '').trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'pg' || v === 'postgres') return 'pg';
  if (v === 'memory') return 'memory';
  throw new SmokeError(`--expect-storage takes 'pg' or 'memory', not '${value}'`);
}

interface SnapshotWrites {
  saved: number;
  failed: number;
  lastSavedAt: string | null;
  lastFailedAt: string | null;
}

/** `/health.snapshots`, or null when the server does not report it (a build from before it existed). */
function snapshotWrites(health: Record<string, unknown>): SnapshotWrites | null {
  const s = health.snapshots;
  if (!isRecord(s) || typeof s.saved !== 'number' || typeof s.failed !== 'number') return null;
  return { saved: s.saved, failed: s.failed, lastSavedAt: typeof s.lastSavedAt === 'string' ? s.lastSavedAt : null, lastFailedAt: typeof s.lastFailedAt === 'string' ? s.lastFailedAt : null };
}

export class SmokeError extends Error {}

/** The http(s) origin and the matching ws(s) socket address for any of http, https, ws or wss. */
export function smokeUrls(input: string): { base: string; wsUrl: string } {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new SmokeError(`Not a URL: '${input}'. Pass the server address, e.g. https://mahjong-signal.fly.dev`);
  }
  const scheme = { 'http:': 'http', 'ws:': 'http', 'https:': 'https', 'wss:': 'https' }[url.protocol];
  if (!scheme) throw new SmokeError(`Unsupported scheme '${url.protocol}' in '${input}': use https://, http://, wss:// or ws://`);
  const base = `${scheme}://${url.host}`;
  return { base, wsUrl: `${scheme === 'https' ? 'wss' : 'ws'}://${url.host}` };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

async function http(base: string, method: string, path: string, timeoutMs: number, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new SmokeError(`${method} ${base}${path} failed: ${cause?.code ?? cause?.message ?? (e as Error).message}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) json = parsed;
    } catch {
      /* not JSON: callers check the status and fields */
    }
  }
  return { status: res.status, json, text };
}

const brief = (text: string) => (text.length > 300 ? `${text.slice(0, 300)}...` : text);

async function until(what: string, pred: () => boolean, ms: number, fail?: () => string | null): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    const why = fail?.();
    if (why) throw new SmokeError(why);
    if (Date.now() > deadline) throw new SmokeError(`Timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Run the smoke test against `input` (see the file comment). Never throws; the result says what failed. */
export async function runSmoke(input: string, opts: SmokeOptions = {}): Promise<SmokeResult> {
  const handTimeoutMs = opts.handTimeoutMs ?? 300_000;
  const stepMs = opts.stepTimeoutMs ?? 15_000;
  const log = opts.log ?? (() => undefined);
  const started = Date.now();
  const steps: SmokeStep[] = [];
  let urls: { base: string; wsUrl: string };
  try {
    urls = smokeUrls(input);
  } catch (e) {
    return { ok: false, base: input, wsUrl: '', steps, totalMs: 0, error: (e as Error).message };
  }
  const { base, wsUrl } = urls;
  const sockets: WebSocket[] = [];
  let token: string | null = null;
  let deleted = false;
  let signaling: SignalingClient | null = null;
  let table: TableClient | null = null;

  const step = async (name: string, fn: () => Promise<string | void>): Promise<void> => {
    const t0 = Date.now();
    try {
      const detail = (await fn()) || undefined;
      const s: SmokeStep = { name, ok: true, ms: Date.now() - t0, detail };
      steps.push(s);
      log(`ok    ${name.padEnd(10)} ${String(s.ms).padStart(6)} ms${detail ? `  ${detail}` : ''}`);
    } catch (e) {
      const message = e instanceof SmokeError ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
      steps.push({ name, ok: false, ms: Date.now() - t0, detail: message });
      log(`FAIL  ${name.padEnd(10)} ${String(Date.now() - t0).padStart(6)} ms  ${message}`);
      throw new SmokeError(`${name}: ${message}`);
    }
  };

  let error: string | undefined;
  let before: SnapshotWrites | null = null;
  try {
    await step('health', async () => {
      const res = await http(base, 'GET', '/health', stepMs);
      if (res.status !== 200 || res.json.ok !== true) throw new SmokeError(`/health answered ${res.status}: ${brief(res.text)}`);
      if ('db' in res.json && res.json.db !== 'ok') throw new SmokeError(`/health reports the database as '${String(res.json.db)}'`);
      const storage = String(res.json.storage ?? 'unknown');
      if (opts.expectStorage && storage !== opts.expectStorage) {
        const why = storage === 'memory' ? ': accounts, clubs and tables are lost at every restart (DATABASE_URL is not set, or ALLOW_EPHEMERAL=1 is still on)' : '';
        throw new SmokeError(`/health reports storage '${storage}', expected '${opts.expectStorage}'${why}`);
      }
      if (opts.expectStorage === 'pg' && res.json.db !== 'ok') throw new SmokeError('/health does not report the database as ok');
      before = snapshotWrites(res.json);
      const image = typeof res.json.image === 'string' && res.json.image ? `, image ${res.json.image}` : '';
      return `storage ${storage}${'db' in res.json ? ', db ok' : ''}, ${String(res.json.tables ?? 0)} tables${image}`;
    });

    await step('config', async () => {
      const res = await http(base, 'GET', '/api/config', stepMs);
      if (res.status !== 200 || !Array.isArray(res.json.authProviders)) throw new SmokeError(`/api/config answered ${res.status}: ${brief(res.text)}`);
      if (res.json.maintenance) throw new SmokeError(`the server is in maintenance: ${JSON.stringify(res.json.maintenance)}`);
      return `providers [${(res.json.authProviders as unknown[]).join(', ')}], store ${res.json.storeEnabled ? 'on' : 'off'}, minBuild ${String(res.json.minBuild ?? 0)}`;
    });

    let userId = '';
    await step('guest', async () => {
      const device = { id: `${SMOKE_DEVICE_PREFIX}${randomUUID()}`, platform: 'smoke', appBuild: 'smoke', locale: 'en' };
      const res = await http(base, 'POST', '/api/auth/guest', stepMs, { device, displayName: SMOKE_DISPLAY_NAME });
      const session = res.json.session;
      if (res.status !== 201 || !isRecord(session) || typeof session.token !== 'string' || typeof res.json.userId !== 'string') {
        throw new SmokeError(`guest sign-up answered ${res.status}: ${brief(res.text)}`);
      }
      token = session.token;
      userId = res.json.userId;
      return `user ${userId}`;
    });

    await step('socket', async () => {
      signaling = new SignalingClient(wsUrl, {
        auth: token!,
        timeoutMs: stepMs,
        webSocket: (u) => {
          const ws = new WebSocket(u);
          ws.on('error', () => undefined);
          sockets.push(ws);
          return ws as unknown as WebSocketLike;
        },
      });
      try {
        await signaling.connect();
      } catch (e) {
        throw new SmokeError(`the socket at ${wsUrl} did not say hello: ${(e as Error).message}`);
      }
      if (signaling.userId !== userId) throw new SmokeError(`the socket's hello named user ${String(signaling.userId)}, not ${userId}`);
      return `peer ${signaling.peerId}`;
    });

    let room = '';
    await step('table', async () => {
      const sig = signaling!;
      const info = await sig.createHostedRoom({}).catch((e: Error) => {
        throw new SmokeError(`the server refused to open a table: ${e.message}`);
      });
      room = info.room;
      const c = new TableClient(transportLink(new RelayTransport(sig), info.host), SMOKE_DISPLAY_NAME, undefined, { userId });
      table = c;
      c.join();
      await until('a seat at the table', () => c.state.seat !== null, stepMs, () => c.state.lastError);
      return `room ${room}, seat ${c.state.seat}`;
    });

    await step('bots', async () => {
      const c = table!;
      for (let i = 0; i < 3; i++) c.requestBot();
      await until('three bots to sit down', () => c.state.seats.filter((s) => s.isBot).length >= 3, stepMs, () => c.state.lastError);
      return c.state.seats.map((s) => (s.isBot ? `bot ${s.name}` : s.name)).join(', ');
    });

    await step('hand', async () => {
      const c = table!;
      let acted: string | null = null;
      let actions = 0;
      const play = () => {
        if (c.state.disconnected || c.state.kicked) return;
        const s = c.localState();
        const seat = c.state.seat;
        if (!s || seat === null || c.state.view?.phase === 'ended') return;
        if (legalActions(s, seat).length === 0 || c.state.stateHash === acted) return;
        acted = c.state.stateHash;
        const a = chooseAction(s, seat, { seed: `smoke-${room}` });
        if (a) {
          actions++;
          c.act(a);
        }
      };
      const off = c.onChange(() => setImmediate(play));
      try {
        c.requestStart();
        setImmediate(play);
        await until('the hand to end and its audit to arrive', () => c.state.audits.length >= 1, handTimeoutMs, () => {
          if (c.state.kicked) return 'the table removed this seat';
          if (c.state.disconnected) return 'the socket dropped during the hand';
          if (c.state.lastErrorCode && c.state.lastErrorCode !== 'illegal') return `the table refused: ${c.state.lastError} (${c.state.lastErrorCode})`;
          return null;
        });
      } finally {
        off();
      }
      const r = c.state.lastResult;
      const outcome = !r ? 'no result' : r.type === 'draw' ? 'a draw' : `won by seat ${r.wins.map((w) => w.seat).join(', ')}`;
      return `${actions} own moves, ${c.state.lastAudit?.log.length ?? 0} logged actions, ${outcome}`;
    });

    await step('audit', async () => {
      const a = table!.state.audits[0];
      if (a.status !== 'ok') {
        throw new SmokeError(`the hand's audit is '${a.status}'${a.failures.length ? `: ${a.failures.join('; ')}` : ''}${a.caveats.length ? ` (caveats: ${a.caveats.join('; ')})` : ''}`);
      }
      return `hand ${a.audit.handNumber} verified, ${a.audit.ceremonyAttempts} ceremony attempt(s)`;
    });

    await step('snapshot', async () => {
      // The end of a hand is written at once; give the write a moment to land, then judge.
      const start = before as SnapshotWrites | null;
      const deadline = Date.now() + stepMs;
      for (;;) {
        const res = await http(base, 'GET', '/health', stepMs);
        if (res.status !== 200 || res.json.ok !== true) throw new SmokeError(`/health answered ${res.status} after the hand: ${brief(res.text)}`);
        const now = snapshotWrites(res.json);
        if (!now || !start) {
          if (opts.expectStorage) throw new SmokeError('/health does not report table snapshot writes (an older build answered?)');
          return 'not reported by this server';
        }
        const failed = now.failed - start.failed;
        if (failed > 0) {
          throw new SmokeError(`${failed} table snapshot write${failed === 1 ? '' : 's'} failed during the hand${now.lastFailedAt ? ` (last at ${now.lastFailedAt})` : ''}: tables would not survive a restart; the server log says why ("snapshot not saved")`);
        }
        const saved = now.saved - start.saved;
        if (saved > 0) return `${saved} written during the hand, none failed${now.lastSavedAt ? `, last at ${now.lastSavedAt}` : ''}`;
        if (Date.now() > deadline) throw new SmokeError('no table snapshot was written during the hand: tables would not survive a restart');
        await new Promise((r) => setTimeout(r, 200));
      }
    });

    await step('leave', async () => {
      const c = table!;
      table = null;
      c.leave();
      signaling = null;
    });

    await step('delete', async () => {
      const res = await http(base, 'DELETE', '/api/me', stepMs, undefined, token!);
      if (res.status !== 204) throw new SmokeError(`DELETE /api/me answered ${res.status}: ${brief(res.text)}`);
      deleted = true;
      const after = await http(base, 'GET', '/api/me', stepMs, undefined, token!);
      if (after.status !== 401) throw new SmokeError(`the deleted account's session still works: GET /api/me answered ${after.status} instead of 401`);
      return 'the session no longer works';
    });
  } catch (e) {
    error = (e as Error).message;
  } finally {
    try {
      (table as TableClient | null)?.leave();
      (signaling as SignalingClient | null)?.close();
    } catch {
      /* closing is best effort */
    }
    if (token && !deleted) {
      // Never leave a smoke account behind, whatever failed.
      const res = await http(base, 'DELETE', '/api/me', stepMs, undefined, token).catch(() => null);
      log(res?.status === 204 ? 'cleanup: the smoke account was deleted' : `cleanup: could not delete the smoke account (${res ? res.status : 'no answer'})`);
    }
    for (const ws of sockets) ws.terminate();
  }
  return { ok: !error, base, wsUrl, steps, totalMs: Date.now() - started, ...(error ? { error } : {}) };
}

/** The command line: the server address and the options (see the file comment). Throws SmokeError on a bad option. */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): { url?: string; handTimeoutMs?: number; expectStorage?: SmokeStorage; json: boolean } {
  const out: { url?: string; handTimeoutMs?: number; expectStorage?: SmokeStorage; json: boolean } = { json: false };
  let storage = env.SMOKE_EXPECT_STORAGE;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--hand-timeout') out.handTimeoutMs = Number(argv[++i]) * 1000;
    else if (a === '--expect-storage') storage = argv[++i] ?? '?';
    else if (a.startsWith('--expect-storage=')) storage = a.slice('--expect-storage='.length) || '?';
    else if (a.startsWith('--')) throw new SmokeError(`Unknown option '${a}'`);
    else out.url = a;
  }
  const expectStorage = smokeStorage(storage);
  if (expectStorage) out.expectStorage = expectStorage;
  return out;
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const url = args.url ?? process.env.SMOKE_URL;
  if (!url) {
    console.error('Usage: npm run smoke -w @mjm/signal -- <server url> [--expect-storage pg] [--hand-timeout <seconds>] [--json]   (https://..., http://..., wss://... or ws://...)');
    process.exit(2);
  }
  if (args.handTimeoutMs !== undefined && !(args.handTimeoutMs > 0)) {
    console.error('--hand-timeout takes a number of seconds');
    process.exit(2);
  }
  console.log(`Smoke test against ${url}${args.expectStorage ? ` (storage must be ${args.expectStorage})` : ''}`);
  const result = await runSmoke(url, { handTimeoutMs: args.handTimeoutMs, expectStorage: args.expectStorage, log: (line) => console.log(line) });
  console.log(`${result.ok ? 'PASSED' : 'FAILED'} in ${result.totalMs} ms (${result.base}, ${result.wsUrl || 'no socket'})`);
  if (args.json) console.log(JSON.stringify(result));
  if (!result.ok) {
    console.error(`Smoke test failed: ${result.error}`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
