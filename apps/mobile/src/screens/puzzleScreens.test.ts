/**
 * Source checks for the puzzle screens that the render tests do not reach. The drill's difficulty switch, Puzzle
 * Rush's free run, its leave question and its record, and the record-and-tip foot under Rush and the drills are
 * rendered in Puzzles.render.test.tsx; the daily puzzle (which reads the day's puzzle from the server) is checked here.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import en from '../i18n/locales/en/puzzles.json';
import zh from '../i18n/locales/zh-TW/puzzles.json';

const read = (f: string) => readFileSync(join(__dirname, f), 'utf8');

describe('leaving Puzzle Rush mid-run', () => {
  it('asks in both languages', () => {
    expect(en.rush.leaveTitle).toBeTruthy();
    expect(zh.rush.leaveTitle).toBeTruthy();
  });
});

describe('the tall daily puzzle screen', () => {
  it('fills the space under the puzzle with the player’s record and a tip', () => {
    const src = read('PuzzleScreens.tsx');
    expect(src.slice(src.indexOf('export function DailyPuzzleScreen'), src.indexOf('export function PuzzleRushScreen'))).toMatch(/<PuzzleFoot/);
  });
});
