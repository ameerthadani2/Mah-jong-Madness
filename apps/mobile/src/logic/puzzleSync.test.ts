import { describe, expect, it } from 'vitest';
import { dailyPuzzleForKey, rushRunPuzzle, type PuzzleAnswerInput } from '@mjm/engine';
import { ApiError } from '../api/http';
import { puzzleErrorMessage, type DailyFinish, type RushFinish } from '../api/puzzles';
import { createServerRatingStore, openDaily, openRush, shouldReadRating, shownRating, submitDaily, submitRush, SERVER_RATING_FRESH_MS, type PuzzleServer } from './puzzleSync';
import { checkPuzzleAnswer, wireAnswer } from './puzzle';
import { rushPuzzleAt } from './rush';

const down = () => Promise.reject(new ApiError('Could not reach the game server', 'puzzle_unreachable'));

/** A fake server that records calls; each route answers what the test sets. */
function fake(over: Partial<PuzzleServer> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const server: PuzzleServer = {
    startDaily: async (date) => (calls.push(['startDaily', date]), { attemptId: 'att-1', date, startedAt: '2026-11-16T10:00:00.000Z' }),
    finishDaily: async (id, answer) => (calls.push(['finishDaily', id, answer]), { date: '2026-11-16', correct: true, seconds: 40, rating: { rating: 1012, change: 12, rated: 1 } }),
    startRush: async () => (calls.push(['startRush']), { runId: 'run-1', seed: 'rush-0011223344556677', startedAt: '', expiresAt: '', seconds: 180, strikes: 3 }),
    finishRush: async (id, answers) => (calls.push(['finishRush', id, answers]), { runId: id, solved: 2, wrong: 1, seconds: 31, score: 190, answers: [], rating: { rating: 1020, change: 20, rated: 3 } }),
    getPuzzleRating: async () => (calls.push(['getPuzzleRating']), { rating: 1100, rated: 9, updatedAt: null }),
    ...over,
  };
  return { server, calls };
}

describe('the daily puzzle through the server', () => {
  it('starts the attempt when the puzzle opens and finishes it with the answer; the server’s time and rating are shown', async () => {
    const { server, calls } = fake();
    const link = await openDaily(server, '2026-11-16');
    expect(link).toEqual({ ranked: true, attemptId: 'att-1', startedAt: '2026-11-16T10:00:00.000Z' });
    const out = await submitDaily(server, link, 7, true);
    expect(out).toEqual({ ranked: true, correct: true, seconds: 40, rating: { rating: 1012, change: 12, rated: 1 }, mismatch: false });
    expect(calls).toEqual([
      ['startDaily', '2026-11-16'],
      ['finishDaily', 'att-1', 7],
    ]);
  });

  it('shows the server’s verdict when it differs from the device’s, and logs it', async () => {
    const logged: string[] = [];
    const { server } = fake({ finishDaily: async () => ({ date: 'd', correct: false, seconds: 9, rating: { rating: 990, change: -10, rated: 1 } }) as DailyFinish });
    const out = await submitDaily(server, await openDaily(server, 'd'), 7, true, (m) => logged.push(m));
    expect(out).toMatchObject({ ranked: true, correct: false, mismatch: true });
    expect(logged).toHaveLength(1);
  });

  it('plays locally, unranked, when the server cannot be reached or there is no session', async () => {
    const offline = fake({ startDaily: down });
    const link = await openDaily(offline.server, '2026-11-16');
    expect(link).toMatchObject({ ranked: false, down: true });
    expect(await submitDaily(offline.server, link, 7, true)).toMatchObject({ ranked: false, down: true });
    expect(offline.calls).toEqual([]);
    expect(await openDaily(null, '2026-11-16')).toEqual({ ranked: false, down: true });
    // The start answered but the finish could not be sent: unranked, the device's result stands.
    const lost = fake({ finishDaily: down });
    expect(await submitDaily(lost.server, await openDaily(lost.server, 'd'), 7, true)).toMatchObject({ ranked: false, down: true });
  });

  it('keeps a refusal as a refusal (played on another device): not "down", with the code to show', async () => {
    const { server } = fake({ startDaily: () => Promise.reject(new ApiError('already', 'already_played', 409)) });
    const link = await openDaily(server, 'd');
    expect(link).toMatchObject({ ranked: false, down: false, error: { code: 'already_played' } });
  });

  it('sends the answer in the server’s shape: the same one the device judged', () => {
    const p = dailyPuzzleForKey('2026-11-16')!;
    const answer = wireAnswer(p.answers[0]);
    expect(answer).toBe(p.answers[0]);
    expect(checkPuzzleAnswer(p, p.answers[0])).toBe(true);
    expect(wireAnswer({ id: 'chi:1-2' } as never)).toBe('chi:1-2');
    expect(wireAnswer([3, 4])).toEqual([3, 4]);
  });
});

