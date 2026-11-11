/**
 * Puzzle generators for single-player training (daily puzzle, puzzle rush,
 * drills). Everything is seeded so a "daily" puzzle is identical for every
 * player and a rush run can be replayed.
 *
 * Five themes: discard (tile efficiency), waits (name every winning tile),
 * defence (the safest tiles against an opponent with four exposed sets, by the
 * bots' deal-in model and checked by exact enumeration), claim (the response
 * that leaves the hand closest to ready and worth most) and value (the ready
 * discard with the highest expected score). Each has a seeded generator, every
 * accepted answer (several when they are about equal) and a checker.
 *
 * Chinese: first pass, needs native review.
 */
import { coachAction, honourTai, readOpponents, unseenCounts, waitChance, type OpponentRead } from './bot';
import { applyAction, legalActions, type Action, type GameState, type PlayerState } from './game';
import { countsFromKinds, discardOptions, isComplete, relevantKinds, shanten, TOTAL_SETS, waits, type Counts } from './hand';
import { type Meld, type MeldType } from './meld';
import { createRng, shuffle, WALL_RNG_VERSION, type Rng } from './rng';
import { DEFAULT_RULES } from './rules';
import { prevailingWindKind, scoreWin, seatWindKind, type TaiItem } from './scoring';
import { isHonorKind, kindInfo, kindOf, KIND_DRAGON, KIND_WIND, NUM_PLAY_KINDS, NUM_TILES, rankOfKind, sortTiles, type Kind, type TileId } from './tiles';

export interface DiscardPuzzle {
  type: 'discard';
  seed: string;
  /** 17 concealed tiles (kinds), sorted. */
  hand: Kind[];
  /** Kinds that count as a correct answer (ties within 10% acceptance). */
  answers: Kind[];
  best: Kind;
  bestShanten: number;
  bestAcceptance: number;
  currentShanten: number;
  /** Per-kind analysis for explanations. */
  options: Array<{ kind: Kind; shanten: number; acceptance: number; accepts: Kind[] }>;
}

export interface WaitsPuzzle {
  type: 'waits';
  seed: string;
  /** 16 concealed tiles, ready to win. */
  hand: Kind[];
  answers: Kind[];
  candidates: Kind[];
}

export type Puzzle = DiscardPuzzle | WaitsPuzzle;

function randomHand(rng: Rng, maxShanten: number, minShanten = 0): Kind[] {
  for (let attempt = 0; attempt < 500; attempt++) {
    const pool: Kind[] = [];
    for (let k = 0; k < NUM_PLAY_KINDS; k++) for (let c = 0; c < 4; c++) pool.push(k);
    shuffle(pool, rng);
    const hand = pool.slice(0, 17).sort((a, b) => a - b);
    const sh = shanten(countsFromKinds(hand), 5);
    if (sh <= maxShanten && sh >= minShanten) return hand;
  }
  return [];
}

