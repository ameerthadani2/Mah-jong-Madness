/**
 * 台 (tai) scoring for Taiwanese 16-tile Mahjong.
 *
 * The scorer takes a `WinContext` describing how the hand was won, tries every
 * decomposition of the concealed tiles, and returns the highest-scoring one with
 * an itemised breakdown so the UI and the coach can explain the result.
 */
import { decompose, countsFromKinds, waits, type Decomposition, TOTAL_SETS } from './hand';
import { meldKind, type Meld } from './meld';
import { type RuleSet } from './rules';
import {
  isDragonKind,
  isHonorKind,
  isSuited,
  isWindKind,
  KIND_DRAGON,
  KIND_FLOWER,
  KIND_WIND,
  kindOf,
  rankOfKind,
  suitOfKind,
  type Kind,
} from './tiles';

export interface WinContext {
  rules: RuleSet;
  seat: number;
  dealerSeat: number;
  /** Number of consecutive hands the dealer has held (0 on the first). */
  dealerStreak: number;
  /** 0 = East round, 1 = South ... */
  prevailingWind: number;
  /** Concealed kinds, NOT including the winning tile. */
  concealed: Kind[];
  melds: Meld[];
  /** Bonus tiles held (kinds 34..41). */
  flowers: Kind[];
  winningTile: Kind;
  selfDrawn: boolean;
  /** Seat that discarded / was robbed, when not self-drawn. */
  fromSeat?: number;
  /** Won on the replacement tile after a kong (槓上開花). */
  afterKong?: boolean;
  /** Won on the replacement tile after a flower (花上自摸). */
  afterFlower?: boolean;
  /** Won by robbing an added kong (搶槓). */
  robbingKong?: boolean;
  /** Won on the very last drawable tile (海底撈月) or the last discard (河底撈魚). */
  lastTile?: boolean;
  /** Dealer wins on the initial deal (天胡). */
  heavenlyHand?: boolean;
  /** Non-dealer wins on their first draw before any claim (地胡). */
  earthlyHand?: boolean;
  /** Non-dealer wins on dealer's first discard (人胡 — scored as 地胡 variant). */
  humanlyHand?: boolean;
}

export interface TaiItem {
  key: string;
  nameZh: string;
  nameEn: string;
  tai: number;
}

export interface ScoreResult {
  tai: number;
  items: TaiItem[];
  decomposition: Decomposition | null;
  /** The best decomposition's sets expressed uniformly with the exposed melds. */
  concealedSetTypes: Array<'chow' | 'pong'>;
}

const T = (key: string, nameZh: string, nameEn: string, tai: number): TaiItem => ({ key, nameZh, nameEn, tai });

/** Seat wind kind for a seat given the dealer (dealer is 東). */
export function seatWindKind(seat: number, dealerSeat: number): Kind {
  return KIND_WIND + ((seat - dealerSeat + 4) % 4);
}

export function prevailingWindKind(prevailingWind: number): Kind {
  return KIND_WIND + prevailingWind;
}

export function scoreWin(ctx: WinContext): ScoreResult {
  const counts = countsFromKinds([...ctx.concealed, ctx.winningTile]);
  const setsNeeded = TOTAL_SETS - ctx.melds.length;
  const decomps = decompose(counts, setsNeeded);
  if (decomps.length === 0) {
    return { tai: 0, items: [], decomposition: null, concealedSetTypes: [] };
  }
  let best: ScoreResult | null = null;
  for (const d of decomps) {
    const r = scoreDecomposition(ctx, d, setsNeeded);
    if (!best || r.tai > best.tai) best = r;
  }
  return best!;
}

