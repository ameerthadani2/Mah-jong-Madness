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

/** The two instant wins made from bonus tiles alone. */
export type FlowerWin = 'eight' | 'sevenRob';

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
  /** Non-dealer wins on the dealer's first discard (人胡). */
  humanlyHand?: boolean;
  /**
   * An instant bonus-tile win with no hand shape: 八仙過海 (`'eight'`, this seat
   * banked all eight flowers) or 七搶一 (`'sevenRob'`, this seat held seven and
   * took the eighth from `fromSeat`). The concealed tiles are not scored.
   */
  flowerWin?: FlowerWin;
}

export interface TaiItem {
  key: string;
  nameZh: string;
  nameEn: string;
  tai: number;
}

export interface ScoreResult {
  /** Total 台 shown to players: the non-dealer items capped at `maxTai`, plus the dealer items. */
  tai: number;
  /** Sum of every item with no cap applied (used to pick the best decomposition). */
  taiUncapped: number;
  items: TaiItem[];
  /** Null for an incomplete hand and for flower wins, which have no hand shape. */
  decomposition: Decomposition | null;
  /** The best decomposition's sets expressed uniformly with the exposed melds. */
  concealedSetTypes: Array<'chow' | 'pong'>;
  /** Set when the hand was won by 八仙過海 or 七搶一. */
  flowerWin?: FlowerWin;
}

/** Item keys for 莊家 and 連莊 台, which are settled per transaction and sit outside the `maxTai` cap. */
export const DEALER_KEYS: ReadonlySet<string> = new Set(['dealer', 'dealer_streak']);

/** A hand's 台 without dealer items, capped at `rules.maxTai` (0 = no cap). */
export function cappedTai(rules: RuleSet, taiWithoutDealer: number): number {
  return rules.maxTai > 0 ? Math.min(taiWithoutDealer, rules.maxTai) : taiWithoutDealer;
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
  if (ctx.flowerWin) return scoreFlowerWin(ctx, ctx.flowerWin);
  const counts = countsFromKinds([...ctx.concealed, ctx.winningTile]);
  const setsNeeded = TOTAL_SETS - ctx.melds.length;
  const decomps = decompose(counts, setsNeeded);
  if (decomps.length === 0) {
    return { tai: 0, taiUncapped: 0, items: [], decomposition: null, concealedSetTypes: [] };
  }
  let best: ScoreResult | null = null;
  for (const d of decomps) {
    const r = scoreDecomposition(ctx, d, setsNeeded);
    // Compare uncapped totals so the cap never hides the genuinely better reading.
    if (!best || r.taiUncapped > best.taiUncapped) best = r;
  }
  return best!;
}

/** 八仙過海 / 七搶一: a fixed 8 台 plus the dealer items; nothing else applies. */
function scoreFlowerWin(ctx: WinContext, kind: FlowerWin): ScoreResult {
  const items =
    kind === 'eight'
      ? [T('eight_flowers', '八仙過海', 'Eight Immortals (all eight bonus tiles)', 8)]
      : [T('seven_rob', '七搶一', 'Seven Rob One (took the eighth bonus tile)', 8)];
  items.push(...dealerItems(ctx));
  return { ...totals(ctx.rules, items), items, decomposition: null, concealedSetTypes: [], flowerWin: kind };
}

function dealerItems(ctx: WinContext): TaiItem[] {
  if (ctx.seat !== ctx.dealerSeat) return [];
  const items = [T('dealer', '莊家', 'Dealer', ctx.rules.dealerTai)];
  if (ctx.dealerStreak > 0) {
    items.push(T('dealer_streak', `連${ctx.dealerStreak}拉${ctx.dealerStreak}`, `Dealer Streak ×${ctx.dealerStreak}`, ctx.rules.dealerStreakTai * ctx.dealerStreak));
  }
  return items;
}

/** Capped and uncapped totals: the cap applies to the non-dealer items only. */
function totals(rules: RuleSet, items: TaiItem[]): { tai: number; taiUncapped: number } {
  let base = 0;
  let dealer = 0;
  for (const i of items) {
    if (DEALER_KEYS.has(i.key)) dealer += i.tai;
    else base += i.tai;
  }
  return { tai: cappedTai(rules, base) + dealer, taiUncapped: base + dealer };
}

