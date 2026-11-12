/**
 * The number control of the rule editor: "−" and "+" stop at the limits (and are disabled there), holding one
 * repeats it (faster after a while, so a large value is reachable), and a typed number is taken when it is a
 * whole number, pulled inside the limits.
 */
export interface StepperLimits {
  min: number;
  max: number;
  step: number;
}

export function stepped(value: number, dir: -1 | 1, l: StepperLimits, multiplier = 1): number {
  return Math.max(l.min, Math.min(l.max, value + dir * l.step * multiplier));
}

export function atLimit(value: number, dir: -1 | 1, l: StepperLimits): boolean {
  return dir < 0 ? value <= l.min : value >= l.max;
}

/** Wait before a held button starts repeating, and the gap between repeats. */
export const HOLD_DELAY_MS = 400;
export const HOLD_REPEAT_MS = 90;

/** A held button steps by one for the first repeats, then by ten, then by a hundred steps at a time. */
export function holdMultiplier(repeats: number): number {
  return repeats < 15 ? 1 : repeats < 40 ? 10 : 100;
}

/** What the player typed, as a value inside the limits; null when it is not a whole number (the old value stays). */
export function typedValue(text: string, l: StepperLimits): number | null {
  const s = text.trim().replace(/[,\s]/g, '');
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? Math.max(l.min, Math.min(l.max, n)) : null;
}
