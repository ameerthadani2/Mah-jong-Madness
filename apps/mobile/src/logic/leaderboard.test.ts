import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/http';
import { boardPath, type Board, type BoardRow } from '../api/puzzles';
import { boardFailure, boardRequest, boardView, choiceKey, DEFAULT_CHOICE, emptyText, scopeOptions, timeSpoken, timeText, validChoice } from './leaderboard';
import { translator } from './translator.fixture';

const en = translator('en');
const zh = translator('zh-TW');

const row = (rank: number, userId: string, value: number, extra: Partial<BoardRow> = {}): BoardRow => ({ rank, userId, displayName: `P${rank}`, avatar: 'chef', value, ...extra });

describe('leaderboard requests', () => {
  it("asks for the daily board of the player's own date key, and only the options that board takes", () => {
    expect(boardRequest(DEFAULT_CHOICE, '2026-11-16')).toEqual({ kind: 'daily', opts: { date: '2026-11-16' } });
    const daily = boardRequest({ board: 'daily', period: 'week', club: null }, '2026-11-16');
    expect(boardPath(daily.kind, daily.opts)).toBe('/api/leaderboards/daily?date=2026-11-16');
  });

  it('sends the Rush period, and the club for a club board', () => {
    for (const period of ['day', 'week', 'all'] as const) {
      const r = boardRequest({ board: 'rush', period, club: null }, '2026-11-16');
      expect(boardPath(r.kind, r.opts)).toBe(`/api/leaderboards/rush?period=${period}`);
    }
    const club = boardRequest({ board: 'rush', period: 'week', club: 'ABC123' }, '2026-11-16');
    expect(boardPath(club.kind, club.opts)).toBe('/api/leaderboards/rush?period=week&club=ABC123');
    const rating = boardRequest({ board: 'rating', period: 'all', club: 'ABC123' }, '2026-11-16');
    expect(boardPath(rating.kind, rating.opts)).toBe('/api/leaderboards/rating?club=ABC123');
  });

  it('gives each distinct request its own key, and ignores what a board does not use', () => {
    const a = choiceKey({ board: 'rating', period: 'day', club: null }, '2026-11-16');
    expect(choiceKey({ board: 'rating', period: 'all', club: null }, '2026-11-17')).toBe(a);
    expect(choiceKey({ board: 'rush', period: 'day', club: null }, 'x')).not.toBe(choiceKey({ board: 'rush', period: 'week', club: null }, 'x'));
    expect(choiceKey({ board: 'daily', period: 'day', club: null }, '2026-11-16')).not.toBe(choiceKey({ board: 'daily', period: 'day', club: null }, '2026-11-17'));
    expect(choiceKey({ board: 'daily', period: 'day', club: 'C1' }, 'x')).not.toBe(choiceKey({ board: 'daily', period: 'day', club: null }, 'x'));
  });
});

describe('scope choices', () => {
  const clubs = [
    { code: 'ZZ1', name: 'Tuesday Tiles', member: true },
    { code: 'AA1', name: 'Mahjong Moms', member: true },
    { code: 'PEN', name: 'Asked to join', member: false },
  ];
  it("offers everyone first, then the player's own clubs by name (not one they only asked to join)", () => {
    const opts = scopeOptions(clubs, (c) => c.member, en);
    expect(opts.map((o) => o.club)).toEqual([null, 'AA1', 'ZZ1']);
    expect(opts.map((o) => o.label)).toEqual(['Everyone', 'Mahjong Moms', 'Tuesday Tiles']);
    expect(opts[1].a11y).toBe('Show: Mahjong Moms');
    expect(scopeOptions([], () => true, zh)[0]).toEqual({ club: null, label: '所有玩家', a11y: '顯示：所有玩家' });
  });

  it('falls back to everyone when the chosen club is no longer one of theirs', () => {
    const opts = scopeOptions(clubs, (c) => c.member, en);
    expect(validChoice({ board: 'rush', period: 'week', club: 'PEN' }, opts)).toEqual({ board: 'rush', period: 'week', club: null });
    expect(validChoice({ board: 'rush', period: 'week', club: 'AA1' }, opts).club).toBe('AA1');
  });
});

