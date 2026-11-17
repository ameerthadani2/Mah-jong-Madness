/**
 * An independent 台 scorer and settlement, written from docs/RULES.md and not from src/scoring.ts or the
 * hand analysis in src/hand.ts. `test/scoring_oracle.test.ts` runs it against the engine on generated wins.
 *
 * It shares nothing with the engine but the tile numbering (src/tiles.ts): kinds 0..26 are the suited tiles
 * (萬 筒 條, nine each), 27..30 the winds 東南西北, 31..33 the dragons 中發白, 34..37 the flowers 梅蘭竹菊 and
 * 38..41 the seasons 春夏秋冬. Its own decomposition, wait search and item rules are deliberately written
 * differently from the engine's (the winning tile is placed in every slot it could fill, rather than read
 * off the decomposition), so a shared mistake is unlikely.
 */

export type OSet = 'chow' | 'pong' | 'kong';

export interface OMeld {
  type: OSet;
  /** The kind of a pong or kong, or the lowest kind of a chow. */
  kind: number;
  /** A concealed kong (暗槓); every other meld is exposed. */
  concealed: boolean;
}

/** The rule values the payment section and the 台 table of docs/RULES.md refer to. */
export interface ORules {
  basePoints: number;
  taiPoints: number;
  maxTai: number;
  dealerTai: number;
  dealerStreakTai: number;
  noFlowerTai: boolean;
  heavenlyTai: number;
  earthlyTai: number;
  humanlyTai: number;
  liguTai: number;
}

export interface OWin {
  rules: ORules;
  seat: number;
  dealer: number;
  /** 連莊 count: 0 on the dealer's first hand. */
  streak: number;
  /** 0 = 東 round ... 3 = 北 round. */
  prevailing: number;
  /** Concealed kinds without the winning tile. */
  concealed: number[];
  win: number;
  melds: OMeld[];
  flowers: number[];
  selfDrawn: boolean;
  /** Who pays alone when the win is not self-drawn: the discarder, the robbed seat or the 七搶一 victim. */
  fromSeat?: number;
  afterKong?: boolean;
  afterFlower?: boolean;
  robKong?: boolean;
  lastTile?: boolean;
  tianhu?: boolean;
  dihu?: boolean;
  renhu?: boolean;
  flowerWin?: 'eight' | 'sevenRob';
}

export interface OReading {
  /** Items with their 台, dealer items excluded. */
  items: Array<[string, number]>;
  ligu: boolean;
}

export interface OScore {
  /** The hand's own 台 before the cap (dealer items excluded). */
  handTai: number;
  /** 莊家 and 連莊 items, present only when the winner is the dealer. */
  dealerItems: Array<[string, number]>;
  /** 台 shown for the hand: the capped hand 台 plus the dealer items. */
  shown: number;
  /** Every reading that reaches `handTai` (several decompositions can tie). Empty when the hand does not win. */
  readings: OReading[];
}

export interface OPayment {
  from: number;
  to: number;
  tai: number;
  points: number;
}

const SUITED_END = 27;
const PLAY_KINDS = 34;
const suited = (k: number) => k < SUITED_END;
const honour = (k: number) => k >= SUITED_END && k < PLAY_KINDS;
const wind = (k: number) => k >= 27 && k <= 30;
const dragon = (k: number) => k >= 31 && k <= 33;
const suitOf = (k: number) => Math.floor(k / 9);
const rankOf = (k: number) => (k % 9) + 1;

interface HSet {
  type: 'chow' | 'pong';
  kind: number;
}
interface Split {
  pair: number;
  sets: HSet[];
}

function tally(kinds: readonly number[]): number[] {
  const c = new Array<number>(PLAY_KINDS).fill(0);
  for (const k of kinds) c[k]++;
  return c;
}

