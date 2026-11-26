/**
 * The gaps the checks of unit 20 found, each in a fixed form (known.ts): a closed one must stay closed; one still open runs
 * as an expected failure (`OPEN_GAPS`, ci.ts) until it is closed, as do the generated seeds the long runs found open
 * (`OPEN_MIXED_SEEDS`, `OPEN_DIRECT_SEEDS`, `OPEN_HONEST_SEEDS`). R6 needs the build an app update replaces
 * (`ADVERSARY_OLD_TREE`, load.ts) and is skipped without it.
 */
import { describe, expect, it } from 'vitest';
import { failures, LIMIT, OPEN_DIRECT_SEEDS, OPEN_GAPS, OPEN_HONEST_SEEDS, OPEN_MIXED_SEEDS } from './ci';
import { generate } from './generate';
import { KNOWN_CASES } from './known';
import { oldNet } from './load';

describe('the adversary fuzzer: the gaps found', () => {
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

  for (const seed of OPEN_MIXED_SEEDS) {
    it.fails(`still finds the open gap of mixed seed ${seed}`, () => {
      expect(failures(generate(seed, 'mixed'))).toEqual([]);
    }, LIMIT);
  }

  for (const seed of OPEN_DIRECT_SEEDS) {
    it.fails(`still finds the open gap of direct seed ${seed}`, () => {
      expect(failures(generate(seed, 'direct'))).toEqual([]);
    }, LIMIT);
  }

  for (const seed of OPEN_HONEST_SEEDS) {
    it.fails(`still shows red at the honest table of seed ${seed}`, () => {
      expect(failures(generate(seed, 'honest'))).toEqual([]);
    }, LIMIT);
  }
});
