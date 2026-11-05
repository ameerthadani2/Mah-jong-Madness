/**
 * Puzzle generators for single-player training (daily puzzle, puzzle rush,
 * drills). Everything is seeded so a "daily" puzzle is identical for every
 * player and a rush run can be replayed.
 *
 * Five themes: discard (tile efficiency), waits (name every winning tile),
 * defence (the safest tile against a visibly close opponent), claim (what the
 * coach does in a claim window) and value (keep the 台 pattern). Each has a
 * seeded generator, a solver-checked answer and a checker.
 *
 * Chinese: first pass, needs native review.
 */
import { coachAction, dealInDanger, shantenAfterClaim, threats, unseenCounts } from './bot';
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
 * arguments it keeps the classic discard/waits rotation (what the app renders
 * today); pass `PUZZLE_TYPES` to rotate all five themes.
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
// Defence: the safest tile against one visibly close opponent
// ===========================================================================

/** Why the answer is the safest tile, from strongest to weakest kind of safety. */
export type DefenceReason = 'theirDiscard' | 'deadHonour' | 'lastHonour' | 'honour' | 'terminal';

export interface DefenceOption {
  kind: Kind;
  shanten: number;
  /** The engine's deal-in estimate (`dealInDanger`) against the table as shown. */
  danger: number;
}

export interface DefencePuzzle extends PuzzleExplanation {
  type: 'defence';
  seed: string;
  difficulty: PuzzleDifficulty;
  /** Your 17 concealed tiles (seat 0, no exposed sets), sorted. */
  hand: Kind[];
  /** Your own discards, oldest first. */
  ownDiscards: Kind[];
  /** Seats 1–3 as the table shows them. */
  opponents: PuzzleSeatView[];
  /** The opponent who looks close to winning (four exposed sets, or three and a long discard row). */
  threatSeat: number;
  /** `threats()` level of the threatening seat: 1 for four exposed sets, 0.6 for three. */
  threatLevel: number;
  /** Shanten of the hand: the discards that keep it are the candidates. */
  bestShanten: number;
  /** Every discard with its shanten and danger. */
  options: DefenceOption[];
  /** The one safest discard among those that keep `bestShanten`. */
  answer: Kind;
  /** The most efficient of those discards (highest acceptance), for the explanation. */
  efficient: Kind;
  reason: DefenceReason;
}

const DEFENCE_TARGET: Record<PuzzleDifficulty, readonly DefenceReason[]> = {
  1: ['theirDiscard'],
  2: ['honour', 'terminal'],
  3: ['deadHonour', 'lastHonour'],
};

function defenceReason(s: GameState, threatSeat: number, kind: Kind, unseen: Counts): DefenceReason {
  if (s.players[threatSeat].discards.some((t) => kindOf(t) === kind)) return 'theirDiscard';
  if (isHonorKind(kind)) return unseen[kind] === 0 ? 'deadHonour' : unseen[kind] === 1 ? 'lastHonour' : 'honour';
  return 'terminal';
}

function defenceText(p: Pick<DefencePuzzle, 'answer' | 'threatSeat' | 'threatLevel' | 'reason' | 'efficient'>): PuzzleExplanation {
  const t = tileEn(p.answer);
  const tz = tileZh(p.answer);
  const who = SEAT_EN[p.threatSeat];
  const whoZh = SEAT_ZH[p.threatSeat];
  const threatEn =
    p.threatLevel >= 1
      ? `${capitalise(who)} has four exposed sets and needs only one more set or the pair.`
      : `${capitalise(who)} has three exposed sets and a long row of discards: that hand is well on its way.`;
  const threatZh = p.threatLevel >= 1 ? `${whoZh}已經亮了四組面子，只差一組面子或一對眼。` : `${whoZh}亮了三組面子，又打了很多張，牌已經做得差不多了。`;
  let en: string;
  let zh: string;
  switch (p.reason) {
    case 'theirDiscard':
      en = `${t} is a tile ${who} has thrown. Taiwanese rules have no furiten, so it is not a guarantee, but players rarely wait on a tile they have discarded.`;
      zh = `${tz}是${whoZh}自己打過的熟張。台灣麻將沒有振聽，不是百分之百安全，但很少有人聽自己打掉的牌。`;
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
      en = `${t} is an honour: it can complete a pair or a pong but never a chow, so it is safer than any suited tile you could throw here.`;
      zh = `${tz}是字牌，只能湊對或碰，不能吃，比你手上可以打的數字牌安全。`;
      break;
    case 'terminal':
      en = `${t} is a terminal: it fits fewer chows than a middle tile, and none of the discards that keep your shape is an honour or a tile ${who} has thrown.`;
      zh = `${tz}是么九牌，能組成的順子比中張少，比較安全；能保持牌型的牌裡也沒有對方打過的熟張或字牌。`;
      break;
  }
  const keepEn = ' Throwing it also keeps your hand as close to ready as any other discard.';
  const keepZh = '打這張也不會讓你的向聽數退步。';
  const tradeEn = p.efficient !== p.answer ? ` ${tileEn(p.efficient)} would leave more useful tiles, but not while someone looks ready.` : '';
  const tradeZh = p.efficient !== p.answer ? `打${tileZh(p.efficient)}進張比較多，但對方看起來快聽牌了，先求安全。` : '';
  return { reasonKey: `puzzle.defence.${p.reason}`, explanation: `${threatEn} ${en}${keepEn}${tradeEn}`, explanationZh: `${threatZh}${zh}${keepZh}${tradeZh}` };
}

