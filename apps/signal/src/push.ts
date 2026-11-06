/**
 * Push notifications through Expo's push service (`expo-server-sdk`).
 *
 * Three notifications, each at most once a minute per user:
 * - `club_table_opened`: a member opened a table in your club (every member with a token but the opener);
 * - `join_approved`: your request to join a club was approved;
 * - `table_waiting`: you dropped out of a hand at a server table 30 s ago and a bot is playing
 *   for you (`SeatWatcher` notices, from the server's tick).
 *
 * Without EXPO_ACCESS_TOKEN the server builds no client and every call is a no-op
 * (`pushEnabled: false` in `/api/config`); so is a user with no device token. Tokens Expo
 * reports as `DeviceNotRegistered`, on the ticket or later on the receipt, are cleared from
 * `devices.push_token`.
 *
 * Copy is English, or Traditional Chinese for a device whose locale starts with `zh`
 * (zh-TW strings are a first pass and need native review).
 */
import type { ExpoPushMessage, ExpoPushReceipt, ExpoPushTicket } from 'expo-server-sdk';
import type { ClubEvent } from './clubs';
import { reportError } from './observability';
import type { DevicesRepo, PushTarget } from './repos/types';
import type { RoomRegistry } from './rooms';

export type PushKind = 'club_table_opened' | 'join_approved' | 'table_waiting';

/** The part of the Expo SDK client the service uses (a fake in tests). */
export interface PushClient {
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
  getPushNotificationReceiptsAsync(ids: string[]): Promise<Record<string, ExpoPushReceipt>>;
}

/** An Expo push token, as `expo-notifications` returns it. */
export const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

/** The real client when EXPO_ACCESS_TOKEN is set, otherwise null (push off). */
export async function pushClientFromEnv(env: Record<string, string | undefined>): Promise<PushClient | null> {
  const accessToken = (env.EXPO_ACCESS_TOKEN ?? '').trim();
  if (!accessToken) return null;
  const { Expo } = await import('expo-server-sdk');
  return new Expo({ accessToken });
}

const MINUTE = 60_000;
/** Messages per request (Expo's limit is 100). */
const CHUNK = 100;
/** Receipt ids per request (Expo's limit is 1000). */
const RECEIPT_CHUNK = 300;
/** Expo keeps receipts for about a day. */
const RECEIPT_TTL_MS = 24 * 60 * MINUTE;
const MAX_PENDING_RECEIPTS = 20_000;

type Lang = 'en' | 'zh-TW';
type Copy = Record<Lang, (p: Record<string, string>) => { title: string; body: string }>;

// zh-TW: first pass, needs native review.
const COPY: Record<PushKind, Copy> = {
  club_table_opened: {
    en: (p) => ({ title: p.club, body: `${p.name} opened a table. Tap to take a seat.` }),
    'zh-TW': (p) => ({ title: p.club, body: `${p.name} 開了一桌，點一下入座。` }),
  },
  join_approved: {
    en: (p) => ({ title: p.club, body: 'Your request to join has been approved. Welcome to the club!' }),
    'zh-TW': (p) => ({ title: p.club, body: '你的入會申請已通過，歡迎加入！' }),
  },
  table_waiting: {
    en: (p) => ({ title: 'Your table is waiting', body: `A bot is playing your seat at table ${p.room}. Tap to return.` }),
    'zh-TW': (p) => ({ title: '牌桌在等你', body: `電腦正在 ${p.room} 桌代你出牌，點一下回到牌桌。` }),
  },
};

const langOf = (locale: string | null): Lang => (locale && locale.toLowerCase().startsWith('zh') ? 'zh-TW' : 'en');

export interface PushServiceOptions {
  devices: DevicesRepo;
  /** Null: push is off and every call does nothing. */
  client: PushClient | null;
  now?: () => number;
  log?: (line: string) => void;
}

export interface PushResult {
  /** Messages handed to Expo. */
  sent: number;
  /** Users skipped because they had this kind of notification less than a minute ago. */
  limited: number;
}

