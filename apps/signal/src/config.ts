/**
 * Server configuration read from the environment once and turned into a typed
 * object with safe defaults. Every setting an operator can tune is here (see the README).
 */
import { join } from 'node:path';

export interface SignalConfig {
  /** TCP port for both HTTP and WebSocket traffic (`PORT`, default 8787). */
  port: number;
  /** Whether the server may host tables itself (`HOST_TABLES`; on unless set to `0`). */
  hostTables: boolean;
  /** Directory that holds the club store (`DATA_DIR`, default `./data`). */
  dataDir: string;
  /** Take the client IP from the first `x-forwarded-for` hop (`TRUST_PROXY=1`). Enable this only behind a proxy you run. */
  trustProxy: boolean;
  /** Origins allowed to call the HTTP API from a browser (`CORS_ORIGINS`, comma-separated). Empty means same origin only; `*` means any origin. */
  corsOrigins: string[];
  /** Maximum number of tables the server hosts at once (`MAX_HOSTED_TABLES`, default 500). */
  maxHostedTables: number;
  /** Allow rooms the server only relays (`P2P_ROOMS=1`). Off by default; intended for development only. */
  p2pRooms: boolean;
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
  /** Each peer may create one room per this many milliseconds. */
  createCooldownMs: 10_000,
  /** Join attempts allowed per peer within each `joinWindowMs`. */
  joinsPerWindow: 5,
  joinWindowMs: 10_000,
} as const;

type Env = Record<string, string | undefined>;

function flag(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
}

function positiveInt(v: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= max ? n : fallback;
}

export function loadConfig(env: Env = process.env, cwd: string = process.cwd()): SignalConfig {
  return {
    port: positiveInt(env.PORT, 8787, 65_535),
    hostTables: env.HOST_TABLES === undefined ? true : env.HOST_TABLES.trim() !== '0',
    dataDir: env.DATA_DIR && env.DATA_DIR.trim() ? env.DATA_DIR : join(cwd, 'data'),
    trustProxy: flag(env.TRUST_PROXY, false),
    corsOrigins: (env.CORS_ORIGINS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    maxHostedTables: positiveInt(env.MAX_HOSTED_TABLES, 500),
    p2pRooms: flag(env.P2P_ROOMS, false),
  };
}
