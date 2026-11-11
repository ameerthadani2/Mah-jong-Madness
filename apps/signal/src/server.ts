/**
 * The game server as a value: `createSignalServer` wires the room registry, the clubs, the
 * HTTP API, the WebSocket relay and table persistence over the repositories it is given, and
 * listens on `port` (0 picks a free one). Nothing happens at import time; `main.ts` reads the
 * environment and calls it, and the tests call it directly.
 *
 * Boot order: take the host lock (with Postgres: only one process may host a database's tables),
 * load every club, restore every table that had not finished (players reclaim their seats with
 * their rejoin tokens), clear club listings whose table is gone, prune what is more than a day
 * old, then listen. `close()` writes every table one last time and stops without finishing any of
 * them, so the next process can restore them, then gives the host lock up.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocketServer } from 'ws';
import { createApiHandler } from './api';
import type { HostLock } from './db';
import { AuthError, purgeDeletedUsers, type ProviderConfig, type SessionService } from './auth';
import { ClubRegistry, clubGate } from './clubs';
import { LIMITS, type SignalConfig } from './config';
import { BucketTable } from './limits';
import { blockedEitherWay, fillMsFromEnv, Matchmaker, quickMatchCheck } from './matchmaking';
import { LatencyWindow } from './metrics';
import { MuteList } from './moderation';
import { NO_ANALYTICS, reportError, withConsent, type Analytics } from './observability';
import { TablePersister } from './persist';
import { PushService, SeatWatcher } from './push';
import type { RepoHandle } from './repos';
import { EmotePackOwners, RoomRegistry, type RoomEvent } from './rooms';
import { createSocketServer, VerifyUnavailable, type SocketLimits } from './sockets';
import { WalletService } from './wallet';
import { Reconciler, revenueCatClientFromEnv, startReconcileJob } from './reconcile';

export interface SignalServerOptions {
  /** TCP port for HTTP and WebSocket traffic; 0 picks a free port (see `address()`). */
  port: number;
  /** Interface to bind (default: all). */
  host?: string;
  repos: RepoHandle;
  sessions: SessionService;
  providers: ProviderConfig;
  config: SignalConfig;
  now?: () => number;
  /** Delay before a bot acts at a hosted table (default 600 ms). */
  botDelayMs?: number;
  /** Quiet period before a changed table is written (default 500 ms). */
  persistDebounceMs?: number;
  /** Socket limits (default `LIMITS`). */
  socketLimits?: SocketLimits;
  /** How long a quick-match group short of four waits for bots (default QUICK_MATCH_FILL_MS, else 20 s). */
  quickMatchFillMs?: number;
  /** How long a quick-match table waits for its players before starting with bots (default 15 s). */
  quickStartMs?: number;
  /** The moderators' token (default ADMIN_TOKEN from the environment). */
  adminToken?: string | null;
  log?: (line: string) => void;
  /** Push notifications (default: off). */
  push?: PushService;
  /** Server-side product analytics (default: none). */
  analytics?: Analytics;
  /** How long a seated human may be disconnected mid-hand before "your table is waiting" (default 30 s). */
  tableWaitingMs?: number;
  /** Longest `close()` may take before it stops waiting for writes and drops every connection (default 20 s). */
  closeDeadlineMs?: number;
  /**
   * The single-host lease (main.ts passes one for Postgres; memory repositories need none). It is
   * taken before anything is loaded, so a second process waits (and then fails to start) instead
   * of restoring a second copy of every table.
   */
  hostLock?: HostLock;
  /**
   * Called after the host lock was lost and the server has closed (rooms frozen, tables written
   * as far as possible). main.ts exits 1 so the platform restarts the machine.
   */
  onHostLockLost?: (e: Error) => void;
}

