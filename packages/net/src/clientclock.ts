/**
 * Time on the table client: its own clock for its records (`clientClock`), the bounds it allows
 * the host's clock and the link (the link watch, `checkLink`; the order of frames; how late a frame
 * may reach this device, `LATE_MS`), and what it has learned of the host's clock (`ClockBase`): how
 * far ahead of the host's clock this device's is at the least (`offsetFloor`). Also the clocks a
 * host keeps time by, which never step back: `clientClock` by default, `steadyClock` on the server.
 */
import type { ClockAnchor, JournalEntry, PlayRecord, SeenState } from './clientrecords';

/** How long the watch's `pong` request may stay out, while the host's stamps keep falling behind, before `checkLink` calls the link silent. */
export const SILENT_ANSWER_MS = 5_000;
/** A gap between two `checkLink` calls longer than this means the app was not running. */
export const LINK_PAUSE_MS = 5_000;
/** How much earlier than a frame before it on the same link a frame may be stamped (see `noteOrder`). */
export const ORDER_SLACK_MS = 1_000;
/** Slack for the host's rounding of time banks to whole seconds. */
export const CLOCK_SLACK_MS = 1_000;
/** How far the host's clock may seem to gain on this device's after a fixed point between them (clock steps and drift). */
export const CLOCK_SKEW_MS = 5_000;
/**
 * How much later than the frames before it a frame may have been stamped, relative to when each
 * arrived: the swing in network delay an unbroken link can show (a longer stall trips the
 * heartbeat and the link is replaced).
 */
export const LATENCY_SLACK_MS = 30_000;
/**
 * How much later than the least arrival offset of its scope (`TableClient.lagRef`) a frame may reach
 * this device and still be believed to start the seat's clock at its stamp; later than that, the
 * table's move is judged as a drop (`judgeTableMove`). The watch drops a link whose stamps fall 13 s
 * behind its own reference (`2 × CLOCK_FRAME_MS + 2 s + SILENT_ANSWER_MS`; see `WATCH_WINDOW_MS`), or
 * measures afresh one it keeps because its frames still come behind a steady delay (`STEADY_SLACK_MS`),
 * and it checks once a second, so no honest frame on a live link is later than about 15.5 s (13 s, a
 * check period and `RAN_GAP_MS`) by that reference. A state that shows the seat a move and is later
 * than this by the watch's reference fails the hand when its link was live.
 */
export const LATE_MS = 17_000;
/**
 * How far back the link watch looks for its reference (`TableClient.watchRefAt`): the least arrival
 * offset of the stamped frames that arrived in this long, never less than the least offset of the
 * scope (`lagRef`). A network delay that rises and stays up is taken in once it has lasted this
 * long, so a link that has merely grown slower is not dropped over and over (its frames are still
 * measured against `lagRef` by the audit, and one more than `LATE_MS` late is noted as shown late).
 * Stamps that crawl or stand still leave each frame's offset larger than the last, so the least of
 * the last 20 s stays where the crawl began until the watch has dropped the link, 13 s in.
 */
export const WATCH_WINDOW_MS = 20_000;
/**
 * How far apart the arrival offsets of the frames of the last `2 × CLOCK_FRAME_MS + 2 s` may lie for
 * the link watch to count them as coming at the pace of their stamps, behind by a delay that holds
 * steady (`TableClient.steadyBehind`): a network delay that rose in a step and stayed up. The watch
 * keeps such a link while frames keep coming, as it would once its window has taken the delay in.
 * Stamps that crawl or stand still leave each frame's offset larger than the last by the time
 * between them, more than this within a few seconds.
 */
export const STEADY_SLACK_MS = 1_000;
/** How fast the host's clock and this device's may drift apart (500 ppm; real clocks drift 200 ppm at worst): a least offset seen a while ago is relaxed by this much, up to `DRIFT_CAP_MS`. */
export const DRIFT_RATE = 0.0005;
/**
 * The most a least arrival offset is relaxed for drift (`DRIFT_RATE`), however long ago it was seen.
 * Honest frames come back to within it of the least offset long before (at 200 ppm the clocks drift
 * this far in 40 minutes, and a frame near the least delay refreshes the reference), so a delay held
 * for hours cannot grow the `LATE_MS` a turn may be shown late by more than this.
 */
