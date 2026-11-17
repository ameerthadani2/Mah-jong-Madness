import { describe, expect, it } from 'vitest';
import { timeBound } from './helpers/timing';
import { checkDiscardAnswer, countsFromKinds, DAILY_ISOLATED_TILE_SHARE, dailyPuzzle, discardOptions, ISOLATED_TILE_PUZZLE_SHARE, isolatedTile, DEFENCE_SAFETY_ORDER, defenceOrderRule, defencePuzzle, discardPuzzle, kindInfo, LONE_HONOUR_PUZZLE_SHARE, loneHonours, sha256Hex, VALUE_BIG_PATTERN_TAI, valuePatternRule, valuePuzzle, valueSpeedRule, type DefenceOption, type DiscardPuzzle, type TaiItem, type ValueOption, type ValuePuzzle } from '../src/index';

// How often a one-line rule answers a puzzle: "keep the most winning tiles" for value puzzles, a
// fixed safety order for defence puzzles. Easy and medium puzzles teach those rules; hard ones
// should need more than the rule about half the time.

const ready = (kind: number, acceptance: number, accepted: boolean): ValueOption => ({ kind, ready: true, acceptance, accepted });
const kept = (kind: number, reason: DefenceOption['reason'], accepted: boolean, shanten = 1): DefenceOption => ({ kind, shanten, danger: 0, exact: 0, accepted, reason });

describe('one-line rules measured against the judge', () => {
  it('keep the most winning tiles: right, wrong, or split on a tie', () => {
    expect(valueSpeedRule({ options: [ready(1, 8, true), ready(2, 4, false), { kind: 3, ready: false }] })).toBe(true);
    expect(valueSpeedRule({ options: [ready(1, 8, false), ready(2, 4, true)] })).toBe(false);
    expect(valueSpeedRule({ options: [ready(1, 8, false), ready(2, 8, true), ready(3, 2, false)] })).toBeNull();
  });

  it('chase a pattern of 4 台 that keeps half the most winning tiles, else keep the most winning tiles', () => {
    const big: TaiItem[] = [{ key: 'all_pongs', nameZh: '碰碰胡', nameEn: 'All Pongs', tai: 4 }];
    const small: TaiItem[] = [{ key: 'dragon_31', nameZh: '中', nameEn: 'Red Dragon Pong', tai: 1 }];
    const opt = (kind: number, acceptance: number, accepted: boolean, items: TaiItem[], bestTai: number): ValueOption => ({ ...ready(kind, acceptance, accepted), items, bestTai });
    // The pattern keeps half the tiles: the rule chases it.
    expect(valuePatternRule({ options: [opt(1, 8, false, [], 2), opt(2, 4, true, big, 7)] })).toBe(true);
    expect(valuePatternRule({ options: [opt(1, 8, true, [], 2), opt(2, 4, false, big, 7)] })).toBe(false);
    // Under half, or under 4 台: the rule keeps the most winning tiles.
    expect(valuePatternRule({ options: [opt(1, 9, true, [], 2), opt(2, 4, false, big, 7)] })).toBe(true);
    expect(valuePatternRule({ options: [opt(1, 8, false, [], 2), opt(2, 6, true, small, 4)] })).toBe(false);
    // Two patterns that keep half: the one with the biggest win; a tie that splits the judge is null.
    expect(valuePatternRule({ options: [opt(1, 8, false, [], 2), opt(2, 5, true, big, 7), opt(3, 4, false, big, 12)] })).toBe(false);
    expect(valuePatternRule({ options: [opt(1, 8, false, [], 2), opt(2, 5, true, big, 7), opt(3, 4, false, big, 7)] })).toBeNull();
  });

  it('the fixed safety order: looks only at shape-keeping discards with the strongest reason', () => {
    const options = [kept(27, 'honour', false), kept(4, 'middle', true), kept(30, 'theirDiscard', true, 2)];
    expect(defenceOrderRule({ bestShanten: 1, options })).toBe(false);
    expect(defenceOrderRule({ bestShanten: 1, options: [kept(27, 'honour', true), kept(4, 'middle', false)] })).toBe(true);
    expect(defenceOrderRule({ bestShanten: 1, options: [kept(27, 'honour', true), kept(28, 'honour', false)] })).toBeNull();
  });

  it('agree with the first-pick rule on generated puzzles whenever they are not split', () => {
    for (let i = 0; i < 30; i++) {
      const v = valuePuzzle(`depth-pick-${i}`, 2);
      const rule = valueSpeedRule(v);
      const live = v.options.filter((o) => o.ready);
      const most = Math.max(...live.map((o) => o.acceptance ?? 0));
      if (rule !== null) expect(v.answers.includes(live.find((o) => o.acceptance === most)!.kind)).toBe(rule);
      const d = defencePuzzle(`depth-pick-${i}`, 2);
      const order = defenceOrderRule(d);
      const shape = d.options.filter((o) => o.shanten === d.bestShanten);
      const pick = shape.slice().sort((x, y) => DEFENCE_SAFETY_ORDER.indexOf(x.reason) - DEFENCE_SAFETY_ORDER.indexOf(y.reason))[0];
      if (order !== null) expect(d.answers.includes(pick.kind)).toBe(order);
    }
  });
});

