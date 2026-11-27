/**
 * Defence puzzles (from puzzles.ts): the safest tiles against one opponent with four exposed sets, by the bots'
 * deal-in model and checked by exact enumeration.
 */
import { readOpponents, unseenCounts, waitChance, type OpponentRead } from './bot';
import { countsFromKinds, shanten, TOTAL_SETS, type Counts } from './hand';
import { createRng, shuffle, type Rng } from './rng';
import { isHonorKind, KIND_WIND, NUM_PLAY_KINDS, rankOfKind, type Kind } from './tiles';
import { TilePool, randomSet, buildTable, shantenByDiscard, acceptanceAfter, tileEn, tileZh, SEAT_EN, SEAT_ZH, capitalise, seatViews, readyHand, type PuzzleDifficulty, type PuzzleMeld, type PuzzleSeatView, type PuzzleExplanation, type SeatSetup } from './puzzletable';

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
  /** For a discard that keeps the hand's shanten: the tiles left that would improve the hand after it (as `efficient` counts them). */
  acceptance?: number;
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

/** Every four-tile hand of a seat with four exposed sets that is ready, with its winning kinds (built once). */
let readyFours: { tiles: [Kind, number][]; waits: Kind[] }[] | null = null;

function fourTileWaits(): { tiles: [Kind, number][]; waits: Kind[] }[] {
  if (readyFours) return readyFours;
  const sets: Kind[][] = [];
  for (let k = 0; k < NUM_PLAY_KINDS; k++) {
    sets.push([k, k, k]);
    if (k < KIND_WIND && rankOfKind(k) <= 7) sets.push([k, k + 1, k + 2]);
  }
  // In the order each hand is first found, so sums run in the same order on every device.
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
        const key = five.join(',');
        const e = waitsOf.get(key) ?? { counts: five.slice(), waits: new Set<Kind>() };
        e.waits.add(w);
        waitsOf.set(key, e);
        five[w]++;
      }
    }
  }
  readyFours = [...waitsOf.values()].map(({ counts, waits }) => ({
    tiles: counts.flatMap((n, k) => (n > 0 ? [[k, n] as [Kind, number]] : [])),
    waits: [...waits],
  }));
  return readyFours;
}

/**
 * For a seat with four exposed sets (four concealed tiles: one set and a pair to make), the exact
 * chance that each kind is one of its winning tiles, given it is ready: every four-tile hand the
 * `unseen` pool allows, weighted by the number of ways the pool deals it (each copy equally
 * likely), keeping the ready hands none of whose winning tiles is `excluded`. Every ready hand
 * plus a winning tile is a pair and a set, so the hands are found from those five-tile shapes.
 */