export function discardPuzzle(seed: string, difficulty: 1 | 2 | 3 = 2): DiscardPuzzle {
  const rng = createRng(`discard:${seed}`);
  // Harder puzzles are closer to ready, where the differences between discards are subtler.
  const [maxS, minS] = difficulty === 1 ? [4, 2] : difficulty === 2 ? [2, 1] : [1, 0];
  for (let attempt = 0; attempt < 50; attempt++) {
    const hand = randomHand(rng, maxS, minS);
    if (hand.length === 0) continue;
    const counts = countsFromKinds(hand);
    const unseen = counts.map((c) => 4 - c);
    const options = discardOptions(counts, 5, unseen);
    const bestShanten = Math.min(...options.map((o) => o.shanten));
    const bestAcceptance = Math.max(...options.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
    const answers = options.filter((o) => o.shanten === bestShanten && o.acceptance >= bestAcceptance * 0.9).map((o) => o.kind);
    // Skip hands where almost anything is right: a puzzle needs a real decision.
    if (answers.length > Math.max(2, Math.floor(options.length / 3))) continue;
    const best = options.find((o) => o.shanten === bestShanten && o.acceptance === bestAcceptance)!.kind;
    return { type: 'discard', seed, hand, answers, best, bestShanten, bestAcceptance, currentShanten: shanten(counts, 5), options };
  }
  // Fallback: accept whatever we got.
  const hand = randomHand(rng, 8);
  const counts = countsFromKinds(hand);
  const options = discardOptions(counts, 5, counts.map((c) => 4 - c));
  const bestShanten = Math.min(...options.map((o) => o.shanten));
  const bestAcceptance = Math.max(...options.filter((o) => o.shanten === bestShanten).map((o) => o.acceptance));
  const best = options.find((o) => o.shanten === bestShanten && o.acceptance === bestAcceptance)!.kind;
  return { type: 'discard', seed, hand, answers: [best], best, bestShanten, bestAcceptance, currentShanten: shanten(counts, 5), options };
}

/** A random ready (聽牌) 16-tile hand built from 5 random sets + a pair minus one tile. */
export function waitsPuzzle(seed: string, difficulty: 1 | 2 | 3 = 2): WaitsPuzzle {
  const rng = createRng(`waits:${seed}`);
  const minWaits = difficulty === 1 ? 1 : difficulty === 2 ? 2 : 3;
  let fallback: WaitsPuzzle | null = null;
  for (let attempt = 0; attempt < 600; attempt++) {
    const counts = new Array<number>(NUM_PLAY_KINDS).fill(0);
    const hand: Kind[] = [];
    const add = (k: Kind) => {
      counts[k]++;
      hand.push(k);
    };
    let ok = true;
    // Harder puzzles use fewer suits so shapes interlock.
    const suits = difficulty === 3 ? [rng.int(3)] : difficulty === 2 ? [rng.int(3), rng.int(3)] : [0, 1, 2];
    for (let s = 0; s < 5 && ok; s++) {
      if (rng.next() < 0.7) {
        const suit = suits[rng.int(suits.length)];
        const start = suit * 9 + rng.int(7);
        if (counts[start] >= 4 || counts[start + 1] >= 4 || counts[start + 2] >= 4) ok = false;
        else {
          add(start);
          add(start + 1);
          add(start + 2);
        }
      } else {
        const k = difficulty === 1 && rng.next() < 0.5 ? 27 + rng.int(7) : suits[rng.int(suits.length)] * 9 + rng.int(9);
        if (counts[k] + 3 > 4) ok = false;
        else {
          add(k);
          add(k);
          add(k);
        }
      }
    }
    if (!ok) continue;
    const pair = rng.next() < 0.3 ? 27 + rng.int(7) : suits[rng.int(suits.length)] * 9 + rng.int(9);
    if (counts[pair] + 2 > 4) continue;
    add(pair);
    add(pair);
    hand.splice(rng.int(hand.length), 1);
    hand.sort((a, b) => a - b);
    const answers = waits(countsFromKinds(hand), 5);
    if (answers.length === 0) continue;
    const puzzle: WaitsPuzzle = { type: 'waits', seed, hand, answers, candidates: relevantKinds(countsFromKinds(hand)) };
    if (answers.length >= minWaits) return puzzle;
    fallback = fallback ?? puzzle;
  }
  return fallback ?? { type: 'waits', seed, hand: [], answers: [], candidates: [] };
}

/** Deterministic daily puzzle id for a calendar date (UTC). */
export function dailySeed(date: Date): string {
  return `daily-${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function dailyPuzzle(date: Date): DiscardPuzzle {
  const day = date.getUTCDay();
  const difficulty: 1 | 2 | 3 = day === 0 || day === 6 ? 3 : day % 2 === 0 ? 2 : 1;
  return discardPuzzle(dailySeed(date), difficulty);
}

/** Every puzzle theme, in Puzzle Rush rotation order. */
export const PUZZLE_TYPES = ['discard', 'defence', 'waits', 'claim', 'value'] as const;
/** The original rotation (two discard puzzles, then a waits puzzle), still the two-argument default. */
const CLASSIC_RUSH: readonly PuzzleType[] = ['discard', 'discard', 'waits'];

/** Generate one puzzle of the given theme. */
export function puzzleOfType(type: PuzzleType, seed: string, difficulty: PuzzleDifficulty = 2): AnyPuzzle {
  switch (type) {
    case 'discard':
      return discardPuzzle(seed, difficulty);
    case 'waits':
      return waitsPuzzle(seed, difficulty);
    case 'defence':
      return defencePuzzle(seed, difficulty);
    case 'claim':
      return claimPuzzle(seed, difficulty);
    case 'value':
      return valuePuzzle(seed, difficulty);
  }
}

/**
 * Puzzle Rush: an endless, seeded sequence that gets harder as you go. With two
 * arguments it keeps the classic discard/waits rotation; pass `PUZZLE_TYPES` to
 * rotate all five themes (as the app's Rush does).
 */
export function rushPuzzle(runSeed: string, index: number): Puzzle;
export function rushPuzzle(runSeed: string, index: number, types: readonly PuzzleType[]): AnyPuzzle;
export function rushPuzzle(runSeed: string, index: number, types: readonly PuzzleType[] = CLASSIC_RUSH): AnyPuzzle {
  const difficulty: 1 | 2 | 3 = index < 5 ? 1 : index < 15 ? 2 : 3;
  const seed = `${runSeed}:${index}`;
  const list = types.length > 0 ? types : CLASSIC_RUSH;
  return puzzleOfType(list[index % list.length], seed, difficulty);
}

export function checkDiscardAnswer(p: DiscardPuzzle, kind: Kind): boolean {
  return p.answers.includes(kind);
}

export function checkWaitsAnswer(p: WaitsPuzzle, chosen: Kind[]): boolean {
  const set = new Set(chosen);
  return set.size === p.answers.length && p.answers.every((k) => set.has(k));
}

// ===========================================================================
// Shared pieces for the table puzzles (defence, claim, value)
// ===========================================================================

export type PuzzleDifficulty = 1 | 2 | 3;

/** An exposed (or concealed-kong) set as a puzzle shows it. */
export interface PuzzleMeld {
  type: MeldType;
  kinds: Kind[];
  concealed: boolean;
  /** Seat the claimed tile came from (absolute seat). */
  from?: number;
}

/** What another seat shows at the table: exposed sets and discards (oldest first). */
export interface PuzzleSeatView {
  /** Absolute seat; the solver always sits in seat 0, so 1 is on the right, 2 opposite, 3 on the left. */
  seat: number;
  melds: PuzzleMeld[];
  discards: Kind[];
}

/** Explanation shown after answering: a stable key plus English and Taiwanese Mandarin text. */
export interface PuzzleExplanation {
  reasonKey: string;
  explanation: string;
  explanationZh: string;
}

/** Remaining copies of each playable kind while a table is being dealt out. */
class TilePool {
  readonly left = new Array<number>(NUM_PLAY_KINDS).fill(4);

  take(k: Kind, n = 1): boolean {
    if (this.left[k] < n) return false;
    this.left[k] -= n;
    return true;
  }

  takeAll(kinds: readonly Kind[]): void {
    for (const k of kinds) this.left[k]--;
  }

  /** `n` random tiles without removing them, or null when too few are left. */
  sample(rng: Rng, n: number, ok?: (k: Kind) => boolean): Kind[] | null {
    const bag: Kind[] = [];
    for (let k = 0; k < NUM_PLAY_KINDS; k++) if (!ok || ok(k)) for (let c = 0; c < this.left[k]; c++) bag.push(k);
    if (bag.length < n) return null;
    for (let i = 0; i < n; i++) {
      const j = i + rng.int(bag.length - i);
      const t = bag[i];
      bag[i] = bag[j];
      bag[j] = t;
    }
    return bag.slice(0, n);
  }

  draw(rng: Rng, n: number, ok?: (k: Kind) => boolean): Kind[] | null {
    const out = this.sample(rng, n, ok);
    if (out) this.takeAll(out);
    return out;
  }
}

/** A random chow or pong taken from the pool (`suits` limits suited sets; honour pongs need `honours`). */
function randomSet(rng: Rng, pool: TilePool, pongChance: number, suits: readonly number[] = [0, 1, 2], honours = true): Kind[] | null {
  for (let tries = 0; tries < 12; tries++) {
    if (rng.next() < pongChance) {
      const honour = honours && rng.next() < 0.3;
      const k = honour ? KIND_WIND + rng.int(7) : suits[rng.int(suits.length)] * 9 + rng.int(9);
      if (pool.take(k, 3)) return [k, k, k];
    } else {
      const start = suits[rng.int(suits.length)] * 9 + rng.int(7);
      if (pool.left[start] > 0 && pool.left[start + 1] > 0 && pool.left[start + 2] > 0) {
        pool.takeAll([start, start + 1, start + 2]);
        return [start, start + 1, start + 2];
      }
    }
  }
  return null;
}

function randomHonourPong(rng: Rng, pool: TilePool): Kind[] | null {
  for (let tries = 0; tries < 8; tries++) {
    const k = KIND_WIND + rng.int(7);
    if (pool.take(k, 3)) return [k, k, k];
  }
  return null;
}

interface SeatSetup {
  hand: Kind[];
  melds: PuzzleMeld[];
  discards: Kind[];
}

/**
 * A mid-hand table built from kinds: every listed tile gets its own physical copy and the
 * rest (plus the bonus tiles) form the live wall. `turn` holds 17 tiles and is to discard.
 */
function buildTable(seats: SeatSetup[], turn: number, dealerSeat: number, prevailingWind: number, rng: Rng): GameState {
  const next = new Array<number>(NUM_PLAY_KINDS).fill(0);
  const id = (k: Kind): TileId => {
    if (next[k] >= 4) throw new Error(`puzzle table: fifth copy of kind ${k}`);
    return k * 4 + next[k]++;
  };
  const players: PlayerState[] = seats.map((seat) => {
    const hand = sortTiles(seat.hand.map(id));
    const melds: Meld[] = seat.melds.map((m) => {
      const tiles = m.kinds.map(id);
      return m.concealed ? { type: m.type, tiles, concealed: true } : { type: m.type, tiles, concealed: false, from: m.from, claimed: tiles[tiles.length - 1] };
    });
    return { hand, melds, flowers: [], discards: seat.discards.map(id), passedWin: false, draws: seat.discards.length + 1 };
  });
  const wall: TileId[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) for (let c = next[k]; c < 4; c++) wall.push(k * 4 + c);
  for (let t = NUM_PLAY_KINDS * 4; t < NUM_TILES; t++) wall.push(t);
  shuffle(wall, rng);
  const turnHand = players[turn].hand;
  return {
    rules: DEFAULT_RULES,
    seed: 'puzzle',
    rngVersion: WALL_RNG_VERSION,
    handNumber: 0,
    dealerRotations: 0,
    dealerSeat,
    dealerStreak: 0,
    prevailingWind,
    scores: [0, 0, 0, 0],
    wall,
    drawIndex: 0,
    backIndex: wall.length,
    players,
    turn,
    phase: 'discard',
    lastDrawn: turnHand[turnHand.length - 1],
    drawSource: 'wall',
    matchOver: false,
    actionLog: [],
    turnCounter: seats.reduce((n, s) => n + s.discards.length, 0),
    anyClaimThisHand: seats.some((s) => s.melds.some((m) => !m.concealed)),
    dealerDiscards: Math.max(1, seats[dealerSeat].discards.length),
    lastTileDrawn: false,
  };
}

/** Shanten after discarding each held kind (index = kind, Infinity when not held). */
function shantenByDiscard(counts: Counts, setsNeeded: number): number[] {
  const out = new Array<number>(NUM_PLAY_KINDS).fill(Infinity);
  const c = counts.slice();
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (c[k] === 0) continue;
    c[k]--;
    out[k] = shanten(c, setsNeeded);
    c[k]++;
  }
  return out;
}

/** Tile acceptance after discarding `kind` (the same count `discardOptions` reports, for one kind). */
function acceptanceAfter(counts: Counts, setsNeeded: number, kind: Kind, unseen: Counts): number {
  const c = counts.slice();
  c[kind]--;
  const base = shanten(c, setsNeeded);
  let acceptance = 0;
  for (const a of relevantKinds(c)) {
    if (c[a] >= 4 || unseen[a] <= 0) continue;
    c[a]++;
    if (shanten(c, setsNeeded) < base) acceptance += unseen[a];
    c[a]--;
  }
  return acceptance;
}

/** Kinds that complete a 3n+1 hand (pure shape, a fifth copy excluded): `waits` limited to kinds near held tiles. */
function shapeWaits(counts: Counts, setsNeeded: number): Kind[] {
  const out: Kind[] = [];
  for (const k of relevantKinds(counts)) {
    if (counts[k] >= 4) continue;
    counts[k]++;
    if (isComplete(counts, setsNeeded)) out.push(k);
    counts[k]--;
  }
  return out;
}

const tileEn = (k: Kind): string => kindInfo(k).nameEn;
const tileZh = (k: Kind): string => kindInfo(k).nameZh;
const SEAT_EN = ['you', 'the player on your right', 'the player opposite', 'the player on your left'];
const SEAT_ZH = ['你', '下家', '對家', '上家'];
const capitalise = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

function meldsView(p: PlayerState): PuzzleMeld[] {
  return p.melds.map((m) => ({ type: m.type, kinds: m.tiles.map(kindOf), concealed: m.concealed, ...(m.from !== undefined ? { from: m.from } : {}) }));
}

function seatViews(s: GameState): PuzzleSeatView[] {
  return [1, 2, 3].map((seat) => ({ seat, melds: meldsView(s.players[seat]), discards: s.players[seat].discards.map(kindOf) }));
}

// ===========================================================================
// Defence: the safest tiles against one opponent with four exposed sets
// ===========================================================================

/** Why a tile is safe, from strongest to weakest kind of safety. */
export type DefenceReason = 'deadHonour' | 'theirDiscard' | 'passed' | 'lastHonour' | 'honour' | 'fewCopies' | 'terminal' | 'middle';

export interface DefenceOption {
  kind: Kind;
  shanten: number;
  /** The engine's deal-in estimate (`dealInRisk`, the bots' model) against the table as shown. */
  danger: number;
  /**
   * Exact chance that this kind wins for the threat if it is ready, by enumerating every hand its
   * four concealed tiles could be (`exactWaitChances`). Kinds it threw or let pass are not waits.
   */
  exact: number;
  /**
   * Accepted: keeps the hand's shanten and is within `DEFENCE_TOLERANCE` of the safest such discard.
   * Every shape-keeping discard that is not accepted has a strictly higher `exact` chance than every
   * accepted one (a table where the model and the count disagree is not made into a puzzle).
   */
  accepted: boolean;
  reason: DefenceReason;
}

export interface DefencePuzzle extends PuzzleExplanation {
  type: 'defence';
  seed: string;
  difficulty: PuzzleDifficulty;
  /** Your 17 concealed tiles (seat 0, no exposed sets), sorted. */
  hand: Kind[];
  /** Your own discards, oldest first. */
  ownDiscards: Kind[];
  /** Seats 1–3 as the table shows them (discards oldest first: the last tile is the latest). */
  opponents: PuzzleSeatView[];
  /** The opponent who looks close to winning: four exposed sets. */
  threatSeat: number;
  /** The bots' estimate that the threat is ready (`readOpponents`). */
  threatLevel: number;
  /** Shanten of the hand: the discards that keep it are the candidates. */
  bestShanten: number;
  /** Every discard with its shanten and danger. */
  options: DefenceOption[];
  /** Every accepted discard: the safest ones that keep `bestShanten` (within the tolerance). */
  answers: Kind[];
  /** The safest of them, which the explanation is about. */
  answer: Kind;
  /** The most efficient of the shape-keeping discards (highest acceptance), for the explanation. */
  efficient: Kind;
  reason: DefenceReason;
}

/** Discards whose estimated deal-in chance (if the threat is ready) is within this of the safest all count as right. */
export const DEFENCE_TOLERANCE = 0.01;

const binomial = (n: number, k: number): number => {
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return r;
};

/**
 * For a seat with four exposed sets (four concealed tiles: one set and a pair to make), the exact
 * chance that each kind is one of its winning tiles, given it is ready: every four-tile hand the
 * `unseen` pool allows, weighted by the number of ways the pool deals it (each copy equally
 * likely), keeping the ready hands none of whose winning tiles is `excluded`. Every ready hand
 * plus a winning tile is a pair and a set, so the hands are found from those five-tile shapes.
 */
export function exactWaitChances(unseen: Counts, excluded: readonly boolean[]): number[] {
  const sets: Kind[][] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    sets.push([k, k, k]);
    if (k < KIND_WIND && rankOfKind(k) <= 7) sets.push([k, k + 1, k + 2]);
  }
  const waitsOf = new Map<string, { counts: number[]; waits: Set<Kind> }>();
  for (let pair = 0; pair < NUM_PLAY_KINDS; pair++) {
    for (const set of sets) {
      const five = new Array<number>(NUM_PLAY_KINDS).fill(0);
      five[pair] += 2;
      for (const k of set) five[k]++;
      if (five.some((c) => c > 4)) continue;
      for (let w = 0; w < NUM_PLAY_KINDS; w++) {
        if (five[w] === 0) continue;
        five[w]--;
        if (five.every((c, k) => c <= unseen[k])) {
          const key = five.join(',');
          const e = waitsOf.get(key) ?? { counts: five.slice(), waits: new Set<Kind>() };
          e.waits.add(w);
          waitsOf.set(key, e);
        }
        five[w]++;
      }
    }
  }
  const win = new Array<number>(NUM_PLAY_KINDS).fill(0);
  let total = 0;
  for (const { counts, waits } of waitsOf.values()) {
    if ([...waits].some((w) => excluded[w])) continue;
    let weight = 1;
    for (let k = 0; k < NUM_PLAY_KINDS; k++) if (counts[k] > 0) weight *= binomial(unseen[k], counts[k]);
    total += weight;
    for (const w of waits) win[w] += weight;
  }
  return win.map((x) => (total > 0 ? x / total : 0));
}

function defenceReason(read: OpponentRead, kind: Kind, unseen: Counts): DefenceReason {
  // A dead honour cannot win at all, whoever threw it: the one certain reason comes first.
  if (isHonorKind(kind) && unseen[kind] === 0) return 'deadHonour';
  if (read.ownDiscards[kind]) return 'theirDiscard';
  if (read.passed[kind]) return 'passed';
  if (isHonorKind(kind)) return unseen[kind] === 1 ? 'lastHonour' : 'honour';
  if (unseen[kind] <= 1) return 'fewCopies';
  return rankOfKind(kind) === 1 || rankOfKind(kind) === 9 ? 'terminal' : 'middle';
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
/** A positive chance to one decimal, or '' when it would print as "0.0%" (the text then says "under 0.1%"). */
const smallPct = (x: number): string => (x < 0.0005 ? '' : pct(x));

function defenceText(p: Pick<DefencePuzzle, 'answer' | 'answers' | 'threatSeat' | 'threatLevel' | 'reason' | 'efficient' | 'opponents' | 'options'>): PuzzleExplanation {
  const t = tileEn(p.answer);
  const tz = tileZh(p.answer);
  const who = SEAT_EN[p.threatSeat];
  const whoZh = SEAT_ZH[p.threatSeat];
  const threatEn = `${capitalise(who)} has four exposed sets and needs only one more set or the pair.`;
  const threatZh = `${whoZh}已經亮了四組面子，只差一組面子或一對眼。`;
  let en: string;
  let zh: string;
  switch (p.reason) {
    case 'theirDiscard':
      en = `${t} is a tile ${who} has thrown. Taiwanese rules have no furiten, so it is not a guarantee, but players rarely wait on a tile they have discarded.`;
      zh = `${tz}是${whoZh}自己打過的熟張。台灣麻將沒有振聽，不是百分之百安全，但很少有人聽自己打掉的牌。`;
      break;
    case 'passed':
      en = `${t} was thrown after ${who}'s last discard and ${who} did not win on it, so it is not one of their winning tiles unless they changed their wait since.`;
      zh = `${tz}在${whoZh}上一次打牌之後有人打過，${whoZh}沒有胡，所以除非後來換了聽牌，這張不是他要的牌。`;
      break;
    case 'deadHonour':
      en = `Every other copy of ${t} is already visible, so nobody can win on it: an honour only completes a pair or a pong.`;
      zh = `${tz}其他幾張都已經看得到了，字牌只能湊對或碰，所以沒有人能胡這張。`;
      break;
    case 'lastHonour':
      en = `Only one ${t} is unseen. An honour never joins a chow, so the only way to deal in is a single-tile wait on that last copy.`;
      zh = `${tz}只剩一張沒出現。字牌不能吃，只有對方單吊最後那張才會放槍。`;
      break;
    case 'honour':
      en = `${t} is an honour: it can complete a pair or a pong but never a chow.`;
      zh = `${tz}是字牌，只能湊對或碰，不能吃。`;
      break;
    case 'fewCopies':
      en = `Most copies of ${t} and its neighbours are visible, so few hands ${who} could hold are waiting on it.`;
      zh = `${tz}和旁邊的牌大多已經看得到了，${whoZh}能聽這張的牌型很少。`;
      break;
    case 'terminal':
      en = `${t} is a terminal: it fits fewer chows than a middle tile.`;
      zh = `${tz}是么九牌，能組成的順子比中張少。`;
      break;
    case 'middle':
      en = `Counting the tiles you can see, ${t} completes the fewest of the hands ${who} could hold.`;
      zh = `算一算看得到的牌，${tz}能讓${whoZh}胡的牌型最少。`;
      break;
  }
  const a = p.options.find((o) => o.kind === p.answer)!;
  const others = p.answers.filter((k) => k !== p.answer);
  // The exact count leaves out every hand that waits on a tile the threat threw or let pass, so for
  // such an answer it is 0 by assumption: quote the coach's own estimate, which is small but not
  // zero. A dead honour needs no figure (nobody can win on it), and a true zero is said in words.
  let numbersEn: string;
  let numbersZh: string;
  if (p.reason === 'theirDiscard' || p.reason === 'passed') {
    const model = a.danger / p.threatLevel;
    numbersEn = ` If ${who} is ready, the coach puts the chance that ${t} wins for them at ${smallPct(model) ? `about ${smallPct(model)}` : 'under 0.1%'}.`;
    numbersZh = `如果${whoZh}已經聽牌，教練估計${tz}放槍的機率${smallPct(model) ? `大約${smallPct(model)}` : '不到0.1%'}。`;
  } else if (p.reason === 'deadHonour') {
    numbersEn = '';
    numbersZh = '';
  } else if (a.exact <= 0) {
    numbersEn = ` If ${who} is ready and is not waiting on a tile they threw or let pass, none of the hands they could hold wins on ${t}.`;
    numbersZh = `如果${whoZh}已經聽牌，而且不是聽自己打過或放過的牌，他可能的牌型沒有一種會胡${tz}。`;
  } else {
    numbersEn = ` If ${who} is ready, ${t} wins for them in ${smallPct(a.exact) ? `about ${smallPct(a.exact)}` : 'under 0.1%'} of the hands they could hold.`;
    numbersZh = `如果${whoZh}已經聽牌，${tz}${smallPct(a.exact) ? `大約只在${smallPct(a.exact)}` : '只在不到0.1%'}的牌型裡會放槍。`;
  }
  const alsoEn = others.length > 0 ? ` ${others.map(tileEn).join(' and ')} ${others.length > 1 ? 'are' : 'is'} about as safe, so ${others.length > 1 ? 'they count' : 'it counts'} too.` : '';
  const alsoZh = others.length > 0 ? `${others.map(tileZh).join('、')}差不多一樣安全，也算對。` : '';
  const keepEn = ' Throwing it also keeps your hand as close to ready as any other discard.';
  const keepZh = '打這張也不會讓你的向聽數退步。';
  const tradeEn = !p.answers.includes(p.efficient) ? ` ${tileEn(p.efficient)} would leave more useful tiles, but not while someone looks ready.` : '';
  const tradeZh = !p.answers.includes(p.efficient) ? `打${tileZh(p.efficient)}進張比較多，但對方看起來快聽牌了，先求安全。` : '';
  return {
    reasonKey: `puzzle.defence.${p.reason}`,
    explanation: `${threatEn} ${en}${numbersEn}${alsoEn}${keepEn}${tradeEn}`,
    explanationZh: `${threatZh}${zh}${numbersZh}${alsoZh}${keepZh}${tradeZh}`,
  };
}

