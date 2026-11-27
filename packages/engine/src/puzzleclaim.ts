/**
 * Claim puzzles (from puzzles.ts): what the coach does in a claim window. The response that leaves the hand closest to
 * ready and worth the most; claims within `CLAIM_TOLERANCE` of the best all count as right.
 */
import { coachAction, honourTai, unseenCounts } from './bot';
import { applyAction, legalActions, type Action, type GameState } from './game';
import { countsFromKinds, relevantKinds, shanten, TOTAL_SETS, waits, type Counts } from './hand';
import type { Meld } from './meld';
import { createRng, type Rng } from './rng';
import { DEFAULT_RULES } from './rules';
import { prevailingWindKind, seatWindKind } from './scoring';
import { isHonorKind, kindOf, KIND_DRAGON, KIND_WIND, NUM_PLAY_KINDS, type Kind } from './tiles';
import { TilePool, randomSet, buildTable, shantenByDiscard, shapeWaits, tileEn, tileZh, seatViews, readyHand, type PuzzleDifficulty, type PuzzleMeld, type PuzzleSeatView, type PuzzleExplanation, type SeatSetup } from './puzzletable';
import { VALUE_SELF_DRAW_SHARE, scoreWaits } from './puzzlevalue';

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

export function claimText(p: Pick<ClaimPuzzle, 'answer' | 'discard' | 'shantenBefore' | 'options' | 'melds'>, valuePong: number): PuzzleExplanation {
  const a = p.answer;
  const label = claimLabel(a, p.discard);
  const concealed = p.melds.every((m) => m.concealed);
  if (a.type === 'hu') {
    return {
      reasonKey: 'puzzle.claim.hu',
      explanation: `${tileEn(p.discard)} completes your hand: five sets and a pair. A win comes before every other claim, so call 胡.`,
      explanationZh: `${tileZh(p.discard)}讓你湊齊五組加一對眼，胡牌優先於任何吃碰，直接胡。`,
    };
  }
  if (a.type === 'pass') {
    const o = othersText(p);
    if (p.shantenBefore === 0 && concealed) {
      return {
        reasonKey: 'puzzle.claim.passReady',
        explanation: `You are already ready (聽牌) with a concealed hand and ${a.acceptance} live winning ${a.acceptance === 1 ? 'tile' : 'tiles'}. No claim gets you closer, and calling would cost you 門清 (and 門清自摸 on a self-draw), so pass.${o.en}`,
        explanationZh: `你已經聽牌，而且是門清，還有 ${a.acceptance} 張可以胡。吃碰不會讓你更接近胡牌，還會失去門清（自摸時的門清自摸），所以這張過。${o.zh}`,
      };
    }
    return {
      reasonKey: 'puzzle.claim.passNoGain',
      explanation: `No claim here leaves the hand better off: none of them gets you closer to ready with as much to win. Exposing a set for nothing gives away information and flexibility, so pass.${o.en}`,
      explanationZh: `這些吃碰都不能讓牌變得更好：沒有離聽牌更近，能胡的牌和台數也沒有增加。白白亮出一組牌只會洩露牌型、少了變化，所以這張過。${o.zh}`,
    };
  }
  const after = a.shantenAfter;
  // A claim accepted as about as good as passing may leave the hand just as far from ready: it is not said to bring it closer.
  const closer = after < p.shantenBefore;
  const tilesFrom = (k: number) => `${k} ${k === 1 ? 'tile' : 'tiles'} from ready`;
  const stepsEn = !closer ? (after === 0 ? 'keeps you ready (聽牌), as passing does' : `leaves you ${tilesFrom(after)}, as passing does`) : after === 0 ? 'makes you ready (聽牌)' : `takes you from ${p.shantenBefore} to ${tilesFrom(after)}`;
  // Named for the claim on offer (吃, 碰 or 槓), never 吃碰.
  const verb = a.type === 'chi' ? '吃' : a.type === 'kong' ? '槓' : '碰';
  const stepsZh = !closer ? (after === 0 ? `這樣還是聽牌，和不${verb}一樣` : `這樣還是差 ${after} 張聽牌，和不${verb}一樣`) : after === 0 ? '這樣就聽牌' : `從差 ${p.shantenBefore} 張聽牌變成差 ${after} 張`;
  const waitEn = after === 0 && a.waits ? ` It leaves ${a.acceptance} live winning ${a.acceptance === 1 ? 'tile' : 'tiles'}.` : '';
  const waitZh = after === 0 && a.waits ? `聽 ${a.acceptance} 張。` : '';
  // A pong that brings the hand no closer is taken for its 台: said so, not as an extra.
  const valueEn = valuePong ? ` The pong of ${tileEn(p.discard)} is ${closer ? 'also ' : ''}worth ${valuePong} 台.` : '';
  const valueZh = valuePong ? `${tileZh(p.discard)}的刻子${closer ? '還' : ''}有 ${valuePong} 台。` : '';
  const kongEn = a.type === 'kong' ? ' A kong also brings a replacement tile from the back of the wall.' : '';
  const kongZh = a.type === 'kong' ? '槓還可以從牌尾補一張。' : '';
  return {
    reasonKey: a.type === 'kong' ? 'puzzle.claim.kong' : !closer ? (valuePong ? 'puzzle.claim.value' : 'puzzle.claim.even') : after === 0 ? 'puzzle.claim.ready' : 'puzzle.claim.closer',
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
    // Passing is named as an act ("passing", 不吃不碰), not by its button's label.
    const en1 = (o: ClaimOption, i: number) => (o.type === 'pass' ? (i === 0 ? 'Passing' : 'passing') : claimLabel(o, p.discard).en);
    const zh1 = (o: ClaimOption) => (o.type === 'pass' ? '不吃不碰' : claimLabel(o, p.discard).zh);
    en += ` ${also.map(en1).join(' and ')} ${also.length > 1 ? 'are' : 'is'} about as good.`;
    zh += `${also.map(zh1).join('、')}也差不多一樣好。`;
  }
  if (worse.some((o) => o.shantenAfter > p.answer.shantenAfter)) {
    en += ' The other choices leave you further from ready.';
    zh += '其他選擇離聽牌比較遠。';
  } else if (worse.length > 0) {
    en += ' The other choices are as close to ready but leave fewer or cheaper winning tiles.';
    zh += '其他選擇離聽牌一樣近，但能胡的牌比較少或台數比較低。';
  }
  return { en, zh };
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

/** The 台 a pong of the claim puzzle's discard is worth to the player (seat 0): a dragon, the seat wind, the round wind. */
export function claimPongTai(p: Pick<ClaimPuzzle, 'discard' | 'dealerSeat' | 'prevailingWind'>): number {
  if (!isHonorKind(p.discard)) return 0;
  if (p.discard >= KIND_DRAGON) return 1;
  return (p.discard === seatWindKind(0, p.dealerSeat) ? 1 : 0) + (p.discard === prevailingWindKind(p.prevailingWind) ? 1 : 0);
}