/** Share of `n` seeded puzzles at `difficulty` where `rule` is wrong, with generation times. */
function measure<T>(gen: (seed: string, d: 1 | 2 | 3) => T, rule: (p: T) => boolean | null, difficulty: 1 | 2 | 3, n: number, prefix: string) {
  let wrong = 0;
  const ms: number[] = [];
  const puzzles: T[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const p = gen(`${prefix}-${i}`, difficulty);
    ms.push(performance.now() - t0);
    puzzles.push(p);
    if (rule(p) === false) wrong++;
  }
  ms.sort((a, b) => a - b);
  return { share: wrong / n, median: ms[Math.floor(n / 2)], max: ms[n - 1], puzzles };
}

describe('hard value puzzles need more than "keep the most winning tiles"', () => {
  const hard = measure(valuePuzzle, valueSpeedRule, 3, 160, 'depth-v');

  it('the rule is wrong in 40 to 60 percent of hard puzzles', () => {
    expect(hard.share).toBeGreaterThanOrEqual(0.4);
    expect(hard.share).toBeLessThanOrEqual(0.6);
  });

  it('easy and medium still teach the rule', () => {
    for (const d of [1, 2] as const) expect(measure(valuePuzzle, valueSpeedRule, d, 80, 'depth-v').share).toBeLessThan(0.25);
  });

  it('when the rule is right at hard, speed beats a bigger hand', () => {
    for (const p of hard.puzzles) {
      if (valueSpeedRule(p) !== true) continue;
      const a = p.options.find((o) => o.kind === p.answer)!;
      const r = p.options.find((o) => o.kind === p.rival)!;
      expect(r.acceptance! > a.acceptance! || r.bestTai! > a.bestTai!).toBe(true);
    }
  });

  it('give the same puzzle for the same seed', () => {
    for (let i = 0; i < 160; i += 16) expect(valuePuzzle(`depth-v-${i}`, 3)).toEqual(hard.puzzles[i]);
  });

  it('generate quickly enough for the server to regenerate a Rush run (loose bound for CI)', () => {
    expect(hard.median).toBeLessThan(timeBound(60));
    expect(hard.max).toBeLessThan(timeBound(1500));
  });
});

/** The headline items of 4 台 or more in an option's best win. */
const bigItems = (o: ValueOption): TaiItem[] => (o.items ?? []).filter((i) => i.tai >= VALUE_BIG_PATTERN_TAI);
const topKey = (o: ValueOption): string => bigItems(o).sort((x, y) => y.tai - x.tai)[0]?.key ?? '';
const opt = (p: ValuePuzzle, k: number) => p.options.find((o) => o.kind === k)!;

