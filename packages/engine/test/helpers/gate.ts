/**
 * The rules of the bot strength gate (`npm run sim -- --gate`, `scripts/simulate.ts`).
 *
 * The gate plays fixed seeds, so two runs of the same code give the same score on every hand:
 * there is no sampling noise between a run and its stored reference. A floor of "two standard
 * errors below the reference" (about 8 points a hand over 2,000 hands) therefore let almost any
 * change through. The gate compares hand by hand instead and allows a drop of `GATE_MAX_DROP`
 * points a hand, which is room for an intended small change and nothing more.
 *
 * Two series are kept, each one number per hand, for one test seat that rotates with the seed:
 *  - `proVsClub`: the seat's score with Pro there minus its score with Club there, three Club
 *    bots in the other seats both times.
 *  - `termsVsBare`: the seat's score with Pro there minus its score with Pro there and
 *    `PRO_TERMS_OFF` applied (Pro without its deal-in and 台 terms), three Club bots in the other
 *    seats both times. This is the check that shows a model which adds nothing.
 *
 * Regenerate after an intentional change to Pro or Club: `npm run sim -- --gate --record`.
 */
import type { BOT_WEIGHTS } from '../../src/index';

/** Hands the gate plays (seed prefix `gate`, test seat `hand % 4`). */
export const GATE_HANDS = 2000;
/** The gate fails when a series' mean falls more than this many points a hand below its reference. */
export const GATE_MAX_DROP = 1;

/**
 * Pro's deal-in terms (the lean away from danger and the fold) and 台 terms (value-honour pairs
 * and pongs, the flush chase) switched off: what is left is Pro's tile efficiency and claiming.
 */
export const PRO_TERMS_OFF: Partial<typeof BOT_WEIGHTS> = { proLean: 0, proFold: 0, proValuePair: 0, proFlush: 0, proValuePong: 0 };

export interface GateSeries {
  mean: number;
  se: number;
  /** One paired score difference per hand, in seed order. */
  perHand: number[];
}

/** What the test seat did over the gate's hands with one kind of bot in it. */
export interface SeatStats {
  wins: number;
  dealIns: number;
  /** Total 台 over its wins. */
  tai: number;
}

export interface GateReference {
  note: string;
  prefix: string;
  hands: number;
  proVsClub: GateSeries;
  termsVsBare: GateSeries;
  /** How many hands end with a different score for the test seat once the terms are switched off. */
  handsChangedByTerms: number;
  /** For the record only (the gate does not judge them): the test seat as Pro, as Pro without the terms, and as Club. */
  seat: { pro: SeatStats; bare: SeatStats; club: SeatStats };
}

export interface Summary {
  mean: number;
  se: number;
  low: number;
  high: number;
}

/** Mean, standard error and normal 95% interval of a sample. */
export function summarise(xs: readonly number[]): Summary {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / Math.max(1, n));
  return { mean, se, low: mean - 1.96 * se, high: mean + 1.96 * se };
}

/** Where a paired difference stands at 95%: `level` means the interval includes zero. */
export type Standing = 'ahead' | 'behind' | 'level';
export function standing(xs: readonly number[]): Standing {
  const s = summarise(xs);
  return s.low > 0 ? 'ahead' : s.high < 0 ? 'behind' : 'level';
}

/** A run against its reference: the change of the mean (points a hand) and how many hands differ. */
export function againstReference(current: readonly number[], reference: readonly number[]): { change: number; differing: number } {
  if (current.length !== reference.length) throw new Error(`The gate reference has ${reference.length} hands and the run ${current.length}: record it again (npm run sim -- --gate --record)`);
  let sum = 0;
  let differing = 0;
  for (let i = 0; i < current.length; i++) {
    sum += current[i] - reference[i];
    if (current[i] !== reference[i]) differing++;
  }
  return { change: sum / Math.max(1, current.length), differing };
}

export interface GateRun {
  proVsClub: readonly number[];
  termsVsBare: readonly number[];
}

/**
 * Why a run fails the gate (empty when it passes):
 *  - a series' mean is more than `GATE_MAX_DROP` points a hand below its reference;
 *  - Pro is behind Club at 95% (a recorded reference cannot bless a Pro that loses to Club);
 *  - the terms cost points at 95%, or change no hand at all (they are switched off or inert).
 * The terms being level with the bare model is NOT a failure: the gate reports it (see
 * `termsVerdict`) and the reference records it, so it is visible without blocking unrelated work.
 */
export function gateFailures(run: GateRun, ref: Pick<GateReference, 'proVsClub' | 'termsVsBare'>): string[] {
  const out: string[] = [];
  const club = againstReference(run.proVsClub, ref.proVsClub.perHand);
  if (club.change < -GATE_MAX_DROP) out.push(`Pro against Club is ${(-club.change).toFixed(2)} pts/hand below the stored reference (allowed: ${GATE_MAX_DROP.toFixed(2)})`);
  if (standing(run.proVsClub) === 'behind') out.push('Pro is behind Club at 95%');
  const terms = againstReference(run.termsVsBare, ref.termsVsBare.perHand);
  if (terms.change < -GATE_MAX_DROP) out.push(`Pro against Pro without its deal-in and 台 terms is ${(-terms.change).toFixed(2)} pts/hand below the stored reference (allowed: ${GATE_MAX_DROP.toFixed(2)})`);
  if (run.termsVsBare.every((x) => x === 0)) out.push('Pro’s deal-in and 台 terms change no hand: they are switched off or have no effect');
  else if (standing(run.termsVsBare) === 'behind') out.push('Pro’s deal-in and 台 terms cost points at 95%');
  return out;
}

/** One honest line on what the terms are worth in results, for the gate's output. */
export function termsVerdict(xs: readonly number[]): string {
  if (xs.every((x) => x === 0)) return 'the terms change no hand';
  const s = standing(xs);
  return s === 'ahead' ? 'the terms earn points at 95%' : s === 'behind' ? 'the terms cost points at 95%' : 'no measurable gain from the terms (the 95% interval includes zero)';
}
