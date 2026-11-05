import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createApiHandler } from './api';
import { ClubRegistry, type ClubData, type ClubStore } from './clubs';
import { LIMITS, loadConfig } from './config';
import { BucketTable } from './limits';
import { RoomRegistry } from './rooms';
import { createSocketServer } from './sockets';

const config = loadConfig();

/**
 * Persistence to a JSON file; replace it with a database once clubs outgrow a single node.
 * Writes are atomic (temp file then rename). A corrupt file is moved aside rather
 * than silently replaced by an empty registry.
 */
function fileStore(path: string): ClubStore {
  return {
    load: () => {
      if (!existsSync(path)) return { clubs: [], credentials: {} };
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as ClubData | unknown[];
        if (Array.isArray(parsed)) return { clubs: parsed as ClubData['clubs'], credentials: {} }; // legacy shape
        return { clubs: parsed.clubs ?? [], credentials: parsed.credentials ?? {} };
      } catch (e) {
        const backup = `${path}.corrupt-${Date.now()}`;
        renameSync(path, backup);
        console.error(`[signal] club store unreadable (${(e as Error).message}); moved to ${backup}`);
        return { clubs: [], credentials: {} };
      }
    },
    save: (data) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, path);
    },
  };
}

const rooms = new RoomRegistry({ allowHosted: config.hostTables, allowP2P: config.p2pRooms, maxHostedTables: config.maxHostedTables });
const clubs = new ClubRegistry({ store: fileStore(join(config.dataDir, 'clubs.json')) });
const httpLimiter = new BucketTable<string>(LIMITS.httpBurst, LIMITS.httpPerSec);
const api = createApiHandler({ clubs, rooms }, { corsOrigins: config.corsOrigins, limiter: httpLimiter, trustProxy: config.trustProxy });

// Keep club table listings in step with the hosted tables, and add results to the standings.
rooms.onRoomEvent(({ room, event }) => clubs.applyRoomEvent(room, event));

const http = createServer((req, res) => {
  api(req, res)
    .then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      }
    })
    .catch((e: Error) => {
      console.error('[signal] api error', e.message);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    });
});

// A failure to listen (port in use, no permission) is fatal; anything else a client does is not.
http.on('error', (e: Error) => {
  console.error('[signal] http server error', e.message);
  if (!http.listening) process.exit(1);
});
// Frames over 64 KiB close the socket with 1009; a malformed frame closes it with 1002.
createSocketServer(http, rooms, config);

setInterval(() => {
  try {
    rooms.tick();
  } catch (e) {
    console.error('[signal] tick error', (e as Error).message);
  }
}, 500);

http.listen(config.port, () => {
  console.log(
    `[signal] listening on :${config.port} (hosted tables ${config.hostTables ? `enabled, up to ${config.maxHostedTables}` : 'disabled'}, relay-only rooms ${config.p2pRooms ? 'enabled' : 'disabled'}, CORS ${config.corsOrigins.length ? config.corsOrigins.join(' ') : 'same origin only'}, data in ${config.dataDir})`,
  );
});