/** What each difficulty plants: 1 tiles the threat threw, 2 a tile let pass or none, 3 visible copies of a held kind. */
const DEFENCE_PLANT: Record<PuzzleDifficulty, 'theirDiscard' | 'passed' | 'copies'> = { 1: 'theirDiscard', 2: 'passed', 3: 'copies' };

/**
 * A 17-tile hand (seat 0) facing one opponent with four exposed sets. Every discard that keeps
 * the hand's shanten is rated by the bots' deal-in model (`readOpponents` / `waitChance`), and
 * every one within `DEFENCE_TOLERANCE` of the safest is accepted. A puzzle is kept only when the
 * exact enumeration (`exactWaitChances`) agrees: its safest kind is accepted, every accepted kind
 * is within 1.5 points of it, every discard that is not accepted is strictly more dangerous by that
 * count than every accepted one, and at least one shape-keeping discard is clearly worse (2 points).
 * Difficulty decides what the table plants (tiles the threat threw, a tile let pass, visible
 * copies), not which rule the answer follows.
 */
export function defencePuzzle(seed: string, difficulty: PuzzleDifficulty = 2): DefencePuzzle {
  const rng = createRng(`defence:${seed}:${difficulty}`);
  for (let attempt = 0; attempt < 600; attempt++) {
    const p = defenceAttempt(seed, difficulty, rng);
    if (p) return p;
  }
  throw new Error(`defencePuzzle: no puzzle for seed ${seed}`);
}

