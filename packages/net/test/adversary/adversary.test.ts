/**
 * The adversary fuzzer, on a fixed set of seeds: the real TableHost deals and plays honestly, the real TableClient is the
 * phone of the player at seat 0, and between them a server programmed by each scenario withholds, delays, repeats and
 * forges (server.ts), while the player's app restarts, resumes and loses its records as apps do (sim.ts). The oracle
 * (oracle.ts) knows what really happened and holds the phone's verdicts to the charter:
 * - a hand in which the player was cheated is never green, amber only where docs/FAIRNESS.md states the case as a limit
 *   (each limit quoted word for word in `EXCEPTIONS`), and the end of the match is not shown verified;
 * - a scenario made only of honest events never shows red.
 * The long runs are soak.ts (`npm run fuzz:fair -w @mjm/net -- --from 1 --to 5000 --mode both --workers 2`); this file
 * keeps a sample of them in CI, and adversary-gaps.test.ts and adversary-rules.test.ts the known gaps, limits and controls
 * in their fixed forms (known.ts), with the generated seeds of the gaps still open (ci.ts). A failure prints the seed, the events and the command that replays it.
 */
import { describe, expect, it } from 'vitest';
import { COVERED, failures, LIMIT } from './ci';
import { generate } from './generate';
import { quotesMissing } from './oracle';

/** Honest scenarios: cuts, delays, restarts, resumes, a new phone, the seat on another phone, a server restart, sleep (four under coverage). */
const HONEST_SEEDS = Array.from({ length: COVERED ? 4 : 12 }, (_, i) => 1 + i * 83);
/**
 * Generated attacks. The first seeds are ones the fuzzer found gaps with on the code before unit 20g (d6745d5), one or
 * two per gap (named in the comments), closed since; the rest are a plain sample. Seeds name scenarios of this
 * generate.ts: a change to the generator gives them other scenarios, so pick them again with soak.ts after one.
 */
const MIXED_SEEDS = [
  // Gaps found on d6745d5, one seed each (oracle.ts KNOWN and FOUND).
  144, // R1
  28, // R2
  93, // R3
  2890, // R4
  3021, // R5
  449, // R7
  67, // S1
  104, // S2
  314, // S3
  452, // N1
  2828, // N5
  955, // S3 (a stale saved table: kept in the archive since unit 20g)
  6664, // a 12 s stall, then a move written as the player's own on a turn shown late, matched to an older move of the same kind: red since unit 20h (the copy rule)
  // Clean on d6745d5 (`GAP_SEEDS` counts the seeds above).
  ...Array.from({ length: 8 }, (_, i) => 2 + i),
];
const GAP_SEEDS = 13;

describe('the adversary fuzzer', () => {
  it('quotes each stated limit from docs/FAIRNESS.md word for word', () => {
    expect(quotesMissing()).toEqual([]);
  });

  it('shows no red at an honest table', () => {
    expect(HONEST_SEEDS.flatMap((seed) => failures(generate(seed, 'honest')))).toEqual([]);
  }, LIMIT);

  it('holds every generated attack to the charter', () => {
    // Under coverage, the seeds of the gaps only.
    const seeds = COVERED ? MIXED_SEEDS.slice(0, GAP_SEEDS) : MIXED_SEEDS;
    expect(seeds.flatMap((seed) => failures(generate(seed, 'mixed')))).toEqual([]);
  }, LIMIT);
});