/** The 天胡 / 地胡 / 人胡 item for a limit deal, or null when none applies (a configured 0 turns the hand off). */
function limitDealItem(ctx: WinContext): TaiItem | null {
  const r = ctx.rules;
  if (ctx.heavenlyHand && r.heavenlyTai > 0) return T('tianhu', '天胡', 'Heavenly Hand', r.heavenlyTai);
  if (ctx.earthlyHand && r.earthlyTai > 0) return T('dihu', '地胡', 'Earthly Hand', r.earthlyTai);
  if (ctx.humanlyHand && r.humanlyTai > 0) return T('renhu', '人胡', 'Humanly Hand', r.humanlyTai);
  return null;
}

function scoreDecomposition(ctx: WinContext, d: Decomposition, setsNeeded: number): ScoreResult {
  const items: TaiItem[] = [];
  const rules = ctx.rules;
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

  // 天胡 / 地胡 / 人胡 absorb the win method, 獨聽, 平胡, the replacement-tile wins and
  // 海底/河底; pattern hands, value pongs, flowers and dealer items still add.
  const limit = limitDealItem(ctx);
  const limitDeal = limit !== null;
  if (limit) items.push(limit);

  const allHonors = suitsUsed.size === 0 && hasHonors;
  if (allHonors) items.push(T('all_honors', '字一色', 'All Honours', 16));
  else if (suitsUsed.size === 1 && !hasHonors) items.push(T('full_flush', '清一色', 'Full Flush', 8));
  else if (suitsUsed.size === 1 && hasHonors) items.push(T('half_flush', '混一色', 'Half Flush', 4));

  if (windPongs === 4) items.push(T('big_four_winds', '大四喜', 'Big Four Winds', 16));
  else if (windPongs === 3 && isWindKind(d.pair)) items.push(T('small_four_winds', '小四喜', 'Small Four Winds', 8));

  if (dragonPongs === 3) items.push(T('big_three_dragons', '大三元', 'Big Three Dragons', 8));
  else if (dragonPongs === 2 && isDragonKind(d.pair)) items.push(T('small_three_dragons', '小三元', 'Small Three Dragons', 4));

  // 字一色 can only be built from pongs, so it absorbs 碰碰胡.
  if (chows.length === 0 && !allHonors) items.push(T('all_pongs', '碰碰胡', 'All Pongs', 4));

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

  // ---- Win method (absorbed by a limit deal) ----
  if (!limitDeal) {
    if (isConcealedHand && ctx.selfDrawn) items.push(T('concealed_self_draw', '門清自摸', 'Concealed Self-Draw', 3));
    else {
      if (isConcealedHand) items.push(T('concealed', '門清', 'Concealed Hand', 1));
      if (ctx.selfDrawn) items.push(T('self_draw', '自摸', 'Self-Draw', 1));
    }
  }
  // 全求人 / 半求人: all five sets exposed (a concealed kong does not count), one tile left in hand.
  const begging = ctx.melds.length === TOTAL_SETS && ctx.concealed.length === 1 && ctx.melds.every((m) => !m.concealed);
  if (begging) {
    if (ctx.selfDrawn) items.push(T('half_begging', '半求人', 'Half Begging (all exposed, self-draw)', 1));
    else items.push(T('full_begging', '全求人', 'Full Begging (all exposed, won by discard)', 2));
  }

  // ---- Wait: 獨聽 means exactly one kind could still win ----
  // A kind is dead only when the player's own tiles (concealed plus own melds) hold all
  // four copies; other players' discards are not considered. The begging hands are
  // always a single wait, so they absorb 獨聽.
  const ownMeldCounts = countsFromKinds(ctx.melds.flatMap((m) => m.tiles.map(kindOf)));
  const liveWaits = waits(concealedCounts, setsNeeded, ownMeldCounts);
  const singleWait = liveWaits.length === 1 && !begging && !limitDeal;
  if (singleWait) items.push(T('single_wait', '獨聽', 'Single Wait', 1));

  // ---- 平胡: all chows, non-honour pair, two-sided wait, no flowers, not self-drawn ----
  if (
    !limitDeal &&
    chows.length === TOTAL_SETS &&
    !isHonorKind(d.pair) &&
    ctx.flowers.length === 0 &&
    !ctx.selfDrawn &&
    isTwoSidedWin(d, ctx.winningTile)
  ) {
    items.push(T('all_chows', '平胡', 'All Chows', 2));
  }

  // ---- Flowers ----
  const seatIndex = (ctx.seat - ctx.dealerSeat + 4) % 4; // 0 = East
  const flowerSet = ctx.flowers.filter((f) => f >= KIND_FLOWER && f < KIND_FLOWER + 4);
  const seasonSet = ctx.flowers.filter((f) => f >= KIND_FLOWER + 4);
  if (flowerSet.length === 4) items.push(T('four_flowers', '花槓（梅蘭竹菊）', 'Four Flowers', 2));
  else if (flowerSet.some((f) => f - KIND_FLOWER === seatIndex)) items.push(T('seat_flower', '正花', 'Seat Flower', 1));
  if (seasonSet.length === 4) items.push(T('four_seasons', '花槓（春夏秋冬）', 'Four Seasons', 2));
  else if (seasonSet.some((f) => f - KIND_FLOWER - 4 === seatIndex)) items.push(T('seat_season', '正季', 'Seat Season', 1));
  if (rules.noFlowerTai && ctx.flowers.length === 0) items.push(T('no_flowers', '無花', 'No Flowers', 1));

  // ---- Situational ----
  if (!limitDeal) {
    if (ctx.afterKong) items.push(T('after_kong', '槓上開花', 'Win on Kong Replacement', 1));
    if (ctx.afterFlower) items.push(T('after_flower', '花上自摸', 'Win on Flower Replacement', 1));
  }
  if (ctx.robbingKong) items.push(T('rob_kong', '搶槓', 'Robbing the Kong', 1));
  if (ctx.lastTile && !limitDeal) items.push(ctx.selfDrawn ? T('last_tile_draw', '海底撈月', 'Last Tile Draw', 1) : T('last_tile_discard', '河底撈魚', 'Last Discard', 1));

  // ---- Dealer (outside the cap) ----
  items.push(...dealerItems(ctx));

  return {
    ...totals(rules, items),
    items,
    decomposition: d,
    concealedSetTypes: d.sets.map((s) => s.type),
  };
}