export const DRIFT_CAP_MS = 500;
/** A gap longer than this since this app last ran (handled a frame, checked the link, bound a link, sent a move) was a pause: the phone slept, or the app was in the background. */
export const RAN_GAP_MS = 1_500;
/** Frames handled within this long after a pause ended may have waited in the device through it: they may have arrived as early as it began (never before their link was bound). */
export const PAUSE_GRACE_MS = 2_000;
/**
 * What the uplink of a fixed point (a move or share this device sent) may have taken on an honest
 * link. A frame later than the fixed points allow by more than this and `LATE_MS` is noted as shown
 * late, never failed for that alone: a slow uplink looks the same from here (see `lateAnchor`; the
 * table's move it shows is then judged as a drop, which is red only when a whole clock cannot have
 * run out).
 */
export const RTT_ALLOW_MS = 4_000;
/** How much of the turn clock the state that starts a turn may already have used, by its own deadline and stamp: an honest host stamps it in the tick it arms the clock. */
export const ARM_SLACK_MS = 1_000;
/** The host rounds a time bank to whole seconds: a bank it states may be up to this much more than it holds. */
export const BANK_ROUND_MS = 500;
/**
 * Pings remembered until answered, by the `at` each carried (the oldest is dropped beyond this). The
 * client sends one a second while it holds a seat on a link that is up (`TableClient.checkLink`), and
 * one right after each join; the host answers each at once with its clock (`pong`).
 */
export const MAX_PINGS = 64;
/** A hand keeps one pong fixed point per this much of ping time: the one with the shortest round trip. */
export const PONG_WINDOW_MS = 10_000;
/** And at most this many (two hours of windows). */
export const MAX_PONGS = 720;
/** A hand in which this device sent this many pings and kept no answer is amber (`noAnswer`): nothing tied the table's clock to its own. */
export const NO_ANSWER_PINGS = 5;
/** A hand keeps the first ping of at most this many scopes (clock era of the host, run of this device's clock; `PlayRecord.pingedFrom`). */
export const MAX_PING_SCOPES = 16;
/** The round trip a pong measured is published (`ClientState.rttMs`) at most this often: each publication re-renders the table and saves the record. */
export const RTT_PUBLISH_MS = 10_000;
/** The stretches in which the app did not run that a client keeps for each run of the app (`TableClient.pauses`; saved with the record, `RunScope`). */
export const MAX_PAUSES = 16;
/** The runs of the app a client keeps what they carried for (`RunScope`, `TableClient.earlier`): those whose frames the hands on record hold, the latest this many. */
export const MAX_RUN_SCOPES = 32;
/**
 * A clock that starts at the wall time and then moves on by the monotonic clock alone: it ignores
 * steps of the wall clock both ways and never goes back. The signal server's tables keep time by it.
 */
export function steadyClock(wall: () => number = () => Date.now(), steady: () => number = () => performance.now()): () => number {
  const w0 = wall();
  const m0 = steady();
  return () => w0 + (steady() - m0);
}

/**
 * What this client knows of the host's clock in one clock era, as measured in one run of the app and
 * of this device's clock (`run`, `seg`; see `holdsIn`): the fixed points between the two clocks, and
 * the least offset any frame showed.
 */
export interface ClockBase {
  era: number;
  /** The run of the app it was measured in (absent in a record saved by an older build). */
  run?: string;
  /** The run of this device's clock it was measured in, or the latest of them. */
  seg?: number;
  anchor: number | null;
  minOffset: number | null;
}

/** Where a reading of this device's clock was made: the run of the app (`TableClient.runId`) and the run of its clock (`clientClock`'s segment). */
export interface ClockScope {
  run?: string;
  seg?: number;
}

/**
 * Whether what was measured between the two clocks in scope `from` holds for a reading made in scope
 * `at`. Only within one run of the app: a restart starts this device's clock afresh from its wall
 * clock, which may have been set anywhere while the app was closed, so a fixed point from before it
 * says nothing of the readings after it, nor these of those before. Within a run, from a run of this
 * device's clock to the same or a later one: a later one starts where the wall clock ran ahead of the
 * steady one (the phone slept, or its wall clock was set forward) and moves this device's clock on by
 * the wall clock, which leaves it no further behind the host's than the earlier one did (unless the
 * wall clock was also set back during a sleep, which this does not allow for). (Records saved by older
 * builds keep no run: those readings are compared only with each other.)
 */
