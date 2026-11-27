/**
 * Value puzzles (from puzzles.ts): several discards keep the hand ready; which one is worth the most? Every live
 * winning tile of each ready discard is scored (`scoreWaits`), and the answer is the discard with the highest expected
 * score.
 */
import { countsFromKinds, isComplete, TOTAL_SETS } from './hand';
import type { Meld } from './meld';
import { createRng, shuffle, type Rng } from './rng';
import { DEFAULT_RULES } from './rules';
import { prevailingWindKind, scoreWin, seatWindKind, type TaiItem } from './scoring';
import { isHonorKind, KIND_DRAGON, KIND_WIND, NUM_PLAY_KINDS, type Kind } from './tiles';
import { TilePool, randomSet, randomHonourPong, shapeWaits, tileEn, tileZh, type PuzzleDifficulty, type PuzzleMeld, type PuzzleExplanation } from './puzzletable';

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

/** Hard puzzles also name the concealed-pong patterns, which a hand of pongs can be worth keeping for. */
const HARD_HEADLINE_KEYS: ReadonlySet<string> = new Set([...HEADLINE_KEYS, 'three_concealed', 'four_concealed', 'five_concealed']);

/**
 * Share of wins that are self-drawn when judging a wait: measured at 24% on Club-bot tables
 * (`npm run sim`), rounded to a quarter. A self-drawn win is paid by all three other seats.
 */
export const VALUE_SELF_DRAW_SHARE = 0.25;
/** Discards whose expected score is at least this share of the best one's all count as right. */
export const VALUE_TOLERANCE = 0.9;
/** Share of hard value puzzles where the bigger hand wins, so keeping the most winning tiles is wrong. */
export const VALUE_HARD_SIZE_SHARE = 0.5;
/**
 * The share of the most winning tiles that the one discard holding a pattern of 4 台 or more keeps in a hard
 * value puzzle, as [kept, most] (or the same fraction of other counts), drawn per seed and the same whichever
 * hand wins. From 17 November 2026 most speed wins were against a pattern keeping exactly half the tiles, and
 * the bigger hands won keeping more, so "chase a pattern of 4 台 if it keeps more than half the most winning
 * tiles, else keep the most" was right on 94 to 98% of hard value puzzles. With the share the same on both
 * sides, the threshold says nothing: what decides is how big the pattern is against the faster hand.
 */
export const VALUE_HARD_SHARES: readonly (readonly [number, number])[] = [
  [4, 7],
  [2, 3],
];
/** Hands tried for a hard value puzzle before settling for one with the right winner and another share. */
const VALUE_HARD_ATTEMPTS = 1500;
/**
 * How each hard target is built, by share (as in VALUE_HARD_SHARES) and winner, one chosen per hand: the theme,
 * and whether the hand is built for size (a pure flush with a narrow wait, five pongs) or against it. These are
 * the ones that give the target most often (measured on seed prefix `u21tune-v`), with pongs among the bigger
 * hands at 2 of 3 so that they do not all win with a flush.
 */
const VALUE_HARD_BUILDS: readonly { pattern: readonly [ValueTheme, boolean][]; speed: readonly [ValueTheme, boolean][] }[] = [
  {
    pattern: [['pongs', true]],
    speed: [
      ['honours', false],
      ['pongs', false],
    ],
  },
  {
    pattern: [
      ['flush', true],
      ['flush', true],
      ['pongs', true],
    ],
    speed: [['flush', true]],
  },
];

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

type ValueTheme = 'flush' | 'pongs' | 'honour' | 'honours';
/** [flush share, all-pongs share] of value puzzles per difficulty; the rest are value-honour hands. */
const VALUE_THEME_MIX: Record<PuzzleDifficulty, [number, number]> = { 1: [0.65, 0.15], 2: [0.4, 0.3], 3: [0.15, 0.6] };