/** Every way to read `c` (play kinds only) as `n` sets plus a pair. */
function splits(c: number[], n: number): Split[] {
  const out: Split[] = [];
  const sets: HSet[] = [];
  const walk = (pair: number) => {
    let i = 0;
    while (i < PLAY_KINDS && c[i] === 0) i++;
    if (i === PLAY_KINDS) {
      if (sets.length === n) out.push({ pair, sets: sets.slice() });
      return;
    }
    if (sets.length === n) return;
    if (c[i] >= 3) {
      c[i] -= 3;
      sets.push({ type: 'pong', kind: i });
      walk(pair);
      sets.pop();
      c[i] += 3;
    }
    if (suited(i) && rankOf(i) <= 7 && c[i + 1] > 0 && c[i + 2] > 0) {
      c[i]--;
      c[i + 1]--;
      c[i + 2]--;
      sets.push({ type: 'chow', kind: i });
      walk(pair);
      sets.pop();
      c[i]++;
      c[i + 1]++;
      c[i + 2]++;
    }
  };
  for (let p = 0; p < PLAY_KINDS; p++) {
    if (c[p] < 2) continue;
    c[p] -= 2;
    walk(p);
    c[p] += 2;
  }
  return out;
}

/** 嚦咕嚦咕: seven pairs and one triplet, so exactly seven kinds held twice and one held three times. */
function liguShape(c: readonly number[]): boolean {
  let pairs = 0;
  let triplets = 0;
  for (const n of c) {
    if (n === 2) pairs++;
    else if (n === 3) triplets++;
    else if (n !== 0) return false;
  }
  return pairs === 7 && triplets === 1;
}

const meldTiles = (m: OMeld): number[] => (m.type === 'chow' ? [m.kind, m.kind + 1, m.kind + 2] : new Array<number>(m.type === 'kong' ? 4 : 3).fill(m.kind));

/** The kinds that would complete the hand, leaving out kinds whose four copies are all in the player's own tiles. */
export function oracleWaits(w: Pick<OWin, 'concealed' | 'melds' | 'rules'>): number[] {
  const need = 5 - w.melds.length;
  const own = tally([...w.concealed, ...w.melds.flatMap(meldTiles)]);
  const c = tally(w.concealed);
  const out: number[] = [];
  for (let k = 0; k < PLAY_KINDS; k++) {
    if (own[k] >= 4) continue;
    c[k]++;
    const five = splits(c, need).length > 0;
    const ligu = w.rules.liguTai > 0 && w.melds.length === 0 && liguShape(c);
    c[k]--;
    if (five || ligu) out.push(k);
  }
  return out;
}

function limitItem(w: OWin): [string, number] | null {
  if (w.tianhu && w.rules.heavenlyTai > 0) return ['tianhu', w.rules.heavenlyTai];
  if (w.dihu && w.rules.earthlyTai > 0) return ['dihu', w.rules.earthlyTai];
  if (w.renhu && w.rules.humanlyTai > 0) return ['renhu', w.rules.humanlyTai];
  return null;
}

function flushItem(kinds: readonly number[]): [string, number] | null {
  const suits = new Set(kinds.filter(suited).map(suitOf));
  const honours = kinds.some(honour);
  if (suits.size === 0) return ['all_honors', 16];
  if (suits.size === 1) return honours ? ['half_flush', 4] : ['full_flush', 8];
  return null;
}

/** 正花 / 正季 (東1 南2 西3 北4), 花槓 for a whole set (which already holds the seat's own bonus tile), 無花. */
function flowerItems(w: OWin): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  const position = (w.seat - w.dealer + 4) % 4;
  const flowers = w.flowers.filter((f) => f < 38);
  const seasons = w.flowers.filter((f) => f >= 38);
  if (flowers.length === 4) out.push(['four_flowers', 2]);
  else if (flowers.includes(34 + position)) out.push(['seat_flower', 1]);
  if (seasons.length === 4) out.push(['four_seasons', 2]);
  else if (seasons.includes(38 + position)) out.push(['seat_season', 1]);
  if (w.rules.noFlowerTai && w.flowers.length === 0) out.push(['no_flowers', 1]);
  return out;
}

