import { describe, expect, it } from 'vitest';
import { timeBound } from './helpers/timing';
import {
  answerExplanation,
  claimPuzzle,
  countsFromKinds,
  dailyPuzzle,
  defencePuzzle,
  discardPuzzle,
  isolatedTile,
  kindInfo,
  valuePuzzle,
  type DiscardPuzzle,
  type PuzzleExplanation,
} from '../src/index';

// A puzzle accepts every answer about as good as the best, and its own explanation is written for one
// of them. Before 18 November 2026 a player who chose another right answer read that one explanation:
// on 365 dailies and 300 hard puzzles it was untrue of the chosen tile for 112 of 317 answers to
// "isolated tile" puzzles and 104 of 366 to "break a pair" ones, and named no other tile for 77 of 150
// "compare the shapes" ones. `answerExplanation` explains the answer the player gave.

const near = (c: number[], k: number, d: number) => k < 27 && (k % 9) + d >= 0 && (k % 9) + d <= 8 && c[k + d] > 0;
const isolated = (c: number[], k: number) => c[k] === 1 && ![-2, -1, 1, 2].some((d) => near(c, k, d));
/** A single that is one end of an edge (1-2, 8-9) or closed (1-3) 搭子 and touches nothing else. */
const inWeakPartial = (c: number[], k: number) => {
  if (k >= 27 || c[k] !== 1) return false;
  const has = (d: number) => near(c, k, d);
  if (has(-1) && has(1)) return false;
  for (const d of [-1, 1]) {
    if (!has(d) || has(-d) || has(2 * d) || has(-2 * d)) continue;
    const lo = Math.min(k % 9, (k % 9) + d);
    if (lo === 0 || lo === 7) return true;
  }
  return !has(-1) && !has(1) && [-2, 2].some((d) => has(d) && !has(-d));
};
const en = (k: number) => kindInfo(k).nameEn;
const zh = (k: number) => kindInfo(k).nameZh;
const named = (x: PuzzleExplanation, k: number) => x.explanation.includes(en(k)) && x.explanationZh.includes(zh(k));

/** What is wrong with the explanation of discard puzzle `p` given for its accepted answer `k`; '' when it is true of `k`. */
function discardFault(p: DiscardPuzzle, k: number): string {
  const x = answerExplanation(p, k)!;
  const c = countsFromKinds(p.hand);
  if (!named(x, k)) return 'does not name the tile';
  if (k !== p.best && !named(x, p.best)) return "does not name the puzzle's own answer";
  if (/[A-Za-z]/.test(x.explanationZh)) return 'Latin letters in the Chinese text';
  // A right tile that keeps fewer than another is not called the best, and while another right answer
  // exists no wrong tile is called the next best: the same explanation would say otherwise.
  const acc = (j: number) => p.options.find((o) => o.kind === j)!.acceptance;
  const fewer = acc(k) < Math.max(...p.answers.map(acc));
  if (fewer && /keeps the strongest shapes|the tile you need least/.test(x.explanation)) return 'calls a tile that keeps fewer the best';
  if (fewer && /最划算|它最沒用/.test(x.explanationZh)) return 'calls a tile that keeps fewer the best, in Chinese';
  if (p.answers.length > 1 && (x.explanation.includes('the closest other choice') || x.explanationZh.includes('次佳的'))) return 'calls a wrong tile the next best';
  // A pair is two tiles: "The pair of 4 Characters", "Your 6 Dots are your only pair".
  if (/pair of \d (Character|Dot)\b|of (East|South|West|North) Wind\b|of (Red|Green|White) Dragon\b|is your only pair/.test(x.explanation)) return 'names a pair in the singular';
  switch (x.reasonKey) {
    case 'puzzle.discard.isolated':
      return isolated(c, k) ? '' : 'says isolated';
    case 'puzzle.discard.breakPair':
      return c[k] === 2 ? '' : 'says break a pair';
    case 'puzzle.discard.keepPair':
      return c[k] !== 2 && c.filter((n) => n === 2).length === 1 ? '' : 'says keep the only pair';
    case 'puzzle.discard.weakerTaatsu':
      return inWeakPartial(c, k) ? '' : 'says the weaker 搭子';
    case 'puzzle.discard.widerWait':
      return p.options.find((o) => o.kind === k)!.shanten === 0 ? '' : 'says ready';
    case 'puzzle.discard.hiddenValue': {
      const lone = isolatedTile(p.hand);
      return lone !== null && !p.answers.includes(lone) && named(x, lone) ? '' : 'says a lone tile is worth keeping';
    }
    case 'puzzle.discard.compare':
      return '';
    default:
      return `unknown decision ${x.reasonKey}`;
  }
}