describe('results under the server’s human-time floors', () => {
  it('reads a daily answer or a Rush run the server recorded but did not rank as not ranked, with its own line', async () => {
    const { server } = fake({
      finishDaily: async () => ({ date: 'd', correct: true, seconds: 2, ranked: false, rating: { rating: 1000, change: 0, rated: 0 } }) as DailyFinish,
      finishRush: async (id) => ({ runId: id, solved: 20, wrong: 0, seconds: 29, score: 3000, ranked: false, answers: [], rating: { rating: 1000, change: 0, rated: 0 } }) as RushFinish,
    });
    const daily = await submitDaily(server, await openDaily(server, 'd'), 7, true);
    const rush = await submitRush(server, await openRush(server, 'x'), [1, 2], 2);
    for (const out of [daily, rush]) {
      expect(out).toMatchObject({ ranked: false, down: false, error: { code: 'too_fast_to_rank' } });
      if (out.ranked) throw new Error('ranked');
      expect(puzzleErrorMessage(out.error).key).toBe('puzzles.server.errors.tooFastToRank');
    }
  });
});

describe('Puzzle Rush through the server', () => {
  it('uses the server’s seed for every puzzle, then finishes once with every answer in order', async () => {
    const { server, calls } = fake();
    const link = await openRush(server, 'rush-local');
    expect(link).toEqual({ ranked: true, runId: 'run-1', seed: 'rush-0011223344556677' });
    // The app's puzzle sequence is the engine's, the one the server regenerates.
    expect(rushPuzzleAt(link.seed, 4)).toEqual(rushRunPuzzle(link.seed, 4));
    const answers: PuzzleAnswerInput[] = [1, [2, 3], 'pass'];
    const out = await submitRush(server, link, answers, 2);
    expect(out).toEqual({ ranked: true, solved: 2, seconds: 31, score: 190, rating: { rating: 1020, change: 20, rated: 3 }, mismatch: false });
    expect(calls).toEqual([['startRush'], ['finishRush', 'run-1', answers]]);
  });

  it('shows the server’s score even when its clock makes it lower than the device’s estimate', async () => {
    const logged: string[] = [];
    const { server } = fake({ finishRush: async (id) => ({ runId: id, solved: 3, wrong: 0, seconds: 62, score: 280, answers: [], rating: { rating: 1030, change: 30, rated: 3 } }) as RushFinish });
    const out = await submitRush(server, await openRush(server, 'x'), [1, 2, 3], 4, (m) => logged.push(m));
    expect(out).toMatchObject({ ranked: true, score: 280, seconds: 62, solved: 3, mismatch: true });
    expect(logged).toHaveLength(1);
  });

  it('runs on a local seed, unranked, when the server cannot be reached', async () => {
    const { server, calls } = fake({ startRush: down });
    const link = await openRush(server, 'rush-local');
    expect(link).toMatchObject({ ranked: false, seed: 'rush-local', down: true });
    expect(await submitRush(server, link, [1], 1)).toMatchObject({ ranked: false, down: true });
    expect(calls).toEqual([]);
    expect(await openRush(null, 'rush-local')).toEqual({ ranked: false, seed: 'rush-local', down: true });
  });

  it('passes on an expired run as a refusal the screen can offer a new run for', async () => {
    const { server } = fake({ finishRush: () => Promise.reject(new ApiError('expired', 'run_expired', 410)) });
    expect(await submitRush(server, await openRush(server, 'x'), [1], 1)).toMatchObject({ ranked: false, down: false, error: { code: 'run_expired' } });
  });
});

describe('the rating the screens show', () => {
  it('is the server’s when it was read for this account, else the device’s', () => {
    const store = createServerRatingStore();
    expect(shownRating(1040, 8, store.forUser('u-1'))).toEqual({ rating: 1040, change: 8, source: 'device' });
    let seen = 0;
    const off = store.subscribe(() => seen++);
    store.read('u-1', { rating: 1100, rated: 9, updatedAt: null }, 1000);
    expect(shownRating(1040, 8, store.forUser('u-1'))).toEqual({ rating: 1100, change: null, source: 'server' });
    // Another account on this device does not see it.
    expect(store.forUser('u-2')).toBeNull();
    expect(store.forUser(null)).toBeNull();
    store.submitted('u-1', { rating: 1112, change: 12, rated: 10 }, 2000);
    expect(shownRating(1040, 8, store.forUser('u-1'))).toEqual({ rating: 1112, change: 12, source: 'server' });
    store.clearChange();
    expect(store.get()?.change).toBeNull();
    off();
    store.clear();
    expect(seen).toBe(3);
    expect(store.get()).toBeNull();
  });

  it('is read again when a screen opens only once it is a minute old', () => {
    const store = createServerRatingStore();
    expect(shouldReadRating(null, 0)).toBe(true);
    store.read('u', { rating: 1000, rated: 0, updatedAt: null }, 10_000);
    expect(shouldReadRating(store.get(), 10_000 + SERVER_RATING_FRESH_MS - 1)).toBe(false);
    expect(shouldReadRating(store.get(), 10_000 + SERVER_RATING_FRESH_MS)).toBe(true);
  });
});