/**
 * Can the winning tile be read as completing a two-sided (兩面) chow in this
 * decomposition? 平胡 needs one: 單騎, 嵌張 and 邊張 (12 waiting 3, 89 waiting 7)
 * do not count. Every copy of a kind is alike, so any chow holding the winning
 * kind at an open end qualifies.
 */
function isTwoSidedWin(d: Decomposition, win: Kind): boolean {
  for (const s of d.sets) {
    if (s.type !== 'chow') continue;
    if (win === s.kind && rankOfKind(s.kind + 2) !== 9) return true; // e.g. 23 waiting on 1 or 4, won on 1
    if (win === s.kind + 2 && rankOfKind(s.kind) !== 1) return true; // e.g. 45 waiting on 3 or 6, won on 6
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
 * Compute point transfers for a win. `taiWithoutDealer` is the hand's uncapped
 * 台 excluding dealer items; it is capped at `rules.maxTai`, then 莊家 and 連莊 台
 * are added per transaction whenever the dealer pays or wins.
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
  const base = cappedTai(rules, taiWithoutDealer);
  const payments: Payment[] = [];
  const pay = (from: number) => {
    const dealerInvolved = from === dealerSeat || winner === dealerSeat;
    const tai = base + (dealerInvolved ? dealerExtra : 0);
    payments.push({ from, to: winner, tai, points: rules.basePoints + tai * rules.taiPoints });
  };
  if (selfDrawn) {
    for (let s = 0; s < 4; s++) if (s !== winner) pay(s);
  } else if (fromSeat !== undefined) {
    pay(fromSeat);
  }
  return payments;
}