function defenceAttempt(seed: string, difficulty: PuzzleDifficulty, rng: Rng): DefencePuzzle | null {
  const pool = new TilePool();
  const threatSeat = 1 + rng.int(3);
  const melds: PuzzleMeld[] = [];
  for (let i = 0; i < 4; i++) {
    const set = randomSet(rng, pool, 0.45);
    if (!set) return null;
    const pong = set[0] === set[1];
    const from = pong ? (threatSeat + 1 + rng.int(3)) % 4 : (threatSeat + 3) % 4;
    melds.push({ type: pong ? 'pong' : 'chow', kinds: set, concealed: false, from });
  }
  // The threat's four concealed tiles are a ready shape: a set and a single, or a pair and two.
  const threatHand = readyHand(rng, pool, 1);
  if (!threatHand) return null;

  const [minS, maxS] = difficulty === 1 ? [2, 4] : [1, 3];
  let hand: Kind[] | null = null;
  let counts: Counts = [];
  for (let tries = 0; tries < 8 && !hand; tries++) {
    const h = pool.sample(rng, 17);
    if (!h) return null;
    const c = countsFromKinds(h);
    const sh = shanten(c, TOTAL_SETS);
    if (sh >= minS && sh <= maxS) {
      hand = h;
      counts = c;
    }
  }
  if (!hand) return null;
  pool.takeAll(hand);
  const byDiscard = shantenByDiscard(counts, TOTAL_SETS);
  const bestShanten = Math.min(...byDiscard);
  const keepList: Kind[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) if (byDiscard[k] === bestShanten) keepList.push(k);
  if (keepList.length < 3) return null;
  const plant = DEFENCE_PLANT[difficulty];

  const threatDiscards: Kind[] = [];
  if (plant === 'theirDiscard') {
    for (let i = 0, n = 1 + rng.int(2); i < n; i++) {
      const g = keepList[rng.int(keepList.length)];
      if (pool.take(g)) threatDiscards.push(g);
    }
  }
  const rest = pool.draw(rng, 5 + rng.int(6) - threatDiscards.length, (k) => plant === 'theirDiscard' || !keepList.includes(k));
  if (!rest) return null;
  threatDiscards.push(...rest);
  shuffle(threatDiscards, rng);

  // Turn order is threat, then the seats after it, then you: those seats threw after the threat.
  const otherSeats = [1, 2, 3].filter((x) => x !== threatSeat);
  const otherDiscards: Kind[][] = [[], []];
  if (plant === 'copies') {
    const k = keepList[rng.int(keepList.length)];
    const want = Math.max(0, 4 - counts[k] - rng.int(2));
    for (let i = 0; i < want; i++) {
      if (!pool.take(k)) return null;
      otherDiscards[rng.int(2)].splice(0, 0, k);
    }
  }
  for (let i = 0; i < 2; i++) {
    const d = pool.draw(rng, Math.max(1, 5 + rng.int(6) - otherDiscards[i].length), (k) => plant === 'passed' || !keepList.includes(k) || rng.next() < 0.3);
    if (!d) return null;
    otherDiscards[i].splice(0, 0, ...d);
    shuffle(otherDiscards[i], rng);
  }
  if (plant === 'passed') {
    // The latest discard of a seat that plays after the threat: a kind you could throw.
    const after = otherSeats.filter((x) => x > threatSeat).map((x) => otherSeats.indexOf(x));
    if (after.length > 0) {
      const i = after[rng.int(after.length)];
      const k = keepList[rng.int(keepList.length)];
      if (!pool.take(k)) return null;
      otherDiscards[i].push(k);
    }
  }
  const ownDiscards = pool.draw(rng, 5 + rng.int(6));
  if (!ownDiscards) return null;
  const hidden: Kind[][] = [];
  for (let i = 0; i < 2; i++) {
    const h = pool.draw(rng, 16);
    if (!h) return null;
    hidden.push(h);
  }

  const seats: SeatSetup[] = [{ hand, melds: [], discards: ownDiscards }];
  for (let seat = 1; seat < 4; seat++) {
    if (seat === threatSeat) seats.push({ hand: threatHand, melds, discards: threatDiscards });
    else {
      const i = otherSeats.indexOf(seat);
      seats.push({ hand: hidden[i], melds: [], discards: otherDiscards[i] });
    }
  }
  const s = buildTable(seats, 0, rng.int(4), rng.int(2), rng);
  const read = readOpponents(s, 0)[threatSeat];
  const unseen = unseenCounts(s, 0);
  const excluded = read.ownDiscards.map((x, k) => x || read.passed[k]);
  const exact = exactWaitChances(unseen, excluded);
  const options: DefenceOption[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (counts[k] === 0) continue;
    options.push({ kind: k, shanten: byDiscard[k], danger: read.tenpai * waitChance(read, k, unseen), exact: exact[k], accepted: false, reason: defenceReason(read, k, unseen) });
  }
  const kept = options.filter((o) => o.shanten === bestShanten);
  const minChance = Math.min(...kept.map((o) => o.danger / read.tenpai));
  for (const o of kept) o.accepted = o.danger / read.tenpai <= minChance + DEFENCE_TOLERANCE;
  const accepted = kept.filter((o) => o.accepted);
  // The exact enumeration must agree with the model, and there must be a real choice to make.
  const exactMin = Math.min(...kept.map((o) => o.exact));
  if (!kept.some((o) => o.accepted && o.exact <= exactMin + 1e-9)) return null;
  if (accepted.some((o) => o.exact > exactMin + 0.015)) return null;
  // No tile is marked wrong that the count rates as safe as an accepted one, or safer.
  const acceptedMax = Math.max(...accepted.map((o) => o.exact));
  if (kept.some((o) => !o.accepted && o.exact <= acceptedMax + 1e-9)) return null;
  if (!kept.some((o) => !o.accepted && o.exact >= exactMin + 0.02)) return null;
  if (accepted.length > Math.max(2, Math.floor(kept.length / 2))) return null;
  const best = accepted.slice().sort((x, y) => x.danger - y.danger || x.exact - y.exact || x.kind - y.kind)[0];
  let efficient = best.kind;
  let bestAcc = -1;
  for (const o of kept) {
    const acc = acceptanceAfter(counts, TOTAL_SETS, o.kind, unseen);
    if (acc > bestAcc) {
      bestAcc = acc;
      efficient = o.kind;
    }
  }
  const opponents = seatViews(s);
  const base = { answer: best.kind, answers: accepted.map((o) => o.kind), threatSeat, threatLevel: read.tenpai, reason: best.reason, efficient, opponents, options };
  return {
    type: 'defence',
    seed,
    difficulty,
    hand: hand.slice().sort((a, b) => a - b),
    ownDiscards,
    bestShanten,
    ...base,
    ...defenceText(base),
  };
}

export function checkDefenceAnswer(p: DefencePuzzle, kind: Kind): boolean {
  return p.answers.includes(kind);
}

// ===========================================================================
// Claim: what the coach does in a claim window
// ===========================================================================

export type ClaimChoice = 'pass' | 'hu' | 'pong' | 'kong' | 'chi';

export interface ClaimOption {
  /** Stable id: 'pass', 'hu', 'pong', 'kong' or 'chi:<kind>-<kind>' (the two hand kinds, lower first). */
  id: string;
  type: ClaimChoice;
  /** For 吃: the two hand kinds used with the discard. */
  kinds?: [Kind, Kind];
  /** Shanten after taking this claim and making the best discard (pass: unchanged; hu: -1). */
  shantenAfter: number;
  /**
   * What the hand is worth afterwards, comparable between options that reach the same shanten: when
   * ready, the expected score of its winning tiles (`scoreWaits`: live copies, 台 by discard and by
   * self-draw, so 門清 and value pongs count); otherwise the useful tiles left times a win at the 台
   * the hand can already count on (value pongs, 門清). 胡 is not scored.
   */
  value: number;
  /** Live winning tiles after the claim and the best discard, when it leaves the hand ready. */
  waits?: Kind[];
  /** Live copies of `waits` (ready), or of the tiles that would improve the hand (not ready). */
  acceptance: number;
  /** Accepted: reaches the lowest shanten on offer and is within `CLAIM_TOLERANCE` of the best value there. */
  accepted: boolean;
}

/** Claims whose value is at least this share of the best (at the same shanten) all count as right. */
export const CLAIM_TOLERANCE = 0.9;

export interface ClaimPuzzle extends PuzzleExplanation {
  type: 'claim';
  seed: string;
  difficulty: PuzzleDifficulty;
  /** Your concealed tiles (16 minus three per exposed set), sorted. */
  hand: Kind[];
  melds: PuzzleMeld[];
  /** The tile just discarded. */
  discard: Kind;
  /** Seat that discarded it: 3 is on your left (the only seat you may 吃 from). */
  from: number;
  dealerSeat: number;
  prevailingWind: number;
  opponents: PuzzleSeatView[];
  /** Your own discards, oldest first (they count when judging how many winning tiles are live). */
  ownDiscards: Kind[];
  shantenBefore: number;
  /** Legal responses: pass, 胡, 碰, 槓 and each 吃 shape. */
  options: ClaimOption[];
  /** The coach's action (`coachAction`); always one of the accepted options. */
  answer: ClaimOption;
  /** Ids of every accepted option. */
  answers: string[];
}