export class PushService {
  private readonly client: PushClient | null;
  private readonly devices: DevicesRepo;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** When each `userId:kind` was last notified. */
  private readonly lastSent = new Map<string, number>();
  /** Ticket id → token, until its receipt has been read. */
  private readonly pending = new Map<string, { token: string; at: number }>();

  constructor(opts: PushServiceOptions) {
    this.client = opts.client;
    this.devices = opts.devices;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Tickets whose receipts have not been read yet (for tests and diagnostics). */
  get pendingReceipts(): number {
    return this.pending.size;
  }

  /** Users from `userIds` not notified of `kind` in the last minute; marks them as notified now. */
  private admit(userIds: string[], kind: PushKind): { admitted: string[]; limited: number } {
    const at = this.now();
    if (this.lastSent.size > 50_000) for (const [k, t] of this.lastSent) if (at - t >= MINUTE) this.lastSent.delete(k);
    const admitted: string[] = [];
    let limited = 0;
    for (const id of new Set(userIds)) {
      const key = `${id}:${kind}`;
      const last = this.lastSent.get(key);
      if (last !== undefined && at - last < MINUTE) {
        limited++;
        continue;
      }
      this.lastSent.set(key, at);
      admitted.push(id);
    }
    return { admitted, limited };
  }

  /** Send `kind` to every device of these users. Never throws; failures are logged and reported. */
  async notify(userIds: string[], kind: PushKind, params: Record<string, string>, data: Record<string, unknown> = {}): Promise<PushResult> {
    if (!this.client || userIds.length === 0) return { sent: 0, limited: 0 };
    try {
      const targets = await this.devices.pushTargets([...new Set(userIds)]);
      const withTokens = [...new Set(targets.map((t) => t.userId))];
      const { admitted, limited } = this.admit(withTokens, kind);
      const allowed = new Set(admitted);
      const seen = new Set<string>();
      const batch: PushTarget[] = targets.filter((t) => allowed.has(t.userId) && EXPO_PUSH_TOKEN.test(t.token) && !seen.has(t.token) && seen.add(t.token));
      const messages: ExpoPushMessage[] = batch.map((t) => {
        const { title, body } = COPY[kind][langOf(t.locale)](params);
        // `type` is what the app's deep-link handler reads (club → the club screen; table → that table).
        return { to: t.token, title, body, data: { kind, type: kind === 'join_approved' ? 'club' : 'table', ...data }, sound: 'default', priority: kind === 'table_waiting' ? 'high' : 'default', channelId: 'default' };
      });
      for (let i = 0; i < messages.length; i += CHUNK) {
        const chunk = messages.slice(i, i + CHUNK);
        const tickets = await this.client.sendPushNotificationsAsync(chunk);
        await this.readTickets(chunk, tickets);
      }
      return { sent: messages.length, limited };
    } catch (e) {
      this.log(`[signal] push ${kind} failed: ${(e as Error).message}`);
      reportError(e, { where: 'push', kind });
      return { sent: 0, limited: 0 };
    }
  }

  private async readTickets(messages: ExpoPushMessage[], tickets: ExpoPushTicket[]): Promise<void> {
    const at = this.now();
    for (let i = 0; i < tickets.length; i++) {
      const ticket = tickets[i];
      const token = String(messages[i]?.to ?? '');
      if (ticket.status === 'ok') {
        if (this.pending.size < MAX_PENDING_RECEIPTS) this.pending.set(ticket.id, { token, at });
      } else if (ticket.details?.error === 'DeviceNotRegistered') {
        await this.forget(ticket.details.expoPushToken ?? token);
      } else {
        this.log(`[signal] push ticket error: ${ticket.details?.error ?? ticket.message}`);
      }
    }
  }

  private async forget(token: string): Promise<void> {
    if (!token) return;
    const n = await this.devices.clearPushToken(token);
    if (n) this.log(`[signal] push token cleared (${n} device${n === 1 ? '' : 's'}): no longer registered`);
  }

  /**
   * Read the receipts of tickets sent earlier (Expo suggests about 15 minutes later) and clear
   * tokens that are no longer registered. Run on a timer by the server.
   */
  async checkReceipts(): Promise<{ checked: number; cleared: number }> {
    if (!this.client || this.pending.size === 0) return { checked: 0, cleared: 0 };
    const at = this.now();
    for (const [id, p] of this.pending) if (at - p.at > RECEIPT_TTL_MS) this.pending.delete(id);
    const ids = [...this.pending.keys()];
    let checked = 0;
    let cleared = 0;
    try {
      for (let i = 0; i < ids.length; i += RECEIPT_CHUNK) {
        const receipts = await this.client.getPushNotificationReceiptsAsync(ids.slice(i, i + RECEIPT_CHUNK));
        for (const [id, receipt] of Object.entries(receipts)) {
          const p = this.pending.get(id);
          this.pending.delete(id);
          checked++;
          if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
            await this.forget(receipt.details.expoPushToken ?? p?.token ?? '');
            cleared++;
          }
        }
      }
    } catch (e) {
      this.log(`[signal] push receipts failed: ${(e as Error).message}`);
      reportError(e, { where: 'push_receipts' });
    }
    return { checked, cleared };
  }

