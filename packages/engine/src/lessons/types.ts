/**
 * Lesson data model. Content is data so the app can render it, track progress, and the
 * coach can link scoring items back to lessons. Every text field has a Traditional Chinese
 * twin (`…Zh`) written for players in Taiwan; hand notation and tile codes are shared.
 */
export interface LessonQuiz {
  prompt: string;
  promptZh: string;
  hand: string;
  answer: string;
  explanation: string;
  explanationZh: string;
}

export interface LessonStep {
  title: string;
  titleZh: string;
  body: string;
  bodyZh: string;
  /** Optional compact hand to display, e.g. "123m 456p 789s EEE CC". */
  hand?: string;
  /** Optional quiz: which discard is best? Answer as a tile code. */
  quiz?: LessonQuiz;
}

export type LessonTrack = 'basics' | 'efficiency' | 'calling' | 'value' | 'defence' | 'scoring';

export const LESSON_TRACKS: ReadonlyArray<{ id: LessonTrack; name: string; nameZh: string }> = [
  { id: 'basics', name: 'Basics', nameZh: '入門' },
  { id: 'efficiency', name: 'Tile efficiency', nameZh: '牌效率' },
  { id: 'calling', name: 'Calling and shape', nameZh: '吃碰與牌型' },
  { id: 'value', name: '台 value', nameZh: '做台' },
  { id: 'defence', name: 'Defence', nameZh: '防守' },
  { id: 'scoring', name: 'Scoring', nameZh: '算台' },
];

export interface Lesson {
  id: string;
  /** Which learning track the lesson belongs to; the app groups lessons by track in order. */
  track: LessonTrack;
  title: string;
  titleZh: string;
  minutes: number;
  summary: string;
  summaryZh: string;
  steps: LessonStep[];
}