describe('rows', () => {
  it('shows times as seconds under a minute and minutes after, and speaks them in words', () => {
    expect(timeText(42, en)).toBe('42 s');
    expect(timeText(65, en)).toBe('1:05');
    expect(timeText(42, zh)).toBe('42 秒');
    expect(timeSpoken(1, en)).toBe('1 second');
    expect(timeSpoken(65, en)).toBe('1 minute 5 seconds');
    expect(timeSpoken(120, en)).toBe('2 minutes');
    expect(timeSpoken(65, zh)).toBe('1 分鐘 5 秒');
  });

  it('puts the daily rows in rank order, solved before unsolved, with a spoken line for each', () => {
    const board: Board = { board: 'daily', scope: 'global', club: null, rows: [row(3, 'c', 90, { solved: false }), row(1, 'a', 12, { solved: true }), row(2, 'b', 75, { solved: true })], me: null };
    const v = boardView(board, null, en);
    expect(v.rows.map((r) => [r.rankText, r.name, r.value, r.unsolved])).toEqual([
      ['1', 'P1', '12 s', false],
      ['2', 'P2', '1:15', false],
      ['3', 'P3', 'Not solved', true],
    ]);
    expect(v.rows[1].label).toBe('Rank 2, P2, solved in 1 minute 15 seconds');
    expect(v.rows[2].label).toBe('Rank 3, P3, Not solved');
    expect(boardView(board, null, zh).rows[0].label).toBe('第 1 名，P1，12 秒解出');
    expect(v.empty).toBe(false);
  });

  it('reads Rush scores with the puzzles solved, and ratings with the rated answers', () => {
    const rush = boardView({ board: 'rush', rows: [row(1, 'a', 14, { solved: 9 })], me: null }, null, en).rows[0];
    expect([rush.value, rush.detail, rush.label]).toEqual(['14', '9 solved', 'Rank 1, P1, 14 points, 9 solved']);
    const rating = boardView({ board: 'rating', rows: [row(1, 'a', 1240, { rated: 1 })], me: null }, null, zh).rows[0];
    expect([rating.value, rating.detail, rating.label]).toEqual(['1240', '1 次計分作答', '第 1 名，P1，積分 1240，1 次計分作答']);
  });

  it("names a row without a name as a player", () => {
    expect(boardView({ board: 'rush', rows: [row(1, 'a', 3, { displayName: '' })], me: null }, null, en).rows[0].name).toBe('Player');
  });
});