function claimOptionOf(a: Action): Pick<ClaimOption, 'id' | 'type' | 'kinds'> {
  if (a.type === 'chi') {
    const ks = a.tiles.map(kindOf).sort((x, y) => x - y) as [Kind, Kind];
    return { id: `chi:${ks[0]}-${ks[1]}`, type: 'chi', kinds: ks };
  }
  const type = a.type as Exclude<ClaimChoice, 'chi'>;
  return { id: type, type };
}

function claimLabel(o: ClaimOption, discard: Kind): { en: string; zh: string } {
  switch (o.type) {
    case 'pass':
      return { en: 'Pass', zh: '不要' };
    case 'hu':
      return { en: `胡 on ${tileEn(discard)}`, zh: `胡${tileZh(discard)}` };
    case 'pong':
      return { en: `碰 ${tileEn(discard)}`, zh: `碰${tileZh(discard)}` };
    case 'kong':
      return { en: `槓 ${tileEn(discard)}`, zh: `槓${tileZh(discard)}` };
    case 'chi': {
      const [a, b] = o.kinds!;
      return { en: `吃 ${tileEn(discard)} with ${tileEn(a)} and ${tileEn(b)}`, zh: `用${tileZh(a)}${tileZh(b)}吃${tileZh(discard)}` };
    }
  }
}

function claimText(p: Pick<ClaimPuzzle, 'answer' | 'discard' | 'shantenBefore' | 'options' | 'melds'>, valuePong: number): PuzzleExplanation {
  const a = p.answer;
  const label = claimLabel(a, p.discard);
  const concealed = p.melds.every((m) => m.concealed);
  if (a.type === 'hu') {
    return {
      reasonKey: 'puzzle.claim.hu',
      explanation: `${tileEn(p.discard)} completes your hand: five sets and a pair. A win comes before every other claim, so call 胡.`,
      explanationZh: `${tileZh(p.discard)}讓你湊齊五組面子加一對眼，胡牌優先於任何吃碰，直接胡。`,
    };
  }
  if (a.type === 'pass') {
    const o = othersText(p);
    if (p.shantenBefore === 0 && concealed) {
      return {
        reasonKey: 'puzzle.claim.passReady',
        explanation: `You are already ready (聽牌) with a concealed hand and ${a.acceptance} live winning tiles. No claim gets you closer, and calling would cost you 門清 (and 門清自摸 on a self-draw), so pass.${o.en}`,
        explanationZh: `你已經聽牌，而且是門清，還有${a.acceptance}張可以胡。吃碰不會讓你更接近胡牌，還會失去門清（自摸時的門清自摸），所以不要。${o.zh}`,
      };
    }
    return {
      reasonKey: 'puzzle.claim.passNoGain',
      explanation: `No claim here leaves the hand better off: none of them gets you closer to ready (向聽) with as much to win. Exposing a set for nothing gives away information and flexibility, so pass.${o.en}`,
      explanationZh: `這些吃碰都不能讓牌變得更好：向聽數沒有降低，能胡的牌和台數也沒有增加。白白亮出一組面子只會洩露牌型、少了變化，所以不要。${o.zh}`,
    };
  }
  const after = a.shantenAfter;
  const stepsEn = after === 0 ? 'makes you ready (聽牌)' : `takes you from ${p.shantenBefore} to ${after} away from ready (向聽)`;
  const stepsZh = after === 0 ? '吃碰後就聽牌' : `向聽數從${p.shantenBefore}降到${after}`;
  const waitEn = after === 0 && a.waits ? ` It leaves ${a.acceptance} live winning tiles.` : '';
  const waitZh = after === 0 && a.waits ? `聽${a.acceptance}張。` : '';
  const valueEn = valuePong ? ` The pong of ${tileEn(p.discard)} is also worth ${valuePong} 台.` : '';
  const valueZh = valuePong ? `${tileZh(p.discard)}的刻子還有${valuePong}台。` : '';
  const kongEn = a.type === 'kong' ? ' A kong also brings a replacement tile from the back of the wall.' : '';
  const kongZh = a.type === 'kong' ? '槓還可以從牌尾補一張。' : '';
  return {
    reasonKey: a.type === 'kong' ? 'puzzle.claim.kong' : after === 0 ? 'puzzle.claim.ready' : 'puzzle.claim.closer',
    explanation: `${label.en} ${stepsEn}.${waitEn}${valueEn}${kongEn}${othersText(p).en}`,
    explanationZh: `${label.zh}，${stepsZh}。${waitZh}${valueZh}${kongZh}${othersText(p).zh}`,
  };
}

/** How the other options compare: equally good ones named, worse ones summed up. */
function othersText(p: Pick<ClaimPuzzle, 'answer' | 'discard' | 'options'>): { en: string; zh: string } {
  const also = p.options.filter((o) => o.accepted && o.id !== p.answer.id);
  const worse = p.options.filter((o) => !o.accepted && o.type !== 'hu');
  let en = '';
  let zh = '';
  if (also.length > 0) {
    en += ` ${also.map((o) => claimLabel(o, p.discard).en).join(' and ')} ${also.length > 1 ? 'are' : 'is'} about as good.`;
    zh += `${also.map((o) => claimLabel(o, p.discard).zh).join('、')}差不多一樣好。`;
  }
  if (worse.some((o) => o.shantenAfter > p.answer.shantenAfter)) {
    en += ' The other choices leave you further from ready.';
    zh += '其他選擇離聽牌比較遠。';
  } else if (worse.length > 0) {
    en += ' The other choices are as close to ready but leave fewer or cheaper winning tiles.';
    zh += '其他選擇向聽數一樣，但能胡的牌比較少或台數比較低。';
  }
  return { en, zh };
}

/** A ready 3n+1 hand: n sets and a pair, minus one tile; null when the pool runs short. */
function readyHand(rng: Rng, pool: TilePool, sets: number): Kind[] | null {
  const hand: Kind[] = [];
  for (let i = 0; i < sets; i++) {
    const set = randomSet(rng, pool, 0.35);
    if (!set) return null;
    hand.push(...set);
  }
  const pair = pool.sample(rng, 1, (k) => pool.left[k] >= 2);
  if (!pair) return null;
  pool.take(pair[0], 2);
  hand.push(pair[0], pair[0]);
  const drop = hand.splice(rng.int(hand.length), 1)[0];
  pool.left[drop]++;
  return hand;
}

const CLAIM_OPTION_COUNT: Record<PuzzleDifficulty, (n: number) => boolean> = {
  1: (n) => n === 2,
  2: (n) => n === 3,
  3: (n) => n >= 4,
};

/**
 * A claim window: your hand, a discard from another seat and your legal claims. The answer
 * is the coach's action (`coachAction`), kept only when no other option scores the same under
 * the coach's own claim evaluation. Difficulty is the number of options: 2, 3, or 4 and more.
 */
export function claimPuzzle(seed: string, difficulty: PuzzleDifficulty = 2): ClaimPuzzle {
  const rng = createRng(`claim:${seed}:${difficulty}`);
  // Mix the kind of answer so passing and claiming both turn up.
  const wantClaim = rng.next() < 0.6;
  let fallback: ClaimPuzzle | null = null;
  let anyFallback: ClaimPuzzle | null = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const p = claimAttempt(seed, difficulty, rng);
    if (!p) continue;
    const countOk = CLAIM_OPTION_COUNT[difficulty](p.options.length);
    if (countOk && (p.answer.type !== 'pass') === wantClaim) return p;
    if (countOk) fallback = fallback ?? p;
    anyFallback = anyFallback ?? p;
    if (attempt >= 150 && fallback) return fallback;
  }
  const last = fallback ?? anyFallback;
  if (last) return last;
  throw new Error(`claimPuzzle: no puzzle for seed ${seed}`);
}

