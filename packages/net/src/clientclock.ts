/**
 * Time on the table client: its own clock for its records (`clientClock`), the bounds it allows
 * the host's clock and the link (the link watch, `checkLink`, and the order of frames), and what
 * it has learned of the host's clock (`ClockBase`): how far ahead of the host's clock this
 * device's is at the least (`offsetFloor`).
 */
import type { ClockAnchor, PlayRecord, SeenState } from './clientrecords';

/** How long `checkLink` waits for any frame after it asked for a `pong`, before it calls the link silent. */
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

/** What this client knows of the host's clock in one clock era: the fixed points between the two clocks, and the least offset any frame showed. */
export interface ClockBase {
  era: number;
  anchor: number | null;
  minOffset: number | null;
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
  return () => {
    const w = wall();
    const m = steady();
    const dw = w - lastWall;
    const dm = m - lastSteady;
    lastWall = w;
    lastSteady = m;
    t += dw > dm + SLEEP_GAP_MS ? dw : Math.max(0, dm);
    return t;
  };
}

/**
 * Keep what an audited hand showed about the host's clock in era `era` for the hands after it (see
 * `offsetFloor`): the base to keep, a new one when the era moved on, else `clockBase` brought up to date.
 */
export function foldClock(clockBase: ClockBase, era: number, play: PlayRecord | null, end: SeenState, anchors: ClockAnchor[]): ClockBase {
  const base: ClockBase = clockBase.era !== era ? { era, anchor: null, minOffset: null } : clockBase;
  for (const k of anchors) if (k.era === era) base.anchor = base.anchor === null ? k.at - k.now : Math.max(base.anchor, k.at - k.now);
  for (const f of [...(play?.seen ?? []), end]) {
    if ((f.era ?? 0) === era && typeof f.now === 'number') base.minOffset = base.minOffset === null ? f.at - f.now : Math.min(base.minOffset, f.at - f.now);
  }
  return base;
}

/**
 * How far this device's clock is ahead of the host's in clock era `era`, at the least and less
 * the slack an honest table may need, or null when nothing is known. Two things bound it from
 * below. A fixed point: the host cannot have played a move before this device sent it, so the
 * stamp on the frame that shows the move is no earlier than the sending. And every frame up to
 * turn `n`: none arrived before it was stamped, and a frame is not stamped far later, relative
 * to its arrival, than the frames before it. Both hold for the whole era, across links and
 * hands: a new socket does not give the host's clock a fresh allowance.
 */
export function offsetFloor(clockBase: ClockBase, era: number, play: PlayRecord | null, n: number, anchors: ClockAnchor[]): number | null {
  const base = clockBase.era === era ? clockBase : null;
  let anchor = base?.anchor ?? null;
  for (const k of anchors) if (k.era === era) anchor = anchor === null ? k.at - k.now : Math.max(anchor, k.at - k.now);
  let min = base?.minOffset ?? null;
  for (const f of play?.seen ?? []) {
    if ((f.era ?? 0) === era && f.tc <= n && typeof f.now === 'number') min = min === null ? f.at - f.now : Math.min(min, f.at - f.now);
  }
  const viaAnchor = anchor === null ? null : anchor - CLOCK_SKEW_MS;
  const viaFrames = min === null ? null : min - LATENCY_SLACK_MS;
  if (viaAnchor === null || viaFrames === null) return viaAnchor ?? viaFrames;
  return Math.max(viaAnchor, viaFrames);
}
