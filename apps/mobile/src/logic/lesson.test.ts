import { describe, expect, it } from 'vitest';
import { LESSONS } from '@mjm/engine';
import { lessonAnswers, lessonComplete, stepAnswer } from './lesson';

const steps = [{ title: 'Intro' }, { quiz: { answer: 'C' } }, { title: 'Read' }, { quiz: { answer: '1m' } }];

describe('stepAnswer', () => {
  it('distinguishes steps without a quiz, unanswered, right and wrong', () => {
    expect(stepAnswer({}, 'C')).toBe('none');
    expect(stepAnswer({ quiz: { answer: 'C' } }, undefined)).toBe('unanswered');
    expect(stepAnswer({ quiz: { answer: 'C' } }, null)).toBe('unanswered');
    expect(stepAnswer({ quiz: { answer: 'C' } }, 'C')).toBe('correct');
    expect(stepAnswer({ quiz: { answer: 'C' } }, 'F')).toBe('wrong');
  });
});

describe('lessonComplete', () => {
  it('requires every quiz to be answered correctly', () => {
    expect(lessonComplete(lessonAnswers(steps, { 1: 'C', 3: '1m' }))).toBe(true);
  });

  it('is false when a quiz was answered wrongly', () => {
    expect(lessonComplete(lessonAnswers(steps, { 1: 'C', 3: '2m' }))).toBe(false);
  });

  it('is false when a quiz was skipped', () => {
    expect(lessonComplete(lessonAnswers(steps, { 1: 'C' }))).toBe(false);
  });

  it('a later correct pick replaces an earlier wrong one', () => {
    const picks: Record<number, string> = { 1: 'F', 3: '1m' };
    expect(lessonComplete(lessonAnswers(steps, picks))).toBe(false);
    picks[1] = 'C';
    expect(lessonComplete(lessonAnswers(steps, picks))).toBe(true);
  });

  it('a lesson without quizzes is complete once read', () => {
    expect(lessonComplete(lessonAnswers([{}, {}], {}))).toBe(true);
  });

  it('every shipped lesson with a quiz is incomplete until its answers are given', () => {
    const quizzed = LESSONS.filter((l) => l.steps.some((s) => s.quiz));
    expect(quizzed.length).toBeGreaterThan(0);
    for (const l of quizzed) {
      expect(lessonComplete(lessonAnswers(l.steps, {}))).toBe(false);
      const right: Record<number, string> = {};
      l.steps.forEach((s, i) => {
        if (s.quiz) right[i] = s.quiz.answer;
      });
      expect(lessonComplete(lessonAnswers(l.steps, right))).toBe(true);
    }
  });
});