export function holdsIn(from: ClockScope, at: ClockScope): boolean {
  return (from.run ?? null) === (at.run ?? null) && (from.seg ?? 0) <= (at.seg ?? 0);
}

export interface TableClientOptions {
  /** This device's wall clock (ms). Defaults to Date.now. */
  now?: () => number;
  /**
   * A clock that only moves forward at a steady rate (ms, any origin). Defaults to
   * `performance.now`, or to `now` when only `now` is given (so a test that injects one clock
   * drives both).
   */
  monotonic?: () => number;
  /**
   * The app's journal of moves, written before each move goes out: `act` files the move, hands this hook the move as filed
   * (`JournalEntry`), and sends it once the hook has returned, or once the promise it returns is fulfilled (on the link it
   * was filed for, if that link is still the one in use). A hook that throws, or whose promise is rejected, keeps the move
   * from going out, and the client takes it off its record. A client restored with the journal (`journal`) then holds every
   * move this device sent, so its ledger runs on across an app restart. Without a hook a client works as before.
   */
  writeAhead?: (entry: JournalEntry) => void | Promise<void>;
  /**
   * When a client is restored (`TableClient.restore`, `TableClient.fromArchive`) with `writeAhead`: what the app's journal
   * holds for the table, every entry handed to the hook since the record was written (more does no harm). The entries
   * the record holds (`SerializedClient.sentSeq` and before) may be dropped once that record is written.
   */
  journal?: readonly unknown[];
}

/** A wall clock that ran this much further than the monotonic one between two readings means the device slept. */
const SLEEP_GAP_MS = 1_000;

/**
 * The client's clock for its records. It starts at the wall time when the client is made (or
 * restored) and moves on by the monotonic clock, so a step of the device's wall clock (a manual
 * change, a network time correction, a time zone trip) moves no interval measured within one run of
 * the app: how long a link was down, how long a move took. A phone's monotonic clock can stand still
 * while the device sleeps (Android's does), and the wall clock counts that time: when the wall
 * clock has run more than a second further than the monotonic one since the last reading, the clock
 * moves on by the wall clock instead, so a phone that slept through a drop does not mistake an
 * honest timeout for an early one. The cost is that a wall clock stepped forward during a drop
 * lengthens that drop as the phone measures it; a server cannot cause that, and it can only turn a
 * failure into the amber "played while the connection was down", never into green. Only across an
 * app restart, where no monotonic clock survives, do the records meet wall time anew.
 *
 * Each time the clock follows the wall clock instead of the monotonic one, its `segment` counter
 * moves on (it starts at 0): a relation between this clock and the host's seen before then need not
 * hold after, so the table client keeps what it measures of the host's clock per segment. A clock
 * that is the injected `now` alone has no counter; it reads as 0.
 */
export function clientClock(opts: TableClientOptions = {}): () => number {
  const wall = opts.now ?? (() => Date.now());
  // A test that injects one clock drives everything with it, exactly.
  if (opts.now && !opts.monotonic) return wall;
  const steady = opts.monotonic ?? (typeof performance !== 'undefined' && typeof performance.now === 'function' ? () => performance.now() : null);
  if (!steady) return wall;
  let t = wall();
  let lastWall = t;
  let lastSteady = steady();
  const read = (() => {
    const w = wall();
    const m = steady();
    const dw = w - lastWall;
    const dm = m - lastSteady;
    lastWall = w;
    lastSteady = m;
    if (dw > dm + SLEEP_GAP_MS) {
      t += dw;
      read.segment++;
    } else t += Math.max(0, dm);
    return t;
  }) as (() => number) & { segment: number };
  read.segment = 0;
  return read;
}

/**
 * Keep what an audited hand showed about the host's clock in era `era` for the hands after it (see
 * `offsetFloor`), as it holds in `scope`, the run of the app and of this device's clock now: the base
 * to keep, a new one when the era moved on or the app restarted, else `clockBase` brought up to date.
 */