function claimAttempt(seed: string, difficulty: PuzzleDifficulty, rng: Rng): ClaimPuzzle | null {
  const pool = new TilePool();
  const dealerSeat = rng.int(4);
  const prevailingWind = rng.int(2);
  const from = difficulty === 1 ? 1 + rng.int(3) : rng.next() < 0.7 ? 3 : 1 + rng.int(2);
  const melds: PuzzleMeld[] = [];
  if (difficulty > 1 && rng.next() < 0.4) {
    const set = randomSet(rng, pool, 0.5);
    if (!set) return null;
    const pong = set[0] === set[1];
    melds.push({ type: pong ? 'pong' : 'chow', kinds: set, concealed: false, from: pong ? 1 + rng.int(3) : 3 });
  }
  const size = 16 - 3 * melds.length;
  const setsNeeded = TOTAL_SETS - melds.length;
  let hand: Kind[] | null = null;
  if (rng.next() < (difficulty === 1 ? 0.3 : 0.15)) hand = readyHand(rng, pool, setsNeeded);
  else {
    for (let tries = 0; tries < 6 && !hand; tries++) {
      const h = pool.sample(rng, size);
      if (!h) return null;
      if (shanten(countsFromKinds(h), setsNeeded) <= 3) hand = h;
    }
    if (hand) pool.takeAll(hand);
  }
  if (!hand) return null;
  const counts = countsFromKinds(hand);

  // The discard: a kind giving this hand as many claims as the difficulty asks for
  // (the engine's offer is still what counts; this only steers the pick).
  const wins = new Set(shanten(counts, setsNeeded) === 0 ? waits(counts, setsNeeded) : []);
  const claimsFor = (k: Kind): number => {
    let n = (counts[k] >= 2 ? 1 : 0) + (counts[k] >= 3 ? 1 : 0) + (wins.has(k) ? 1 : 0);
    if (from === 3 && k < KIND_WIND) {
      const r = k % 9;
      const has = (d: number) => r + d >= 0 && r + d <= 8 && counts[k + d] > 0;
      n += (has(-2) && has(-1) ? 1 : 0) + (has(-1) && has(1) ? 1 : 0) + (has(1) && has(2) ? 1 : 0);
    }
    return n;
  };
  const wanted = (k: Kind): boolean => (difficulty === 3 ? claimsFor(k) >= 3 : claimsFor(k) === difficulty);
  const pick = pool.sample(rng, 1, wanted);
  if (!pick) return null;
  const discard = pick[0];
  pool.take(discard);

  const seats: SeatSetup[] = [];
  for (let seat = 0; seat < 4; seat++) seats.push({ hand: seat === 0 ? hand : [], melds: seat === 0 ? melds : [], discards: [] });
  for (let seat = 1; seat < 4; seat++) {
    const h = pool.draw(rng, 16);
    if (!h) return null;
    seats[seat].hand = seat === from ? [...h, discard] : h;
  }
  for (let seat = 0; seat < 4; seat++) {
    const d = pool.draw(rng, 3 + rng.int(7));
    if (!d) return null;
    seats[seat].discards = d;
  }
  const table = buildTable(seats, from, dealerSeat, prevailingWind, rng);
  const tile = table.players[from].hand.find((t) => kindOf(t) === discard)!;
  const s = applyAction(table, from, { type: 'discard', tile });
  if (s.phase !== 'claim') return null;
  const actions = legalActions(s, 0);
  if (actions.length < 2) return null;
  // About a fifth of windows used to be a bare 胡-or-pass choice: keep only some of them.
  if (actions.some((a) => a.type === 'hu') && rng.next() < 0.65) return null;
  const coach = coachAction(s, 0);
  if (!coach) return null;
  const before = shanten(counts, setsNeeded);
  const unseen = unseenCounts(s, 0);
  const options: ClaimOption[] = actions.map((a) => ({ ...claimOptionOf(a), ...claimOutcome(s, a, before, unseen) }));
  // Accepted: 胡 when offered; otherwise the lowest shanten on offer, and the best value there (within the tolerance).
  const hu = options.find((o) => o.type === 'hu');
  if (hu) hu.accepted = true;
  else {
    const lowest = Math.min(...options.map((o) => o.shantenAfter));
    const top = Math.max(...options.filter((o) => o.shantenAfter === lowest).map((o) => o.value));
    for (const o of options) o.accepted = o.shantenAfter === lowest && o.value >= CLAIM_TOLERANCE * top;
  }
  const answer = options.find((o) => o.id === claimOptionOf(coach).id);
  // The coach and the puzzle's judgement must agree, and there must be a wrong choice to make.
  if (!answer || !answer.accepted || options.every((o) => o.accepted)) return null;
  const valuePong = answer.type === 'pong' || answer.type === 'kong' ? honourTai(s, 0, discard) : 0;
  const base = { answer, discard, shantenBefore: before, options, melds };
  return {
    type: 'claim',
    seed,
    difficulty,
    hand: hand.slice().sort((a, b) => a - b),
    from,
    dealerSeat,
    prevailingWind,
    opponents: seatViews(s),
    ownDiscards: s.players[0].discards.map(kindOf),
    answers: options.filter((o) => o.accepted).map((o) => o.id),
    ...base,
    ...claimText(base, valuePong),
  };
}

/** Points of a win at `tai` with the default rules, a quarter self-drawn (paid by all three). */
function winWorth(tai: number): number {
  const r = DEFAULT_RULES;
  return (1 - VALUE_SELF_DRAW_SHARE) * (r.basePoints + r.taiPoints * tai) + VALUE_SELF_DRAW_SHARE * 3 * (r.basePoints + r.taiPoints * tai);
}

/** Shanten, value and waits of seat 0's hand after answering a claim window with `a` (see `ClaimOption`). */
function claimOutcome(s: GameState, a: Action, before: number, unseen: Counts): Pick<ClaimOption, 'shantenAfter' | 'value' | 'waits' | 'acceptance' | 'accepted'> {
  if (a.type === 'hu') return { shantenAfter: -1, value: 0, acceptance: 0, accepted: false };
  const p = s.players[0];
  const k = kindOf(s.pending!.tile);
  const hand = p.hand.map(kindOf);
  const melds: Meld[] = p.melds.map((m) => ({ ...m }));
  const take = (kinds: Kind[]) => {
    for (const x of kinds) hand.splice(hand.indexOf(x), 1);
  };
  if (a.type === 'pong' || a.type === 'kong') {
    const n = a.type === 'pong' ? 2 : 3;
    take(new Array<Kind>(n).fill(k));
    melds.push({ type: a.type, tiles: new Array<number>(n + 1).fill(0).map((_, i) => k * 4 + i), concealed: false, from: s.pending!.from });
  } else if (a.type === 'chi') {
    const [x, y] = a.tiles.map(kindOf);
    take([x, y]);
    melds.push({ type: 'chow', tiles: [x, y, k].sort((m, n) => m - n).map((q, i) => q * 4 + i), concealed: false, from: s.pending!.from });
  }
  const setsNeeded = TOTAL_SETS - melds.length;
  const concealedHand = melds.every((m) => m.concealed);
  const meldTai = melds.reduce((n, m) => n + (m.type === 'chow' ? 0 : honourTai(s, 0, kindOf(m.tiles[0]))), 0);
  const handTai = 1.5 + meldTai + (concealedHand ? 1 : 0);
  // The 3n+1 hands to judge: the hand itself after a pass (or a kong, which draws a replacement),
  // or each discard that keeps the best shanten after a pong or chow.
  const candidates: Kind[][] = [];
  let after: number;
  if (a.type === 'pass' || a.type === 'kong') {
    after = a.type === 'pass' ? before : shanten(countsFromKinds(hand), setsNeeded);
    candidates.push(hand);
  } else {
    const byDiscard = shantenByDiscard(countsFromKinds(hand), setsNeeded);
    after = Math.min(...byDiscard);
    for (let d = 0; d < NUM_PLAY_KINDS; d++) {
      if (byDiscard[d] !== after) continue;
      const rest = hand.slice();
      rest.splice(rest.indexOf(d), 1);
      candidates.push(rest);
    }
  }
  const ownMelds = countsFromKinds(melds.flatMap((m) => m.tiles.map(kindOf)));
  let best: Pick<ClaimOption, 'value' | 'waits' | 'acceptance'> = { value: -1, acceptance: 0 };
  for (const h of candidates) {
    const c = countsFromKinds(h);
    if (after === 0) {
      const live = shapeWaits(c.slice(), setsNeeded)
        .map((w) => ({ kind: w, live: Math.max(0, Math.min(unseen[w], 4 - c[w] - ownMelds[w])) }))
        .filter((w) => w.live > 0);
      const v = scoreWaits(h, live, melds, s.dealerSeat, s.prevailingWind);
      const acceptance = live.reduce((n, w) => n + w.live, 0);
      if (v.expectedScore! > best.value) best = { value: v.expectedScore!, waits: live.map((w) => w.kind), acceptance };
    } else {
      let acceptance = 0;
      for (const x of relevantKinds(c)) {
        if (c[x] >= 4 || unseen[x] <= 0) continue;
        c[x]++;
        if (shanten(c, setsNeeded) < after) acceptance += unseen[x];
        c[x]--;
      }
      const value = acceptance * winWorth(handTai);
      if (value > best.value) best = { value, acceptance };
    }
  }
  return { shantenAfter: after, ...best, accepted: false };
}

/** Accepts an option, its id, or the engine action the player chose. */
export function checkClaimAnswer(p: ClaimPuzzle, choice: ClaimOption | string | Action): boolean {
  const id = typeof choice === 'string' ? choice : 'id' in choice ? choice.id : claimOptionOf(choice).id;
  return p.answers.includes(id);
}

// ===========================================================================
// Value: several discards keep the hand ready; which one is worth the most?
// ===========================================================================

/** The patterns a value puzzle is about: flushes, all pongs and value-honour pongs (and their bigger cousins). */
const HEADLINE_KEYS: ReadonlySet<string> = new Set([
  'half_flush',
  'full_flush',
  'all_honors',
  'all_pongs',
  `dragon_${KIND_DRAGON}`,
  `dragon_${KIND_DRAGON + 1}`,
  `dragon_${KIND_DRAGON + 2}`,
  'seat_wind',
  'round_wind',
  'small_three_dragons',
  'big_three_dragons',
  'small_four_winds',
  'big_four_winds',
]);

/**
 * Share of wins that are self-drawn when judging a wait: measured at 24% on Club-bot tables
 * (`npm run sim`), rounded to a quarter. A self-drawn win is paid by all three other seats.
 */
export const VALUE_SELF_DRAW_SHARE = 0.25;
/** Discards whose expected score is at least this share of the best one's all count as right. */
export const VALUE_TOLERANCE = 0.9;

/** One winning tile of a ready discard, with what a win on it scores. */
export interface ValueWait {
  kind: Kind;
  /** Copies still unseen from your own view. */
  live: number;
  /** 台 of a win on a discard and of a self-drawn win (every engine item, dealer items included). */
  taiDiscard: number;
  taiSelfDraw: number;
}

export interface ValueOption {
  kind: Kind;
  /** The discard leaves the hand ready (shanten 0), which is the best this hand can do. */
  ready: boolean;
  /** Live winning tiles after this discard (ready discards only). */
  waits?: Kind[];
  /** Unseen copies of those winning tiles, from your own view (ready discards only). */
  acceptance?: number;
  /** Every winning tile with its 台 (ready discards only). */
  winning?: ValueWait[];
  /** Average 台 of a win, over the live copies and the self-draw share (ready discards only). */
  expectedTai?: number;
  /** The biggest single win this discard allows, in 台 (ready discards only; -1 when no winning tile is live). */
  bestTai?: number;
  /**
   * Expected score per draw (ready discards only): the sum over live copies of what a win on that
   * copy is worth, `VALUE_SELF_DRAW_SHARE` of them self-drawn (all three pay) and the rest by
   * discard, at 底 + 台 × 台值 of the default rules. Proportional to the hand's expected winnings.
   */
  expectedScore?: number;
  /** The headline pattern items (flushes, all pongs, value pongs) its best win includes. */
  items?: TaiItem[];
  /** Within `VALUE_TOLERANCE` of the best expected score. */
  accepted?: boolean;
}

