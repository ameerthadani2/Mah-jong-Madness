/**
 * The check a table snapshot passes before it is restored as a live table (persist.ts `restore`).
 * A table restored from a damaged snapshot would deal, score and time a match from state nobody
 * played, and the players' apps, which replay every hand from its moves under the table's rules,
 * would then flag the table as unfair. So the snapshot is checked with the engine's own rules:
 *
 * - the rules must be a rule set whose every rule the engine accepts as it stands (`sanitizeRules`
 *   changes none of them); a rule the snapshot lacks takes the engine's default, as for a table
 *   written before that rule existed;
 * - a hand in play must be exactly what its deal and its moves give: the engine replays it
 *   (`replayHand`, which also refuses an illegal move) from the match position, the seed and the
 *   moves under the hand's own rules, and the result must hash (`hashState`) to the stored hand;
 * - between hands, the last hand must hash to the figure its record published to the players, and
 *   the match position must be the one the engine moves on to after it (`advanceMatch`);
 * - the hand's rules and the table's must be the same rule set;
 * - the bots' strength must be one the engine has (the players' apps recompute every bot move at it);
 * - each time bank must lie between nothing and the whole bank the rules give (the apps track each
 *   bank from the rules, and fail a hand whose bank shrank further than the seat's own moves allow);
 * - a seat the snapshot calls a bot must not have made a move its own player chose in the hand in play
 *   or in any hand record (the apps freeze the bot seats at the match's first deal);
 * - the seats, time banks, hand records and match position must have the shape the host needs.
 *
 * `snapshotProblem` answers what is wrong, in a few words for the log and the admin view, or null.
 */
import { advanceMatch, BOT_SKILLS, hashState, replayHand, sanitizeRules, stableStringify, type GameState, type LoggedAction, type MatchSnapshot, type RuleSet } from '@mjm/engine';

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const fourNumbers = (v: unknown): boolean => Array.isArray(v) && v.length === 4 && v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Whether `log` holds a move of `seat` that its own player chose (`source: 'player'`): a bot's are always the table's. */
const playerMoved = (log: unknown, seat: number): boolean => Array.isArray(log) && log.some((e) => isObject(e) && e.seat === seat && e.source === 'player');

/**
 * The seats the snapshot calls bots, against the hand in play and the hand records: a bot never makes a
 * move its own player chose. (A seat named '… (away)' is how older builds marked a player who left; the
 * host gives it back to that player when they return, so it is not held to this.)
 */
function botSeatsProblem(data: Obj): string | null {
  const seats = data.seats as Obj[];
  const game = isObject(data.game) ? data.game : null;
  for (const s of seats) {
    if (s.isBot !== true || (s.name as string).endsWith('(away)')) continue;
    const seat = s.seat as number;
    if (playerMoved(game?.actionLog, seat) || (data.audits as Obj[]).some((a) => playerMoved(a.log, seat))) return `seat ${seat} is called a bot, yet its own player made moves in this match`;
  }
  return null;
}

/** Host phases a live table can be restored in ('match_over' is a finished table). */
const RESUMABLE_PHASES = new Set(['lobby', 'commit', 'reveal', 'playing', 'hand_over']);

/** What is wrong with these rules for the engine, or null: not a rule set, or a rule it would change. */
export function rulesProblem(rules: unknown): string | null {
  if (!isObject(rules)) return 'the rules are not a rule set';
  const clean = sanitizeRules(rules) as unknown as Obj;
  for (const key of Object.keys(clean)) {
    if (key in rules && !Object.is(clean[key], rules[key])) return `the rule ${key} is not one the engine accepts`;
  }
  return null;
}

function matchProblem(m: unknown): string | null {
  if (!isObject(m)) return 'the match position is missing';
  if (!isInt(m.handNumber, 0, 100_000) || !isInt(m.dealerRotations, 0, 100_000) || !isInt(m.dealerStreak, 0, 100_000) || !isInt(m.dealerSeat, 0, 3) || !isInt(m.prevailingWind, 0, 3)) {
    return 'the match position is not valid';
  }
  if (!fourNumbers(m.scores)) return 'the match scores are not four numbers';
  if (m.matchOver !== false) return 'the match is over';
  return null;
}

