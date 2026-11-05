/** Timing for the table's motion and call-outs. Pure, so the feel is tunable and testable in one place. */
import type { CallKind } from '../../audio/cues';

/** How long a call-out banner stays up. 胡 and 自摸 hold until the result sheet replaces them. */
export function calloutMs(call: CallKind): number {
  return call === 'hu' || call === 'selfdraw' ? RESULT_HOLD_MS.win : 1100;
}

/** The pause between the hand ending and the result sheet: the winner's hand is shown face up meanwhile. */
export const RESULT_HOLD_MS = { win: 2200, draw: 700 } as const;

/** Stagger between tiles flipping face up in the winner's reveal. */
export const FLIP_STAGGER_MS = 45;
export const FLIP_HALF_MS = 90;
export const DISCARD_SLIDE_MS = 190;

/**
 * Counter roll-up (台 and score changes on the result sheet): eased value at `elapsed` ms of `duration`.
 * Starts at 0, never overshoots, lands exactly on `target`, and works for negative targets.
 */
export function rollUp(target: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return target;
  if (elapsed <= 0) return 0;
  const p = elapsed / duration;
  const eased = 1 - Math.pow(1 - p, 3);
  return Math.trunc(target * eased);
}

/** Roll-up duration: longer for bigger numbers, capped so the sheet never feels slow. */
export function rollUpMs(target: number): number {
  return Math.min(900, 250 + Math.abs(target) * 40);
}

/** Where a new discard slides in from, for the seat `rel` places clockwise from me (0 = me). */
export function slideFrom(rel: number, distance = 26): { x: number; y: number } {
  switch (((rel % 4) + 4) % 4) {
    case 0:
      return { x: 0, y: distance };
    case 1:
      return { x: distance, y: 0 };
    case 2:
      return { x: 0, y: -distance };
    default:
      return { x: -distance, y: 0 };
  }
}
