/**
 * Server configuration read from the environment once and turned into a typed
 * object with safe defaults. Every setting an operator can tune is here (see the README).
 */
import { randomBytes } from 'node:crypto';
import type { ProviderConfig } from './auth/providers';

export interface SignalConfig {
  /** TCP port for both HTTP and WebSocket traffic (`PORT`, default 8787). */
  port: number;
  /** Whether the server may host tables itself (`HOST_TABLES`; on unless set to `0`). */
  hostTables: boolean;
  /**
   * `DATA_DIR`: no longer used (clubs and tables are stored through the repositories). Kept only so
   * the server can warn when it is still set; null when unset.
   */
  dataDir: string | null;
  /**
   * Number of reverse proxies you run in front of the server (`TRUST_PROXY`, default 0 = none).
   * The client IP is the `x-forwarded-for` entry this many places from the right (1 = the rightmost).
   * Set it only behind proxies you run, and to exactly how many there are.
   */
  trustProxy: number;
  /** Origins allowed to call the HTTP API from a browser (`CORS_ORIGINS`, comma-separated). Empty means same origin only; `*` means any origin. */
  corsOrigins: string[];
  /** Maximum number of tables the server hosts at once (`MAX_HOSTED_TABLES`, default 500). */
  maxHostedTables: number;
  /** How long a quick-match group of one to three players waits before bots fill the empty seats (`QUICK_MATCH_FILL_MS`, default 20 s). */
  quickMatchFillMs: number;
  /** Maximum number of unfinished tables one account may have opened (`MAX_TABLES_PER_USER`, default 3). */
  maxTablesPerUser: number;
  /** Allow rooms the server only relays (`P2P_ROOMS=1`). Off by default; intended for development only. */
  p2pRooms: boolean;
  /** Oldest app build allowed to play (`MIN_BUILD`, default 0); `GET /api/config` reports it so older apps can ask to update. */
  minBuild: number;
  /** A notice the app shows instead of online play (`MAINTENANCE_MESSAGE`); null when unset. */
  maintenance: string | null;
  /**
   * The Authorization secret RevenueCat sends with each webhook (`REVENUECAT_WEBHOOK_SECRET`).
   * Null: the webhook answers 503 and `/api/config` reports `storeEnabled: false`.
   */
  revenueCatWebhookSecret: string | null;
}

/** Fixed abuse limits. They are set generously for real play and cannot yet be configured per deployment. */
export const LIMITS = {
  /** Concurrent WebSockets allowed from one IP address. */
  socketsPerIp: 20,
  /** Per-socket message bucket: sustained rate and burst size. Exceeding it closes the socket. */
  messagesPerSec: 30,
  messageBurst: 60,
  /** Per-IP HTTP bucket: sustained rate and burst size. Exceeding it returns 429. */
  httpPerSec: 10,
  httpBurst: 30,
  /** Each account (or socket without one) may create one room per this many milliseconds, however often it reconnects. */
  createCooldownMs: 10_000,
  /** Rooms one IP address may create per minute, whatever the accounts. */
  createsPerIpPerMinute: 6,
  /** Join attempts allowed per account (or socket without one) within each `joinWindowMs`. */
  joinsPerWindow: 5,
  /** Join attempts allowed per IP address within each `joinWindowMs`, whatever the accounts. */
  joinsPerIpPerWindow: 20,
  joinWindowMs: 10_000,
  /** `/api/auth/*` requests per minute, per IP and per user. Exceeding either returns 429. */
  authPerMinute: 5,
  /** Player reports one user may file in 24 hours. */
  reportsPerDay: 10,
  /** Player reports one IP address may file in 24 hours, whatever the accounts (guests are free to make). */
  reportsPerDayPerIp: 30,
} as const;

type Env = Record<string, string | undefined>;