export interface SignalServer {
  http: Server;
  wss: WebSocketServer;
  rooms: RoomRegistry;
  clubs: ClubRegistry;
  /** The quick-match queue. */
  matchmaker: Matchmaker;
  /** Accounts muted by a moderator (their chat and emotes are dropped at every table). */
  mutes: MuteList;
  persister: TablePersister;
  push: PushService;
  /** Action-to-state latency of hosted tables (on `/health`). */
  actionLatency: LatencyWindow;
  api: ReturnType<typeof createApiHandler>;
  address(): { port: number };
  /**
   * Stop accepting HTTP requests and socket upgrades, write every table, close every socket.
   * Tables stay restorable. Never takes longer than `closeDeadlineMs`, even with a hung database.
   */
  close(): Promise<void>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Default `closeDeadlineMs`: inside Fly's 30 s kill_timeout, with room for the process to exit. */
const CLOSE_DEADLINE_MS = 20_000;

export async function createSignalServer(opts: SignalServerOptions): Promise<SignalServer> {
  const { config, repos, sessions } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));
  // Before anything is read: another process that still hosts these tables must stop first.
  if (opts.hostLock) await opts.hostLock.acquire();
  /** Set when `close()` begins: new requests and upgrades are refused, `/health` answers 503. */
  let draining = false;

  const clubs = new ClubRegistry({ store: repos.repos.clubs, now });
  try {
    await clubs.load();
  } catch (e) {
    await opts.hostLock?.release();
    throw e;
  }
  const actionLatency = new LatencyWindow({ now });
  const push = opts.push ?? new PushService({ devices: repos.repos.devices, client: null, now, log });
  const analytics = opts.analytics ?? NO_ANALYTICS;
  const mutes = new MuteList(now);
  await mutes.load(repos.repos).catch((e: Error) => console.error('[signal] mutes not loaded', e.message));
  const matchmaker: Matchmaker = new Matchmaker({
    now,
    fillMs: opts.quickMatchFillMs ?? config.quickMatchFillMs ?? fillMsFromEnv(process.env),
    check: (userId) => quickMatchCheck(repos.repos, userId, now()),
    avoid: (userId) => blockedEitherWay(repos.repos, userId),
    // Declared below; the queue only opens tables once the server is up.
    openTable: (userIds): string => rooms.createQuickMatchRoom(userIds, { startAfterMs: opts.quickStartMs }),
    // One quick-match table per account at a time, each charged to its players like a table they created.
    seatedAt: (userId): string | undefined => rooms.quickTableOf(userId),
    charge: (peerIds): string[] => rooms.chargeQuickMatch(peerIds),
    log,
  });
  const rooms: RoomRegistry = new RoomRegistry({
    queue: matchmaker,
    isMuted: (userId) => mutes.isMuted(userId),
    // A paid emote is relayed only for an account that owns its pack (the wallet is declared below; nothing asks before the server is up).
    emotePacks: new EmotePackOwners((userId) => wallet.summary(userId).then((w) => w.cosmetics), { now }),
    actionLatency,
    allowHosted: config.hostTables,
    allowP2P: config.p2pRooms,
    maxHostedTables: config.maxHostedTables,
    maxTablesPerUser: config.maxTablesPerUser,
    now,
    botDelayMs: opts.botDelayMs,
    clubs: clubGate(clubs),
  });

  const persister = new TablePersister(rooms, repos.repos.tableSnapshots, { now, debounceMs: opts.persistDebounceMs, log });
  try {
    await persister.restore();
  } catch (e) {
    await opts.hostLock?.release();
    throw e;
  }
  persister.start();
  clubs.reconcileTables((code) => rooms.hasRoom(code));
  await persister.prune().catch((e: Error) => console.error('[signal] snapshot prune failed', e.message));

  // Keep club table listings in step with the hosted tables and add results to the standings;
  // record every finished match.
  const recorded = new Set<string>();
  const onRoomEvent = ({ room, event }: RoomEvent) => {
    clubs.applyRoomEvent(room, event);
    if (event.type !== 'match_over' || event.handNumber < 0 || recorded.has(event.matchId)) return;
    recorded.add(event.matchId);
    const host = rooms.hostedTable(room);
    void repos.repos.matchResults
      .record({
        roomCode: room,
        clubCode: rooms.clubOf(room) ?? null,
        handCount: host?.audits.length ?? event.handNumber,
        scores: event.scores.slice(),
        players: event.seats.map((s) => ({ seat: s.seat, name: s.name, userId: s.userId ?? null, isBot: s.isBot })),
        handsWon: event.handsWon.slice(),
        finishedAt: now(),
      })
      .catch((e: Error) => console.error(`[signal] match result for ${room} not saved:`, e.message));
  };
  const offRoomEvents = rooms.onRoomEvent(onRoomEvent);

  // Push: club tables opened and join requests approved; "your table is waiting" from the tick.
  const offClubEvents = clubs.onEvent((ev) => void push.onClubEvent(ev));
  const seats = new SeatWatcher(rooms, (userId, room, club) => void push.tableWaiting(userId, room, club), { now, thresholdMs: opts.tableWaitingMs });

  // One wallet for the API and the nightly store reconciliation, so both serialise on the same per-account lock.
  const wallet = new WalletService(repos.repos, { now, analytics: withConsent(analytics, (id) => repos.repos.users.getAnalyticsConsent(id)) });
  const stopReconcile = startReconcileJob(new Reconciler({ repos: repos.repos, wallet, client: revenueCatClientFromEnv(process.env), now, log }), { log });

  const api = createApiHandler(
    {
      clubs,
      rooms,
      repos: repos.repos,
      sessions,
      providers: opts.providers,
      config,
      storage: repos.kind,
      healthy: repos.kind === 'pg' ? () => repos.healthy() : undefined,
      draining: () => draining,
      now,
      push,
      analytics,
      wallet,
      actionLatency,
      mutes,
      matchmaker,
      ...(opts.adminToken !== undefined ? { adminToken: opts.adminToken } : {}),
    },
    { corsOrigins: config.corsOrigins, limiter: new BucketTable<string>(LIMITS.httpBurst, LIMITS.httpPerSec, { now }), trustProxy: config.trustProxy },
  );

  const http = createServer((req, res) => {
    if (draining && !(req.url ?? '').startsWith('/health')) {
      res.writeHead(503, { 'content-type': 'application/json', connection: 'close', 'retry-after': '5' });
      res.end(JSON.stringify({ error: 'unavailable', message: 'The server is restarting; please try again in a moment' }));
      return;
    }
    api(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found', message: 'No such route' }));
        }
      })
      .catch((e: Error) => {
        console.error('[signal] api error', e.message);
        reportError(e, { where: 'http' });
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal', message: 'Internal error' }));
      });
  });
  // Frames over 64 KiB close the socket with 1009; a malformed frame closes it with 1002; a bad session 4401.
  const wss = createSocketServer(
    http,
    rooms,
    config,
    opts.socketLimits ?? LIMITS,
    {
      verify: async (token) => {
        try {
          const s = await sessions.verify(token);
          // The seat name comes from the account, not from what the client writes in its table join.
          const user = await repos.repos.users.get(s.userId);
          return { userId: s.userId, sessionId: s.sessionId, name: user?.displayName };
        } catch (e) {
          // A bad token is the player's to fix; a database that did not answer is not.
          if (e instanceof AuthError) throw e;
          throw new VerifyUnavailable((e as Error).message);
        }
      },
    },
    () => !draining,
  );

  const ticker = setInterval(() => {
    try {
      rooms.tick();
      matchmaker.tick();
      seats.tick();
    } catch (e) {
      console.error('[signal] tick error', (e as Error).message);
      reportError(e, { where: 'tick' });
    }
  }, 500);
  // Expo keeps receipts for a day and suggests reading them about 15 minutes after sending.
  const receipts = setInterval(() => void push.checkReceipts(), 15 * 60_000);
  receipts.unref();
  const pruner = setInterval(() => {
    clubs.pruneFinishedTables(now() - DAY_MS);
    // Join requests nobody answered in 30 days.
    clubs.expirePending();
    persister.prune().catch((e: Error) => console.error('[signal] snapshot prune failed', e.message));
    // The hard delete promised at soft deletion (30 days), and sessions that have ended.
    // The clubs in memory still hold the purged accounts' rows: drop them before the next club write.
    purgeDeletedUsers(repos.repos, { now })
      .then(({ users, sessions: ended, userIds }) => {
        clubs.dropPurged(userIds);
        if (users || ended) log(`[signal] purged ${users} deleted account(s) and ${ended} ended session(s)`);
      })
      .catch((e: Error) => console.error('[signal] account purge failed', e.message));
  }, HOUR_MS);
  ticker.unref();
  pruner.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    http.once('error', onError);
    http.listen(opts.port, opts.host, () => {
      http.off('error', onError);
      resolve();
    });
  });
  // After listening, an HTTP server error is logged; a client can never bring the process down.
  http.on('error', (e: Error) => console.error('[signal] http server error', e.message));

  let closing: Promise<void> | null = null;
  const deadlineMs = opts.closeDeadlineMs ?? CLOSE_DEADLINE_MS;
  const close = () =>
    (closing ??= (async () => {
      // First stop taking new work: no new connections, upgrades or requests (they get 503).
      draining = true;
      const httpClosed = new Promise<void>((resolve) => http.close(() => resolve()));
      clearInterval(ticker);
      clearInterval(pruner);
      clearInterval(receipts);
      stopReconcile();
      offClubEvents();
      // Stop taking game input next: a move that arrived during the final write would be
      // acknowledged to its player but missing from the snapshot the next process restores.
      // Then write the tables as they are and stop every table without reporting it finished,
      // so club listings stay open and the next process restores them.
      rooms.freeze();
      const writes = (async () => {
        await persister.flush();
        await clubs.flush();
      })().catch((e: Error) => console.error('[signal] final write failed', e.message));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), deadlineMs);
      });
      if ((await Promise.race([writes.then(() => 'done' as const), deadline])) === 'late') {
        console.error(`[signal] shutdown deadline (${deadlineMs} ms) reached before every table was written; closing anyway`);
      }
      clearTimeout(timer);
      persister.stop();
      offRoomEvents();
      rooms.shutdown();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await httpClosed;
      // Last: the next process may restore the tables only once they are written.
      await opts.hostLock?.release();
    })());
  // Losing the lease means another process may already be hosting these tables: stop taking
  // input, write what can be written, and stop so the platform restarts this machine.
  opts.hostLock?.onLost((e) => {
    console.error(`[signal] lost the host lock (${e.message}); freezing the tables and shutting down`);
    reportError(e, { where: 'host-lock' });
    void close().finally(() => opts.onHostLockLost?.(e));
  });

  return {
    http,
    wss,
    rooms,
    clubs,
    matchmaker,
    mutes,
    persister,
    push,
    actionLatency,
    api,
    address: () => ({ port: (http.address() as AddressInfo).port }),
    close,
  };
}