/** The rules the hand was dealt under, checked like the table's and against them. */
function handRulesProblem(game: Obj, rules: RuleSet): string | null {
  const own = rulesProblem(game.rules);
  if (own) return `in the hand: ${own}`;
  if (stableStringify(sanitizeRules(game.rules)) !== stableStringify(rules)) return 'the hand was dealt under other rules than the table has';
  return null;
}

function gameProblem(data: Obj, rules: RuleSet): string | null {
  const game = data.game;
  const audits = data.audits as unknown[];
  if (data.phase === 'playing' || data.phase === 'hand_over') {
    if (!isObject(game)) return 'the hand in play is missing';
    const own = handRulesProblem(game, rules);
    if (own) return own;
    if (typeof game.seed !== 'string' || !game.seed || !Array.isArray(game.actionLog)) return 'the hand has no seed or no moves';
    if ((data.phase === 'playing') !== (game.phase === 'discard' || game.phase === 'claim')) return 'the hand is not in the state the table is';
    let replayed: GameState;
    try {
      replayed = replayHand(data.snapshot as MatchSnapshot, game.seed, game.rules as RuleSet, game.actionLog as LoggedAction[]);
    } catch (e) {
      return `the hand does not replay (${(e as Error).message.slice(0, 120)})`;
    }
    return hashState(replayed) === hashState(game as unknown as GameState) ? null : 'the hand is not what its deal and moves give';
  }
  // Between hands (or before the first): the last hand as its record published it, if there was one.
  if (game === null || game === undefined) return audits.length === 0 ? null : 'the last hand is missing';
  if (!isObject(game)) return 'the last hand is not a hand';
  const own = handRulesProblem(game, rules);
  if (own) return own;
  const last = audits[audits.length - 1];
  if (!isObject(last) || typeof last.finalHash !== 'string') return 'the last hand has no record';
  if (game.phase !== 'ended' || hashState(game as unknown as GameState) !== last.finalHash) return 'the last hand is not the one its record shows';
  let next: MatchSnapshot;
  try {
    next = advanceMatch(game as unknown as GameState);
  } catch (e) {
    return `the match cannot move on from the last hand (${(e as Error).message.slice(0, 120)})`;
  }
  return stableStringify(next) === stableStringify(data.snapshot) ? null : 'the match position does not follow the last hand';
}

/** What keeps this snapshot from being restored as a live table, in a few words; null when it may be. */
export function snapshotProblem(data: unknown): string | null {
  if (!isObject(data)) return 'the snapshot is not an object';
  if (data.version !== 1) return `the snapshot version ${String(data.version)} is unknown`;
  if (typeof data.matchId !== 'string' || !data.matchId) return 'the snapshot has no match id';
  if (typeof data.phase !== 'string' || !RESUMABLE_PHASES.has(data.phase)) return `the table cannot be resumed in phase ${String(data.phase)}`;
  const rules = rulesProblem(data.rules);
  if (rules) return rules;
  const seats = data.seats;
  if (!Array.isArray(seats) || seats.length !== 4 || seats.some((s, i) => !isObject(s) || s.seat !== i || typeof s.isBot !== 'boolean' || typeof s.name !== 'string')) {
    return 'the seats are not four seats in order';
  }
  const clean = sanitizeRules(data.rules);
  if (typeof data.botSkill !== 'string' || !Object.prototype.hasOwnProperty.call(BOT_SKILLS, data.botSkill)) return 'the bot strength is not one the engine has';
  if (!fourNumbers(data.banks)) return 'the time banks are not four numbers';
  if ((data.banks as number[]).some((b) => b < 0 || b > clean.timeBankSeconds * 1000)) return 'a time bank is outside what the rules give';
  if (!Array.isArray(data.audits) || data.audits.some((a) => !isObject(a) || !Number.isInteger(a.handNumber) || typeof a.finalHash !== 'string')) return 'the hand records are not valid';
  const bots = botSeatsProblem(data);
  if (bots) return bots;
  const match = matchProblem(data.snapshot);
  if (match) return match;
  return gameProblem(data, clean);
}