/**
 * A 17-tile hand (seat 0) facing one opponent whose exposed sets and discards are shown.
 * The answer is the safest discard by the engine's danger model (`threats` / `dealInDanger`)
 * among the discards that keep the hand's shanten, and it is the unique minimum. Difficulty
 * picks the reason: 1 a tile the opponent threw (熟張), 2 an honour or terminal when none of
 * the candidates is one they threw, 3 an honour made safe by counting visible copies.
 */
export function defencePuzzle(seed: string, difficulty: PuzzleDifficulty = 2): DefencePuzzle {
  const rng = createRng(`defence:${seed}:${difficulty}`);
  let fallback: DefencePuzzle | null = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const p = defenceAttempt(seed, difficulty, rng);
    if (!p) continue;
    if (DEFENCE_TARGET[difficulty].includes(p.reason)) return p;
    fallback = fallback ?? p;
    if (attempt >= 200) return fallback;
  }
  if (fallback) return fallback;
  throw new Error(`defencePuzzle: no puzzle for seed ${seed}`);
}

function defenceAttempt(seed: string, difficulty: PuzzleDifficulty, rng: Rng): DefencePuzzle | null {
  const pool = new TilePool();
  const threatSeat = 1 + rng.int(3);
  const nMelds = difficulty === 1 || rng.next() < 0.5 ? 4 : 3;
  const melds: PuzzleMeld[] = [];
  for (let i = 0; i < nMelds; i++) {
    const set = randomSet(rng, pool, 0.45);
    if (!set) return null;
    const pong = set[0] === set[1];
    const from = pong ? (threatSeat + 1 + rng.int(3)) % 4 : (threatSeat + 3) % 4;
    melds.push({ type: pong ? 'pong' : 'chow', kinds: set, concealed: false, from });
  }
  const threatHand = pool.draw(rng, 16 - 3 * nMelds);
  if (!threatHand) return null;

  // Your hand: a few draws until one is in the shanten band.
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
  const keep = new Set<Kind>();
  for (let k = 0; k < NUM_PLAY_KINDS; k++) if (byDiscard[k] === bestShanten) keep.add(k);

  // Discards. The threat never throws a kind you could keep-discard, except the one planted at difficulty 1.
  const threatDiscards: Kind[] = [];
  if (difficulty === 1) {
    const keepList = [...keep];
    const g = keepList[rng.int(keepList.length)];
    if (!pool.take(g)) return null;
    threatDiscards.push(g);
  }
  const nThreat = nMelds === 3 ? 8 + rng.int(5) : 5 + rng.int(6);
  const rest = pool.draw(rng, nThreat - threatDiscards.length, (k) => !keep.has(k));
  if (!rest) return null;
  threatDiscards.push(...rest);
  shuffle(threatDiscards, rng);

  const otherSeats = [1, 2, 3].filter((x) => x !== threatSeat);
  const otherDiscards: Kind[][] = [[], []];
  if (difficulty === 3) {
    // Plant visible copies of one kept honour in the other seats' discards.
    const honours = [...keep].filter(isHonorKind);
    if (honours.length < 2) return null;
    const h = honours[rng.int(honours.length)];
    const want = Math.max(0, 4 - counts[h] - (rng.next() < 0.5 ? 0 : 1));
    for (let i = 0; i < want; i++) {
      if (!pool.take(h)) return null;
      otherDiscards[rng.int(2)].push(h);
    }
  }
  for (let i = 0; i < 2; i++) {
    const d = pool.draw(rng, Math.max(1, 5 + rng.int(6) - otherDiscards[i].length));
    if (!d) return null;
    otherDiscards[i].push(...d);
    shuffle(otherDiscards[i], rng);
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
  const levels = threats(s, 0);
  if (levels[threatSeat] === 0 || levels.some((l, i) => i !== threatSeat && l > 0)) return null;
  const unseen = unseenCounts(s, 0);
  const options: DefenceOption[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (counts[k] === 0) continue;
    options.push({ kind: k, shanten: byDiscard[k], danger: dealInDanger(s, 0, k, levels, unseen) });
  }
  const kept = options.filter((o) => o.shanten === bestShanten);
  // A real choice: at least two discards keep the shape.
  if (kept.length < 2) return null;
  const minDanger = Math.min(...kept.map((o) => o.danger));
  const safest = kept.filter((o) => o.danger === minDanger);
  if (safest.length !== 1) return null;
  const answer = safest[0].kind;
  let efficient = answer;
  let bestAcc = -1;
  for (const o of kept) {
    const acc = acceptanceAfter(counts, TOTAL_SETS, o.kind, unseen);
    if (acc > bestAcc) {
      bestAcc = acc;
      efficient = o.kind;
    }
  }
  const reason = defenceReason(s, threatSeat, answer, unseen);
  if (reason === 'terminal' && rankOfKind(answer) !== 1 && rankOfKind(answer) !== 9) return null;
  const base = { answer, threatSeat, threatLevel: levels[threatSeat], reason, efficient };
  return {
    type: 'defence',
    seed,
    difficulty,
    hand: hand.slice().sort((a, b) => a - b),
    ownDiscards,
    opponents: seatViews(s),
    bestShanten,
    options,
    ...base,
    ...defenceText(base),
  };
}

export function checkDefenceAnswer(p: DefencePuzzle, kind: Kind): boolean {
  return kind === p.answer;
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
}

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
  shantenBefore: number;
  /** Legal responses: pass, 胡, 碰, 槓 and each 吃 shape. */
  options: ClaimOption[];
  /** The coach's action (`coachAction`), unique under its own evaluation. */
  answer: ClaimOption;
}

