/**
 * The game server as a value: `createSignalServer` wires the room registry, the clubs, the
 * HTTP API, the WebSocket relay and table persistence over the repositories it is given, and
 * listens on `port` (0 picks a free one). Nothing happens at import time; `main.ts` reads the
 * environment and calls it, and the tests call it directly.
 *
 * Boot order: load every club, restore every table that had not finished (players reclaim their
 * seats with their rejoin tokens), clear club listings whose table is gone, prune what is more
 * than a day old, then listen. `close()` writes every table one last time and stops without
 * finishing any of them, so the next process can restore them.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { WebSocketServer } from 'ws';
import { createApiHandler } from './api';
import type { ProviderConfig, SessionService } from './auth';
import { ClubRegistry, clubGate } from './clubs';
import { LIMITS, type SignalConfig } from './config';
import { BucketTable } from './limits';
import { TablePersister } from './persist';
import type { RepoHandle } from './repos';
import { RoomRegistry, type RoomEvent } from './rooms';
import { createSocketServer, type SocketLimits } from './sockets';

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
  log?: (line: string) => void;
}

export interface SignalServer {
  http: Server;
  wss: WebSocketServer;
  rooms: RoomRegistry;
  clubs: ClubRegistry;
  persister: TablePersister;
  api: ReturnType<typeof createApiHandler>;
  address(): { port: number };
  /** Write every table, stop accepting traffic and close every socket. Tables stay restorable. */
  close(): Promise<void>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export async function createSignalServer(opts: SignalServerOptions): Promise<SignalServer> {
  const { config, repos, sessions } = opts;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line: string) => console.log(line));

  const clubs = new ClubRegistry({ store: repos.repos.clubs, now });
  await clubs.load();
  const rooms = new RoomRegistry({
    allowHosted: config.hostTables,
    allowP2P: config.p2pRooms,
    maxHostedTables: config.maxHostedTables,
    now,
    botDelayMs: opts.botDelayMs,
    clubs: clubGate(clubs),
  });

  const persister = new TablePersister(rooms, repos.repos.tableSnapshots, { now, debounceMs: opts.persistDebounceMs, log });
  await persister.restore();
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

  const api = createApiHandler(
    { clubs, rooms, repos: repos.repos, sessions, providers: opts.providers, config, storage: repos.kind, healthy: repos.kind === 'pg' ? () => repos.healthy() : undefined, now },
    { corsOrigins: config.corsOrigins, limiter: new BucketTable<string>(LIMITS.httpBurst, LIMITS.httpPerSec, { now }), trustProxy: config.trustProxy },
  );

  const http = createServer((req, res) => {
    api(req, res)
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'not_found', message: 'No such route' }));
        }
      })
      .catch((e: Error) => {
        console.error('[signal] api error', e.message);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal', message: 'Internal error' }));
      });
  });
  // Frames over 64 KiB close the socket with 1009; a malformed frame closes it with 1002; a bad session 4401.
  const wss = createSocketServer(http, rooms, config, opts.socketLimits ?? LIMITS, { verify: async (token) => (await sessions.verify(token)).userId });

  const ticker = setInterval(() => {
    try {
      rooms.tick();
    } catch (e) {
      console.error('[signal] tick error', (e as Error).message);
    }
  }, 500);
  const pruner = setInterval(() => {
    clubs.pruneFinishedTables(now() - DAY_MS);
    persister.prune().catch((e: Error) => console.error('[signal] snapshot prune failed', e.message));
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
  const close = () =>
    (closing ??= (async () => {
      clearInterval(ticker);
      clearInterval(pruner);
      // Write the tables as they are, then stop every table without reporting it finished, so
      // club listings stay open and the next process restores them.
      await persister.flush();
      persister.stop();
      offRoomEvents();
      rooms.shutdown();
      for (const ws of wss.clients) ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await clubs.flush();
    })());

  return {
    http,
    wss,
    rooms,
    clubs,
    persister,
    api,
    address: () => ({ port: (http.address() as AddressInfo).port }),
    close,
  };
}
