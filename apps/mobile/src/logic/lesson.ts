import { kindFromCode } from '@mjm/engine';

/** Where a lesson step stands: no quiz, not yet answered, or answered right or wrong. */
export type StepAnswer = 'none' | 'unanswered' | 'correct' | 'wrong';

interface QuizStep {
  quiz?: { answer: string };
}

/** The answer state of one step, given the tile code the player last picked for it. */
export function stepAnswer(step: QuizStep, picked: string | null | undefined): StepAnswer {
  if (!step.quiz) return 'none';
  if (picked === null || picked === undefined) return 'unanswered';
  return kindFromCode(picked) === kindFromCode(step.quiz.answer) ? 'correct' : 'wrong';
}

/** Per-step answer states for a lesson, from the picks keyed by step index. */
export function lessonAnswers(steps: readonly QuizStep[], picks: Readonly<Record<number, string>>): StepAnswer[] {
  return steps.map((s, i) => stepAnswer(s, picks[i]));
}

/** A lesson counts as done only when every quiz in it has been answered correctly. */
export function lessonComplete(answers: readonly StepAnswer[]): boolean {
  return answers.every((a) => a === 'none' || a === 'correct');
}