function claimOptionOf(a: Action): Omit<ClaimOption, 'shantenAfter'> {
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

/** The coach's claim evaluation (mirrors `chooseAction` for the coach): shanten gained, plus half a step for a kong. */
function claimGain(o: ClaimOption, before: number, stayConcealed: boolean): number {
  if (o.type === 'pass' || o.type === 'hu') return 0;
  return before - o.shantenAfter + (o.type === 'kong' ? 0.5 : 0) - (stayConcealed ? 1 : 0);
}

function claimText(p: Pick<ClaimPuzzle, 'answer' | 'discard' | 'shantenBefore' | 'options' | 'melds'>): PuzzleExplanation {
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
    if (p.shantenBefore === 0 && concealed) {
      return {
        reasonKey: 'puzzle.claim.passReady',
        explanation: 'You are already ready (聽牌) with a concealed hand. No claim gets you closer, and calling would cost you 門清, so pass.',
        explanationZh: '你已經聽牌，而且是門清。吃碰不會讓你更接近胡牌，還會失去門清，所以不要。',
      };
    }
    return {
      reasonKey: 'puzzle.claim.passNoGain',
      explanation: 'None of these claims brings your hand closer to ready: the shanten (向聽) stays the same or gets worse. Exposing a set for nothing gives away information and flexibility, so pass.',
      explanationZh: '這些吃碰都不能降低向聽數。白白亮出一組面子只會洩露牌型、少了變化，所以不要。',
    };
  }
  const after = a.shantenAfter;
  const stepsEn = after === 0 ? 'makes you ready (聽牌)' : `takes you from ${p.shantenBefore} to ${after} away from ready (向聽)`;
  const stepsZh = after === 0 ? '吃碰後就聽牌' : `向聽數從${p.shantenBefore}降到${after}`;
  const others = p.options.filter((o) => o.id !== a.id && o.type !== 'pass' && o.type !== 'hu');
  const otherEn = others.length > 0 ? ' The other claims do less for the hand.' : '';
  const otherZh = others.length > 0 ? '其他吃碰的效果都比較差。' : '';
  const kongEn = a.type === 'kong' ? ' A kong also brings a replacement tile from the back of the wall.' : '';
  const kongZh = a.type === 'kong' ? '槓還可以從牌尾補一張。' : '';
  return {
    reasonKey: a.type === 'kong' ? 'puzzle.claim.kong' : after === 0 ? 'puzzle.claim.ready' : 'puzzle.claim.closer',
    explanation: `${label.en} ${stepsEn}.${kongEn}${otherEn}`,
    explanationZh: `${label.zh}，${stepsZh}。${kongZh}${otherZh}`,
  };
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
  const coach = coachAction(s, 0);
  if (!coach) return null;
  const before = shanten(counts, setsNeeded);
  const options: ClaimOption[] = actions.map((a) => ({
    ...claimOptionOf(a),
    shantenAfter: a.type === 'hu' ? -1 : a.type === 'pass' ? before : shantenAfterClaim(s, 0, a),
  }));
  const answer = options.find((o) => o.id === claimOptionOf(coach).id);
  if (!answer) return null;
  // Uniqueness under the coach's evaluation: a claim answer must beat every other claim outright.
  if (answer.type !== 'hu') {
    const stay = melds.length === 0 && before <= 0;
    const gains = options.filter((o) => o.type !== 'pass' && o.type !== 'hu').map((o) => ({ id: o.id, g: claimGain(o, before, stay) }));
    if (answer.type === 'pass') {
      if (gains.some((x) => x.g > 0)) return null;
    } else {
      const mine = gains.find((x) => x.id === answer.id)!.g;
      if (mine <= 0 || gains.some((x) => x.id !== answer.id && x.g >= mine)) return null;
    }
  }
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
    ...base,
    ...claimText(base),
  };
}

