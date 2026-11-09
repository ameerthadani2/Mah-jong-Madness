/**
 * Remote configuration and the update gate. `GET /api/config` (docs/API.md) tells the app the
 * oldest build the server still serves (`minBuild`), an optional maintenance message, whether
 * push is on and whether the server takes store purchases (`storeEnabled`).
 *
 * Pure TypeScript with `fetch` injected. Every failure (no server, a timeout, an odd reply) gives
 * `null`, and `null` shows nothing: an unreachable server never blocks the app.
 */
import { requestJson, type FetchLike } from '../api/http';

export interface RemoteConfig {
  minBuild: number;
  maintenance: string | null;
  pushEnabled: boolean;
  /**
   * False when the server cannot take store purchases (no webhook secret): the Shop then says
   * "Store unavailable" and sells nothing for money, whatever this build's store keys. Present
   * only when the server says; absent means the build's own store setting decides.
   */
  storeEnabled?: boolean;
}

export const CONFIG_TIMEOUT_MS = 8_000;

/** Keeps only the fields the gate reads, with safe values for anything missing or malformed. */
export function readRemoteConfig(raw: unknown): RemoteConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const minBuild = typeof o.minBuild === 'number' && Number.isFinite(o.minBuild) && o.minBuild > 0 ? Math.floor(o.minBuild) : 0;
  const maintenance = typeof o.maintenance === 'string' && o.maintenance.trim() ? o.maintenance.trim().slice(0, 500) : null;
  const config: RemoteConfig = { minBuild, maintenance, pushEnabled: o.pushEnabled === true };
  if (typeof o.storeEnabled === 'boolean') config.storeEnabled = o.storeEnabled;
  return config;
}

export async function fetchRemoteConfig(fetch: FetchLike, base: string, timeoutMs = CONFIG_TIMEOUT_MS): Promise<RemoteConfig | null> {
  try {
    return readRemoteConfig(await requestJson<unknown>({ fetch, base, method: 'GET', path: '/api/config', timeoutMs, scope: 'config', label: 'game server' }));
  } catch {
    return null;
  }
}

/**
 * The running build as a whole number: iOS CFBundleVersion ("12", or dotted "1.0.12", whose last
 * part counts) or the Android versionCode. Null when unknown (the web, Expo Go, a dev client
 * without one), and an unknown build is never blocked.
 */
export function parseBuildNumber(v: string | number | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
  if (typeof v !== 'string') return null;
  const last = v.trim().split('.').pop() ?? '';
  return /^\d+$/.test(last) ? Number(last) : null;
}

/** True when the server says this build is too old to play. */
export function isBuildBlocked(build: number | null, minBuild: number): boolean {
  return build !== null && minBuild > 0 && build < minBuild;
}

export type GateState = { kind: 'open'; maintenance: string | null } | { kind: 'update'; minBuild: number };

export function gateState(config: RemoteConfig | null, build: number | null): GateState {
  if (!config) return { kind: 'open', maintenance: null };
  if (isBuildBlocked(build, config.minBuild)) return { kind: 'update', minBuild: config.minBuild };
  return { kind: 'open', maintenance: config.maintenance };
}

/** The store page for this platform, or null where there is none (the web). */
export function storeUrlFor(platform: string, urls: { ios: string; android: string }): string | null {
  return platform === 'ios' ? urls.ios : platform === 'android' ? urls.android : null;
}
