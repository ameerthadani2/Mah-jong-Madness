import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ApiError, type Authoriser, type FetchLike } from './http';
import { boardPath, isPuzzleServerDown, puzzleErrorMessage, puzzleErrorText, puzzlesApi } from './puzzles';

/** Records each request and answers `status` with `body`. */
function recorder(body: unknown = {}, status = 200) {
  const calls: Array<{ method: string; url: string; auth?: string; body?: unknown }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init.method, url, auth: init.headers.authorization, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  const auth: Authoriser = { token: async () => 'mjs_tok', onUnauthorised: () => undefined };
  return { calls, ctx: { base: 'https://game.example', auth, fetch } };
}

describe('puzzle routes the app calls', () => {
  it('starts and finishes the daily puzzle with the attempt and the answer only', async () => {
    const start = recorder({ attemptId: 'a-1', date: '2026-11-16', startedAt: '2026-11-16T10:00:00.000Z' });
    expect((await puzzlesApi.startDaily(start.ctx, '2026-11-16')).attemptId).toBe('a-1');
    expect(start.calls).toEqual([{ method: 'POST', url: 'https://game.example/api/puzzles/daily/start', auth: 'Bearer mjs_tok', body: { date: '2026-11-16' } }]);
    const finish = recorder({ date: '2026-11-16', correct: true, seconds: 40, rating: { rating: 1012, change: 12, rated: 1 } });
    expect((await puzzlesApi.finishDaily(finish.ctx, 'a-1', 7)).seconds).toBe(40);
    expect(finish.calls).toEqual([{ method: 'POST', url: 'https://game.example/api/puzzles/daily', auth: 'Bearer mjs_tok', body: { attemptId: 'a-1', answer: 7 } }]);
  });

  it('starts a Rush run and finishes it with every answer in order', async () => {
    const start = recorder({ runId: 'r 1', seed: 'rush-00', startedAt: '', expiresAt: '', seconds: 180, strikes: 3 });
    expect((await puzzlesApi.startRush(start.ctx)).seed).toBe('rush-00');
    expect(start.calls[0]).toEqual({ method: 'POST', url: 'https://game.example/api/puzzles/rush', auth: 'Bearer mjs_tok', body: {} });
    const finish = recorder({ runId: 'r 1', solved: 2, wrong: 1, seconds: 30, score: 200, answers: [], rating: { rating: 1000, change: 0, rated: 3 } });
    await puzzlesApi.finishRush(finish.ctx, 'r 1', [3, [1, 4], 'chi:2-3']);
    expect(finish.calls[0]).toEqual({ method: 'POST', url: 'https://game.example/api/puzzles/rush/r%201/finish', auth: 'Bearer mjs_tok', body: { answers: [3, [1, 4], 'chi:2-3'] } });
  });

  it('reads the rating and the boards with only the options each board takes', async () => {
    const r = recorder({ rating: 1100, rated: 4, updatedAt: null });
    expect((await puzzlesApi.getPuzzleRating(r.ctx)).rating).toBe(1100);
    expect(r.calls[0]).toMatchObject({ method: 'GET', url: 'https://game.example/api/puzzles/rating', body: undefined });
    expect(boardPath('daily')).toBe('/api/leaderboards/daily');
    expect(boardPath('daily', { date: '2026-11-16', period: 'week', club: 'AB 12' })).toBe('/api/leaderboards/daily?date=2026-11-16&club=AB%2012');
    expect(boardPath('rush', { period: 'week', date: '2026-11-16' })).toBe('/api/leaderboards/rush?period=week');
    expect(boardPath('rating', { club: 'XY99', period: 'all' })).toBe('/api/leaderboards/rating?club=XY99');
    const b = recorder({ board: 'rush', rows: [], me: null });
    await puzzlesApi.getLeaderboard(b.ctx, 'rush', { period: 'all', club: 'XY99' });
    expect(b.calls[0]).toMatchObject({ method: 'GET', url: 'https://game.example/api/leaderboards/rush?period=all&club=XY99' });
  });

  it('reads and writes "Show me on leaderboards" on /api/me, on unless the server says off', async () => {
    const off = recorder({ user: { id: 'u' }, leaderboardVisible: false });
    expect(await puzzlesApi.setLeaderboardVisible(off.ctx, false)).toBe(false);
    expect(off.calls).toEqual([{ method: 'PATCH', url: 'https://game.example/api/me', auth: 'Bearer mjs_tok', body: { leaderboardVisible: false } }]);
    expect(await puzzlesApi.getLeaderboardVisible(recorder({ user: { id: 'u' }, leaderboardVisible: true }).ctx)).toBe(true);
    // A server from before the setting existed sends none: the player is listed, as the server's default.
    expect(await puzzlesApi.getLeaderboardVisible(recorder({ user: { id: 'u' } }).ctx)).toBe(true);
  });

  it('turns a refusal into an ApiError carrying the server code', async () => {
    const r = recorder({ error: 'already_played', message: 'You have already played this daily puzzle' }, 409);
    await expect(puzzlesApi.finishDaily(r.ctx, 'a-1', 1)).rejects.toMatchObject({ code: 'already_played', status: 409 });
  });
});

