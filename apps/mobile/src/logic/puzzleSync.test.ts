import { describe, expect, it } from 'vitest';
import { dailyPuzzleDifficulty, dailyPuzzleForKey, dateOfDailyKey, leakedFields, puzzleQuestion, rushDifficultyAt, rushRunPuzzle } from '@mjm/engine';
import { ApiError } from '../api/http';
import { puzzleErrorMessage, type DailyFinish, type RushFinish, type RushServed } from '../api/puzzles';
import { createServerRatingStore, openDaily, openRush, sendRushAnswer, shouldReadRating, shownRating, submitDaily, submitRush, SERVER_RATING_FRESH_MS, type PuzzleServer } from './puzzleSync';
import { checkPuzzleAnswer, wireAnswer } from './puzzle';
import { rushPuzzleAt } from './rush';

/** The `index`-th puzzle of a run the fake server serves: the engine's, as its question, as the real server makes it. */
const served = (index: number): RushServed => {
  const puzzle = rushRunPuzzle('rush-0011223344556677', index);
  return { index, type: puzzle.type, question: { ...puzzleQuestion(puzzle, rushDifficultyAt(index)), seed: `run-1:${index}` } };
};
/** The same puzzle whole, as the server reveals it with the verdict. */
const revealedAt = (index: number) => ({ ...rushRunPuzzle('rush-0011223344556677', index), seed: `run-1:${index}` });
const DAILY = dailyPuzzleForKey('2026-11-16')!;
const RIGHT = DAILY.answers[0];
const QUESTION = puzzleQuestion(DAILY, dailyPuzzleDifficulty(dateOfDailyKey('2026-11-16')!));
const down = () => Promise.reject(new ApiError('Could not reach the game server', 'puzzle_unreachable'));

/** A fake server that records calls; each route answers what the test sets. */
function fake(over: Partial<PuzzleServer> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const server: PuzzleServer = {
    startDaily: async (date) => (calls.push(['startDaily', date]), { attemptId: 'att-1', date, startedAt: '2026-11-16T10:00:00.000Z', question: QUESTION }),
    finishDaily: async (id, answer) => (calls.push(['finishDaily', id, answer]), { date: '2026-11-16', correct: true, seconds: 40, rating: { rating: 1012, change: 12, rated: 1 }, revealed: DAILY }),
    startRush: async () => (calls.push(['startRush']), { runId: 'run-1', startedAt: '', expiresAt: '', seconds: 180, strikes: 3, next: served(0) }),
    answerRush: async (id, index, answer) => (calls.push(['answerRush', id, index, answer]), { index, counted: true, correct: true, solved: index + 1, wrong: 0, revealed: revealedAt(index), done: false, next: served(index + 1) }),
    finishRush: async (id) => (calls.push(['finishRush', id]), { runId: id, solved: 2, wrong: 1, seconds: 31, score: 190, answers: [], rating: { rating: 1020, change: 20, rated: 3 } }),
    getPuzzleRating: async () => (calls.push(['getPuzzleRating']), { rating: 1100, rated: 9, updatedAt: null }),
    openReview: async (hand) => (calls.push(['openReview', hand]), { counted: true, unlimited: false, used: 1, limit: 1, resetsAt: null }),
    ...over,
  };
  return { server, calls };
}

