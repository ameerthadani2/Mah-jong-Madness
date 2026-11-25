/**
 * The adversary fuzzer, on a fixed set of seeds: the real TableHost deals and plays honestly, the real TableClient is the
 * phone of the player at seat 0, and between them a server programmed by each scenario withholds, delays, repeats and
 * forges (server.ts), while the player's app restarts, resumes and loses its records as apps do (sim.ts). The oracle
 * (oracle.ts) knows what really happened and holds the phone's verdicts to the charter:
 * - a hand in which the player was cheated is never green, amber only where docs/FAIRNESS.md states the case as a limit
 *   (each limit quoted word for word in `EXCEPTIONS`), and the end of the match is not shown verified;
 * - a scenario made only of honest events never shows red.
 * The long runs are soak.ts (`npx tsx packages/net/test/adversary/soak.ts --from 1 --to 5000 --workers 2`); this file
 * keeps a sample of them, and the known gaps in their fixed forms (known.ts), in CI. A failure prints the seed, the
 * events and the command that replays it.
 */
import { describe, expect, it } from 'vitest';
import { report, runScenario } from './fuzz';
import { generate } from './generate';
import { KNOWN_CASES } from './known';
import { oldNet } from './load';
import { quotesMissing } from './oracle';
import type { Scenario } from './scenario';

/** Coverage runs the code about four times slower. */
const LIMIT = (process.argv.includes('--coverage') || process.env.COVERAGE ? 5 : 1) * 60_000;

/** Honest scenarios: cuts, delays, restarts, resumes, a new phone, the seat on another phone, a server restart, sleep. */
const HONEST_SEEDS = Array.from({ length: 12 }, (_, i) => 1 + i * 83);
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
  // Clean on d6745d5.
  ...Array.from({ length: 8 }, (_, i) => 2 + i),
];

/**
 * Gaps this code still has, found by the fuzzer and reported with their seeds (oracle.ts KNOWN): each test here fails
 * while its gap is open (`it.fails`), so the run stays green, and turns red the day the gap is closed, when the case moves
 * to the closed ones above. A gap docs/FAIRNESS.md comes to state as a limit becomes a `limit` case in known.ts instead.
 */
const OPEN_GAPS = new Set(['N2', 'N3', 'N4']);
const OPEN_MIXED_SEEDS = [
  970, // N3
];

/** What the oracle finds wrong with a run of `s`, as the runner prints it (nothing when the phone did right). */
function failures(s: Scenario): string[] {
  const o = runScenario(s);
  return o.judgement.violations.map((v) => report(o, v));
}

describe('the adversary fuzzer', () => {
  it('quotes each stated limit from docs/FAIRNESS.md word for word', () => {
    expect(quotesMissing()).toEqual([]);
  });

  it('shows no red at an honest table', () => {
    expect(HONEST_SEEDS.flatMap((seed) => failures(generate(seed, 'honest')))).toEqual([]);
  }, LIMIT);

  it('holds every generated attack to the charter', () => {
    expect(MIXED_SEEDS.flatMap((seed) => failures(generate(seed, 'mixed')))).toEqual([]);
  }, LIMIT);

  for (const seed of OPEN_MIXED_SEEDS) {
    it.fails(`still finds the open gap of mixed seed ${seed}`, () => {
      expect(failures(generate(seed, 'mixed'))).toEqual([]);
    }, LIMIT);
  }

  for (const k of KNOWN_CASES.filter((c) => c.role === 'gap' && !OPEN_GAPS.has(c.gap))) {
    it.skipIf(k.gap === 'R6' && !oldNet)(`keeps gap ${k.gap} closed: ${k.what}`, () => {
      expect(failures(k.make(k.seed ?? 1))).toEqual([]);
    }, LIMIT);
  }

  for (const k of KNOWN_CASES.filter((c) => c.role === 'gap' && OPEN_GAPS.has(c.gap))) {
    it.fails(`gap ${k.gap} is still open: ${k.what}`, () => {
      expect(failures(k.make(k.seed ?? 1))).toEqual([]);
    }, LIMIT);
  }

  for (const k of KNOWN_CASES.filter((c) => c.role === 'limit')) {
    it(`keeps the stated limit ${k.gap} amber, never green: ${k.what}`, () => {
      const o = runScenario(k.make(k.seed ?? 1));
      expect(o.judgement.cheats.length).toBeGreaterThan(0);
      expect(o.judgement.violations.map((v) => report(o, v))).toEqual([]);
      expect([...o.judgement.verdicts.values()].some((v) => v.status === 'partial')).toBe(true);
    }, LIMIT);
  }

  for (const k of KNOWN_CASES.filter((c) => c.role === 'control')) {
    it(`sees the attack of gap ${k.gap}'s control: ${k.what}`, () => {
      const o = runScenario(k.make(k.seed ?? 1));
      expect(o.judgement.cheats.length).toBeGreaterThan(0);
      expect(o.judgement.violations.map((v) => report(o, v))).toEqual([]);
      expect([...o.judgement.verdicts.values()].some((v) => v.status === 'failed')).toBe(true);
    }, LIMIT);
  }
});
