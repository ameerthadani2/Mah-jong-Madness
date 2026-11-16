/**
 * The leaderboard screen's rules, as pure logic (src/screens/LeaderboardScreen.tsx only draws them): which
 * request a choice of board, period and scope makes, how the server's rows read (rank, name, value and the
 * line a screen reader speaks), where the player's own row goes (highlighted in the list, or pinned under it
 * when it is further down or hidden), and what a failed request shows (offline, or a message per code).
 * The server orders the boards (docs/API.md, "Puzzles and leaderboards"); the rows are put in rank order
 * here again so a reply is never shown out of order.
 */
import { puzzleErrorMessage, type Board, type BoardKind, type BoardOptions, type BoardRow, type RushPeriod } from '../api/puzzles';
import type { Message, Translate } from './translate';

export const BOARD_KINDS: readonly BoardKind[] = ['daily', 'rush', 'rating'];
export const RUSH_PERIODS: readonly RushPeriod[] = ['day', 'week', 'all'];

/** What the player has picked: the board, the Rush period (only the Rush board uses it) and a club code, or null for everyone. */
export interface BoardChoice {
  board: BoardKind;
  period: RushPeriod;
  club: string | null;
}

export const DEFAULT_CHOICE: BoardChoice = { board: 'daily', period: 'day', club: null };

/**
 * The request for a choice. The daily board asks for the player's own date key (the one the daily puzzle is
 * played and recorded under, `todayKey`), not the server's UTC date, so a player east or west of UTC sees the
 * board of the puzzle they played. Only the options that apply to the board are sent.
 */
export function boardRequest(choice: BoardChoice, dateKey: string): { kind: BoardKind; opts: BoardOptions } {
  const opts: BoardOptions = {};
  if (choice.board === 'daily') opts.date = dateKey;
  if (choice.board === 'rush') opts.period = choice.period;
  if (choice.club) opts.club = choice.club;
  return { kind: choice.board, opts };
}

/** One key per distinct request, so a board already shown can be shown again without asking the server. */
export function choiceKey(choice: BoardChoice, dateKey: string): string {
  const { kind, opts } = boardRequest(choice, dateKey);
  return [kind, opts.date ?? '', opts.period ?? '', opts.club ?? ''].join('|');
}

/** The tab, period and scope labels. */
export const boardTitleKey = (kind: BoardKind) => `puzzles.boards.tabs.${kind}`;
export const periodKey = (p: RushPeriod) => `puzzles.boards.periods.${p}`;

export interface ScopeOption {
  /** Null for everyone. */
  club: string | null;
  label: string;
  /** The screen reader's name for the choice. */
  a11y: string;
}

/**
 * Everyone, then each club the player is a member of (a club they have only asked to join is not theirs yet),
 * in name order. `clubs` is "My clubs" as the server lists it; `isMember` says which are memberships.
 */
export function scopeOptions<C extends { code: string; name: string }>(clubs: readonly C[], isMember: (c: C) => boolean, t: Translate): ScopeOption[] {
  const everyone: ScopeOption = { club: null, label: t('puzzles.boards.everyone'), a11y: t('puzzles.boards.scopeA11y', { name: t('puzzles.boards.everyone') }) };
  const mine = clubs
    .filter(isMember)
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name) || a.code.localeCompare(b.code))
    .map((c) => ({ club: c.code, label: c.name || c.code, a11y: t('puzzles.boards.scopeA11y', { name: c.name || c.code }) }));
  return [everyone, ...mine];
}

/** A chosen club that is no longer among the player's falls back to everyone. */
export function validChoice(choice: BoardChoice, options: readonly ScopeOption[]): BoardChoice {
  return choice.club && !options.some((o) => o.club === choice.club) ? { ...choice, club: null } : choice;
}

/** A row as the screen draws it. */
export interface RowView {
  key: string;
  rank: number;
  rankText: string;
  name: string;
  avatar: string | null;
  /** The number shown at the end of the row (a time, a score or a rating), or "Not solved". */
  value: string;
  /** A smaller line under the name (puzzles solved, rated answers), or null. */
  detail: string | null;
  /** The player's own row: highlighted. */
  mine: boolean;
  /** Daily board: the puzzle was answered but not solved (drawn dimmer, after the solved rows). */
  unsolved: boolean;
  /** Everything a screen reader says for the row. */
  label: string;
}

export interface BoardView {
  rows: RowView[];
  /** The player's own row when it is not in the list (further down, or hidden from others): pinned under it. */
  pinned: RowView | null;
  /** The player hid themselves from leaderboards ("Show me on leaderboards" is off). */
  hidden: boolean;
  /** Nobody on the board (the player's own row included). */
  empty: boolean;
}

/** A time in seconds as the daily board shows it: "42 s" under a minute, else "1:05". */
export function timeText(seconds: number, t: Translate): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return t('puzzles.boards.seconds', { n: s });
  return t('puzzles.boards.minutes', { m: Math.floor(s / 60), s: String(s % 60).padStart(2, '0') });
}

