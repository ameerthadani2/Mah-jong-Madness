/**
 * What the puzzle render tests cannot see: both locales carry the Puzzle Rush leave question. The drill's difficulty
 * switch, Puzzle Rush's free run, its leave question and its record, and the record-and-tip foot under Rush and the
 * drills are rendered in Puzzles.render.test.tsx; the daily puzzle, its foot and its server clock in
 * Daily.render.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en/puzzles.json';
import zh from '../i18n/locales/zh-TW/puzzles.json';

describe('leaving Puzzle Rush mid-run', () => {
  it('asks in both languages', () => {
    expect(en.rush.leaveTitle).toBeTruthy();
    expect(zh.rush.leaveTitle).toBeTruthy();
  });
});