/** 門風 and 圈風 for a wind pong, 中 / 發 / 白 for a dragon pong. */
function valueItems(w: OWin, kind: number, bigDragons: boolean, bigWinds: boolean): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  if (dragon(kind) && !bigDragons) out.push([`dragon_${kind}`, 1]);
  if (wind(kind) && !bigWinds) {
    if (kind === 27 + ((w.seat - w.dealer + 4) % 4)) out.push(['seat_wind', 1]);
    if (kind === 27 + w.prevailing) out.push(['round_wind', 1]);
  }
  return out;
}

/** 槓上開花, 花上自摸, 搶槓, 海底撈月 / 河底撈魚; a limit deal absorbs all but 搶槓. */
function situationItems(w: OWin, limit: boolean): Array<[string, number]> {
  const out: Array<[string, number]> = [];
  if (w.afterKong && !limit) out.push(['after_kong', 1]);
  if (w.afterFlower && !limit) out.push(['after_flower', 1]);
  if (w.robKong) out.push(['rob_kong', 1]);
  if (w.lastTile && !limit) out.push([w.selfDrawn ? 'last_tile_draw' : 'last_tile_discard', 1]);
  return out;
}

/** One five-sets-and-a-pair reading with the winning tile in a given set (`slot` is a set index, or -1 for the pair). */
function fiveSetReading(w: OWin, split: Split, slot: number, liveWaits: number): Array<[string, number]> {
  const items: Array<[string, number]> = [];
  const limit = limitItem(w);
  if (limit) items.push(limit);
  const sets: Array<{ type: 'chow' | 'pong'; kind: number; hidden: boolean }> = [
    ...w.melds.map((m) => ({ type: m.type === 'chow' ? ('chow' as const) : ('pong' as const), kind: m.kind, hidden: m.concealed })),
    // A pong the winning discard completed is not concealed.
    ...split.sets.map((s, i) => ({ type: s.type, kind: s.kind, hidden: !(i === slot && s.type === 'pong' && !w.selfDrawn) })),
  ];
  const pongs = sets.filter((s) => s.type === 'pong');
  const chows = sets.length - pongs.length;
  const kinds = [...w.concealed, w.win, ...w.melds.flatMap(meldTiles)];
  const flush = flushItem(kinds);
  if (flush) items.push(flush);
  const allHonours = flush?.[0] === 'all_honors';
  const windPongs = pongs.filter((s) => wind(s.kind)).length;
  const dragonPongs = pongs.filter((s) => dragon(s.kind)).length;
  if (windPongs === 4) items.push(['big_four_winds', 16]);
  if (windPongs === 3 && wind(split.pair)) items.push(['small_four_winds', 8]);
  if (dragonPongs === 3) items.push(['big_three_dragons', 8]);
  if (dragonPongs === 2 && dragon(split.pair)) items.push(['small_three_dragons', 4]);
  if (chows === 0 && !allHonours) items.push(['all_pongs', 4]);
  const hidden = pongs.filter((s) => s.hidden).length;
  if (hidden >= 3) items.push(hidden === 5 ? ['five_concealed', 8] : hidden === 4 ? ['four_concealed', 5] : ['three_concealed', 2]);
  for (const s of pongs) items.push(...valueItems(w, s.kind, dragonPongs === 3, windPongs === 4));
  const exposed = w.melds.some((m) => !m.concealed);
  if (!limit) {
    if (!exposed && w.selfDrawn) items.push(['concealed_self_draw', 3]);
    if (!exposed && !w.selfDrawn) items.push(['concealed', 1]);
    if (exposed && w.selfDrawn) items.push(['self_draw', 1]);
  }
  const begging = w.melds.length === 5 && !w.melds.some((m) => m.concealed);
  if (begging) items.push(w.selfDrawn ? ['half_begging', 1] : ['full_begging', 2]);
  const single = liveWaits === 1 && !begging && !limit;
  if (single) items.push(['single_wait', 1]);
  if (!limit && !single && chows === 5 && !honour(split.pair) && w.flowers.length === 0 && !w.selfDrawn && slot >= 0) {
    const s = split.sets[slot];
    // Two-sided (兩面): the winning tile is an end of its chow, and the other two tiles were not 12 or 89.
    const twoSided = s.type === 'chow' && ((w.win === s.kind && rankOf(s.kind) !== 7) || (w.win === s.kind + 2 && rankOf(s.kind) !== 1));
    if (twoSided) items.push(['all_chows', 2]);
  }
  items.push(...flowerItems(w));
  items.push(...situationItems(w, limit !== null));
  return items;
}