export function foldClock(clockBase: ClockBase, era: number, scope: ClockScope, play: PlayRecord | null, end: SeenState, anchors: ClockAnchor[]): ClockBase {
  const base: ClockBase = clockBase.era !== era || !holdsIn(clockBase, scope) ? { era, anchor: null, minOffset: null } : clockBase;
  base.run = scope.run;
  base.seg = scope.seg;
  for (const k of anchors) if (k.era === era && holdsIn(k, scope)) base.anchor = base.anchor === null ? k.at - k.now : Math.max(base.anchor, k.at - k.now);
  // (Not from a state restored damaged: its stamp may be anything, `cleanSeen`.)
  for (const f of [...(play?.seen ?? []), end]) {
    if ((f.era ?? 0) === era && typeof f.now === 'number' && f.kept !== false && holdsIn(f, scope)) base.minOffset = base.minOffset === null ? f.at - f.now : Math.min(base.minOffset, f.at - f.now);
  }
  return base;
}

/**
 * How far this device's clock is ahead of the host's in clock era `era`, at the least and less
 * the slack an honest table may need, for a reading of this device's clock made in scope `at`
 * (the frame it is compared with), or null when nothing is known. Two things bound it from
 * below. A fixed point: the host cannot have played a move before this device sent it, so the
 * stamp on the frame that shows the move is no earlier than the sending. And every frame up to
 * turn `n`: none arrived before it was stamped, and a frame is not stamped far later, relative
 * to its arrival, than the frames before it. Both hold for the whole era, across links and
 * hands, as long as the app runs (`holdsIn`): a new socket does not give the host's clock a
 * fresh allowance, but a restart of the app, after which this device's clock may read anything,
 * leaves it 30 s (`LATENCY_SLACK_MS`) until the next fixed point. With `at` null, what was measured
 * in every run counts, as though this device's clock had not been set in between.
 */
export function offsetFloor(clockBase: ClockBase, era: number, play: PlayRecord | null, n: number, anchors: ClockAnchor[], at: ClockScope | null): number | null {
  // (`at` null: whatever scope each was measured in, as if this device's clock had never been set.)
  const holds = (x: ClockScope) => at === null || holdsIn(x, at);
  const base = clockBase.era === era && holds(clockBase) ? clockBase : null;
  let anchor = base?.anchor ?? null;
  for (const k of anchors) if (k.era === era && holds(k)) anchor = anchor === null ? k.at - k.now : Math.max(anchor, k.at - k.now);
  let min = base?.minOffset ?? null;
  // (A state restored damaged counts too: what storage changed can lower the least offset, which only loosens the floor.)
  for (const f of play?.seen ?? []) {
    if ((f.era ?? 0) === era && f.tc <= n && typeof f.now === 'number' && holds(f)) min = min === null ? f.at - f.now : Math.min(min, f.at - f.now);
  }
  const viaAnchor = anchor === null ? null : anchor - CLOCK_SKEW_MS;
  const viaFrames = min === null ? null : min - LATENCY_SLACK_MS;
  if (viaAnchor === null || viaFrames === null) return viaAnchor ?? viaFrames;
  return Math.max(viaAnchor, viaFrames);
}

/**
 * What a fixed point says of this device's clock against the host's: how far ahead of the host's it
 * is at least. The host answered (with the deal, the frame that shows a move made, or a pong) after
 * this device sent at `k.at`, and stamped the answer `k.now`: by that stamp, at least `k.at - k.now`.
 * A host can move the stamp back, so the fixed point counts for no more than the round trip this
 * device measured allows: the answer reached it at `k.fat`, no frame of the scope came sooner after
 * its stamp than the least arrival offset `ref`, so the host's clock read at most `k.fat - ref` when
 * it answered, and this device's is at least `ref - (k.fat - k.at)` ahead. It counts for the smaller
 * of the two. A delay present since the scope began is in the round trip as well as in `ref`, so a
 * backdated answer cannot hide it; an honest answer counts for what its stamp says, less the time it
 * spent on the way back beyond the least.
 */
export function fixedPoint(k: Pick<ClockAnchor, 'at' | 'now' | 'fat'>, ref: number | null): number {
  const stamped = k.at - k.now;
  if (typeof k.fat !== 'number' || ref === null) return stamped;
  return Math.min(stamped, ref - (k.fat - k.at));
}

/** This seat's clock for the move it owes, on this device's clock: when the turn clock ends, and when the time bank after it does. */
export interface OwnClock {
  turnEnd: number;
  bankEnd: number;
}