function flag(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

/** A whole number from 0 to `max`. `true`/`yes`/`on` mean 1 (the old on/off form); anything else is `fallback`. */
function hopCount(v: string | undefined, fallback: number, max: number): number {
  if (v === undefined || v.trim() === '') return fallback;
  const t = v.trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(t)) return 1;
  if (['false', 'no', 'off'].includes(t)) return 0;
  const n = Number(t);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

function positiveInt(v: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
}

export function loadConfig(env: Env = process.env): SignalConfig {
  return {
    port: positiveInt(env.PORT, 8787, 65_535),
    hostTables: env.HOST_TABLES === undefined ? true : env.HOST_TABLES.trim() !== '0',
    dataDir: env.DATA_DIR && env.DATA_DIR.trim() ? env.DATA_DIR.trim() : null,
    trustProxy: hopCount(env.TRUST_PROXY, 0, 10),
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxHostedTables: positiveInt(env.MAX_HOSTED_TABLES, 500),
    quickMatchFillMs: positiveInt(env.QUICK_MATCH_FILL_MS, 20_000, 600_000),
    maxTablesPerUser: positiveInt(env.MAX_TABLES_PER_USER, 3, 100),
    p2pRooms: flag(env.P2P_ROOMS, false),
    minBuild: env.MIN_BUILD && /^\d+$/.test(env.MIN_BUILD.trim()) ? Number(env.MIN_BUILD.trim()) : 0,
    maintenance: env.MAINTENANCE_MESSAGE && env.MAINTENANCE_MESSAGE.trim() ? env.MAINTENANCE_MESSAGE.trim().slice(0, 500) : null,
    revenueCatWebhookSecret: (env.REVENUECAT_WEBHOOK_SECRET ?? '').trim() || null,
  };
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/** Sign-in providers from APPLE_CLIENT_ID, GOOGLE_CLIENT_IDS and FACEBOOK_APP_ID; an unset variable leaves that provider off. */
export function providersFromEnv(env: Env): ProviderConfig {
  const cfg: ProviderConfig = {};
  const apple = list(env.APPLE_CLIENT_ID);
  const google = list(env.GOOGLE_CLIENT_IDS);
  const facebook = (env.FACEBOOK_APP_ID ?? '').trim();
  if (apple.length) cfg.apple = { clientIds: apple };
  if (google.length) cfg.google = { clientIds: google };
  if (facebook) cfg.facebook = { appId: facebook };
  return cfg;
}

/**
 * What a production server would be missing: with `NODE_ENV=production`, `DATABASE_URL` and
 * `AUTH_PEPPER` must be set, because without them every account, club and table lives in memory
 * and every session ends at the next deploy. `ALLOW_EPHEMERAL=1` accepts that on purpose (the CI
 * image check, a throwaway staging machine). Returns the missing variable names; empty means boot.
 */
export function missingProductionEnv(env: Env): string[] {
  if ((env.NODE_ENV ?? '').trim().toLowerCase() !== 'production' || flag(env.ALLOW_EPHEMERAL, false)) return [];
  return ['DATABASE_URL', 'AUTH_PEPPER'].filter((name) => !(env[name] ?? '').trim());
}

/** The message `main.ts` prints before refusing to start (see `missingProductionEnv`). */
export function missingProductionEnvMessage(missing: string[]): string {
  return (
    `[signal] refusing to start: NODE_ENV=production but ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not set, ` +
    'so accounts, clubs and tables would be lost at the next restart. Set ' +
    (missing.length === 1 ? 'it' : 'them') +
    ' (fly secrets set ...), or set ALLOW_EPHEMERAL=1 to run with in-memory storage on purpose.'
  );
}

/** The session pepper: AUTH_PEPPER, or a random one for this process only (with a warning). */
export function pepperFromEnv(env: Env, warn: (line: string) => void): { pepper: string; previousPepper?: string } {
  const pepper = (env.AUTH_PEPPER ?? '').trim();
  const previous = (env.AUTH_PEPPER_PREVIOUS ?? '').trim() || undefined;
  if (pepper) return { pepper, previousPepper: previous };
  warn('[signal] AUTH_PEPPER is not set: using a random pepper, so every session ends when this process stops');
  return { pepper: randomBytes(32).toString('hex'), previousPepper: previous };
}