/** A complete hand of five sets and a pair, shaped by `theme` (`suit` is the flush suit, else -1). */
function themedHand(rng: Rng, pool: TilePool, theme: ValueTheme, valueHonours: readonly Kind[], sizeBias = false): { sets: Kind[][]; pair: Kind; suit: number } | null {
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
    const mixed = rng.next() < 0.6 && !sizeBias;
    for (let i = 0; i < 5; i++) {
      const set = mixed && rng.next() < 0.25 ? randomHonourPong(rng, pool) : randomSet(rng, pool, 0.35, [suit], false);
      if (!set) return null;
      sets.push(set);
    }
    if (!takePair(mixed && rng.next() < 0.35 ? KIND_WIND + rng.int(7) : suit * 9 + rng.int(9))) return null;
  } else if (theme === 'pongs') {
    const nPongs = sizeBias ? 5 : 3 + rng.int(3);
    for (let i = 0; i < 5; i++) {
      const set = randomSet(rng, pool, i < nPongs ? 1 : 0);
      if (!set) return null;
      sets.push(set);
    }
    if (!takePair(rng.next() < 0.3 ? KIND_WIND + rng.int(7) : rng.int(27))) return null;
  } else if (theme === 'honours') {
    // Two dragon pongs and the third dragon as the pair (小三元), or three wind pongs and the
    // fourth wind as the pair (小四喜); the rest any sets, pongs more often than not.
    const winds = rng.next() < 0.25;
    const family = shuffle(winds ? [KIND_WIND, KIND_WIND + 1, KIND_WIND + 2, KIND_WIND + 3] : [KIND_DRAGON, KIND_DRAGON + 1, KIND_DRAGON + 2], rng);
    for (const k of family.slice(0, family.length - 1)) {
      if (!pool.take(k, 3)) return null;
      sets.push([k, k, k]);
    }
    while (sets.length < 5) {
      const set = randomSet(rng, pool, 0.6, [0, 1, 2], false);
      if (!set) return null;
      sets.push(set);
    }
    if (!takePair(family[family.length - 1])) return null;
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
  headline: ReadonlySet<string> = HEADLINE_KEYS,
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
      items = (bySelf.tai >= byDiscard.tai ? bySelf : byDiscard).items.filter((i) => headline.has(i.key));
    }
  }
  return { winning, expectedTai: tiles > 0 ? taiSum / tiles : 0, bestTai, expectedScore: score, items };
}

export const fmt1 = (x: number): string => (Math.round(x * 10) / 10).toString();

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
/**
 * Kinds whose removal from the complete hand `concealed` leaves a wait with exactly `live` unseen
 * winning tiles and also lets a single wait on a new tile compete with it: some second tile can go
 * so that the rest is whole sets.
 */
function narrowOuts(concealed: readonly Kind[], melds: readonly PuzzleMeld[], live: number): Kind[] {
  const counts = countsFromKinds(concealed);
  const seen = countsFromKinds([...concealed, ...melds.flatMap((m) => m.kinds)]);
  const setsNeeded = TOTAL_SETS - melds.length;
  // A kind nobody holds stands in for the new tile's pair when testing the single wait.
  const ghost = seen.findIndex((n) => n === 0);
  const out: Kind[] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (counts[k] === 0) continue;
    counts[k]--;
    const n = shapeWaits(counts, setsNeeded).reduce((sum, w) => sum + Math.max(0, 4 - seen[w] + (w === k ? 1 : 0)), 0);
    let single = false;
    if (n === live && ghost >= 0) {
      counts[ghost] += 2;
      for (let y = 0; y < NUM_PLAY_KINDS && !single; y++) {
        if (counts[y] === 0 || y === ghost) continue;
        counts[y]--;
        single = isComplete(counts, setsNeeded);
        counts[y]++;
      }
      counts[ghost] -= 2;
    }
    counts[k]++;
    if (single) out.push(k);
  }
  return out;
}

function valueReason(answer: ValueOption, rival: ValueOption, keepsPattern: boolean): string | null {
  if (keepsPattern) return rival.acceptance! > answer.acceptance! ? 'puzzle.value.tradeSpeed' : 'puzzle.value.keepPattern';
  const faster = answer.acceptance! > rival.acceptance!;
  const rivalBigger = rival.expectedTai! > answer.expectedTai! || rival.bestTai! > answer.bestTai!;
  if (faster) return rivalBigger ? 'puzzle.value.speed' : 'puzzle.value.both';
  return answer.expectedTai! > rival.expectedTai! ? 'puzzle.value.moreTai' : null;
}