describe('the daily puzzle through the server', () => {
  it('starts the attempt when the puzzle opens and finishes it with the answer; the server’s time and rating are shown', async () => {
    const { server, calls } = fake();
    const link = await openDaily(server, '2026-11-16');
    // The link holds the question only: nothing in it gives the answer away.
    expect(link).toEqual({ ranked: true, attemptId: 'att-1', startedAt: '2026-11-16T10:00:00.000Z', question: QUESTION });
    expect(leakedFields(QUESTION as never)).toEqual([]);
    const out = await submitDaily(server, link, RIGHT);
    expect(out).toEqual({ ranked: true, correct: true, seconds: 40, rating: { rating: 1012, change: 12, rated: 1 }, revealed: DAILY, mismatch: false });
    expect(calls).toEqual([
      ['startDaily', '2026-11-16'],
      ['finishDaily', 'att-1', RIGHT],
    ]);
  });

  it('shows the server’s verdict when it differs from the device’s check of the revealed puzzle, and logs it', async () => {
    const logged: string[] = [];
    const { server } = fake({ finishDaily: async () => ({ date: 'd', correct: false, seconds: 9, rating: { rating: 990, change: -10, rated: 1 }, revealed: DAILY }) as DailyFinish });
    const out = await submitDaily(server, await openDaily(server, 'd'), RIGHT, (m) => logged.push(m));
    expect(out).toMatchObject({ ranked: true, correct: false, mismatch: true });
    expect(logged).toHaveLength(1);
  });

  it('plays locally, unranked, when the server cannot be reached or there is no session', async () => {
    const offline = fake({ startDaily: down });
    const link = await openDaily(offline.server, '2026-11-16');
    expect(link).toMatchObject({ ranked: false, down: true });
    expect(await submitDaily(offline.server, link, 7)).toMatchObject({ ranked: false, down: true });
    expect(offline.calls).toEqual([]);
    expect(await openDaily(null, '2026-11-16')).toEqual({ ranked: false, down: true });
    // The start answered but the finish could not be sent: unranked, the device's result stands.
    const lost = fake({ finishDaily: down });
    expect(await submitDaily(lost.server, await openDaily(lost.server, 'd'), 7)).toMatchObject({ ranked: false, down: true });
  });

  it('keeps a refusal as a refusal (played on another device): not "down", with the code to show', async () => {
    const { server } = fake({ startDaily: () => Promise.reject(new ApiError('already', 'already_played', 409)) });
    const link = await openDaily(server, 'd');
    expect(link).toMatchObject({ ranked: false, down: false, error: { code: 'already_played' } });
  });

  it('plays here, unranked, when the start brings no question or the answer no revealed puzzle', async () => {
    const noQuestion = fake({ startDaily: async (date) => ({ attemptId: 'a', date, startedAt: '' }) as never });
    expect(await openDaily(noQuestion.server, 'd')).toMatchObject({ ranked: false, down: true, error: { code: 'puzzle_bad_reply' } });
    const noReveal = fake({ finishDaily: async () => ({ date: 'd', correct: true, seconds: 9, rating: { rating: 990, change: -10, rated: 1 } }) as never });
    expect(await submitDaily(noReveal.server, await openDaily(noReveal.server, 'd'), RIGHT)).toMatchObject({ ranked: false, down: true, error: { code: 'puzzle_bad_reply' } });
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
    const daily = await submitDaily(server, await openDaily(server, 'd'), 7);
    const rush = await submitRush(server, await openRush(server, 'x'), 2);
    for (const out of [daily, rush]) {
      expect(out).toMatchObject({ ranked: false, down: false, error: { code: 'too_fast_to_rank' } });
      if (out.ranked) throw new Error('ranked');
      expect(puzzleErrorMessage(out.error).key).toBe('puzzles.server.errors.tooFastToRank');
    }
  });

  it('says a Rush run the server held over its ceiling waits for a person, not that it was too fast', async () => {
    const { server } = fake({
      finishRush: async (id) => ({ runId: id, solved: 40, wrong: 1, seconds: 180, score: 4000, ranked: false, held: true, answers: [], rating: { rating: 1000, change: 0, rated: 0 } }) as RushFinish,
    });
    const out = await submitRush(server, await openRush(server, 'x'), 40);
    expect(out).toMatchObject({ ranked: false, down: false, error: { code: 'rush_held' } });
    if (out.ranked) throw new Error('ranked');
    expect(puzzleErrorMessage(out.error).key).toBe('puzzles.server.errors.rushHeld');
  });
});