export interface ValuePuzzle extends PuzzleExplanation {
  type: 'value';
  seed: string;
  difficulty: PuzzleDifficulty;
  /** Concealed tiles (17 minus three per exposed set), sorted. */
  hand: Kind[];
  melds: PuzzleMeld[];
  dealerSeat: number;
  prevailingWind: number;
  /** Your seat wind (you are seat 0). */
  seatWind: Kind;
  /** 0: every discard counted here leaves the hand ready (聽牌). */
  bestShanten: number;
  options: ValueOption[];
  /** Every accepted discard (within `VALUE_TOLERANCE` of the best expected score). */
  answers: Kind[];
  /** The discard with the highest expected score. */
  answer: Kind;
  /** The tempting alternative: the ready discard outside the accepted set with the most winning tiles. */
  rival: Kind;
  /** The headline 台 item the answer keeps and the rival loses ('' when it loses none: see `valueReason`). */
  patternKey: string;
  patternEn: string;
  patternZh: string;
  patternTai: number;
}

type ValueTheme = 'flush' | 'pongs' | 'honour';
/** [flush share, all-pongs share] of value puzzles per difficulty; the rest are value-honour hands. */
const VALUE_THEME_MIX: Record<PuzzleDifficulty, [number, number]> = { 1: [0.65, 0.15], 2: [0.4, 0.3], 3: [0.15, 0.6] };

/** A complete hand of five sets and a pair, shaped by `theme` (`suit` is the flush suit, else -1). */
function themedHand(rng: Rng, pool: TilePool, theme: ValueTheme, valueHonours: readonly Kind[]): { sets: Kind[][]; pair: Kind; suit: number } | null {
  const sets: Kind[][] = [];
  let pair = -1;
  let suit = -1;
  const takePair = (k: Kind): boolean => {
    if (!pool.take(k, 2)) return false;
    pair = k;
    return true;
  };
  if (theme === 'flush') {
    suit = rng.int(3);
    const mixed = rng.next() < 0.6;
    for (let i = 0; i < 5; i++) {
      const set = mixed && rng.next() < 0.25 ? randomHonourPong(rng, pool) : randomSet(rng, pool, 0.35, [suit], false);
      if (!set) return null;
      sets.push(set);
    }
    if (!takePair(mixed && rng.next() < 0.35 ? KIND_WIND + rng.int(7) : suit * 9 + rng.int(9))) return null;
  } else if (theme === 'pongs') {
    const nPongs = 3 + rng.int(3);
    for (let i = 0; i < 5; i++) {
      const set = randomSet(rng, pool, i < nPongs ? 1 : 0);
      if (!set) return null;
      sets.push(set);
    }
    if (!takePair(rng.next() < 0.3 ? KIND_WIND + rng.int(7) : rng.int(27))) return null;
  } else {
    if (!takePair(valueHonours[rng.int(valueHonours.length)])) return null;
    for (let i = 0; i < 5; i++) {
      const set = randomSet(rng, pool, 0.35, [0, 1, 2], false);
      if (!set) return null;
      sets.push(set);
    }
  }
  shuffle(sets, rng);
  return { sets, pair, suit };
}

/**
 * Score every live winning tile of a ready hand (`concealed` is the 3n+1 hand after the discard)
 * both ways, with every engine item. Returns the waits and the summary numbers of a value option.
 */
export function scoreWaits(
  concealed: Kind[],
  live: readonly { kind: Kind; live: number }[],
  melds: Meld[],
  dealerSeat: number,
  prevailingWind: number,
): Pick<ValueOption, 'winning' | 'expectedTai' | 'bestTai' | 'expectedScore' | 'items'> {
  const rules = DEFAULT_RULES;
  const winning: ValueWait[] = [];
  let tiles = 0;
  let taiSum = 0;
  let score = 0;
  let bestTai = -1;
  let items: TaiItem[] = [];
  for (const w of live) {
    if (w.live <= 0) continue;
    const ctx = { rules, seat: 0, dealerSeat, dealerStreak: 0, prevailingWind, concealed, melds, flowers: [], winningTile: w.kind };
    const byDiscard = scoreWin({ ...ctx, selfDrawn: false, fromSeat: 1 });
    const bySelf = scoreWin({ ...ctx, selfDrawn: true });
    winning.push({ kind: w.kind, live: w.live, taiDiscard: byDiscard.tai, taiSelfDraw: bySelf.tai });
    const mix = (1 - VALUE_SELF_DRAW_SHARE) * byDiscard.tai + VALUE_SELF_DRAW_SHARE * bySelf.tai;
    tiles += w.live;
    taiSum += w.live * mix;
    score +=
      w.live *
      ((1 - VALUE_SELF_DRAW_SHARE) * (rules.basePoints + rules.taiPoints * byDiscard.tai) + VALUE_SELF_DRAW_SHARE * 3 * (rules.basePoints + rules.taiPoints * bySelf.tai));
    const top = Math.max(byDiscard.tai, bySelf.tai);
    if (top > bestTai) {
      bestTai = top;
      items = (bySelf.tai >= byDiscard.tai ? bySelf : byDiscard).items.filter((i) => HEADLINE_KEYS.has(i.key));
    }
  }
  return { winning, expectedTai: tiles > 0 ? taiSum / tiles : 0, bestTai, expectedScore: score, items };
}

const fmt1 = (x: number): string => (Math.round(x * 10) / 10).toString();

/**
 * Why the answer beats the rival, chosen so that the headline is true of the numbers shown:
 *  - keepPattern / tradeSpeed: the answer keeps a headline pattern the rival loses (and gives up
 *    winning tiles for it in the second case);
 *  - speed: the answer has more winning tiles and the rival is the bigger hand (a higher average
 *    or a higher best win);
 *  - both: the answer has more winning tiles and its wins are no smaller on either measure;
 *  - moreTai: the answer has no more winning tiles but more 台 a win, from items outside the
 *    headline patterns (a single wait, 平胡, concealed pongs, a concealed hand).
 * null when none of them is true (no more winning tiles and no more 台 a win on average: the
 * answer leads only through the self-draw weighting, which no short reason explains).
 */
function valueReason(answer: ValueOption, rival: ValueOption, keepsPattern: boolean): string | null {
  if (keepsPattern) return rival.acceptance! > answer.acceptance! ? 'puzzle.value.tradeSpeed' : 'puzzle.value.keepPattern';
  const faster = answer.acceptance! > rival.acceptance!;
  const rivalBigger = rival.expectedTai! > answer.expectedTai! || rival.bestTai! > answer.bestTai!;
  if (faster) return rivalBigger ? 'puzzle.value.speed' : 'puzzle.value.both';
  return answer.expectedTai! > rival.expectedTai! ? 'puzzle.value.moreTai' : null;
}

function valueText(p: Pick<ValuePuzzle, 'answer' | 'answers' | 'rival' | 'options' | 'patternEn' | 'patternZh' | 'patternTai'>, reasonKey: string): PuzzleExplanation {
  const a = p.options.find((o) => o.kind === p.answer)!;
  const r = p.options.find((o) => o.kind === p.rival)!;
  const A = tileEn(p.answer);
  const Az = tileZh(p.answer);
  const R = tileEn(p.rival);
  const Rz = tileZh(p.rival);
  const ratio = Math.round((100 * r.expectedScore!) / a.expectedScore!);
  let en = `Throwing ${A} leaves ${a.acceptance} winning tiles worth ${fmt1(a.expectedTai!)} 台 a win on average (up to ${a.bestTai} 台). Throwing ${R} leaves ${r.acceptance}, worth ${fmt1(r.expectedTai!)} 台 on average (up to ${r.bestTai} 台).`;
  let zh = `打${Az}聽${a.acceptance}張，平均每次胡${fmt1(a.expectedTai!)}台（最多${a.bestTai}台）；打${Rz}聽${r.acceptance}張，平均${fmt1(r.expectedTai!)}台（最多${r.bestTai}台）。`;
  if (reasonKey === 'puzzle.value.speed') {
    en += ` More winning tiles beat the bigger hand here: counting 100 points a win plus 20 a 台, ${R} is worth only ${ratio}% of ${A}.`;
    zh += `這手牌速度比台數重要：以底100、每台20計算，打${Rz}的期望值只有打${Az}的${ratio}%。`;
  } else if (reasonKey === 'puzzle.value.both') {
    en += ` ${A} has more winning tiles and its wins are no smaller, so there is nothing to trade: counting 100 points a win plus 20 a 台, ${R} is worth only ${ratio}% of ${A}.`;
    zh += `打${Az}聽的張數比較多，胡的台數也不比較少，沒有什麼要取捨的：以底100、每台20計算，打${Rz}的期望值只有打${Az}的${ratio}%。`;
  } else if (reasonKey === 'puzzle.value.moreTai') {
    const tiles = a.acceptance! < r.acceptance! ? 'fewer winning tiles' : 'the same number of winning tiles';
    const tilesZh = a.acceptance! < r.acceptance! ? '聽的張數比較少' : '聽的張數一樣';
    en += ` ${A} has ${tiles}, but each win is worth more 台: counting 100 points a win plus 20 a 台, ${R} is worth only ${ratio}% of ${A}.`;
    zh += `打${Az}${tilesZh}，但是每次胡的台數比較多：以底100、每台20計算，打${Rz}的期望值只有打${Az}的${ratio}%。`;
  } else {
    const keep = p.patternEn ? ` keeps ${p.patternEn} (${p.patternZh}, ${p.patternTai} 台), and` : '';
    const keepZh = p.patternZh ? `保住${p.patternZh}（${p.patternTai}台），` : '';
    en += ` ${A}${keep} counting 100 points a win plus 20 a 台, ${R} is worth only ${ratio}% of it.`;
    zh += `打${Az}${keepZh}以底100、每台20計算，打${Rz}的期望值只有它的${ratio}%。`;
    if (reasonKey === 'puzzle.value.tradeSpeed') {
      en += ` That is a trade of speed for value worth making.`;
      zh += `這是值得的以速度換台數。`;
    }
  }
  const others = p.answers.filter((k) => k !== p.answer);
  if (others.length > 0) {
    en += ` ${others.map(tileEn).join(' and ')} ${others.length > 1 ? 'are' : 'is'} within 10% of the best, so ${others.length > 1 ? 'they count' : 'it counts'} too.`;
    zh += `${others.map(tileZh).join('、')}和最好的差不到一成，也算對。`;
  }
  en += ' A quarter of wins are counted as self-drawn, which all three players pay.';
  zh += '計算時假設四分之一是自摸（三家都要付）。';
  return { reasonKey, explanation: en, explanationZh: zh };
}