/** The same time spoken in words ("1 minute 5 seconds"). */
export function timeSpoken(seconds: number, t: Translate): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m === 0) return t('puzzles.boards.secondsSpoken', { count: rest });
  if (rest === 0) return t('puzzles.boards.minutesSpoken', { count: m });
  return t('puzzles.boards.minutesSecondsSpoken', { m: t('puzzles.boards.minutesSpoken', { count: m }), s: t('puzzles.boards.secondsSpoken', { count: rest }) });
}

const solvedFlag = (r: BoardRow) => r.solved !== false;

function rowView(kind: BoardKind, r: BoardRow, mine: boolean, t: Translate): RowView {
  let value: string;
  let spoken: string;
  let detail: string | null = null;
  let unsolved = false;
  if (kind === 'daily') {
    unsolved = !solvedFlag(r);
    value = unsolved ? t('puzzles.boards.notSolved') : timeText(r.value, t);
    spoken = unsolved ? value : t('puzzles.boards.solvedIn', { time: timeSpoken(r.value, t) });
  } else if (kind === 'rush') {
    value = String(r.value);
    spoken = t('puzzles.boards.scoreSpoken', { count: r.value });
    if (typeof r.solved === 'number') detail = t('puzzles.boards.rushSolved', { count: r.solved });
  } else {
    value = String(r.value);
    spoken = t('puzzles.boards.ratingSpoken', { n: r.value });
    if (typeof r.rated === 'number') detail = t('puzzles.boards.rated', { count: r.rated });
  }
  const name = r.displayName || t('common.player');
  const who = mine ? t('puzzles.boards.youNamed', { name }) : name;
  const label = [t('puzzles.boards.rankSpoken', { rank: r.rank }), who, spoken, detail].filter(Boolean).join(t('puzzles.boards.listSeparator'));
  return { key: r.userId, rank: r.rank, rankText: String(r.rank), name, avatar: r.avatar, value, detail, mine, unsolved, label };
}

/**
 * The board as drawn: rows in rank order with the player's own highlighted, and the player's own row pinned
 * under the list when it is not in it. `myUserId` is the signed-in account (the server's `me` says the same
 * once the player has an entry; both are used so the row is found either way). `visible` is the player's
 * "Show me on leaderboards" choice: off, the board says the player is hidden even where they have no row.
 */
export function boardView(board: Pick<Board, 'board' | 'rows' | 'me'>, myUserId: string | null, t: Translate, /** "Show me on leaderboards" as the server has it, when read. */ visible?: boolean): BoardView {
  const me = board.me;
  const mineId = me?.userId ?? myUserId;
  const rows = [...board.rows].sort((a, b) => a.rank - b.rank).map((r) => rowView(board.board, r, r.userId === mineId, t));
  const listed = mineId !== null && rows.some((r) => r.key === mineId);
  const pinned = me && !listed ? rowView(board.board, me, true, t) : null;
  // Hidden either way: the board says so with the player's own row, and the setting says so on a board they have no entry on yet.
  return { rows, pinned, hidden: me?.hidden === true || visible === false, empty: rows.length === 0 && !pinned };
}

/** The empty board's line, per board (the rating board says how many answers it takes to appear). */
export function emptyText(board: Pick<Board, 'board' | 'scope' | 'minRated'>, t: Translate): string {
  if (board.board === 'rating') return t('puzzles.boards.empty.rating', { count: board.minRated ?? 20 });
  return t(board.scope === 'club' ? `puzzles.boards.empty.${board.board}Club` : `puzzles.boards.empty.${board.board}`);
}

/** The board-specific copy for the codes the board routes answer; anything else is the puzzle client's own. */
const BOARD_ERRORS: Readonly<Record<string, string>> = {
  invalid: 'puzzles.boards.errors.invalid',
  forbidden: 'puzzles.boards.errors.forbidden',
  not_found: 'puzzles.boards.errors.notFound',
  rate_limited: 'puzzles.boards.errors.rateLimited',
  puzzle_bad_reply: 'puzzles.boards.errors.badReply',
  banned: 'puzzles.boards.errors.banned',
};

export type BoardFailure =
  | { kind: 'offline' }
  /** `clubGone`: the club cannot be shown (not a member any more, or no such club); the screen goes back to everyone. */
  | { kind: 'error'; message: Message; clubGone: boolean };

const codeOf = (e: unknown): string => (e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : '');
const statusOf = (e: unknown): number | undefined => (e && typeof e === 'object' && typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : undefined);

/**
 * What a failed board request shows. "Can't reach the game server" when there was no answer at all (no
 * session could be made, a timeout, no connection); otherwise the reason, in words, for every code.
 */
export function boardFailure(e: unknown): BoardFailure {
  const code = codeOf(e);
  if (code === 'puzzle_timeout' || code === 'puzzle_unreachable' || code === 'offline' || code.endsWith('_unreachable') || code.endsWith('_timeout')) return { kind: 'offline' };
  const status = statusOf(e);
  const key = BOARD_ERRORS[code];
  const message: Message = key ? { key } : status !== undefined && status >= 500 ? { key: 'puzzles.boards.errors.server' } : puzzleErrorMessage(e);
  return { kind: 'error', message, clubGone: code === 'forbidden' || code === 'not_found' };
}