describe('hard value puzzles need judgement, not a two-line rule', () => {
  const hard = Array.from({ length: 200 }, (_, i) => valuePuzzle(`depth-two-${i}`, 3));
  const share = (f: (p: ValuePuzzle) => boolean) => hard.filter(f).length / hard.length;

  it('"chase a pattern of 4 台 that keeps half the winning tiles" is wrong in at least 30 percent', () => {
    expect(share((p) => valuePatternRule(p) === false)).toBeGreaterThanOrEqual(0.3);
  });

  it('the one-line rules stay near half: most winning tiles, and the biggest win', () => {
    expect(share((p) => valueSpeedRule(p) === false)).toBeGreaterThanOrEqual(0.4);
    expect(share((p) => valueSpeedRule(p) === false)).toBeLessThanOrEqual(0.6);
    const biggest = (p: ValuePuzzle) => {
      const ready = p.options.filter((o) => o.ready);
      const top = Math.max(...ready.map((o) => o.bestTai ?? -1));
      return p.answers.includes(ready.find((o) => o.bestTai === top)!.kind);
    };
    expect(share(biggest)).toBeGreaterThanOrEqual(0.35);
    expect(share(biggest)).toBeLessThanOrEqual(0.65);
  });

  it('the bigger hand wins with several patterns, none in most of them', () => {
    const counts = new Map<string, number>();
    const wins = hard.filter((p) => valueSpeedRule(p) === false);
    for (const p of wins) counts.set(topKey(opt(p, p.answer)), (counts.get(topKey(opt(p, p.answer))) ?? 0) + 1);
    expect(counts.size).toBeGreaterThanOrEqual(3);
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(0.5 * wins.length);
  });

  it('a pattern that keeps half the tiles and is not worth chasing is named, in both languages', () => {
    const traps = hard.filter((p) => valueSpeedRule(p) === true && valuePatternRule(p) === false);
    const chased = new Set<string>();
    for (const p of traps) {
      const r = opt(p, p.rival);
      const a = opt(p, p.answer);
      expect(r.accepted).toBe(false);
      expect(2 * r.acceptance!).toBeGreaterThanOrEqual(a.acceptance!);
      const item = bigItems(r).filter((i) => !(a.items ?? []).some((x) => x.key === i.key)).sort((x, y) => y.tai - x.tai)[0];
      if (!item) continue;
      chased.add(item.key);
      expect(p.explanation).toContain(`${kindInfo(p.rival).nameEn} goes for ${item.nameEn}`);
      expect(p.explanationZh).toContain(`打${kindInfo(p.rival).nameZh}是做`);
    }
    expect(traps.length).toBeGreaterThanOrEqual(0.25 * hard.length);
    expect(chased.size).toBeGreaterThanOrEqual(3);
  });
});

describe('easy and medium value puzzles stay as they are', () => {
  // Recorded on 17 November 2026, before the hard puzzles were varied: changing how hard puzzles
  // are built must not move an easy or medium one (the daily and Rush seeds keep their puzzles).
  const pinned = {
    1: '0c200f6592816b4aade34272daa8feb2ec63caaf8f4b207753d818dce53187ac',
    2: '7fdbd000354100d3fdfb694283d326c197e86ee980e00e47ef378b27625e91dd',
  } as const;
  for (const d of [1, 2] as const) {
    it(`difficulty ${d}: 120 seeded puzzles are byte-identical to the recorded ones`, () => {
      const all = Array.from({ length: 120 }, (_, i) => valuePuzzle(`pin-${i}`, d));
      expect(sha256Hex(JSON.stringify(all))).toBe(pinned[d]);
    });
  }
});

describe('hard defence puzzles need reading the discards, not a fixed safety order', () => {
  const hard = measure(defencePuzzle, defenceOrderRule, 3, 160, 'depth-d');

  it('the fixed order is wrong in 40 to 60 percent of hard puzzles', () => {
    expect(hard.share).toBeGreaterThanOrEqual(0.4);
    expect(hard.share).toBeLessThanOrEqual(0.6);
  });

  it('easy and medium still follow the order', () => {
    for (const d of [1, 2] as const) expect(measure(defencePuzzle, defenceOrderRule, d, 80, 'depth-d').share).toBeLessThan(0.15);
  });

  it("say which tile the order picks and that the count rates it more dangerous, in both languages", () => {
    let wrong = 0;
    for (const p of hard.puzzles) {
      const kept = p.options.filter((o) => o.shanten === p.bestShanten);
      const top = Math.min(...kept.map((o) => DEFENCE_SAFETY_ORDER.indexOf(o.reason)));
      const pick = kept.find((o) => DEFENCE_SAFETY_ORDER.indexOf(o.reason) === top)!;
      if (defenceOrderRule(p) !== false) {
        expect(p.explanation).not.toMatch(/by the usual order/);
        continue;
      }
      wrong++;
      const answer = p.options.find((o) => o.kind === p.answer)!;
      expect(pick.exact).toBeGreaterThan(answer.exact);
      expect(p.explanation).toContain(`${kindInfo(pick.kind).nameEn} looks safer by the usual order`);
      expect(p.explanationZh).toContain(`照一般的順序，${kindInfo(pick.kind).nameZh}看起來比較安全`);
      expect(p.explanation).not.toMatch(/(^|[^0-9.])0\.0%/);
    }
    expect(wrong).toBeGreaterThan(0);
  });

  it('give the same puzzle for the same seed', () => {
    for (let i = 0; i < 160; i += 16) expect(defencePuzzle(`depth-d-${i}`, 3)).toEqual(hard.puzzles[i]);
  });

  it('generate quickly enough for the server to regenerate a Rush run (loose bound for CI)', () => {
    expect(hard.median).toBeLessThan(timeBound(60));
    expect(hard.max).toBeLessThan(timeBound(1500));
  });
});

