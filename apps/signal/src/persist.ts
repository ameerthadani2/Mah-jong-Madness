/**
 * Table persistence: every server-hosted table is written to `table_snapshots` as it changes, so
 * a restart or a deploy resumes it where it was and players reclaim their seats with their
 * rejoin tokens.
 *
 * Writes are debounced per table (500 ms by default) because a hand changes state on every move;
 * the end of a hand and the end of a match are written at once. Writes for one table run in
 * order, each taking the table as it is when the write runs, so a burst of changes is one write.
 * `flush()` writes everything pending (SIGTERM, `close()`).
 *
 * At boot `restore()` reopens every snapshot that has not finished; finished snapshots are pruned
 * once they are a day old.
 */
import type { SerializedHost, TableHost } from '@mjm/net';
import type { TableSnapshotsRepo, TableStatus } from './repos/types';
import type { RoomRegistry } from './rooms';

const DAY_MS = 86_400_000;

export interface TablePersisterOptions {
  /** Quiet period before a changed table is written (default 500 ms). */
  debounceMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

/** The snapshot status for a table: 'open' until its first deal, 'finished' once the match is over. */
export function tableStatus(host: TableHost): TableStatus {
  if (host.phase === 'match_over') return 'finished';
  if (host.phase === 'lobby' && host.match().handNumber === 0 && host.audits.length === 0) return 'open';
  return 'playing';
}

interface Tracked {
  host: TableHost;
  clubCode: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Write chain for this table. */
  chain: Promise<void>;
  /** A write is queued that has not started yet. */
  queued: boolean;
  /** The room has closed; the next write marks the snapshot finished and forgets the table. */
  closed: boolean;
}

export class TablePersister {
  private readonly tables = new Map<string, Tracked>();
  private readonly unsubs: Array<() => void> = [];
  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private stopped = false;
  /** Number of snapshot writes that reached the store (tests). */
  writes = 0;

  constructor(
    private readonly rooms: RoomRegistry,
    private readonly repo: TableSnapshotsRepo,
    opts: TablePersisterOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 500;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => console.log(line));
  }

  /** Start following the registry's hosted tables. */
  start(): void {
    this.unsubs.push(
      this.rooms.onTableChange((code) => this.schedule(code, false)),
      this.rooms.onRoomEvent(({ room, event }) => {
        if (event.type === 'match_over' && event.handNumber < 0) this.closed(room);
        else this.schedule(room, event.type === 'hand_over' || event.type === 'match_over');
      }),
    );
  }

  /** Stop following the registry. Pending debounced writes are dropped unless `flush()` ran first. */
  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs.splice(0)) u();
    for (const t of this.tables.values()) if (t.timer) clearTimeout(t.timer);
  }

  private track(code: string): Tracked | undefined {
    let t = this.tables.get(code);
    if (!t) {
      const host = this.rooms.hostedTable(code);
      if (!host) return undefined;
      t = { host, clubCode: this.rooms.clubOf(code) ?? null, timer: null, chain: Promise.resolve(), queued: false, closed: false };
      this.tables.set(code, t);
    }
    return t;
  }

  private schedule(code: string, immediate: boolean): void {
    if (this.stopped) return;
    const t = this.track(code);
    if (!t) return;
    if (immediate) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      this.enqueue(code, t);
      return;
    }
    if (t.timer) return;
    t.timer = setTimeout(() => {
      t.timer = null;
      this.enqueue(code, t);
    }, this.debounceMs);
  }

  /** The room closed (abandoned past its keep-alive, or every player left): write it as finished so it is never restored. */
  private closed(code: string): void {
    if (this.stopped) return;
    const t = this.tables.get(code);
    if (!t) {
      // Never changed since it was written (or restored): mark the stored snapshot finished as it is.
      void this.repo
        .get(code)
        .then((s) => (s && s.status !== 'finished' ? this.repo.save({ ...s, status: 'finished', updatedAt: this.now() }) : undefined))
        .catch((e: Error) => console.error(`[signal] table ${code} snapshot not closed:`, e.message));
      return;
    }
    t.closed = true;
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    this.enqueue(code, t);
  }

  private enqueue(code: string, t: Tracked): Promise<void> {
    if (t.queued) return t.chain;
    t.queued = true;
    t.chain = t.chain
      .then(async () => {
        t.queued = false;
        const snapshot = t.host.serialize();
        await this.repo.save({ roomCode: code, clubCode: t.clubCode, status: t.closed ? 'finished' : tableStatus(t.host), snapshot, updatedAt: this.now() });
        this.writes++;
        if (t.closed && this.tables.get(code) === t && !t.queued) this.tables.delete(code);
      })
      .catch((e: Error) => console.error(`[signal] table ${code} snapshot not saved:`, e.message));
    return t.chain;
  }

  /** Write every hosted table now (including ones with nothing pending) and wait for all writes. */
  async flush(): Promise<void> {
    for (const code of this.rooms.hostedRooms()) this.track(code);
    const pending: Promise<void>[] = [];
    for (const [code, t] of this.tables) {
      if (t.timer) clearTimeout(t.timer);
      t.timer = null;
      pending.push(this.enqueue(code, t));
    }
    await Promise.all(pending);
  }

  /**
   * Reopen every table that had not finished. A snapshot that cannot be restored (malformed, an
   * unknown version, or the server is full) is logged and marked finished, so it is not retried
   * at every boot. Returns the codes restored.
   */
  async restore(): Promise<string[]> {
    const restored: string[] = [];
    for (const s of await this.repo.listActive()) {
      try {
        const code = this.rooms.createHostedRoom({ restore: s.snapshot as SerializedHost, clubCode: s.clubCode ?? undefined });
        this.track(code);
        restored.push(code);
      } catch (e) {
        this.log(`[signal] table ${s.roomCode} could not be restored (${(e as Error).message}); marking it finished`);
        await this.repo.save({ ...s, status: 'finished', updatedAt: this.now() });
      }
    }
    if (restored.length) this.log(`[signal] restored ${restored.length} table(s): ${restored.join(' ')}`);
    return restored;
  }

  /** Remove finished snapshots older than a day. */
  prune(): Promise<number> {
    return this.repo.pruneFinished(this.now() - DAY_MS);
  }
}
