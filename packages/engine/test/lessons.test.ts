import { describe, expect, it } from 'vitest';
import { countsFromKinds, discardOptions, kindFromCode, kindsFromString, LESSONS, NUM_PLAY_KINDS, waits } from '../src/index';

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