export function exactWaitChances(unseen: Counts, excluded: readonly boolean[]): number[] {
  const win = new Array<number>(NUM_PLAY_KINDS).fill(0);
  let total = 0;
  for (const { tiles, waits } of fourTileWaits()) {
    if (tiles.some(([k, n]) => n > unseen[k])) continue;
    if (waits.some((w) => excluded[w])) continue;
    let weight = 1;
    for (const [k, n] of tiles) weight *= binomial(unseen[k], n);
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

/**
 * The defence explanation of `p.answer` (with its own `reason`). `alternative`: the answer is a right
 * answer other than the safest one, so "the fewest hands" becomes "about as few as the safest tile".
 */
export function defenceText(p: Pick<DefencePuzzle, 'answer' | 'answers' | 'threatSeat' | 'threatLevel' | 'reason' | 'efficient' | 'opponents' | 'options'>, alternative = false): PuzzleExplanation {
  const t = tileEn(p.answer);
  const tz = tileZh(p.answer);
  const who = SEAT_EN[p.threatSeat];
  const whoZh = SEAT_ZH[p.threatSeat];
  const threatEn = `${capitalise(who)} has four exposed sets and needs only one more set or the pair.`;
  const threatZh = `${whoZh}已經亮了四組，只差一組或一對眼。`;
  let en: string;
  let zh: string;
  switch (p.reason) {
    case 'theirDiscard':
      en = `${t} is a tile ${who} has thrown. Taiwanese rules have no furiten, so it is not a guarantee, but players rarely wait on a tile they have discarded.`;
      zh = `${tz}是${whoZh}自己打過的熟張。台灣麻將打過的牌也能胡，所以不是百分之百安全，但很少有人聽自己打掉的牌。`;
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
      zh = `${tz}只剩一張沒出現。字牌不能吃，只有對方單騎最後那張才會放槍。`;
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
      en = alternative
        ? `Counting the tiles you can see, ${t} completes about as few of the hands ${who} could hold as the safest tile.`
        : `Counting the tiles you can see, ${t} completes the fewest of the hands ${who} could hold.`;
      zh = alternative ? `算一算看得到的牌，${tz}能讓${whoZh}胡的牌型和最安全的那張差不多一樣少。` : `算一算看得到的牌，${tz}能讓${whoZh}胡的牌型最少。`;
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
  const { orderEn, orderZh } = orderText(p, t, tz, who, whoZh);
  const alsoEn = others.length > 0 ? ` ${others.map(tileEn).join(' and ')} ${others.length > 1 ? 'are' : 'is'} about as safe, so ${others.length > 1 ? 'they count' : 'it counts'} too.` : '';
  const alsoZh = others.length > 0 ? `${others.map(tileZh).join('、')}差不多一樣安全，也算對。` : '';
  const keepEn = ' Throwing it also keeps your hand as close to ready as any other discard.';
  const keepZh = '打這張也不會讓你離聽牌更遠。';
  // Only when the efficient discard keeps strictly more than the tile explained (a tie is no trade).
  const accOf = (k: Kind) => p.options.find((o) => o.kind === k)?.acceptance;
  const [effAcc, ownAcc] = [accOf(p.efficient), accOf(p.answer)];
  const trade = !p.answers.includes(p.efficient) && effAcc !== undefined && ownAcc !== undefined && effAcc > ownAcc;
  const tradeEn = trade ? ` ${tileEn(p.efficient)} would leave more useful tiles, but not while someone looks ready.` : '';
  const tradeZh = trade ? `打${tileZh(p.efficient)}進張比較多，但對方看起來快聽牌了，先求安全。` : '';
  return {
    reasonKey: `puzzle.defence.${p.reason}`,
    explanation: `${threatEn} ${en}${numbersEn}${orderEn}${alsoEn}${keepEn}${tradeEn}`,
    explanationZh: `${threatZh}${zh}${numbersZh}${orderZh}${alsoZh}${keepZh}${tradeZh}`,
  };
}

const ORDER_LABEL: Partial<Record<DefenceReason, [string, string]>> = {
  lastHonour: ['only one copy is unseen', '只剩一張沒出現'],
  honour: ['an honour never joins a chow', '字牌不能吃'],
  fewCopies: ['most copies are visible', '大多已經看得到'],
  terminal: ['a terminal fits fewer chows', '么九牌能組的順子少'],
};

/**
 * When the fixed safety order picks a wrong tile (`defenceOrderRule` false): which tile it picks,
 * what the count says about it, and the threat's discards across a gap of three (筋) from the
 * answer, the reading that makes the answer safer. Empty when the order is right.
 */
function orderText(p: Pick<DefencePuzzle, 'answer' | 'threatSeat' | 'opponents' | 'options'>, t: string, tz: string, who: string, whoZh: string): { orderEn: string; orderZh: string } {
  const bestShanten = Math.min(...p.options.map((o) => o.shanten));
  if (defenceOrderRule({ options: p.options, bestShanten }) !== false) return { orderEn: '', orderZh: '' };
  const kept = p.options.filter((o) => o.shanten === bestShanten);
  const top = Math.min(...kept.map((o) => DEFENCE_SAFETY_ORDER.indexOf(o.reason)));
  const pick = kept.find((o) => DEFENCE_SAFETY_ORDER.indexOf(o.reason) === top)!;
  const [label, labelZh] = ORDER_LABEL[pick.reason] ?? ['', ''];
  const P = tileEn(pick.kind);
  const Pz = tileZh(pick.kind);
  const chance = smallPct(pick.exact);
  let orderEn = ` ${capitalise(P)} looks safer by the usual order (${label}), but counting the tiles you can see it wins for them in ${chance ? `about ${chance}` : 'under 0.1%'} of the hands they could hold, more than ${t}.`;
  let orderZh = `照一般的順序，${Pz}看起來比較安全（${labelZh}），但是算一算看得到的牌，${Pz}${chance ? `大約在${chance}` : '在不到0.1%'}的牌型裡會放槍，比${tz}危險。`;
  const threw = p.opponents.find((o) => o.seat === p.threatSeat)!.discards;
  const suji = p.answer < KIND_WIND ? [...new Set(threw)].filter((k) => k < KIND_WIND && Math.floor(k / 9) === Math.floor(p.answer / 9) && Math.abs(k - p.answer) === 3) : [];
  if (suji.length > 0) {
    orderEn += ` ${capitalise(who)} threw ${suji.map(tileEn).join(' and ')}, so a two-sided wait on ${t} would also win on a tile they gave up: players rarely wait that way.`;
    orderZh += `${whoZh}打過${suji.map(tileZh).join('、')}，聽${tz}的兩面聽也會胡他打過的牌，很少有人這樣聽。`;
  }
  return { orderEn, orderZh };
}

/** Share of hard defence puzzles where the fixed safety order (`DEFENCE_SAFETY_ORDER`) is wrong. */
export const DEFENCE_HARD_READ_SHARE = 0.5;

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
 * copies), not which rule the answer follows. At difficulty 3 about half the seats are dealt so
 * that the fixed safety order (`DEFENCE_SAFETY_ORDER`) is wrong: a live honour in the hand, and the
 * threat's discards across a gap of three (筋) from a suited tile that the count rates safer.
 */
export function defencePuzzle(seed: string, difficulty: PuzzleDifficulty = 2): DefencePuzzle {
  const rng = createRng(`defence:${seed}:${difficulty}`);
  // Hard puzzles: half need reading the discards (the fixed safety order is wrong), half follow
  // it, drawn per seed.
  const readTable = difficulty === 3 && rng.next() < DEFENCE_HARD_READ_SHARE;
  let fallback: DefencePuzzle | null = null;
  for (let attempt = 0; attempt < 600; attempt++) {
    const p = defenceAttempt(seed, difficulty, rng, readTable);
    if (!p) continue;
    if (difficulty < 3 || defenceOrderRule(p) === !readTable) return p;
    fallback = fallback ?? p;
    if (attempt >= 300) return fallback;
  }
  if (fallback) return fallback;
  throw new Error(`defencePuzzle: no puzzle for seed ${seed}`);
}

function defenceAttempt(seed: string, difficulty: PuzzleDifficulty, rng: Rng, readTable = false): DefencePuzzle | null {
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
  if (readTable) {
    // The fixed order would throw a live honour; a suited tile whose partner across the gap of
    // three (筋) the threat has thrown may be safer, which only reading the discards shows.
    // The honour must be live (two or more unseen copies), and no shape-keeping kind is dead,
    // thrown by the threat or let pass: those reasons come before an honour in the fixed order.
    const ownMelds = countsFromKinds(melds.flatMap((m) => m.kinds));
    if (!keepList.some((k) => isHonorKind(k))) return null;
    if (keepList.some((k) => isHonorKind(k) && counts[k] + ownMelds[k] >= 3)) return null;
    const suited = keepList.filter((k) => k < KIND_WIND);
    if (suited.length === 0) return null;
    for (let i = 0, n = 1 + rng.int(2); i < n; i++) {
      const k = suited[rng.int(suited.length)];
      const r = rankOfKind(k);
      const partners = [r > 3 ? k - 3 : -1, r < 7 ? k + 3 : -1].filter((x) => x >= 0 && !keepList.includes(x));
      for (const x of partners) if (pool.take(x)) threatDiscards.push(x);
    }
  }
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
    const from = readTable ? keepList.filter((x) => x < KIND_WIND) : keepList;
    const k = from[rng.int(from.length)];
    const want = Math.max(0, 4 - counts[k] - rng.int(2));
    for (let i = 0; i < want; i++) {
      if (!pool.take(k)) return null;
      otherDiscards[rng.int(2)].splice(0, 0, k);
    }
  }
  for (let i = 0; i < 2; i++) {
    const d = pool.draw(rng, Math.max(1, 5 + rng.int(6) - otherDiscards[i].length), (k) => plant === 'passed' || !keepList.includes(k) || (!readTable && rng.next() < 0.3));
    if (!d) return null;
    otherDiscards[i].splice(0, 0, ...d);
    shuffle(otherDiscards[i], rng);
    // Reading the table: a planted copy is an older discard, not the latest (which would mark it passed).
    const last = otherDiscards[i].length - 1;
    const swap = otherDiscards[i].findIndex((k) => !keepList.includes(k));
    if (readTable && keepList.includes(otherDiscards[i][last]) && swap >= 0) [otherDiscards[i][last], otherDiscards[i][swap]] = [otherDiscards[i][swap], otherDiscards[i][last]];
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
  const ownDiscards = pool.draw(rng, 5 + rng.int(6), readTable ? (k) => !keepList.includes(k) : undefined);
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
    o.acceptance = acc;
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

/** A fixed safety order a player can learn instead of reading the table (strongest reason first). */
export const DEFENCE_SAFETY_ORDER: readonly DefenceReason[] = ['deadHonour', 'theirDiscard', 'passed', 'lastHonour', 'honour', 'fewCopies', 'terminal', 'middle'];

/**
 * The fixed safety order against the judge: among the discards that keep the hand's shanten, those
 * with the reason highest in `DEFENCE_SAFETY_ORDER`. True when every one of them is accepted, false
 * when none is, null when they split.
 */
export function defenceOrderRule(p: Pick<DefencePuzzle, 'options' | 'bestShanten'>): boolean | null {
  const kept = p.options.filter((o) => o.shanten === p.bestShanten);
  const top = Math.min(...kept.map((o) => DEFENCE_SAFETY_ORDER.indexOf(o.reason)));
  const picks = kept.filter((o) => DEFENCE_SAFETY_ORDER.indexOf(o.reason) === top);
  const right = picks.filter((o) => o.accepted).length;
  return right === picks.length ? true : right === 0 ? false : null;
}

export function checkDefenceAnswer(p: DefencePuzzle, kind: Kind): boolean {
  return p.answers.includes(kind);
}