/** The host's clock era, the run of the app and the run of this device's clock a reading is made in: what a fixed point must share with it to place the host's clock on it. */
export interface OwnScope {
  era: number;
  run: string;
  seg: number;
}

/**
 * The clock the app shows for the move the seat owes (`TableClient.ownClock`): the clock the audit
 * holds the table to, counted by this device itself. `end` is when the seat's time runs out on the
 * host's clock, the end the audit holds the table to (`streakEnd`: the rules' clock as this device
 * tracks it, or a later end a state of the streak claimed, each stated bank less the host's rounding,
 * `BANK_ROUND_MS`). `streak` holds the states that showed the seat the move, the first (`r0`) first
 * (`ownRun`); the turn clock ends at the latest deadline one of them gives before the bank (for a
 * state already in the bank, its stamp), never after `end`. So the bank follows the turn clock without
 * waiting for the state that says it has started. Only states of the latest one's clock era count.
 *
 * Those ends are placed on this device's clock by the strongest fixed point of the scope `at` is read
 * in (`points`: the hand's pongs and its deal; `best`: the strongest one carried from the hands before:
 * the same fixed points the audit measures the turns against, `PongClock`), each worth
 * what its round trip allows against `ref`, the least arrival offset now (`fixedPoint`), less the drift
 * since it was made; never later than the first state of the streak this device's clock can place,
 * counted from its arrival (by its own stamp), nor than the least arrival offset of the scope now
 * (`ref`); with no fixed point, by the smaller of those two. Null when the seat owes no move with a
 * clock, or nothing places the host's clock on this device's.
 */
export function ownClockFrom(streak: SeenState[], end: number, points: ClockAnchor[], best: { era: number; run: string; seg: number; value: number; at: number; rtt?: number } | null, ref: number | null, at: number, scope: OwnScope): OwnClock | null {
  const era = streak.length > 0 ? (streak[streak.length - 1].era ?? 0) : 0;
  let turnEnd = Number.NEGATIVE_INFINITY;
  let clocked = false;
  for (const f of streak) {
    if ((f.era ?? 0) !== era || f.deadline === null || !Number.isFinite(f.deadline)) continue;
    clocked = true;
    if (!f.inBank) turnEnd = Math.max(turnEnd, f.deadline);
    else if (typeof f.now === 'number') turnEnd = Math.max(turnEnd, f.now);
  }
  if (!clocked || !Number.isFinite(end)) return null;
  const bankEnd = end;
  // (A state in the bank says the turn clock is over: never later than the bank's end.)
  turnEnd = Number.isFinite(turnEnd) ? Math.min(turnEnd, bankEnd) : bankEnd;
  const inScope = (x: { era?: number; run?: string; seg?: number }) => (x.era ?? 0) === scope.era && x.run === scope.run && (x.seg ?? 0) === scope.seg;
  let offset = Number.NEGATIVE_INFINITY;
  for (const k of points) if (inScope(k)) offset = Math.max(offset, fixedPoint(k, ref) - DRIFT_RATE * Math.max(0, at - k.at));
  if (best && best.era === scope.era && best.run === scope.run && best.seg === scope.seg) {
    const value = typeof best.rtt === 'number' && ref !== null ? Math.min(best.value, ref - best.rtt) : best.value;
    offset = Math.max(offset, value - DRIFT_RATE * Math.max(0, at - best.at));
  }
  const first = streak.find((f) => typeof f.now === 'number' && inScope(f));
  const own = first ? (first.atLo ?? first.at) - (first.now as number) : null;
  // Never later than the first state allows counted from its arrival, nor than the least arrival offset of the
  // scope (`ref`, what the audit measures a state's lateness against when no fixed point bounds it, `lateRef`):
  // a state held on its way, with no answered ping since a resume or a sleep, cannot buy the screen time.
  let placed: number | null = Number.isFinite(offset) ? offset : null;
  for (const x of [own, ref]) if (x !== null) placed = placed === null ? x : Math.min(placed, x);
  if (placed === null) return null;
  const out = { turnEnd: turnEnd + placed, bankEnd: bankEnd + placed };
  return Number.isFinite(out.turnEnd) && Number.isFinite(out.bankEnd) ? out : null;
}
