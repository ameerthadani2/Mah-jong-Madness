/**
 * Push token registration: asks for notification permission at the right moment (just after the
 * player creates or joins a club, never at launch), sends the Expo push token to the game server
 * with the bearer session (`POST /api/push/token`), and refreshes it on later launches when
 * permission was already granted.
 *
 * Pure TypeScript: the notification API, storage, fetch and session are injected, so tests run it
 * with fakes. Nothing here throws: every outcome is a result value.
 */
import { authorisedJson, globalFetch, type Authoriser, type FetchLike } from '../api/http';
import type { KeyValueStore } from '../telemetry/consent';

export type PermissionStatus = 'granted' | 'denied' | 'undetermined';

/** The device side (expo-notifications on a phone; nothing on the web). */
export interface PushPlatform {
  getPermission(): Promise<{ status: PermissionStatus; canAskAgain: boolean }>;
  requestPermission(): Promise<PermissionStatus>;
  /** The Expo push token, or null when this build cannot have one (no EAS project id, a simulator, the web). */
  getToken(): Promise<string | null>;
}

export interface PushRegistrarOptions {
  platform: PushPlatform;
  kv: KeyValueStore;
  /** HTTP base of the game server. */
  base: string;
  auth: Authoriser;
  /** True once this device has a server session; nothing here creates one. */
  hasSession(): boolean;
  /** The account the session belongs to: a token is registered per account, so a new account re-sends it. */
  userId?(): string | null;
  /** The server's `pushEnabled` from `/api/config`; null while unknown. */
  pushEnabled(): boolean | null;
  devicePlatform: 'ios' | 'android' | 'web';
  locale(): string;
  fetch?: FetchLike;
  now?: () => number;
}

export type PushResult = 'registered' | 'unchanged' | 'no-session' | 'disabled' | 'not-granted' | 'denied' | 'no-token' | 'failed';

/** Re-send an unchanged token this often, so the server's record never goes stale. */
export const REREGISTER_AFTER_MS = 7 * 24 * 3600_000;
export const PUSH_REQUEST_TIMEOUT_MS = 10_000;

interface PushRecord {
  v: 1;
  /** The last token the server accepted. */
  token: string | null;
  /** The account it was registered for (null when unknown: an older record, or no account). */
  userId: string | null;
  registeredAt: number;
  /** The permission prompt has been shown once from the club flow. */
  asked: boolean;
}

const EMPTY: PushRecord = { v: 1, token: null, userId: null, registeredAt: 0, asked: false };

/** One record per game server, like the session itself. */
export function pushStorageKey(base: string): string {
  return `mjm.push.${base.replace(/^[a-z]+:\/\//i, '').replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export class PushRegistrar {
  private readonly key: string;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private record: PushRecord | null = null;
  private inFlight: Promise<PushResult> | null = null;

  constructor(private readonly o: PushRegistrarOptions) {
    this.key = pushStorageKey(o.base);
    this.fetch = o.fetch ?? globalFetch;
    this.now = o.now ?? Date.now;
  }

  /** At launch and on foreground: re-send the token only when permission is already granted. Never prompts. */
  refreshOnStart(): Promise<PushResult> {
    return this.serial(async () => {
      if (!this.o.hasSession()) return 'no-session';
      if (this.o.pushEnabled() === false) return 'disabled';
      const perm = await this.safe(() => this.o.platform.getPermission(), { status: 'undetermined' as PermissionStatus, canAskAgain: false });
      if (perm.status !== 'granted') return 'not-granted';
      return this.registerCurrent(false);
    });
  }

  /** Just after creating or joining a club: ask once (if the system still lets us), then register. */
  requestAfterClub(): Promise<PushResult> {
    return this.serial(async () => {
      if (!this.o.hasSession()) return 'no-session';
      if (this.o.pushEnabled() !== true) return 'disabled';
      const rec = await this.load();
      const perm = await this.safe(() => this.o.platform.getPermission(), { status: 'undetermined' as PermissionStatus, canAskAgain: false });
      let status = perm.status;
      if (status === 'undetermined' && perm.canAskAgain && !rec.asked) {
        await this.save({ ...rec, asked: true });
        status = await this.safe(() => this.o.platform.requestPermission(), 'denied' as PermissionStatus);
      }
      if (status !== 'granted') return status === 'denied' ? 'denied' : 'not-granted';
      return this.registerCurrent(false);
    });
  }

  /** The system issued a new token (expo-notifications' push token listener). */
  tokenChanged(): Promise<PushResult> {
    return this.serial(async () => {
      if (!this.o.hasSession()) return 'no-session';
      return this.registerCurrent(true);
    });
  }

  /** The account signed out or was deleted: its registration is forgotten here (the permission answer is kept). */
  async forget(): Promise<void> {
    await this.serial(async () => {
      await this.save({ ...(await this.load()), token: null, userId: null, registeredAt: 0 });
      return 'unchanged';
    });
  }

  private async registerCurrent(force: boolean): Promise<PushResult> {
    const token = await this.safe(() => this.o.platform.getToken(), null);
    if (!token) return 'no-token';
    const rec = await this.load();
    const userId = this.o.userId?.() ?? null;
    // The same token registered for another account counts as changed: the server keeps one account per device.
    if (!force && rec.token === token && rec.userId === userId && this.now() - rec.registeredAt < REREGISTER_AFTER_MS) return 'unchanged';
    try {
      await authorisedJson<unknown>(this.o.auth, {
        fetch: this.fetch,
        base: this.o.base,
        method: 'POST',
        path: '/api/push/token',
        body: { token, platform: this.o.devicePlatform, locale: this.o.locale() },
        timeoutMs: PUSH_REQUEST_TIMEOUT_MS,
        scope: 'push',
        label: 'game server',
      });
    } catch {
      return 'failed';
    }
    await this.save({ ...(await this.load()), token, userId, registeredAt: this.now() });
    return 'registered';
  }

  /** One registration at a time; a second call waits for the first and then runs. */
  private serial(job: () => Promise<PushResult>): Promise<PushResult> {
    const run = (this.inFlight ?? Promise.resolve<PushResult>('unchanged')).then(job, job);
    this.inFlight = run;
    return run;
  }

  private async safe<T>(f: () => Promise<T>, fallback: T): Promise<T> {
    try {
      return await f();
    } catch {
      return fallback;
    }
  }

  private async load(): Promise<PushRecord> {
    if (this.record) return this.record;
    let rec = EMPTY;
    try {
      const raw = await this.o.kv.getItem(this.key);
      const o = raw ? (JSON.parse(raw) as Partial<PushRecord>) : null;
      if (o && o.v === 1) rec = { v: 1, token: typeof o.token === 'string' ? o.token : null, userId: typeof o.userId === 'string' ? o.userId : null, registeredAt: typeof o.registeredAt === 'number' ? o.registeredAt : 0, asked: o.asked === true };
    } catch {
      /* unreadable: start again */
    }
    this.record = rec;
    return rec;
  }

  private async save(rec: PushRecord): Promise<void> {
    this.record = rec;
    try {
      await this.o.kv.setItem(this.key, JSON.stringify(rec));
    } catch {
      /* the next launch registers again */
    }
  }
}