  /** React to club events: a table opened (tell the other members), a join approved (tell the player). */
  onClubEvent(ev: ClubEvent): Promise<PushResult> {
    if (ev.type === 'table_opened') {
      const opener = ev.club.members.find((m) => m.userId === ev.by);
      const others = ev.club.members.filter((m) => m.userId !== ev.by).map((m) => m.userId);
      return this.notify(others, 'club_table_opened', { club: ev.club.name, name: opener?.name ?? ev.table.label }, { club: ev.club.code, room: ev.table.code });
    }
    return this.notify([ev.userId], 'join_approved', { club: ev.club.name }, { club: ev.club.code });
  }

  tableWaiting(userId: string, room: string, clubCode?: string): Promise<PushResult> {
    return this.notify([userId], 'table_waiting', { room }, clubCode ? { room, club: clubCode } : { room });
  }
}

/**
 * Notices a human who has been disconnected from a hand in progress for `thresholdMs` (30 s of
 * play) at a server-hosted table, and calls `onWaiting` once per disconnection. A player who
 * left the table on purpose (`seat.left`) is not told it is waiting for them. Driven by `tick()`.
 */
export class SeatWatcher {
  /** `room:userId` → the last tick the seat was seen, how long it has been away while a hand was in play, and whether we already called. */
  private readonly since = new Map<string, { at: number; playedMs: number; notified: boolean }>();
  constructor(
    private readonly rooms: Pick<RoomRegistry, 'hostedRooms' | 'hostedTable' | 'clubOf'>,
    private readonly onWaiting: (userId: string, room: string, clubCode?: string) => void,
    private readonly opts: { now?: () => number; thresholdMs?: number } = {},
  ) {}

  tick(): void {
    const at = (this.opts.now ?? Date.now)();
    const threshold = this.opts.thresholdMs ?? 30_000;
    const live = new Set<string>();
    for (const room of this.rooms.hostedRooms()) {
      const host = this.rooms.hostedTable(room);
      if (!host) continue;
      const playing = host.phase === 'playing';
      for (const seat of host.seatInfo()) {
        if (seat.isBot || seat.connected || !seat.userId || seat.left) continue;
        const key = `${room}:${seat.userId}`;
        // Between hands the clock pauses (only time in play counts), but someone already being
        // watched stays watched: one notification per disconnection, not one per hand.
        const entry = this.since.get(key);
        if (!playing) {
          if (entry) {
            entry.at = at;
            live.add(key);
          }
          continue;
        }
        live.add(key);
        if (!entry) {
          this.since.set(key, { at, playedMs: 0, notified: false });
          continue;
        }
        entry.playedMs += Math.max(0, at - entry.at);
        entry.at = at;
        if (!entry.notified && entry.playedMs >= threshold) {
          entry.notified = true;
          this.onWaiting(seat.userId, room, this.rooms.clubOf(room));
        }
      }
    }
    // A player who came back (or whose table closed) starts afresh next time.
    for (const key of [...this.since.keys()]) if (!live.has(key)) this.since.delete(key);
  }
}
