import { describe, expect, it, jest } from '@jest/globals';
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { kindInfo, kindsFromString, LESSONS } from '@mjm/engine';
import { LearnScreen, LessonScreen } from './LearnScreen';
import { FakeProviders } from '../test/providers';
import { DEFAULT_PROGRESS, type Progress } from '../storage';

async function renderLearn(progress: Progress = DEFAULT_PROGRESS) {
  const go = jest.fn();
  await render(
    <FakeProviders app={{ go, progress, screen: { name: 'learn' } }}>
      <LearnScreen />
    </FakeProviders>,
  );
  return { go };
}

const first = LESSONS[0];

describe('the Learn screen', () => {
  it('welcomes a new player with one obvious first lesson', async () => {
    const { go } = await renderLearn();
    expect(screen.getByTestId('learn-welcome')).toBeOnTheScreen();
    expect(screen.getByText(`0/${LESSONS.length} lessons`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: `First lesson: ${first.title}` }));
    expect(go).toHaveBeenCalledWith({ name: 'lesson', id: first.id });
  });

  it('names what each practice button opens, and opens it', async () => {
    const { go } = await renderLearn();
    await fireEvent.press(screen.getByRole('button', { name: 'Solve: Daily puzzle' }));
    expect(go).toHaveBeenLastCalledWith({ name: 'daily' });
    await fireEvent.press(screen.getByRole('button', { name: 'Go: Puzzle Rush' }));
    expect(go).toHaveBeenLastCalledWith({ name: 'rush' });
  });

  it('offers Start on a lesson not done and Review on one done, each named after its lesson', async () => {
    const { go } = await renderLearn({ ...DEFAULT_PROGRESS, lessonsDone: { [first.id]: true } });
    expect(screen.queryByTestId('learn-welcome')).toBeNull();
    expect(screen.getByText(`1/${LESSONS.length} lessons`)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: `Review: ${first.title}` }));
    expect(go).toHaveBeenLastCalledWith({ name: 'lesson', id: first.id });
    const second = LESSONS[1];
    await fireEvent.press(screen.getByRole('button', { name: `Start: ${second.title}` }));
    expect(go).toHaveBeenLastCalledWith({ name: 'lesson', id: second.id });
  });

  it('shows every lesson and practice blurb whole: no line limit cuts a sentence', async () => {
    await renderLearn();
    // The sentences: the welcome, each practice card's text and each lesson's summary (buttons and pills keep one line).
    const sentences = screen.getAllByText(/\S/).filter((el) => /\w[^.!?]*[.!?]$/.test(String([el.props.children].flat().join(''))) && String([el.props.children].flat().join('')).length > 30);
    expect(sentences.length).toBeGreaterThan(LESSONS.length);
    for (const el of sentences) expect(el.props.numberOfLines).toBeUndefined();
  });
});

/** A lesson with a quiz on one of its steps. */
const quizLesson = LESSONS.find((l) => l.steps.some((s) => s.quiz))!;
const quizStep = quizLesson.steps.findIndex((s) => s.quiz);
const quiz = quizLesson.steps[quizStep].quiz!;
const nameOf = (code: string) => kindInfo(kindsFromString(code)[0]).nameEn;

async function renderLesson() {
  const back = jest.fn();
  const setProgress = jest.fn();
  await render(
    <FakeProviders app={{ back, setProgress, screen: { name: 'lesson', id: quizLesson.id } }}>
      <LessonScreen id={quizLesson.id} />
    </FakeProviders>,
  );
  for (let i = 0; i < quizStep; i++) await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
  return { back, setProgress };
}

describe('a lesson', () => {
  it('holds Next back until the quiz is answered, and lets a wrong pick be tried again', async () => {
    await renderLesson();
    const forward = () => screen.getByRole('button', { name: quizStep === quizLesson.steps.length - 1 ? /^(Finish lesson|Leave lesson)$/ : 'Next' });
    expect(forward()).toBeDisabled();
    const wrong = kindsFromString(quiz.hand).map((k) => kindInfo(k).nameEn).find((n) => n !== nameOf(quiz.answer))!;
    await fireEvent.press(screen.getAllByRole('button', { name: wrong })[0]);
    expect(screen.getByText(/^Not quite: tap another tile to try again\./)).toBeOnTheScreen();
    await fireEvent.press(screen.getAllByRole('button', { name: nameOf(quiz.answer) })[0]);
    expect(screen.getByText(/^Correct!/)).toBeOnTheScreen();
    expect(forward()).toBeEnabled();
  });

  it('counts as done only when every quiz is answered, and then shows the lesson end', async () => {
    const { setProgress, back } = await renderLesson();
    for (let i = quizStep; i < quizLesson.steps.length; i++) {
      const q = quizLesson.steps[i].quiz;
      if (q) await fireEvent.press(screen.getAllByRole('button', { name: nameOf(q.answer) })[0]);
      if (i < quizLesson.steps.length - 1) await fireEvent.press(screen.getByRole('button', { name: 'Next' }));
    }
    await fireEvent.press(screen.getByRole('button', { name: 'Finish lesson' }));
    expect(setProgress).toHaveBeenCalled();
    expect(screen.getByTestId('lesson-end')).toBeOnTheScreen();
    expect(screen.getByText('Lesson complete!')).toBeOnTheScreen();
    expect(back).not.toHaveBeenCalled();
  });
});
