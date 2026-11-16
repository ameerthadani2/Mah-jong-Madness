/**
 * How long a lesson takes, measured from its text: English at about 200 words a minute, Traditional Chinese
 * at about 400 characters a minute, plus half a minute to work out each quiz. `Lesson.minutes` is the English
 * figure (test/lessons.test.ts keeps it within 25% of this measure); the app shows the measure for the
 * reader's language.
 */
import type { Lesson } from './types';

export const READING_PACE = { wordsPerMinute: 200, charsPerMinute: 400, quizMinutes: 0.5 } as const;

export type LessonLanguage = 'en' | 'zh-TW';

/** Words in English text: each run of letters or digits (a tile code such as 234m is one) and each run of Han characters. */
function englishWords(s: string): number {
  return (s.match(/[A-Za-z0-9'’]+|[㐀-鿿]+/g) ?? []).length;
}

/** Characters in Chinese text: each Han character, and each run of letters or digits (a tile code) as one. */
function chineseChars(s: string): number {
  return (s.match(/[㐀-鿿]/g) ?? []).length + (s.match(/[A-Za-z0-9]+/g) ?? []).length;
}

function lessonText(l: Lesson, lang: LessonLanguage): string {
  const zh = lang === 'zh-TW';
  const parts = [zh ? l.titleZh : l.title, zh ? l.summaryZh : l.summary];
  for (const s of l.steps) {
    parts.push(zh ? s.titleZh : s.title, zh ? s.bodyZh : s.body);
    if (s.quiz) parts.push(zh ? s.quiz.promptZh : s.quiz.prompt, zh ? s.quiz.explanationZh : s.quiz.explanation);
  }
  return parts.join(' ');
}

/** Measured minutes, unrounded: reading time in `lang` plus the quizzes. */
export function readingMinutes(l: Lesson, lang: LessonLanguage): number {
  const text = lessonText(l, lang);
  const reading = lang === 'zh-TW' ? chineseChars(text) / READING_PACE.charsPerMinute : englishWords(text) / READING_PACE.wordsPerMinute;
  return reading + READING_PACE.quizMinutes * l.steps.filter((s) => s.quiz).length;
}

/** The minutes to show for a lesson read in `lang`: the measure rounded to a whole minute, at least 1. */
export function lessonMinutes(l: Lesson, lang: LessonLanguage): number {
  return Math.max(1, Math.round(readingMinutes(l, lang)));
}