function scoreDecomposition(ctx: WinContext, d: Decomposition, setsNeeded: number): ScoreResult {
  const items: TaiItem[] = [];
  const rules = ctx.rules;
  const isDealer = ctx.seat === ctx.dealerSeat;
  const seatWind = seatWindKind(ctx.seat, ctx.dealerSeat);
  const roundWind = prevailingWindKind(ctx.prevailingWind);
  const concealedCounts = countsFromKinds(ctx.concealed);
  const openMelds = ctx.melds.filter((m) => !m.concealed);
  const isConcealedHand = openMelds.length === 0;

  // ---- All set kinds (exposed + concealed) ----
  const allSets: Array<{ type: 'chow' | 'pong' | 'kong'; kind: Kind; concealed: boolean }> = [];
  for (const m of ctx.melds) allSets.push({ type: m.type, kind: meldKind(m), concealed: m.concealed });
  for (const s of d.sets) {
    // A concealed pong that was completed by the winning discard counts as exposed for 暗刻 purposes.
    const completedByDiscard = !ctx.selfDrawn && s.type === 'pong' && s.kind === ctx.winningTile && concealedCounts[s.kind] === 2;
    allSets.push({ type: s.type, kind: s.kind, concealed: !completedByDiscard });
  }
  const pongLike = allSets.filter((s) => s.type !== 'chow');
  const chows = allSets.filter((s) => s.type === 'chow');
  const concealedPongs = pongLike.filter((s) => s.concealed).length;

  // ---- Limit-style hands first ----
  const allKinds = [...ctx.concealed, ctx.winningTile, ...ctx.melds.flatMap((m) => m.tiles.map(kindOf))];
  const suitsUsed = new Set(allKinds.filter(isSuited).map(suitOfKind));
  const hasHonors = allKinds.some(isHonorKind);
  const windPongs = pongLike.filter((s) => isWindKind(s.kind)).length;
  const dragonPongs = pongLike.filter((s) => isDragonKind(s.kind)).length;

  if (ctx.heavenlyHand) items.push(T('tianhu', '天胡', 'Heavenly Hand', 16));
  else if (ctx.earthlyHand) items.push(T('dihu', '地胡', 'Earthly Hand', 16));
  else if (ctx.humanlyHand) items.push(T('renhu', '人胡', 'Humanly Hand', 16));

  if (ctx.flowers.length === 8) items.push(T('eight_flowers', '八仙過海', 'Eight Immortals (all 8 bonus tiles)', 8));

  if (suitsUsed.size === 0 && hasHonors) items.push(T('all_honors', '字一色', 'All Honors', 16));
  else if (suitsUsed.size === 1 && !hasHonors) items.push(T('full_flush', '清一色', 'Full Flush', 8));
  else if (suitsUsed.size === 1 && hasHonors) items.push(T('half_flush', '混一色', 'Half Flush', 4));

  if (windPongs === 4) items.push(T('big_four_winds', '大四喜', 'Big Four Winds', 16));
  else if (windPongs === 3 && isWindKind(d.pair)) items.push(T('small_four_winds', '小四喜', 'Small Four Winds', 8));

  if (dragonPongs === 3) items.push(T('big_three_dragons', '大三元', 'Big Three Dragons', 8));
  else if (dragonPongs === 2 && isDragonKind(d.pair)) items.push(T('small_three_dragons', '小三元', 'Small Three Dragons', 4));

  if (chows.length === 0) items.push(T('all_pongs', '碰碰胡', 'All Pongs', 4));

  if (concealedPongs === 5) items.push(T('five_concealed', '五暗刻', 'Five Concealed Pongs', 8));
  else if (concealedPongs === 4) items.push(T('four_concealed', '四暗刻', 'Four Concealed Pongs', 5));
  else if (concealedPongs === 3) items.push(T('three_concealed', '三暗刻', 'Three Concealed Pongs', 2));

  // ---- Value pongs ----
  for (const s of pongLike) {
    if (isDragonKind(s.kind)) {
      // Individual dragon tai is subsumed by 大三元; 小三元 still adds its two dragon pongs in common rules.
      if (dragonPongs !== 3) items.push(T(`dragon_${s.kind}`, `${['中', '發', '白'][s.kind - KIND_DRAGON]}`, `${['Red', 'Green', 'White'][s.kind - KIND_DRAGON]} Dragon Pong`, 1));
    } else if (isWindKind(s.kind)) {
      if (windPongs !== 4) {
        if (s.kind === seatWind) items.push(T('seat_wind', '門風', 'Seat Wind Pong', 1));
        if (s.kind === roundWind) items.push(T('round_wind', '圈風', 'Prevailing Wind Pong', 1));
      }
    }
  }

  // ---- Win method ----
  if (isConcealedHand && ctx.selfDrawn) items.push(T('concealed_self_draw', '門清自摸', 'Concealed Self-Draw', 3));
  else {
    if (isConcealedHand) items.push(T('concealed', '門清', 'Concealed Hand', 1));
    if (ctx.selfDrawn) items.push(T('self_draw', '自摸', 'Self-Draw', 1));
  }
  // 全求人 / 半求人: every set exposed, only the pair left in hand
  if (ctx.melds.length === TOTAL_SETS && ctx.concealed.length === 1) {
    if (ctx.selfDrawn) items.push(T('half_begging', '半求人', 'Half Begging (all exposed, self-draw)', 1));
    else items.push(T('full_begging', '全求人', 'Full Begging (all exposed, won by discard)', 2));
  }

  // ---- Wait shape ----
  const waitKinds = waits(countsFromKinds(ctx.concealed), setsNeeded);
  const singleWait = waitKinds.length === 1 && isRestrictedWait(d, ctx.winningTile, ctx.concealed);
  if (singleWait) items.push(T('single_wait', '獨聽', 'Single Wait', 1));

  // ---- 平胡: all chows, non-honor pair, two-sided wait, no flowers, not self-drawn ----
  const pairIsValue = isHonorKind(d.pair);
  if (
    chows.length === TOTAL_SETS &&
    !pairIsValue &&
    ctx.flowers.length === 0 &&
    !ctx.selfDrawn &&
    !singleWait &&
    !allSets.some((s) => s.type === 'kong')
  ) {
    items.push(T('all_chows', '平胡', 'All Chows', 2));
  }

  // ---- Flowers ----
  const seatIndex = (ctx.seat - ctx.dealerSeat + 4) % 4; // 0 = East
  const flowerSet = ctx.flowers.filter((f) => f >= KIND_FLOWER && f < KIND_FLOWER + 4);
  const seasonSet = ctx.flowers.filter((f) => f >= KIND_FLOWER + 4);
  if (ctx.flowers.length < 8) {
    if (flowerSet.length === 4) items.push(T('four_flowers', '花槓（梅蘭竹菊）', 'Four Flowers', 2));
    else if (flowerSet.some((f) => f - KIND_FLOWER === seatIndex)) items.push(T('seat_flower', '正花', 'Seat Flower', 1));
    if (seasonSet.length === 4) items.push(T('four_seasons', '花槓（春夏秋冬）', 'Four Seasons', 2));
    else if (seasonSet.some((f) => f - KIND_FLOWER - 4 === seatIndex)) items.push(T('seat_season', '正季', 'Seat Season', 1));
  }
  if (rules.noFlowerTai && ctx.flowers.length === 0) items.push(T('no_flowers', '無花', 'No Flowers', 1));

  // ---- Situational ----
  if (ctx.afterKong) items.push(T('after_kong', '槓上開花', 'Win on Kong Replacement', 1));
  if (ctx.afterFlower) items.push(T('after_flower', '花上自摸', 'Win on Flower Replacement', 1));
  if (ctx.robbingKong) items.push(T('rob_kong', '搶槓', 'Robbing the Kong', 1));
  if (ctx.lastTile) items.push(ctx.selfDrawn ? T('last_tile_draw', '海底撈月', 'Last Tile Draw', 1) : T('last_tile_discard', '河底撈魚', 'Last Discard', 1));

  // ---- Dealer ----
  if (isDealer) {
    items.push(T('dealer', '莊家', 'Dealer', rules.dealerTai));
    if (ctx.dealerStreak > 0) items.push(T('dealer_streak', `連${ctx.dealerStreak}拉${ctx.dealerStreak}`, `Dealer Streak ×${ctx.dealerStreak}`, rules.dealerStreakTai * ctx.dealerStreak));
  }

  let tai = items.reduce((a, b) => a + b.tai, 0);
  if (rules.maxTai > 0 && tai > rules.maxTai) tai = rules.maxTai;
  return {
    tai,
    items,
    decomposition: d,
    concealedSetTypes: d.sets.map((s) => s.type),
  };
}