export function valueText(
  p: Pick<ValuePuzzle, 'answer' | 'answers' | 'rival' | 'options' | 'patternEn' | 'patternZh' | 'patternTai'>,
  reasonKey: string,
  chase?: TaiItem,
): PuzzleExplanation {
  const a = p.options.find((o) => o.kind === p.answer)!;
  const r = p.options.find((o) => o.kind === p.rival)!;
  const A = tileEn(p.answer);
  const Az = tileZh(p.answer);
  const R = tileEn(p.rival);
  const Rz = tileZh(p.rival);
  const ratio = Math.round((100 * r.expectedScore!) / a.expectedScore!);
  let en = `Throwing ${A} leaves ${a.acceptance} winning tiles worth ${fmt1(a.expectedTai!)} 台 a win on average (up to ${a.bestTai} 台). Throwing ${R} leaves ${r.acceptance}, worth ${fmt1(r.expectedTai!)} 台 on average (up to ${r.bestTai} 台).`;
  let zh = `打${Az}聽 ${a.acceptance} 張，平均每次胡 ${fmt1(a.expectedTai!)} 台（最多 ${a.bestTai} 台）；打${Rz}聽 ${r.acceptance} 張，平均 ${fmt1(r.expectedTai!)} 台（最多 ${r.bestTai} 台）。`;
  if (reasonKey === 'puzzle.value.speed') {
    en += ` More winning tiles beat the bigger hand here: counting 100 points a win plus 20 a 台, ${R} is worth only ${ratio}% of ${A}.`;
    zh += `這手牌速度比台數重要：以底100、每台20計算，打${Rz}的期望值只有打${Az}的${ratio}%。`;
  } else if (reasonKey === 'puzzle.value.both') {
    en += ` ${A} has more winning tiles and its wins are no smaller, so there is nothing to trade: counting 100 points a win plus 20 a 台, ${R} is worth only ${ratio}% of ${A}.`;
    zh += `打${Az}聽的張數比較多，胡的台數也不會比較少，沒有什麼好取捨的：以底100、每台20計算，打${Rz}的期望值只有打${Az}的${ratio}%。`;
  } else if (reasonKey === 'puzzle.value.moreTai') {
    const tiles = a.acceptance! < r.acceptance! ? 'fewer winning tiles' : 'the same number of winning tiles';
    const tilesZh = a.acceptance! < r.acceptance! ? '聽的張數比較少' : '聽的張數一樣';
    en += ` ${A} has ${tiles}, but each win is worth more 台: counting 100 points a win plus 20 a 台, ${R} is worth only ${ratio}% of ${A}.`;
    zh += `打${Az}${tilesZh}，但是每次胡的台數比較多：以底100、每台20計算，打${Rz}的期望值只有打${Az}的${ratio}%。`;
  } else {
    const keep = p.patternEn ? ` keeps ${p.patternEn} (${p.patternZh}, ${p.patternTai} 台), and` : '';
    const keepZh = p.patternZh ? `保住${p.patternZh}（${p.patternTai} 台），` : '';
    en += ` ${A}${keep} counting 100 points a win plus 20 a 台, ${R} is worth only ${ratio}% of it.`;
    zh += `打${Az}${keepZh}以底100、每台20計算，打${Rz}的期望值只有它的${ratio}%。`;
    if (reasonKey === 'puzzle.value.tradeSpeed') {
      en += ` That is a trade of speed for value worth making.`;
      zh += `用速度換台數，這樣很值得。`;
    }
  }
  if (chase) {
    en += ` ${R} goes for ${chase.nameEn} (${patternNameZh(chase)}, ${chase.tai} 台), but with ${r.acceptance} winning tiles against ${a.acceptance} that is not worth it.`;
    zh += `打${Rz}是做${patternNameZh(chase)}（${chase.tai} 台），但是只聽 ${r.acceptance} 張、比 ${a.acceptance} 張少，不值得。`;
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
 * Difficulty 1: the best discard is also at least as fast as the rival; 3: in about half the
 * seeds (`VALUE_HARD_SIZE_SHARE`) the bigger hand wins, so keeping the most winning tiles is wrong
 * (`valueSpeedRule`), and in the rest the best discard wins on speed against a bigger hand. Either way the
 * pattern of 4 台 or more keeps the same share of the most winning tiles (`VALUE_HARD_SHARES`), so no
 * threshold on that share tells the two apart (`hardValuePuzzle`).
 */
export function valuePuzzle(seed: string, difficulty: PuzzleDifficulty = 2): ValuePuzzle {
  const rng = createRng(`value:${seed}:${difficulty}`);
  if (difficulty === 3) return hardValuePuzzle(seed, rng);
  let fallback: ValuePuzzle | null = null;
  for (let attempt = 0; attempt < 600; attempt++) {
    const p = valueAttempt(seed, difficulty, rng);
    if (!p) continue;
    const a = p.options.find((o) => o.kind === p.answer)!;
    const r = p.options.find((o) => o.kind === p.rival)!;
    if (difficulty === 1 ? a.acceptance! >= r.acceptance! && p.patternKey !== '' : true) return p;
    fallback = fallback ?? p;
    if (attempt >= 300) return fallback;
  }
  if (fallback) return fallback;
  throw new Error(`valuePuzzle: no puzzle for seed ${seed}`);
}

/**
 * The two-line rule at any threshold, against the judge: "take the discard whose best win holds a pattern of
 * 4 台 or more and keeps at least `share` of the most winning tiles (the biggest such win), else keep the most
 * winning tiles". True when every discard it picks is accepted, false when none is, null when they split
 * (`valuePatternRule` is this rule at a share of one half).
 */
export function valueTwoLineRule(p: Pick<ValuePuzzle, 'options'>, share: number): boolean | null {
  const ready = p.options.filter((o) => o.ready);
  const most = Math.max(...ready.map((o) => o.acceptance ?? 0));
  const big = ready.filter((o) => (o.items ?? []).some((i) => i.tai >= VALUE_BIG_PATTERN_TAI) && (o.acceptance ?? 0) >= share * most);
  const top = Math.max(...big.map((o) => o.bestTai ?? -1));
  const picks = big.length > 0 ? big.filter((o) => o.bestTai === top) : ready.filter((o) => (o.acceptance ?? 0) === most);
  const right = picks.filter((o) => o.accepted).length;
  return right === picks.length ? true : right === 0 ? false : null;
}

/**
 * True when the two-line rule is right at a threshold exactly when the threshold is at most `kept / of` (the
 * pattern wins) or exactly when it is above it (speed wins), at every threshold that changes what it picks.
 */
function twoLineStep(p: ValuePuzzle, kept: number, of: number, patternWins: boolean): boolean {
  const ready = p.options.filter((o) => o.ready);
  const most = Math.max(...ready.map((o) => o.acceptance ?? 0));
  if (!ready.some((o) => (o.acceptance ?? 0) * of === most * kept && (o.items ?? []).some((i) => i.tai >= VALUE_BIG_PATTERN_TAI))) return false;
  const shares = [0, 1.01, ...ready.flatMap((o) => [(o.acceptance ?? 0) / most, (o.acceptance ?? 0) / most + 1e-9])];
  return shares.every((r) => valueTwoLineRule(p, r) === (patternWins === r * of <= kept));
}

/**
 * A hard value puzzle: the seed draws who wins (`VALUE_HARD_SIZE_SHARE`: the bigger hand, so keeping the most
 * winning tiles is wrong; else speed against a bigger hand) and the share of the most winning tiles the pattern
 * keeps (`VALUE_HARD_SHARES`), and hands are drawn until one has both. Bigger hands come from a pure flush with a
 * narrow wait or from pongs, speed wins from a flush, pongs or a family of honours against the faster wait.
 */
function hardValuePuzzle(seed: string, rng: Rng): ValuePuzzle {
  const sizeWins = rng.next() < VALUE_HARD_SIZE_SHARE;
  const target = rng.int(VALUE_HARD_SHARES.length);
  const [kept, of] = VALUE_HARD_SHARES[target];
  const builds = VALUE_HARD_BUILDS[target][sizeWins ? 'pattern' : 'speed'];
  let fallback: ValuePuzzle | null = null;
  let fallbackWins = false;
  for (let attempt = 0; attempt < VALUE_HARD_ATTEMPTS; attempt++) {
    const [theme, forSize] = builds[rng.int(builds.length)];
    const p = valueAttempt(seed, 3, rng, forSize, !forSize, theme, [kept, of]);
    if (!p) continue;
    if (twoLineStep(p, kept, of, sizeWins)) return p;
    // Settle, if it comes to that, for a hand with the right winner.
    const wins = valueSpeedRule(p) === !sizeWins;
    if (!fallback || (wins && !fallbackWins)) {
      fallback = p;
      fallbackWins = wins;
    }
  }
  // None had the share: the first hand with the right winner whatever its share, or failing that any hand.
  for (let attempt = 0; attempt < VALUE_HARD_ATTEMPTS && !fallbackWins; attempt++) {
    const [theme, forSize] = builds[rng.int(builds.length)];
    const p = valueAttempt(seed, 3, rng, forSize, !forSize, theme);
    if (!p) continue;
    const wins = valueSpeedRule(p) === !sizeWins;
    if (!fallback || wins) {
      fallback = p;
      fallbackWins = wins;
    }
  }
  if (fallback) return fallback;
  throw new Error(`valuePuzzle: no puzzle for seed ${seed}`);
}

function valueAttempt(seed: string, difficulty: PuzzleDifficulty, rng: Rng, sizeBias = false, trap = false, forced?: ValueTheme, share?: readonly [number, number]): ValuePuzzle | null {
  const pool = new TilePool();
  const dealerSeat = rng.int(4);
  const prevailingWind = rng.int(2);
  const seatWind = seatWindKind(0, dealerSeat);
  const valueHonours = [...new Set([seatWind, prevailingWindKind(prevailingWind), KIND_DRAGON, KIND_DRAGON + 1, KIND_DRAGON + 2])];
  // Theme mix by difficulty: flushes usually keep the faster wait too, pongs usually trade speed.
  const roll = rng.next();
  // A hard puzzle with a big pattern against speed (`sizeBias`: the pattern wins; `trap`: it keeps
  // half the winning tiles and still loses) is built from a flush, pongs (concealed pongs count)
  // or two dragon pongs with the third dragon as the pair (小三元). `pure`: a flush without
  // honours, and five pongs.
  const [flushShare, pongShare] = sizeBias ? [0.45, 0.55] : trap ? [0.3, 0.35] : VALUE_THEME_MIX[difficulty];
  const theme: ValueTheme = forced ?? (roll < flushShare ? 'flush' : roll < flushShare + pongShare ? 'pongs' : sizeBias || trap ? 'honours' : 'honour');
  // A flush against speed is pure a third of the time.
  const pure = sizeBias || (trap && (theme !== 'flush' || (forced ? roll < 1 / 3 : roll < flushShare / 3)));
  const nExposed = difficulty === 1 ? 0 : rng.int(3);
  const built = themedHand(rng, pool, theme, valueHonours, pure);
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
  const pongKinds = theme === 'pongs' || theme === 'honours' ? [...new Set(concealed.filter((k) => concealed.filter((x) => x === k).length >= 3 && (difficulty < 3 || k < KIND_WIND)))] : [];
  const pairPick = theme === 'flush' && rng.next() < 0.4;
  let outKind = pongKinds.length > 0 && (difficulty === 3 || rng.next() < 0.7) ? pongKinds[rng.int(pongKinds.length)] : pairPick ? built.pair : concealed[rng.int(concealed.length)];
  if (theme === 'honours' && (pongKinds.length === 0 || rng.next() < 0.4)) outKind = built.pair;
  if (sizeBias && theme === 'flush') {
    // The flush wait left after throwing the off-suit tile has exactly two live winning tiles, one
    // fewer than the single wait on the off-suit tile it competes with.
    const narrow = narrowOuts(concealed, melds, 2);
    if (narrow.length === 0) return null;
    outKind = narrow[rng.int(narrow.length)];
  }
  const out = concealed.splice(concealed.indexOf(outKind), 1)[0];
  const hasHonour = [...concealed, ...melds.flatMap((m) => m.kinds)].some(isHonorKind);
  const sameSuitNear = (k: Kind) => concealed.some((c) => c < KIND_WIND && Math.floor(c / 9) === Math.floor(k / 9) && Math.abs(c - k) <= 2 && c !== k);
  const tempting = (k: Kind): boolean => {
    if (k === out) return false;
    if (theme === 'flush') return k < KIND_WIND ? Math.floor(k / 9) !== built.suit : !hasHonour;
    // Next to the broken pong, so throwing from it leaves a chow-shaped wait that kills 碰碰胡.
    if (theme === 'pongs' || (theme === 'honours' && outKind !== built.pair)) return outKind < KIND_WIND ? k < KIND_WIND && Math.floor(k / 9) === Math.floor(outKind / 9) && Math.abs(k - outKind) <= (difficulty === 3 ? 1 : 2) : k < KIND_WIND && sameSuitNear(k);
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
  const c = counts.slice();
  // Live from your own view: the discarded copy is gone too, so count the hand before the discard.
  const shapes: Array<{ kind: Kind; live: { kind: Kind; live: number }[] | null }> = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    if (counts[k] === 0) continue;
    c[k]--;
    const shape = shapeWaits(c, setsNeeded);
    c[k]++;
    shapes.push({ kind: k, live: shape.length === 0 ? null : shape.map((w) => ({ kind: w, live: 4 - counts[w] - ownMeldCounts[w] })).filter((w) => w.live > 0) });
  }
  // A hard puzzle asks for a ready discard that keeps exactly `share` of the most winning tiles: without one, skip the scoring.
  if (share) {
    const tiles = shapes.flatMap((x) => (x.live ? [x.live.reduce((n, w) => n + w.live, 0)] : []));
    const most = Math.max(...tiles);
    if (!tiles.some((n) => n * share[1] === most * share[0])) return null;
  }
  const options: ValueOption[] = [];
  for (const { kind: k, live } of shapes) {
    if (!live) {
      options.push({ kind: k, ready: false });
      continue;
    }
    const rest = concealed.slice();
    rest.splice(rest.indexOf(k), 1);
    const v = scoreWaits(rest, live, meldObjs, dealerSeat, prevailingWind, difficulty === 3 ? HARD_HEADLINE_KEYS : HEADLINE_KEYS);
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
  const patternZh = pattern ? patternNameZh(pattern) : '';
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
    ...valueText(base, reasonKey, difficulty === 3 ? chasedPattern(answer, rival) : undefined),
  };
}

/** A value-honour item is a pong (中 → 中的刻子); flushes and 碰碰胡 read as they are. */
function patternNameZh(item: TaiItem): string {
  return item.key.startsWith('dragon_') || item.key === 'seat_wind' || item.key === 'round_wind' ? `${item.nameZh}的刻子` : item.nameZh;
}

/**
 * The biggest pattern of `VALUE_BIG_PATTERN_TAI` or more that the rival's best win holds and the
 * answer's does not, when the rival also has fewer winning tiles: the pattern that is not worth chasing.
 */
export function chasedPattern(answer: ValueOption, rival: ValueOption): TaiItem | undefined {
  if (rival.acceptance! >= answer.acceptance!) return undefined;
  const mine = new Set(answer.items!.map((i) => i.key));
  return rival.items!.filter((i) => i.tai >= VALUE_BIG_PATTERN_TAI && !mine.has(i.key)).sort((x, y) => y.tai - x.tai)[0];
}

/**
 * The one-line rule "keep the most winning tiles" against the judge: true when every ready discard
 * with the most winning tiles is accepted, false when none is, null when they split.
 */
export function valueSpeedRule(p: Pick<ValuePuzzle, 'options'>): boolean | null {
  const ready = p.options.filter((o) => o.ready);
  const most = Math.max(...ready.map((o) => o.acceptance ?? 0));
  const picks = ready.filter((o) => (o.acceptance ?? 0) === most);
  const right = picks.filter((o) => o.accepted).length;
  return right === picks.length ? true : right === 0 ? false : null;
}

/** A pattern of at least this many 台 is what the two-line rule (`valuePatternRule`) chases. */
export const VALUE_BIG_PATTERN_TAI = 4;

/**
 * The two-line rule "take a discard whose best win holds a pattern of 4 台 or more if it keeps at
 * least half the most winning tiles (the biggest such win), else keep the most winning tiles"
 * against the judge: true when every discard it picks is accepted, false when none is, null when
 * they split.
 */
export function valuePatternRule(p: Pick<ValuePuzzle, 'options'>): boolean | null {
  const ready = p.options.filter((o) => o.ready);
  const most = Math.max(...ready.map((o) => o.acceptance ?? 0));
  const big = ready.filter((o) => (o.items ?? []).some((i) => i.tai >= VALUE_BIG_PATTERN_TAI) && 2 * (o.acceptance ?? 0) >= most);
  const top = Math.max(...big.map((o) => o.bestTai ?? -1));
  const picks = big.length > 0 ? big.filter((o) => o.bestTai === top) : ready.filter((o) => (o.acceptance ?? 0) === most);
  const right = picks.filter((o) => o.accepted).length;
  return right === picks.length ? true : right === 0 ? false : null;
}

export function checkValueAnswer(p: ValuePuzzle, kind: Kind): boolean {
  return p.answers.includes(kind);
}