describe('Puzzle Rush through the server', () => {
  it('plays the server’s puzzles one at a time: each answer is posted as it is made and brings the next puzzle', async () => {
    const { server, calls } = fake();
    const link = await openRush(server, 'rush-local');
    expect(link).toEqual({ ranked: true, runId: 'run-1', first: served(0) });
    // The seed stays on the server: the link has the first puzzle, not the seed.
    expect(JSON.stringify(link)).not.toContain('rush-0011223344556677');
    // Each answer brings its verdict, the whole puzzle it answered and the next question.
    const step = await sendRushAnswer(server, link, 0, 5, 0);
    expect(step).toEqual({ kind: 'next', next: served(1), correct: true, revealed: revealedAt(0) });
    expect(leakedFields(served(1).question as never)).toEqual([]);
    const out = await submitRush(server, link, 2);
    expect(out).toEqual({ ranked: true, solved: 2, seconds: 31, score: 190, rating: { rating: 1020, change: 20, rated: 3 }, mismatch: false });
    expect(calls).toEqual([['startRush'], ['answerRush', 'run-1', 0, 5], ['finishRush', 'run-1']]);
  });

  it('ends the run with the server’s result when the third strike (or the clock) finishes it', async () => {
    const result = { runId: 'run-1', solved: 4, wrong: 3, seconds: 41, score: 520, ranked: true, answers: [], rating: { rating: 1000, change: 0, rated: 0 } } as RushFinish;
    const { server } = fake({ answerRush: async (_id, index) => ({ index, counted: true, correct: false, solved: 4, wrong: 3, done: true, next: null, result }) });
    expect(await sendRushAnswer(server, await openRush(server, 'x'), 6, 1, 4)).toEqual({ kind: 'done', outcome: { ranked: true, solved: 4, seconds: 41, score: 520, rating: result.rating, mismatch: false } });
    // With the revealed puzzle, the last verdict comes with it (the view shows it as the run ends).
    const revealing = fake({ answerRush: async (_id, index) => ({ index, counted: true, correct: false, solved: 4, wrong: 3, revealed: revealedAt(index), done: true, next: null, result }) });
    expect(await sendRushAnswer(revealing.server, await openRush(revealing.server, 'x'), 6, 1, 4)).toMatchObject({ kind: 'done', correct: false, revealed: revealedAt(6), outcome: { ranked: true, mismatch: false } });
    // An inhuman or too-fast run comes back recorded but not ranked.
    const unranked = fake({ answerRush: async (_id, index) => ({ index, counted: true, done: true, next: null, result: { ...result, ranked: false, inhuman: true } }) });
    expect(await sendRushAnswer(unranked.server, await openRush(unranked.server, 'x'), 6, 1, 4)).toMatchObject({ kind: 'done', outcome: { ranked: false, error: { code: 'too_fast_to_rank' } } });
  });

  it('ends the run, unranked and marked lost, when an answer cannot reach the server or is refused', async () => {
    const lost = fake({ answerRush: down });
    expect(await sendRushAnswer(lost.server, await openRush(lost.server, 'x'), 0, 1, 1)).toMatchObject({ kind: 'done', outcome: { ranked: false, down: true, lost: true, error: { code: 'puzzle_unreachable' } } });
    const refused = fake({ answerRush: () => Promise.reject(new ApiError('gone', 'run_expired', 410)) });
    expect(await sendRushAnswer(refused.server, await openRush(refused.server, 'x'), 0, 1, 1)).toMatchObject({ kind: 'done', outcome: { ranked: false, down: false, lost: true, error: { code: 'run_expired' } } });
    // A local run never reaches the server.
    expect(await sendRushAnswer(lost.server, { ranked: false, seed: 'x', down: true }, 0, 1, 1)).toMatchObject({ kind: 'done', outcome: { ranked: false, lost: true } });
    expect(puzzleErrorMessage(new ApiError('x', 'not_served', 409)).key).toBe('puzzles.server.errors.runOutOfStep');
    // A reply with the next question but not the answered puzzle cannot be shown: the run ends there.
    const noReveal = fake({ answerRush: async (_id, index) => ({ index, counted: true, correct: true, solved: 1, wrong: 0, done: false, next: served(index + 1) }) });
    expect(await sendRushAnswer(noReveal.server, await openRush(noReveal.server, 'x'), 0, 1, 0)).toMatchObject({ kind: 'done', outcome: { ranked: false, lost: true, error: { code: 'puzzle_bad_reply' } } });
    // A start without a question plays on the device, unranked.
    const noQuestion = fake({ startRush: async () => ({ runId: 'r', startedAt: '', expiresAt: '', seconds: 180, strikes: 3, next: { index: 0, type: 'discard' } }) as never });
    expect(await openRush(noQuestion.server, 'local')).toMatchObject({ ranked: false, seed: 'local', error: { code: 'puzzle_bad_reply' } });
  });

  it('shows the server’s score even when its clock makes it lower than the device’s estimate', async () => {
    const logged: string[] = [];
    const { server } = fake({ finishRush: async (id) => ({ runId: id, solved: 3, wrong: 0, seconds: 62, score: 280, answers: [], rating: { rating: 1030, change: 30, rated: 3 } }) as RushFinish });
    const out = await submitRush(server, await openRush(server, 'x'), 4, (m) => logged.push(m));
    expect(out).toMatchObject({ ranked: true, score: 280, seconds: 62, solved: 3, mismatch: true });
    expect(logged).toHaveLength(1);
  });

  it('runs on a local seed, unranked, when the server cannot be reached', async () => {
    const { server, calls } = fake({ startRush: down });
    const link = await openRush(server, 'rush-local');
    expect(link).toMatchObject({ ranked: false, seed: 'rush-local', down: true });
    expect(await submitRush(server, link, 1)).toMatchObject({ ranked: false, down: true });
    expect(calls).toEqual([]);
    expect(await openRush(null, 'rush-local')).toEqual({ ranked: false, seed: 'rush-local', down: true });
    // The local run's puzzles are the engine's.
    expect(rushPuzzleAt('rush-local', 4)).toEqual(rushRunPuzzle('rush-local', 4));
  });

  it('passes on an expired run as a refusal the screen can offer a new run for', async () => {
    const { server } = fake({ finishRush: () => Promise.reject(new ApiError('expired', 'run_expired', 410)) });
    expect(await submitRush(server, await openRush(server, 'x'), 1)).toMatchObject({ ranked: false, down: false, error: { code: 'run_expired' } });
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