/**
 * Is the winning tile in this decomposition sitting in a restricted wait shape:
 * 單騎 (pair), 邊張 (edge 12→3 / 89→7), 嵌張 (middle of a chow)?
 */
function isRestrictedWait(d: Decomposition, win: Kind, concealedBefore: Kind[]): boolean {
  const before = countsFromKinds(concealedBefore);
  // Pair wait (單騎): the winning tile completed the pair.
  if (d.pair === win && before[win] === 1) {
    return true;
  }
  for (const s of d.sets) {
    if (s.type !== 'chow') continue;
    const [a, b, c] = [s.kind, s.kind + 1, s.kind + 2];
    if (win === b) return true; // 嵌張
    if (win === c && rankOfKind(a) === 1) return true; // 12 waiting 3
    if (win === a && rankOfKind(c) === 9) return true; // 89 waiting 7
  }
  return false;
}

/** Dealer-related 台 that apply between the dealer and the opponent in a transaction. */
export function dealerExtraTai(rules: RuleSet, dealerStreak: number): number {
  return rules.dealerTai + rules.dealerStreakTai * dealerStreak;
}

export interface Payment {
  from: number;
  to: number;
  points: number;
  tai: number;
}

/**
 * Compute point transfers for a win. `baseTai` is the hand's 台 excluding dealer
 * items (which are added per transaction depending on who is involved).
 */
export function computePayments(
  rules: RuleSet,
  winner: number,
  dealerSeat: number,
  dealerStreak: number,
  taiWithoutDealer: number,
  selfDrawn: boolean,
  fromSeat: number | undefined,
): Payment[] {
  const dealerExtra = dealerExtraTai(rules, dealerStreak);
  const payments: Payment[] = [];
  const pay = (from: number) => {
    const dealerInvolved = from === dealerSeat || winner === dealerSeat;
    let tai = taiWithoutDealer + (dealerInvolved ? dealerExtra : 0);
    if (rules.maxTai > 0 && tai > rules.maxTai) tai = rules.maxTai;
    payments.push({ from, to: winner, tai, points: rules.basePoints + tai * rules.taiPoints });
  };
  if (selfDrawn) {
    for (let s = 0; s < 4; s++) if (s !== winner) pay(s);
  } else if (fromSeat !== undefined) {
    pay(fromSeat);
  }
  return payments;
}
