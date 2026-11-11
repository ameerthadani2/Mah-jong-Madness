import { describe, expect, it } from 'vitest';
import { countsFromKinds, discardOptions, kindFromCode, kindsFromString, LESSONS, NUM_PLAY_KINDS, waitChance, waits, type OpponentRead } from '../src/index';

const quizzes = LESSONS.flatMap((l) => l.steps.filter((st) => st.quiz).map((st) => ({ lesson: l.id, title: st.title, quiz: st.quiz! })));

describe('lesson quizzes', () => {
  it('has quizzes to check', () => {
    expect(quizzes.length).toBeGreaterThanOrEqual(3);
  });

  for (const { lesson, title, quiz } of quizzes) {
    it(`${lesson} / ${title}: the engine agrees with the answer`, () => {
      const kinds = kindsFromString(quiz.hand);
      expect([16, 17]).toContain(kinds.length);
      const counts = countsFromKinds(kinds);
      for (const c of counts) expect(c).toBeLessThanOrEqual(4);
      const answer = kindFromCode(quiz.answer);
      if (kinds.length === 16) {
        // A waits question: the answer must be one of the tiles that completes the hand.
        expect(waits(counts, 5)).toContain(answer);
      } else {
        // A discard question: the answer must be among the engine's best discards
        // (lowest shanten, then most unseen accepting tiles), and the only one, since the app accepts a single answer.
        expect(counts[answer]).toBeGreaterThan(0);
        const unseen = Array.from({ length: NUM_PLAY_KINDS }, (_, k) => 4 - counts[k]);
        const options = discardOptions(counts, 5, unseen);
        const bestShanten = Math.min(...options.map((o) => o.shanten));
        const atBest = options.filter((o) => o.shanten === bestShanten);
        const bestAcceptance = Math.max(...atBest.map((o) => o.acceptance));
        const top = atBest.filter((o) => o.acceptance === bestAcceptance).map((o) => o.kind);
        expect(top).toEqual([answer]);
      }
    });
  }
});

/** Han characters: a Traditional Chinese field must contain some, not only tile codes and numbers. */
const HAN = /[一-鿿]/;

describe('lesson translations', () => {
  const pairs: Array<[string, string, string]> = [];
  for (const l of LESSONS) {
    pairs.push([`${l.id} title`, l.title, l.titleZh], [`${l.id} summary`, l.summary, l.summaryZh]);
    l.steps.forEach((st, i) => {
      pairs.push([`${l.id}[${i}] title`, st.title, st.titleZh], [`${l.id}[${i}] body`, st.body, st.bodyZh]);
      if (st.quiz) pairs.push([`${l.id}[${i}] quiz prompt`, st.quiz.prompt, st.quiz.promptZh], [`${l.id}[${i}] quiz explanation`, st.quiz.explanation, st.quiz.explanationZh]);
    });
  }

  it('every lesson, step and quiz has Chinese text that differs from the English', () => {
    expect(pairs.length).toBeGreaterThan(LESSONS.length * 4);
    for (const [where, en, zh] of pairs) {
      expect(typeof zh, where).toBe('string');
      expect(zh.trim().length, where).toBeGreaterThan(0);
      expect(zh, where).not.toBe(en);
      expect(zh, where).toMatch(HAN);
    }
  });

  it('the Chinese explanations keep the tile codes the English ones use', () => {
    const codes = (s: string) => (s.match(/\d+[mps]/g) ?? []).sort();
    for (const l of LESSONS) {
      for (const st of l.steps) {
        if (!st.quiz) continue;
        expect(codes(st.quiz.explanationZh), `${l.id} ${st.title}`).toEqual(codes(st.quiz.explanation));
      }
    }
  });
});

describe('defence lessons and the coach agree on which tiles are safest', () => {
  const read = (over: Partial<OpponentRead>): OpponentRead => ({
    seat: 1,
    tenpai: 1,
    valueTai: 2,
    flushSuit: -1,
    ownDiscards: new Array<boolean>(NUM_PLAY_KINDS).fill(false),
    passed: new Array<boolean>(NUM_PLAY_KINDS).fill(false),
    ...over,
  });
  const mark = (k: number) => new Array<boolean>(NUM_PLAY_KINDS).fill(false).map((_, i) => i === k);
  const unseenWith = (k: number, n: number) => new Array<number>(NUM_PLAY_KINDS).fill(4).map((c, i) => (i === k ? n : c));
  const step = (lesson: string, title: string) => LESSONS.find((l) => l.id === lesson)!.steps.find((st) => st.title === title)!;

  it('the coach rates a kind the opponent threw as safer than one it let pass, for every tile', () => {
    let worstOwn = 0;
    let worstPassed = 0;
    for (let k = 0; k < NUM_PLAY_KINDS; k++) {
      for (let n = 0; n <= 3; n++) {
        const unseen = unseenWith(k, n);
        const own = waitChance(read({ ownDiscards: mark(k) }), k, unseen);
        const passed = waitChance(read({ passed: mark(k) }), k, unseen);
        const plain = waitChance(read({}), k, unseen);
        if (plain === 0) continue; // a dead honour: nothing to compare
        expect(own, `kind ${k}, ${n} unseen`).toBeLessThan(passed);
        expect(passed, `kind ${k}, ${n} unseen`).toBeLessThan(plain);
        worstOwn = Math.max(worstOwn, own);
        worstPassed = Math.max(worstPassed, passed);
      }
    }
    // The rungs of the ladder as the lesson gives them: their own discards, then (about level) the
    // last honour and a tile let pass, then other honours.
    const east = 27;
    const lastHonour = waitChance(read({}), east, unseenWith(east, 1));
    const otherHonour = waitChance(read({}), east, unseenWith(east, 2));
    expect(worstOwn).toBeLessThan(lastHonour);
    expect(worstPassed).toBeLessThan(otherHonour);
    expect(lastHonour).toBeLessThan(otherHonour);
  });

  it('the lesson text gives the same order, in both languages', () => {
    const ladder = step('def-safe-tiles', 'A safety ladder');
    const before = (text: string, first: string, second: string) => {
      expect(text).toContain(first);
      expect(text).toContain(second);
      expect(text.indexOf(first)).toBeLessThan(text.indexOf(second));
    };
    before(ladder.body, 'honours with all four visible', 'kinds they threw themselves');
    before(ladder.body, 'kinds they threw themselves', 'that they let pass');
    before(ladder.body, 'that they let pass', 'other honours');
    before(ladder.bodyZh, '四張都看得到的字牌', '他自己打過的牌');
    before(ladder.bodyZh, '他自己打過的牌', '他沒有胡的牌');
    before(ladder.bodyZh, '他沒有胡的牌', '其他字牌');
    // A tile let pass is not called safer than their own discard anywhere.
    const danger = step('def-fold', 'How dangerous each tile is');
    expect(danger.body).not.toMatch(/even less/);
    expect(danger.bodyZh).not.toContain('更不會是');
    expect(danger.body).toContain('only a little more often');
    const fresh = step('def-discards', 'Fresh information');
    expect(fresh.body).not.toMatch(/strongest clue/i);
    expect(fresh.body).toContain('a little less safe than one they threw themselves');
  });
});