/** Accepts an option, its id, or the engine action the player chose. */
export function checkClaimAnswer(p: ClaimPuzzle, choice: ClaimOption | string | Action): boolean {
  const id = typeof choice === 'string' ? choice : 'id' in choice ? choice.id : claimOptionOf(choice).id;
  return id === p.answer.id;
}

// ===========================================================================
// Value: two discards keep the same shanten; one keeps a 台 pattern
// ===========================================================================

/**
 * Items that describe how or when a hand is won rather than what it is made of. The
 * projected 台 leaves them out, so the comparison is about the pattern each discard keeps.
 */
const NON_PATTERN_KEYS: ReadonlySet<string> = new Set([
  'single_wait',
  'all_chows',
  'concealed',
  'concealed_self_draw',
  'self_draw',
  'full_begging',
  'half_begging',
  'dealer',
  'dealer_streak',
  'last_tile_draw',
  'last_tile_discard',
  'rob_kong',
  'after_kong',
  'after_flower',
  'no_flowers',
  'four_flowers',
  'four_seasons',
  'seat_flower',
  'seat_season',
]);

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

export interface ValueOption {
  kind: Kind;
  /** The discard leaves the hand ready (shanten 0), which is the best this hand can do. */
  ready: boolean;
  /** Live winning tiles after this discard (ready discards only). */
  waits?: Kind[];
  /** Unseen copies of those winning tiles, from your own view (ready discards only). */
  acceptance?: number;
  /** Projected pattern 台 of the best completion; -1 when no winning tile is live (ready discards only). */
  projectedTai?: number;
  /** The pattern items of that best completion. */
  items?: TaiItem[];
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
  /** The discard that keeps the higher projected 台 (unique). */
  answer: Kind;
  /** The tempting alternative: the other ready-keeping discard with the most acceptance. */
  rival: Kind;
  /** The headline 台 item the answer keeps and the rival loses. */
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

/** Pattern 台 of the best discard win for a ready hand: the highest over its live waits (-1 when none is live). */
function projectValue(concealed: Kind[], liveWaits: readonly Kind[], melds: Meld[], dealerSeat: number, prevailingWind: number): { tai: number; items: TaiItem[] } {
  let best: { tai: number; items: TaiItem[] } = { tai: -1, items: [] };
  for (const w of liveWaits) {
    const r = scoreWin({ rules: DEFAULT_RULES, seat: 0, dealerSeat, dealerStreak: 0, prevailingWind, concealed, melds, flowers: [], winningTile: w, selfDrawn: false, fromSeat: 1 });
    const items = r.items.filter((i) => !NON_PATTERN_KEYS.has(i.key));
    const tai = items.reduce((n, i) => n + i.tai, 0);
    if (tai > best.tai) best = { tai, items };
  }
  return best;
}

function valueText(p: Pick<ValuePuzzle, 'answer' | 'rival' | 'options' | 'patternEn' | 'patternZh' | 'patternTai'>, itemZh: string): PuzzleExplanation {
  const a = p.options.find((o) => o.kind === p.answer)!;
  const r = p.options.find((o) => o.kind === p.rival)!;
  let en = `Throwing ${tileEn(p.answer)} or ${tileEn(p.rival)} leaves you ready (聽牌) either way, but only throwing ${tileEn(p.answer)} keeps ${p.patternEn} (${itemZh}, ${p.patternTai} 台). Your best win would be worth ${a.projectedTai} 台 from the hand's patterns, against ${r.projectedTai} 台 after throwing ${tileEn(p.rival)}.`;
  let zh = `打${tileZh(p.answer)}或${tileZh(p.rival)}都能聽牌，但只有打${tileZh(p.answer)}才能保住${p.patternZh}（${p.patternTai}台）。牌型台數最多可以胡到${a.projectedTai}台，打${tileZh(p.rival)}只有${r.projectedTai}台。`;
  const trade = r.acceptance! > a.acceptance!;
  if (trade) {
    en += ` ${tileEn(p.rival)} would leave more winning tiles (${r.acceptance} against ${a.acceptance}): this is a trade of speed for value.`;
    zh += `打${tileZh(p.rival)}能胡的牌比較多（${r.acceptance}張對${a.acceptance}張），這是用速度換台數。`;
  }
  return { reasonKey: trade ? 'puzzle.value.tradeSpeed' : 'puzzle.value.keepPattern', explanation: en, explanationZh: zh };
}

/**
 * A 17-tile hand (with up to two exposed sets above difficulty 1) where at least two discards
 * keep it ready but differ in 台. Projected 台 (a documented heuristic): for each discard that
 * keeps the best shanten, score every live winning tile with `scoreWin` as a win by discard and
 * take the best, counting only pattern items (flushes, all pongs, value-honour pongs, concealed
 * pongs) and leaving out wait and win-method items (獨聽, 平胡, 門清, 自摸), dealer items and
 * flowers. The answer is the unique highest, and the rival loses a headline pattern. Difficulty 1:
 * the answer is also at least as fast; 3: the rival leaves strictly more winning tiles.
 */
export function valuePuzzle(seed: string, difficulty: PuzzleDifficulty = 2): ValuePuzzle {
  const rng = createRng(`value:${seed}:${difficulty}`);
  let fallback: ValuePuzzle | null = null;
  for (let attempt = 0; attempt < 600; attempt++) {
    const p = valueAttempt(seed, difficulty, rng);
    if (!p) continue;
    const a = p.options.find((o) => o.kind === p.answer)!.acceptance!;
    const r = p.options.find((o) => o.kind === p.rival)!.acceptance!;
    if (difficulty === 1 ? a >= r : difficulty === 3 ? r > a : true) return p;
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
    const live = shape.filter((w) => counts[w] + ownMeldCounts[w] < 4);
    const rest = concealed.slice();
    rest.splice(rest.indexOf(k), 1);
    const v = projectValue(rest, live, meldObjs, dealerSeat, prevailingWind);
    const acceptance = live.reduce((n, w) => n + 4 - counts[w] - ownMeldCounts[w], 0);
    options.push({ kind: k, ready: true, waits: live, acceptance, projectedTai: v.tai, items: v.items });
  }
  // A ready shape whose every winning tile is in your own hand or sets cannot win: it scores -1.
  const live = options.filter((o) => o.ready && o.projectedTai! >= 0);
  if (live.length < 2) return null;
  const top = Math.max(...live.map((o) => o.projectedTai!));
  const winners = live.filter((o) => o.projectedTai === top);
  if (winners.length !== 1) return null;
  const answer = winners[0];
  const rival = live.filter((o) => o !== answer).sort((x, y) => y.acceptance! - x.acceptance! || y.projectedTai! - x.projectedTai! || x.kind - y.kind)[0];
  const rivalKeys = new Set(rival.items!.map((i) => i.key));
  const lost = answer.items!.filter((i) => HEADLINE_KEYS.has(i.key) && !rivalKeys.has(i.key)).sort((x, y) => y.tai - x.tai);
  if (lost.length === 0) return null;
  const pattern = lost[0];
  // A value-honour item is a pong (中 → 中的刻子); flushes and 碰碰胡 read as they are.
  const patternZh = pattern.key.startsWith('dragon_') || pattern.key === 'seat_wind' || pattern.key === 'round_wind' ? `${pattern.nameZh}的刻子` : pattern.nameZh;
  const base = { answer: answer.kind, rival: rival.kind, options, patternEn: pattern.nameEn, patternZh, patternTai: pattern.tai };
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
    patternKey: pattern.key,
    ...base,
    ...valueText(base, pattern.nameZh),
  };
}

export function checkValueAnswer(p: ValuePuzzle, kind: Kind): boolean {
  return kind === p.answer;
}

/** Every puzzle theme. `Puzzle` stays the two classic themes the app renders today. */
export type AnyPuzzle = Puzzle | DefencePuzzle | ClaimPuzzle | ValuePuzzle;
export type PuzzleType = AnyPuzzle['type'];