/** "Throw an isolated honour if you have one": right when the hand holds one and throwing it is accepted. */
const loneHonourRule = (p: DiscardPuzzle): boolean => {
  const counts = countsFromKinds(p.hand);
  const lone = counts.findIndex((c, k) => k >= 27 && c === 1);
  return lone >= 0 && checkDiscardAnswer(p, lone);
};

describe('the daily and medium and hard discard puzzles need reading the shape', () => {
  // Before: the rule was right on 303 of the next 365 dailies and every medium and hard puzzle that held a
  // lone honour (256 and 171 of 300). Only a small share of seeds may still hold one.
  const dailies = Array.from({ length: 120 }, (_, i) => dailyPuzzle(new Date(Date.UTC(2026, 10, 18 + i))));

  it('"throw the lone honour" answers under a quarter of the daily puzzles', () => {
    expect(dailies.filter(loneHonourRule).length).toBeLessThan(0.25 * dailies.length);
    // Every weekday's difficulty is covered, Monday's easy one included.
    expect(dailies.filter((p) => p.bestShanten >= 2).length).toBeGreaterThan(0);
  });

  for (const d of [2, 3] as const) {
    it(`and under a quarter of the ${d === 2 ? 'medium' : 'hard'} discard puzzles, with a few still holding one`, () => {
      const ms: number[] = [];
      const all = Array.from({ length: 150 }, (_, i) => {
        const t0 = performance.now();
        const p = discardPuzzle(`depth-lone-${i}`, d);
        ms.push(performance.now() - t0);
        return p;
      });
      const right = all.filter(loneHonourRule).length;
      expect(right).toBeLessThan(0.25 * all.length);
      expect(right).toBeGreaterThan(0);
      expect(right).toBeLessThan(0.2 * all.length);
      // A puzzle is still a decision: never more than a third of the discards accepted.
      for (const p of all) expect(p.answers.length).toBeLessThanOrEqual(Math.max(2, Math.floor(p.options.length / 3)));
      ms.sort((a, b) => a - b);
      expect(ms[75]).toBeLessThan(timeBound(20));
      expect(ms[149]).toBeLessThan(timeBound(500));
    });
  }

  it('name the lone honours a hand holds', () => {
    expect(loneHonours([0, 1, 2, 27, 31, 31, 33])).toEqual([27, 33]);
    expect(loneHonours([27, 27, 4])).toEqual([]);
    expect(LONE_HONOUR_PUZZLE_SHARE).toBeLessThan(0.25);
  });

  it('give the same puzzle for the same seed', () => {
    for (let i = 0; i < 120; i += 20) expect(dailyPuzzle(new Date(Date.UTC(2026, 10, 18 + i)))).toEqual(dailies[i]);
    expect(discardPuzzle('depth-lone-same', 3)).toEqual(discardPuzzle('depth-lone-same', 3));
  });

  it('easy drills keep the beginner\'s lesson, byte-identical to the puzzles recorded before the change', () => {
    const easy = Array.from({ length: 120 }, (_, i) => discardPuzzle(`pin-${i}`, 1));
    expect(sha256Hex(JSON.stringify(easy))).toBe('b4c15eac9eee2354943d28ed718993a321fbe64220f92691629b56397ccce443');
    expect(easy.filter(loneHonourRule).length).toBeGreaterThan(0.75 * easy.length);
    // The daily reads the shape even on an easy day; the same seed as a drill does not.
    const monday = new Date(Date.UTC(2026, 10, 23));
    expect(dailyPuzzle(monday)).toEqual(discardPuzzle('daily-2026-11-23', 1, { readShape: true, isolatedTileShare: DAILY_ISOLATED_TILE_SHARE }));
  });
});