/**
 * A 17-tile hand (with up to two exposed sets above difficulty 1) where at least two discards
 * keep it ready but differ in value. Each ready discard is judged by its expected score: for every
 * live winning tile (unseen copies from your view), the engine's 台 for a win on a discard and a
 * self-drawn win, mixed `VALUE_SELF_DRAW_SHARE`, at 底 + 台 × 台值. Every discard within
 * `VALUE_TOLERANCE` of the best is accepted, and at least one ready discard is clearly worse.
 * Difficulty 1: the best discard is also at least as fast as the rival; 3: the rival leaves
 * strictly more winning tiles, or the best discard wins on speed against a bigger hand.
 */
export function valuePuzzle(seed: string, difficulty: PuzzleDifficulty = 2): ValuePuzzle {
  const rng = createRng(`value:${seed}:${difficulty}`);
  let fallback: ValuePuzzle | null = null;
  for (let attempt = 0; attempt < 600; attempt++) {
    const p = valueAttempt(seed, difficulty, rng);
    if (!p) continue;
    const a = p.options.find((o) => o.kind === p.answer)!;
    const r = p.options.find((o) => o.kind === p.rival)!;
    const trade = r.acceptance! > a.acceptance! || r.bestTai! > a.bestTai!;
    if (difficulty === 1 ? a.acceptance! >= r.acceptance! && p.patternKey !== '' : difficulty === 3 ? trade : true) return p;
    fallback = fallback ?? p;
    if (attempt >= 300) return fallback;
  }
  if (fallback) return fallback;
  throw new Error(`valuePuzzle: no puzzle for seed ${seed}`);
}

function valueAttempt(seed: string, difficulty: PuzzleDifficulty, rng: Rng): ValuePuzzle | null {
  const pool = new TilePool();
  const dealerSeat = rng.int(4);
  const prevailingWind = rng.int(2);
  const seatWind = seatWindKind(0, dealerSeat);
  const valueHonours = [...new Set([seatWind, prevailingWindKind(prevailingWind), KIND_DRAGON, KIND_DRAGON + 1, KIND_DRAGON + 2])];
  // Theme mix by difficulty: flushes usually keep the faster wait too, pongs usually trade speed.
  const roll = rng.next();
  const [flushShare, pongShare] = VALUE_THEME_MIX[difficulty];
  const theme: ValueTheme = roll < flushShare ? 'flush' : roll < flushShare + pongShare ? 'pongs' : 'honour';
  const nExposed = difficulty === 1 ? 0 : rng.int(3);
  const built = themedHand(rng, pool, theme, valueHonours);
  if (!built) return null;
  const melds: PuzzleMeld[] = built.sets.slice(0, nExposed).map((kinds) => {
    const pong = kinds[0] === kinds[1];
    return { type: pong ? 'pong' : 'chow', kinds, concealed: false, from: pong ? 1 + rng.int(3) : 3 };
  });
  const concealed: Kind[] = [...built.sets.slice(nExposed).flat(), built.pair, built.pair];
  // Perturb the complete hand: one tile out, one tempting tile in. A flush hand gets a tile that
  // breaks the flush; an all-pongs hand gets a tile next to one of its pongs, offering a chow.
  // An all-pongs hand usually loses a tile from a pong, which leaves a pair-and-pair (對碰) wait.
  // At difficulty 3 it is always a suited pong and the new tile sits right next to it (a two-sided shape).
  const pongKinds = theme === 'pongs' ? [...new Set(concealed.filter((k) => concealed.filter((x) => x === k).length >= 3 && (difficulty < 3 || k < KIND_WIND)))] : [];
  const pairPick = theme === 'flush' && rng.next() < 0.4;
  const outKind = pongKinds.length > 0 && (difficulty === 3 || rng.next() < 0.7) ? pongKinds[rng.int(pongKinds.length)] : pairPick ? built.pair : concealed[rng.int(concealed.length)];
  const out = concealed.splice(concealed.indexOf(outKind), 1)[0];
  const hasHonour = [...concealed, ...melds.flatMap((m) => m.kinds)].some(isHonorKind);
  const sameSuitNear = (k: Kind) => concealed.some((c) => c < KIND_WIND && Math.floor(c / 9) === Math.floor(k / 9) && Math.abs(c - k) <= 2 && c !== k);
  const tempting = (k: Kind): boolean => {
    if (k === out) return false;
    if (theme === 'flush') return k < KIND_WIND ? Math.floor(k / 9) !== built.suit : !hasHonour;
    // Next to the broken pong, so throwing from it leaves a chow-shaped wait that kills 碰碰胡.
    if (theme === 'pongs') return outKind < KIND_WIND ? k < KIND_WIND && Math.floor(k / 9) === Math.floor(outKind / 9) && Math.abs(k - outKind) <= (difficulty === 3 ? 1 : 2) : k < KIND_WIND && sameSuitNear(k);
    return true;
  };
  const add = pool.sample(rng, 1, tempting);
  if (!add) return null;
  pool.take(add[0]);
  concealed.push(add[0]);
  concealed.sort((a, b) => a - b);

  const setsNeeded = TOTAL_SETS - melds.length;
  const counts = countsFromKinds(concealed);
  // Readiness by wait search rather than shanten: whole-suit hands make shanten's search slow,
  // and a 3n+1 hand is ready exactly when some tile completes it.
  if (isComplete(counts, setsNeeded)) return null;
  const ownMeldCounts = countsFromKinds(melds.flatMap((m) => m.kinds));
  const meldObjs: Meld[] = melds.map((m) => ({ type: m.type, tiles: m.kinds.map((k, i) => k * 4 + i), concealed: false, from: m.from }));
  const options: ValueOption[] = [];
  const c = counts.slice();
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (counts[k] === 0) continue;
    c[k]--;
    const shape = shapeWaits(c, setsNeeded);
    c[k]++;
    if (shape.length === 0) {
      options.push({ kind: k, ready: false });
      continue;
    }
    // Live from your own view: the discarded copy is gone too, so count the hand before the discard.
    const live = shape.map((w) => ({ kind: w, live: 4 - counts[w] - ownMeldCounts[w] })).filter((w) => w.live > 0);
    const rest = concealed.slice();
    rest.splice(rest.indexOf(k), 1);
    const v = scoreWaits(rest, live, meldObjs, dealerSeat, prevailingWind);
    const acceptance = live.reduce((n, w) => n + w.live, 0);
    options.push({ kind: k, ready: true, waits: live.map((w) => w.kind), acceptance, ...v });
  }
  // A ready shape whose every winning tile is in your own hand or sets cannot win.
  const live = options.filter((o) => o.ready && o.acceptance! > 0);
  if (live.length < 2) return null;
  const top = Math.max(...live.map((o) => o.expectedScore!));
  for (const o of live) o.accepted = o.expectedScore! >= VALUE_TOLERANCE * top;
  const accepted = live.filter((o) => o.accepted);
  const rejected = live.filter((o) => !o.accepted);
  // A real decision: some ready discard is clearly worse, and not everything else is right.
  if (rejected.length === 0 || accepted.length > 2) return null;
  const answer = accepted.slice().sort((x, y) => y.expectedScore! - x.expectedScore! || x.kind - y.kind)[0];
  const rival = rejected.slice().sort((x, y) => y.acceptance! - x.acceptance! || y.expectedScore! - x.expectedScore! || x.kind - y.kind)[0];
  const rivalKeys = new Set(rival.items!.map((i) => i.key));
  const lost = answer.items!.filter((i) => !rivalKeys.has(i.key)).sort((x, y) => y.tai - x.tai);
  const pattern = lost[0];
  // A value-honour item is a pong (中 → 中的刻子); flushes and 碰碰胡 read as they are.
  const patternZh = !pattern ? '' : pattern.key.startsWith('dragon_') || pattern.key === 'seat_wind' || pattern.key === 'round_wind' ? `${pattern.nameZh}的刻子` : pattern.nameZh;
  const reasonKey = valueReason(answer, rival, !!pattern);
  if (!reasonKey) return null;
  const base = {
    answer: answer.kind,
    answers: accepted.map((o) => o.kind),
    rival: rival.kind,
    options,
    patternEn: pattern?.nameEn ?? '',
    patternZh,
    patternTai: pattern?.tai ?? 0,
  };
  return {
    type: 'value',
    seed,
    difficulty,
    hand: concealed,
    melds,
    dealerSeat,
    prevailingWind,
    seatWind,
    bestShanten: 0,
    patternKey: pattern?.key ?? '',
    ...base,
    ...valueText(base, reasonKey),
  };
}

export function checkValueAnswer(p: ValuePuzzle, kind: Kind): boolean {
  return p.answers.includes(kind);
}

/** Every puzzle theme. `Puzzle` is the two classic themes (discard and waits), the two-argument `rushPuzzle` rotation. */
export type AnyPuzzle = Puzzle | DefencePuzzle | ClaimPuzzle | ValuePuzzle;
export type PuzzleType = AnyPuzzle['type'];