describe('the explanation shown is true of the answer the player gave', () => {
  const discards = [...Array.from({ length: 365 }, (_, i) => dailyPuzzle(new Date(Date.UTC(2026, 10, 18 + i)))), ...Array.from({ length: 300 }, (_, i) => discardPuzzle(`explain-h-${i}`, 3))];

  it(
    'discard: for every accepted answer of 365 dailies and 300 hard puzzles, in both languages',
    () => {
      const faults: string[] = [];
      let alternatives = 0;
      for (const p of discards) {
        for (const k of p.answers) {
          if (k !== p.best) alternatives++;
          const fault = discardFault(p, k);
          if (fault && faults.length < 5) faults.push(`${fault}: hand ${p.hand.join(',')} answers ${p.answers.join(',')} chosen ${en(k)}: ${answerExplanation(p, k)!.explanation}`);
        }
        // The puzzle's own answer, and a wrong one, keep the puzzle's own explanation.
        const own = {
          reasonKey: p.reasonKey,
          explanation: p.explanation,
          explanationZh: p.explanationZh,
        };
        expect(answerExplanation(p, p.best)).toEqual(own);
        const wrong = p.hand.find((k) => !p.answers.includes(k));
        if (wrong !== undefined) expect(answerExplanation(p, wrong)).toEqual(own);
      }
      expect(faults).toEqual([]);
      // Plenty of puzzles accept a second answer, so this is not checking an empty set.
      expect(alternatives).toBeGreaterThan(200);
    },
    timeBound(60_000),
  );

  it("defence, claim and value: an accepted answer other than the puzzle's own is explained by its own reason and names the other", () => {
    let alternatives = 0;
    for (let i = 0; i < 150; i++) {
      const d = (1 + (i % 3)) as 1 | 2 | 3;
      const f = defencePuzzle(`explain-d-${i}`, d);
      for (const k of f.answers.filter((a) => a !== f.answer)) {
        alternatives++;
        const x = answerExplanation(f, k)!;
        const reason = f.options.find((o) => o.kind === k)!.reason;
        expect(x.reasonKey).toBe(reason === 'middle' ? 'puzzle.defence.middleNear' : `puzzle.defence.${reason}`);
        expect(named(x, k) && named(x, f.answer)).toBe(true);
        expect(x.explanation).toContain('about as safe');
      }
      const c = claimPuzzle(`explain-c-${i}`, d);
      for (const id of c.answers.filter((a) => a !== c.answer.id)) {
        alternatives++;
        const o = c.options.find((x) => x.id === id)!;
        const x = answerExplanation(c, id)!;
        // A claim is said to bring the hand closer, or to make it ready, only when it does.
        const closer = o.shantenAfter < c.shantenBefore;
        const fits =
          o.type === 'hu'
            ? x.reasonKey === 'puzzle.claim.hu'
            : o.type === 'pass'
              ? x.reasonKey.startsWith('puzzle.claim.pass')
              : o.type === 'kong'
                ? x.reasonKey === 'puzzle.claim.kong'
                : closer
                  ? ['puzzle.claim.ready', 'puzzle.claim.closer'].includes(x.reasonKey)
                  : ['puzzle.claim.even', 'puzzle.claim.value'].includes(x.reasonKey);
        expect(fits, `${c.seed} ${id}: ${x.reasonKey}`).toBe(true);
        expect(x.explanation).toMatch(/about as good\./);
      }
      const v = valuePuzzle(`explain-v-${i}`, d);
      for (const k of v.answers.filter((a) => a !== v.answer)) {
        alternatives++;
        const x = answerExplanation(v, k)!;
        expect(x.reasonKey).toBe('puzzle.value.nearBest');
        expect(x.explanation.startsWith(`Throwing ${en(k)} is right too`)).toBe(true);
        expect(x.explanationZh.startsWith(`打${zh(k)}也算對`)).toBe(true);
        expect(named(x, v.answer)).toBe(true);
        // Then the puzzle's own comparison of the best and the rival, without repeating that this one counts too.
        expect(x.explanation).toContain(`Throwing ${en(v.answer)} leaves`);
        if (v.answers.length === 2) expect(x.explanation).not.toContain('counts too');
      }
      for (const p of [f, c, v]) {
        const own = {
          reasonKey: p.reasonKey,
          explanation: p.explanation,
          explanationZh: p.explanationZh,
        };
        expect(answerExplanation(p, p.type === 'claim' ? p.answer.id : p.answer)).toEqual(own);
      }
    }
    expect(alternatives).toBeGreaterThan(40);
  });
});