describe("the player's own row", () => {
  it('is highlighted in the list and not pinned again', () => {
    const v = boardView({ board: 'rush', rows: [row(1, 'a', 20), row(2, 'me', 10)], me: row(2, 'me', 10) }, 'me', en);
    expect(v.rows.map((r) => r.mine)).toEqual([false, true]);
    expect(v.rows[1].label).toBe('Rank 2, you (P2), 10 points');
    expect(v.pinned).toBeNull();
    expect(v.hidden).toBe(false);
  });

  it('is found by the account id before the server has sent a row for the player', () => {
    expect(boardView({ board: 'rush', rows: [row(1, 'me', 20)], me: null }, 'me', en).rows[0].mine).toBe(true);
  });

  it('is pinned under the list when it is further down', () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i + 1, `u${i}`, 500 - i));
    const v = boardView({ board: 'rush', rows, me: row(250, 'me', 3) }, 'me', en);
    expect(v.rows.some((r) => r.mine)).toBe(false);
    expect(v.pinned).toMatchObject({ rank: 250, mine: true, value: '3' });
  });

  it('is pinned and marked hidden when the player hid themselves', () => {
    const v = boardView({ board: 'rating', rows: [row(1, 'a', 1300)], me: { ...row(1, 'me', 1350), hidden: true } }, 'me', en);
    expect(v.hidden).toBe(true);
    expect(v.pinned).toMatchObject({ rank: 1, mine: true });
    expect(v.empty).toBe(false);
  });

  it('marks the player’s own row flagged, with its own note instead of the hidden one, when the server’s automation check keeps them off', () => {
    const v = boardView({ board: 'rush', rows: [row(1, 'a', 3000)], me: { ...row(1, 'me', 3500), hidden: true, flagged: true } }, 'me', en);
    expect(v.flagged).toBe(true);
    expect(v.hidden).toBe(false);
    expect(v.pinned).toMatchObject({ key: 'me' });
    expect(boardView({ board: 'rush', rows: [row(1, 'me', 3000)], me: { ...row(1, 'me', 3000), hidden: false, flagged: false } }, 'me', en).flagged).toBe(false);
  });

  it('says the player is hidden when the setting is off, even on a board they have no row on', () => {
    const v = boardView({ board: 'rating', rows: [row(1, 'a', 1300)], me: null }, 'me', en, false);
    expect([v.hidden, v.pinned, v.empty]).toEqual([true, null, false]);
    expect(boardView({ board: 'rating', rows: [], me: null }, 'me', en, true).hidden).toBe(false);
  });

  it('leaves an empty board empty, with a line per board', () => {
    const v = boardView({ board: 'daily', rows: [], me: null }, 'me', en);
    expect(v).toEqual({ rows: [], pinned: null, hidden: false, flagged: false, empty: true });
    expect(emptyText({ board: 'daily', scope: 'global' }, en)).toBe("Nobody is on today's board yet. Be the first!");
    expect(emptyText({ board: 'rush', scope: 'club' }, en)).toBe('Nobody in this club has a Puzzle Rush score in this period yet.');
    expect(emptyText({ board: 'rating', scope: 'global', minRated: 20 }, zh)).toBe('完成 20 次計分作答後，就會出現在這裡。');
  });
});

describe('failures', () => {
  it("says the game server can't be reached when there was no answer", () => {
    expect(boardFailure(new ApiError('x', 'puzzle_unreachable'))).toEqual({ kind: 'offline' });
    expect(boardFailure(new ApiError('x', 'puzzle_timeout', undefined, 10))).toEqual({ kind: 'offline' });
    // No session could be made (the guest sign-up could not reach the server).
    expect(boardFailure(new ApiError('x', 'auth_unreachable'))).toEqual({ kind: 'offline' });
    expect(boardFailure({ code: 'offline' })).toEqual({ kind: 'offline' });
  });

  it('has a message in both languages for every code the boards answer', () => {
    const codes: Array<[string, number]> = [
      ['invalid', 400],
      ['forbidden', 403],
      ['not_found', 404],
      ['rate_limited', 429],
      ['puzzle_bad_reply', 502],
      ['banned', 403],
      ['', 500],
      ['', 503],
      ['session_revoked', 401],
      ['something_new', 400],
    ];
    const seen = new Set<string>();
    for (const [code, status] of codes) {
      const f = boardFailure(new ApiError('x', code || undefined, status));
      expect(f.kind).toBe('error');
      if (f.kind !== 'error') continue;
      const words = [en(f.message.key, f.message.params), zh(f.message.key, f.message.params)];
      for (const w of words) expect(w).not.toMatch(/puzzles\.|missing/);
      if (['invalid', 'forbidden', 'not_found', 'rate_limited', 'puzzle_bad_reply', 'banned'].includes(code)) seen.add(f.message.key);
    }
    expect(seen.size).toBe(6);
    expect(boardFailure(new ApiError('x', undefined, 500))).toMatchObject({ message: { key: 'puzzles.boards.errors.server' } });
  });

  it('goes back to everyone when the club cannot be shown', () => {
    expect(boardFailure(new ApiError('x', 'forbidden', 403))).toMatchObject({ clubGone: true });
    expect(boardFailure(new ApiError('x', 'not_found', 404))).toMatchObject({ clubGone: true });
    expect(boardFailure(new ApiError('x', 'rate_limited', 429))).toMatchObject({ clubGone: false });
  });
});