// "Throw an isolated tile (a single with no neighbour within two in its suit), honours first, then
// terminals, then the outermost": written here apart from the engine's `isolatedTile`.
const isolatedRulePick = (hand: readonly number[]): number => {
  const c = countsFromKinds(hand);
  const xs: number[] = [];
  for (let k = 0; k < 34; k++) {
    if (c[k] !== 1) continue;
    const r = k % 9;
    if (k < 27 && [-2, -1, 1, 2].some((d) => r + d >= 0 && r + d <= 8 && c[k + d] > 0)) continue;
    xs.push(k);
  }
  xs.sort((a, b) => (b >= 27 ? 1 : 0) - (a >= 27 ? 1 : 0) || Math.abs(4 - (b % 9)) - Math.abs(4 - (a % 9)) || a - b);
  return xs[0] ?? -1;
};
const isolatedRule = (p: DiscardPuzzle): boolean => {
  const k = isolatedRulePick(p.hand);
  return k >= 0 && checkDiscardAnswer(p, k);
};

describe('the daily and hard discard puzzles need comparing shapes', () => {
  // Before: the isolated-tile rule was right on 271 of the next 365 dailies, 227 of 300 medium and 184 of 300 hard puzzles.
  const dailies = Array.from({ length: 120 }, (_, i) => dailyPuzzle(new Date(Date.UTC(2026, 11, 1 + i))));
  const hard = Array.from({ length: 150 }, (_, i) => discardPuzzle(`shapes-${i}`, 3));
  const medium = Array.from({ length: 150 }, (_, i) => discardPuzzle(`shapes-${i}`, 2));

  it('the isolated-tile rule is right on under half of the daily puzzles, and still on some', () => {
    const right = dailies.filter(isolatedRule).length;
    expect(right).toBeLessThan(0.4 * dailies.length);
    expect(right).toBeGreaterThan(0.1 * dailies.length);
  });

  it('and on under half of the hard puzzles; medium moves partway', () => {
    const hardRight = hard.filter(isolatedRule).length;
    expect(hardRight).toBeLessThan(0.4 * hard.length);
    expect(hardRight).toBeGreaterThan(0.1 * hard.length);
    const mediumRight = medium.filter(isolatedRule).length;
    expect(mediumRight).toBeGreaterThan(hardRight);
    expect(mediumRight).toBeLessThan(0.65 * medium.length);
  });

  it('the engine names the same tile as the rule written here', () => {
    for (const p of [...dailies, ...hard]) expect(isolatedTile(p.hand) ?? -1).toBe(isolatedRulePick(p.hand));
    expect(isolatedTile([0, 1, 2, 8, 13, 27, 27])).toBe(8);
    expect(isolatedTile([0, 1, 2, 8, 13, 31])).toBe(31);
    expect(isolatedTile([0, 1, 2, 3])).toBeNull();
    expect(ISOLATED_TILE_PUZZLE_SHARE[1]).toBe(1);
    expect(DAILY_ISOLATED_TILE_SHARE).toBeLessThan(0.5);
  });

  it('keeps every answer exact: each discard within 10 percent of the best acceptance, at the best shanten', () => {
    for (const p of [...dailies.slice(0, 40), ...hard.slice(0, 40)]) {
      const counts = countsFromKinds(p.hand);
      const opts = discardOptions(counts, 5, counts.map((c) => 4 - c));
      const sh = Math.min(...opts.map((o) => o.shanten));
      const top = Math.max(...opts.filter((o) => o.shanten === sh).map((o) => o.acceptance));
      expect([...p.answers].sort((a, b) => a - b)).toEqual(opts.filter((o) => o.shanten === sh && o.acceptance >= top * 0.9).map((o) => o.kind).sort((a, b) => a - b));
    }
  });

  it('give the same puzzle for the same seed', () => {
    expect(discardPuzzle('shapes-7', 3)).toEqual(hard[7]);
    expect(dailyPuzzle(new Date(Date.UTC(2026, 11, 5)))).toEqual(dailies[4]);
  });
});