describe('claim and defence explanations say only what is true of the hand', () => {
  const claims = Array.from({ length: 600 }, (_, i) => claimPuzzle(`explain-cl-${i}`, (1 + (i % 3)) as 1 | 2 | 3));

  it('a claim that leaves the hand as far from ready as passing is not said to bring it closer, in either language; passing is named as an act', () => {
    let even = 0;
    for (const c of claims) {
      for (const id of c.answers) {
        const o = c.options.find((x) => x.id === id)!;
        if (o.type !== 'chi' && o.type !== 'pong') continue;
        const x = answerExplanation(c, id)!;
        if (o.shantenAfter < c.shantenBefore) continue;
        even++;
        expect(['puzzle.claim.closer', 'puzzle.claim.ready'], `${c.seed} ${id}`).not.toContain(x.reasonKey);
        expect(x.explanation).not.toMatch(/takes you from (\d+) to \1 /);
        expect(x.explanationZh).not.toMatch(/從差(\d+)張聽牌變成差\1張/);
        expect(x.explanation).toMatch(/as passing does/);
      }
      for (const id of c.answers) expect(answerExplanation(c, id)!.explanationZh).not.toContain('不要差不多');
    }
    expect(even).toBeGreaterThan(20);
  });

  it('counts of one take the singular in English: "1 tile from ready", "1 live winning tile"', () => {
    let ones = 0;
    for (const c of claims) {
      for (const id of c.answers) {
        const x = answerExplanation(c, id)!;
        expect(x.explanation, c.seed).not.toMatch(/\b1 tiles\b|\b1 live winning tiles\b/);
        if (/\b1 tile from ready\b|\b1 live winning tile\b/.test(x.explanation)) ones++;
      }
    }
    expect(ones).toBeGreaterThan(20);
  });

  it('a defence explanation says another tile would leave more useful tiles only when it leaves more than the tile explained', () => {
    let shown = 0;
    let ties = 0;
    for (let i = 0; i < 300; i++) {
      const f = defencePuzzle(`explain-tr-${i}`, (1 + (i % 3)) as 1 | 2 | 3);
      const acc = (k: number) => f.options.find((o) => o.kind === k)!.acceptance!;
      for (const k of f.answers) {
        const x = answerExplanation(f, k)!;
        const said = x.explanation.includes('would leave more useful tiles');
        expect(said, `${f.seed} ${k}`).toBe(x.explanationZh.includes('進張比較多'));
        if (said) {
          shown++;
          expect(acc(f.efficient), `${f.seed} ${k}`).toBeGreaterThan(acc(k));
        } else if (!f.answers.includes(f.efficient) && acc(f.efficient) === acc(k)) ties++;
      }
    }
    expect(shown).toBeGreaterThan(50);
    expect(ties).toBeGreaterThan(10);
  });
});