function liguReading(w: OWin, c: readonly number[]): Array<[string, number]> {
  const items: Array<[string, number]> = [];
  const limit = limitItem(w);
  if (limit) items.push(limit);
  items.push(['ligu', w.rules.liguTai]);
  const flush = flushItem([...w.concealed, w.win]);
  if (flush) items.push(flush);
  items.push(...valueItems(w, c.indexOf(3), false, false));
  if (w.selfDrawn && !limit) items.push(['self_draw', 1]);
  items.push(...flowerItems(w));
  items.push(...situationItems(w, limit !== null));
  return items;
}

const sum = (items: ReadonlyArray<[string, number]>) => items.reduce((a, [, t]) => a + t, 0);

function dealerItems(w: OWin): Array<[string, number]> {
  if (w.seat !== w.dealer) return [];
  const out: Array<[string, number]> = [['dealer', w.rules.dealerTai]];
  if (w.streak > 0) out.push(['dealer_streak', w.rules.dealerStreakTai * w.streak]);
  return out;
}

const capped = (r: ORules, tai: number) => (r.maxTai > 0 ? Math.min(r.maxTai, tai) : tai);

export function oracleScore(w: OWin): OScore {
  const dealer = dealerItems(w);
  const done = (readings: OReading[], handTai: number): OScore => ({ handTai, dealerItems: dealer, shown: capped(w.rules, handTai) + sum(dealer), readings });
  if (w.flowerWin) return done([{ items: [[w.flowerWin === 'eight' ? 'eight_flowers' : 'seven_rob', 8]], ligu: false }], 8);
  const c = tally([...w.concealed, w.win]);
  const live = oracleWaits(w).length;
  let best = -1;
  let readings: OReading[] = [];
  for (const split of splits(c, 5 - w.melds.length)) {
    const slots: number[] = [];
    if (split.pair === w.win) slots.push(-1);
    split.sets.forEach((s, i) => {
      if (s.type === 'pong' ? s.kind === w.win : w.win >= s.kind && w.win <= s.kind + 2) slots.push(i);
    });
    for (const slot of slots) {
      const items = fiveSetReading(w, split, slot, live);
      const t = sum(items);
      if (t > best) {
        best = t;
        readings = [];
      }
      if (t === best) readings.push({ items, ligu: false });
    }
  }
  // Both readings: 嚦咕嚦咕 is kept only when it is strictly better; a tie keeps five sets.
  if (w.rules.liguTai > 0 && w.melds.length === 0 && liguShape(c)) {
    const items = liguReading(w, c);
    const t = sum(items);
    if (t > best) {
      best = t;
      readings = [{ items, ligu: true }];
    }
  }
  return best < 0 ? { handTai: 0, dealerItems: [], shown: 0, readings: [] } : done(readings, best);
}

/**
 * Who pays whom: 自摸 and 八仙過海 are paid by the three others, a discard, a robbed kong and 七搶一 by
 * `fromSeat` alone. Each payment is 底 + 台 × 台值 with the hand's 台 capped at `maxTai`, plus the dealer
 * 台 and 2 per 連莊 (the rule values) outside the cap whenever the dealer pays or wins.
 */
export function oraclePayments(w: OWin, handTai: number): OPayment[] {
  const r = w.rules;
  const payers = w.selfDrawn ? [0, 1, 2, 3].filter((s) => s !== w.seat) : [w.fromSeat!];
  return payers.map((from) => {
    const dealerPart = from === w.dealer || w.seat === w.dealer ? r.dealerTai + r.dealerStreakTai * w.streak : 0;
    const tai = capped(r, handTai) + dealerPart;
    return { from, to: w.seat, tai, points: r.basePoints + tai * r.taiPoints };
  });
}