const here = dirname(fileURLToPath(import.meta.url));
const locale = (name: string) => JSON.parse(readFileSync(join(here, '..', 'i18n', 'locales', name, 'puzzles.json'), 'utf8')) as { server: { errors: Record<string, string> } };
const en = locale('en');
const zh = locale('zh-TW');
/** A `t` over one locale's puzzle strings. */
const tFor = (strings: typeof en) => (key: string) => {
  const m = /^puzzles\.server\.errors\.(\w+)$/.exec(key);
  return m ? strings.server.errors[m[1]] : key;
};

describe('puzzle errors as copy', () => {
  const CODES = ['invalid', 'invalid_answer', 'date_out_of_range', 'already_played', 'rush_too_fast', 'run_not_found', 'run_finished', 'run_expired', 'forbidden', 'not_found', 'rate_limited'];

  it('gives every puzzle route code its own line in both languages', () => {
    const keys = new Set<string>();
    for (const code of CODES) {
      const m = puzzleErrorMessage(new ApiError('x', code, 400));
      expect(m.key).toMatch(/^puzzles\.server\.errors\./);
      keys.add(m.key);
      for (const strings of [en, zh]) expect(tFor(strings)(m.key), `${code}`).not.toMatch(/^puzzles\./);
    }
    expect(keys.size).toBe(CODES.length);
  });

  it('reads already played as today, an expired run as a new run, and a limit as a wait', () => {
    const say = (code: string, strings = en) => puzzleErrorText(new ApiError('x', code), tFor(strings));
    expect(say('already_played')).toMatch(/already played today/i);
    expect(say('run_expired')).toMatch(/start a new run/i);
    expect(say('rate_limited')).toMatch(/wait/i);
    expect(say('already_played', zh)).toContain('今天已經玩過');
    expect(say('run_expired', zh)).toContain('新的一輪');
    expect(say('rate_limited', zh)).toContain('稍等');
  });

  it('reads the server’s free Rush meter as the Coach Gold message the Rush lock shows, in both languages', () => {
    const limit = new ApiError('x', 'rush_daily_limit', 403);
    expect(puzzleErrorMessage(limit).key).toBe('shop.rushUsed');
    expect(isPuzzleServerDown(limit)).toBe(false);
    // The Shop's strings, with %{name} filled in as i18n-js does.
    const shopT = (name: string) => {
      const shop = JSON.parse(readFileSync(join(here, '..', 'i18n', 'locales', name, 'shop.json'), 'utf8')) as { rushUsed: string; tiers: { gold: string } };
      return (key: string, params?: Record<string, unknown>) =>
        (key === 'shop.rushUsed' ? shop.rushUsed : key === 'shop.tiers.gold' ? shop.tiers.gold : key).replace(/%\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? `%{${k}}`));
    };
    expect(puzzleErrorText(limit, shopT('en'))).toBe('Free accounts get one Puzzle Rush a day. Coach Gold makes it unlimited.');
    expect(puzzleErrorText(limit, shopT('zh-TW'))).toBe('免費帳號每天可以玩一次謎題衝刺。訂閱「黃金教練」就不限次數。');
  });

  it('says unreachable for the client’s own failures and leaves other codes to the generic mapping', () => {
    expect(puzzleErrorMessage(new ApiError('x', 'puzzle_timeout')).key).toBe('puzzles.server.errors.unreachable');
    expect(puzzleErrorMessage(new ApiError('x', 'puzzle_unreachable')).key).toBe('puzzles.server.errors.unreachable');
    expect(puzzleErrorMessage(new ApiError('x', 'puzzle_bad_reply', 502)).key).toBe('puzzles.server.errors.badReply');
    expect(puzzleErrorMessage(new ApiError('x', 'session_expired', 401)).key).toBe('errors.sessionExpired');
  });

  it('plays on locally only when the server could not be used, not when it refused', () => {
    for (const code of ['puzzle_timeout', 'puzzle_unreachable', 'puzzle_bad_reply', 'signed_out']) expect(isPuzzleServerDown(new ApiError('x', code))).toBe(true);
    expect(isPuzzleServerDown(new ApiError('Request failed (503)', undefined, 503))).toBe(true);
    for (const code of ['already_played', 'rate_limited', 'run_expired', 'invalid']) expect(isPuzzleServerDown(new ApiError('x', code, 400))).toBe(false);
  });
});
