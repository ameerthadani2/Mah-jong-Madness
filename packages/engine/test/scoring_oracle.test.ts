/**
 * The engine's 台 scorer and settlement against an independent oracle (`helpers/oracle.ts`, written from
 * docs/RULES.md). Every win is generated from a fixed seed so a failure names a reproducible hand.
 *
 * - 40,000 ordinary wins (self-drawn or on a discard), built to reach every item in the 台 table.
 * - 16,000 win situations: 槓上開花, 花上自摸, 搶槓, 海底撈月 / 河底撈魚, 天胡 / 地胡 / 人胡, 八仙過海 and 七搶一,
 *   alone and with ordinary items, under random rule values (封頂, 莊家 and 連莊 台, 底 and 台值).
 *
 * For each win the engine's items, its shown 台 and its payments (who pays, how many 台, how many points) must
 * equal the oracle's. The settlement is the engine's own: `scoreWin`, then `computePayments` on the hand's 台
 * without the dealer items, as `finishWin` in src/game.ts does. A further 2,000 ordinary wins are played
 * through the game itself (a self-draw, or a win on seat 0's discard), so that glue and the score changes it
 * books are checked too.
 */
import { describe, expect, it } from 'vitest';
import { applyAction, computePayments, DEALER_KEYS, kindsToString, scoreWin, withRules, type GameState, type Meld, type RuleSet, type ScoreResult, type WinContext } from '../src/index';
import { oraclePayments, oracleScore, type OMeld, type OWin } from './helpers/oracle';
import { respond, setup, type SeatSpec } from './helpers/state';
import { timeBound } from './helpers/timing';

/** mulberry32: a small seeded generator, so every run builds the same wins. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)],
  };
}
type Rng = ReturnType<typeof rng>;

type Profile = 'mixed' | 'chows' | 'pongs' | 'half' | 'full' | 'honours' | 'winds' | 'dragons' | 'begging' | 'ligu';

interface Shape {
  concealed: number[];
  win: number;
  melds: OMeld[];
}

/**
 * A winning hand of the given profile: five sets and a pair (or 嚦咕嚦咕), some of the sets exposed as melds,
 * with the winning tile drawn from the concealed part. Null when the random choices run out of tiles.
 */
function buildShape(r: Rng, profile: Profile, meldCount: number, needKong: boolean): Shape | null {
  const count = new Array<number>(34).fill(0);
  const take = (k: number, n: number) => {
    if (count[k] + n > 4) return false;
    count[k] += n;
    return true;
  };
  const suit = r.int(3) * 9;
  const pool: number[] = [];
  for (let k = 0; k < 34; k++) {
    const inSuit = k >= suit && k < suit + 9;
    if (profile === 'half' && !(inSuit || k >= 27)) continue;
    if ((profile === 'full' || profile === 'ligu') && !inSuit) continue;
    if (profile === 'honours' && k < 27) continue;
    if (profile === 'chows' && k >= 27) continue;
    pool.push(k);
  }
  if (profile === 'ligu') {
    // Seven pairs and a triplet, often in one suit so some also read as five sets and a pair.
    const kinds = r.chance(0.5) ? pool.slice() : Array.from({ length: 34 }, (_, k) => k);
    const chosen: number[] = [];
    while (chosen.length < 8) {
      const k = r.pick(kinds);
      if (!chosen.includes(k)) chosen.push(k);
    }
    const tiles = chosen.flatMap((k, i) => (i === 0 ? [k, k, k] : [k, k]));
    const at = r.int(tiles.length);
    return { concealed: tiles.filter((_, i) => i !== at), win: tiles[at], melds: [] };
  }
  const chowShare = profile === 'chows' ? 0.95 : profile === 'pongs' || profile === 'honours' ? 0 : 0.5;
  const sets: Array<{ type: 'chow' | 'pong'; kind: number }> = [];
  if (profile === 'winds' || profile === 'dragons') {
    const kinds = profile === 'winds' ? [27, 28, 29, 30] : [31, 32, 33];
    const forced = profile === 'winds' ? 3 + r.int(2) : 2 + r.int(2);
    for (let i = kinds.length - 1; i > 0; i--) {
      const j = r.int(i + 1);
      [kinds[i], kinds[j]] = [kinds[j], kinds[i]];
    }
    for (const k of kinds.slice(0, forced)) {
      take(k, 3);
      sets.push({ type: 'pong', kind: k });
    }
  }
  let guard = 0;
  while (sets.length < 5 && guard++ < 200) {
    const k = r.pick(pool);
    if (r.chance(chowShare) && k < 27 && k % 9 <= 6 && pool.includes(k + 2)) {
      if (count[k] < 4 && count[k + 1] < 4 && count[k + 2] < 4) {
        count[k]++;
        count[k + 1]++;
        count[k + 2]++;
        sets.push({ type: 'chow', kind: k });
      }
    } else if (take(k, 3)) sets.push({ type: 'pong', kind: k });
  }
  if (sets.length < 5) return null;
  // The pair: in winds and dragons hands often an honour of the same group, for 小四喜 / 小三元.
  let pair = -1;
  for (let g = 0; g < 60 && pair < 0; g++) {
    const k = profile === 'winds' && r.chance(0.5) ? 27 + r.int(4) : profile === 'dragons' && r.chance(0.5) ? 31 + r.int(3) : r.pick(pool);
    if (take(k, 2)) pair = k;
  }
  if (pair < 0) return null;
  // Exposed sets first in a shuffled order; a pong may be shown as a kong when the fourth copy is free.
  for (let i = sets.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [sets[i], sets[j]] = [sets[j], sets[i]];
  }
  const melds: OMeld[] = [];
  for (let i = 0; i < meldCount; i++) {
    const s = sets[i];
    if (s.type === 'chow') {
      melds.push({ type: 'chow', kind: s.kind, concealed: false });
      continue;
    }
    const kong = (needKong && i === 0) || r.chance(0.35);
    if (kong && take(s.kind, 1)) melds.push({ type: 'kong', kind: s.kind, concealed: profile !== 'begging' && r.chance(0.5) });
    else melds.push({ type: 'pong', kind: s.kind, concealed: false });
  }
  if (needKong && melds[0]?.type !== 'kong') return null;
  const hand = [...sets.slice(meldCount).flatMap((s) => (s.type === 'chow' ? [s.kind, s.kind + 1, s.kind + 2] : [s.kind, s.kind, s.kind])), pair, pair];
  const at = r.int(hand.length);
  return { concealed: hand.filter((_, i) => i !== at), win: hand[at], melds };
}

function randomRules(r: Rng, ligu: boolean): RuleSet {
  const limit = () => (r.chance(0.8) ? undefined : r.chance(0.5) ? 0 : 1 + r.int(64));
  return withRules({
    basePoints: r.pick([100, 100, 0, 50, 300, r.int(5001)]),
    taiPoints: r.pick([20, 20, 0, 10, 50, r.int(2001)]),
    maxTai: r.chance(0.5) ? 0 : r.pick([4, 8, 10, 16, 1 + r.int(64)]),
    dealerTai: r.chance(0.7) ? 1 : r.int(9),
    dealerStreakTai: r.chance(0.7) ? 2 : r.int(9),
    noFlowerTai: r.chance(0.25),
    heavenlyTai: limit(),
    earthlyTai: limit(),
    humanlyTai: limit(),
    liguTai: ligu ? 1 + r.int(40) : 0,
  });
}

function randomFlowers(r: Rng): number[] {
  if (r.chance(0.4)) return [];
  const out: number[] = [];
  if (r.chance(0.15)) out.push(...(r.chance(0.5) ? [34, 35, 36, 37] : [38, 39, 40, 41]));
  for (let f = 34; f < 42; f++) if (!out.includes(f) && r.chance(0.3)) out.push(f);
  return out.slice(0, 7);
}

type Situation = 'none' | 'afterKong' | 'afterFlower' | 'robKong' | 'lastDraw' | 'lastDiscard' | 'tianhu' | 'dihu' | 'renhu' | 'eight' | 'sevenRob';

interface Case {
  oracle: OWin;
  engine: WinContext;
  situation: Situation;
}

function toEngineMelds(melds: readonly OMeld[], seat: number): Meld[] {
  const copies = new Map<number, number>();
  const id = (k: number) => {
    const c = copies.get(k) ?? 0;
    copies.set(k, c + 1);
    return k * 4 + c;
  };
  return melds.map((m) => ({
    type: m.type,
    tiles: m.type === 'chow' ? [id(m.kind), id(m.kind + 1), id(m.kind + 2)] : Array.from({ length: m.type === 'kong' ? 4 : 3 }, () => id(m.kind)),
    concealed: m.concealed,
    from: m.concealed ? undefined : (seat + 3) % 4,
  }));
}

const PROFILES: Profile[] = ['mixed', 'mixed', 'mixed', 'chows', 'chows', 'pongs', 'pongs', 'half', 'full', 'honours', 'winds', 'dragons', 'begging'];
const MELDS = [0, 0, 0, 0, 1, 1, 2, 3, 4, 5];

/** One generated win; `situation` 'none' is an ordinary self-draw or discard win. */
function generate(r: Rng, situation: Situation): Case | null {
  const limitDeal = situation === 'tianhu' || situation === 'dihu' || situation === 'renhu';
  const ligu = r.chance(0.3);
  const rules = randomRules(r, ligu);
  let profile = r.pick(PROFILES);
  if (ligu && r.chance(0.35)) profile = 'ligu';
  const meldCount = profile === 'begging' ? 5 : profile === 'ligu' || limitDeal ? 0 : situation === 'afterKong' ? 1 + r.int(5) : r.pick(MELDS);
  const shape = buildShape(r, profile, meldCount, situation === 'afterKong');
  if (!shape) return null;
  const dealer = r.int(4);
  let seat = r.int(4);
  if (situation === 'tianhu') seat = dealer;
  if ((situation === 'dihu' || situation === 'renhu') && seat === dealer) seat = (dealer + 1 + r.int(3)) % 4;
  let selfDrawn = r.chance(0.5);
  if (['afterKong', 'afterFlower', 'lastDraw', 'tianhu', 'dihu', 'eight'].includes(situation)) selfDrawn = true;
  if (['robKong', 'lastDiscard', 'renhu', 'sevenRob'].includes(situation)) selfDrawn = false;
  let fromSeat = selfDrawn ? undefined : (seat + 1 + r.int(3)) % 4;
  if (situation === 'renhu') fromSeat = dealer;
  // 平胡 needs a hand without flowers, so the chow-heavy hands mostly have none.
  let flowers = profile === 'chows' && r.chance(0.7) ? [] : randomFlowers(r);
  if (situation === 'afterFlower' && flowers.length === 0) flowers = [34 + r.int(8)];
  if (situation === 'eight' || situation === 'sevenRob') flowers = [34, 35, 36, 37, 38, 39, 40, 41];
  // 搶槓: the robbed tile is the fourth copy of another player's pong, so the hand holds no other copy.
  if (situation === 'robKong') {
    const all = [...shape.concealed, shape.win, ...shape.melds.flatMap((m) => (m.type === 'chow' ? [m.kind, m.kind + 1, m.kind + 2] : [m.kind]))];
    if (all.filter((k) => k === shape.win).length !== 1) return null;
  }
  const flowerWin = situation === 'eight' ? 'eight' : situation === 'sevenRob' ? 'sevenRob' : undefined;
  // A flower drawn from the back may end the wall too, and the dealer's or a first draw may follow a flower.
  const afterFlower = situation === 'afterFlower' || ((situation === 'tianhu' || situation === 'dihu') && flowers.length > 0 && r.chance(0.4));
  const lastTile = situation === 'lastDraw' || situation === 'lastDiscard' || ((situation === 'afterKong' || situation === 'afterFlower') && r.chance(0.3));
  const oracle: OWin = {
    rules,
    seat,
    dealer,
    streak: r.chance(0.5) ? 0 : 1 + r.int(6),
    prevailing: r.int(4),
    concealed: shape.concealed,
    win: flowerWin ? r.pick(flowers) : shape.win,
    melds: shape.melds,
    flowers,
    selfDrawn,
    fromSeat,
    afterKong: situation === 'afterKong',
    afterFlower,
    robKong: situation === 'robKong',
    lastTile,
    tianhu: situation === 'tianhu',
    dihu: situation === 'dihu',
    renhu: situation === 'renhu',
    flowerWin,
  };
  const engine: WinContext = {
    rules,
    seat,
    dealerSeat: dealer,
    dealerStreak: oracle.streak,
    prevailingWind: oracle.prevailing,
    concealed: shape.concealed,
    melds: toEngineMelds(shape.melds, seat),
    flowers,
    winningTile: oracle.win,
    selfDrawn,
    fromSeat,
    afterKong: oracle.afterKong,
    afterFlower,
    robbingKong: oracle.robKong,
    lastTile,
    heavenlyHand: oracle.tianhu,
    earthlyHand: oracle.dihu,
    humanlyHand: oracle.renhu,
    flowerWin,
  };
  return { oracle, engine, situation };
}

const line = (items: ReadonlyArray<[string, number]>) =>
  items
    .map(([k, t]) => `${k}:${t}`)
    .sort()
    .join(' ');

/** The engine's items as `key:tai`, sorted. */
const engineLine = (s: ScoreResult) => line(s.items.map((i): [string, number] => [i.key, i.tai]));

interface Tally {
  cases: number;
  items: Map<string, number>;
  situations: Map<string, number>;
  capped: number;
  cappedDealerStreak: number;
  failures: string[];
}

/** Score and settle one case both ways; a difference is recorded with the hand that produced it. */
function check(c: Case, t: Tally): void {
  const o = c.oracle;
  const expected = oracleScore(o);
  const score = scoreWin(c.engine);
  const taiWithoutDealer = score.items.filter((i) => !DEALER_KEYS.has(i.key)).reduce((a, i) => a + i.tai, 0);
  const payments = computePayments(c.engine.rules, o.seat, o.dealer, o.streak, taiWithoutDealer, o.selfDrawn, o.fromSeat);
  const got = engineLine(score);
  const options = expected.readings.map((rd) => line([...rd.items, ...expected.dealerItems]));
  const want = oraclePayments(o, expected.handTai);
  const problems: string[] = [];
  if (!options.includes(got)) problems.push(`items engine [${got}] oracle ${options.map((x) => `[${x}]`).join(' or ')}`);
  if (score.tai !== expected.shown) problems.push(`shown 台 engine ${score.tai} oracle ${expected.shown}`);
  if (Boolean(score.ligu) !== Boolean(expected.readings[0]?.ligu)) problems.push(`嚦咕 reading engine ${Boolean(score.ligu)}`);
  if ((score.flowerWin ?? null) !== (o.flowerWin ?? null)) problems.push(`flowerWin engine ${score.flowerWin}`);
  const streakItem = score.items.find((i) => i.key === 'dealer_streak');
  if (streakItem && streakItem.nameZh !== `連${o.streak}拉${o.streak}`) problems.push(`streak name ${streakItem.nameZh}`);
  if (JSON.stringify(payments) !== JSON.stringify(want)) problems.push(`payments engine ${JSON.stringify(payments)} oracle ${JSON.stringify(want)}`);
  t.cases++;
  t.situations.set(c.situation, (t.situations.get(c.situation) ?? 0) + 1);
  for (const i of score.items) t.items.set(i.key, (t.items.get(i.key) ?? 0) + 1);
  if (o.rules.maxTai > 0 && expected.handTai > o.rules.maxTai) {
    t.capped++;
    if (expected.dealerItems.some(([k, v]) => k === 'dealer_streak' && v > 0)) t.cappedDealerStreak++;
  }
  if (problems.length > 0 && t.failures.length < 10) {
    const { rules, ...rest } = o;
    t.failures.push(
      `${c.situation} hand ${kindsToString(o.concealed)} + ${o.win} melds ${JSON.stringify(o.melds)} ${JSON.stringify({ ...rest, concealed: undefined, melds: undefined })} rules ${JSON.stringify({ maxTai: rules.maxTai, dealerTai: rules.dealerTai, dealerStreakTai: rules.dealerStreakTai, liguTai: rules.liguTai, noFlowerTai: rules.noFlowerTai, limits: [rules.heavenlyTai, rules.earthlyTai, rules.humanlyTai] })}: ${problems.join('; ')}`,
    );
  }
}

function run(seed: number, n: number, situations: readonly Situation[]): Tally {
  const r = rng(seed);
  const t: Tally = { cases: 0, items: new Map(), situations: new Map(), capped: 0, cappedDealerStreak: 0, failures: [] };
  for (let i = 0; t.cases < n; ) {
    const c = generate(r, situations[i % situations.length]);
    if (!c) continue;
    check(c, t);
    i++;
  }
  return t;
}

const code = (k: number) => kindsToString([k]);
const meldSpec = (m: OMeld) => ({
  type: m.type,
  tiles: kindsToString(m.type === 'chow' ? [m.kind, m.kind + 1, m.kind + 2] : new Array<number>(m.type === 'kong' ? 4 : 3).fill(m.kind)),
  concealed: m.concealed,
});

/**
 * Play an ordinary win through the game itself: seat 0 self-draws it, or discards the winning tile to the
 * winner. The table's own bookkeeping (no limit deal, no replacement tile, not the last tile) matches 'none'.
 */
function playThrough(c: Case): GameState {
  const o = c.oracle;
  const winner: SeatSpec = { hand: o.selfDrawn ? `${kindsToString(o.concealed)} ${code(o.win)}` : kindsToString(o.concealed), melds: o.melds.map(meldSpec), flowers: kindsToString(o.flowers) };
  const seats: Array<string | SeatSpec> = ['', '', '', ''];
  if (o.selfDrawn) seats[0] = winner;
  else {
    // Seat 0 holds the winning tile and sixteen tiles nobody else needs, and discards the winning tile.
    const used = new Array<number>(34).fill(0);
    for (const k of [...o.concealed, o.win, ...o.melds.flatMap((m) => (m.type === 'chow' ? [m.kind, m.kind + 1, m.kind + 2] : new Array<number>(m.type === 'kong' ? 4 : 3).fill(m.kind)))]) used[k]++;
    const filler: number[] = [];
    for (let k = 0; filler.length < 16; k = (k + 7) % 34) {
      if (used[k] >= 4) continue;
      used[k]++;
      filler.push(k);
    }
    seats[0] = `${kindsToString(filler)} ${code(o.win)}`;
    seats[o.seat] = winner;
  }
  let s = setup(c.engine.rules, seats, 20);
  s.dealerSeat = o.dealer;
  s.dealerStreak = o.streak;
  s.prevailingWind = o.prevailing;
  if (o.selfDrawn) return applyAction(s, 0, { type: 'hu' });
  s = applyAction(s, 0, { type: 'discard', tile: s.players[0].hand[16] });
  return respond(s, { [o.seat]: { type: 'hu' } });
}

describe('scoring oracle (independent re-implementation of docs/RULES.md)', () => {
  it(
    'agrees with the engine on 40,000 ordinary wins that reach every item of the 台 table',
    () => {
      const started = Date.now();
      const t = run(20261117, 40_000, ['none']);
      const ms = Date.now() - started;
      expect(t.failures).toEqual([]);
      expect(t.cases).toBe(40_000);
      // Every ordinary item of the 台 table, a few hundred times at least.
      const ordinary = [
        'self_draw', 'concealed', 'concealed_self_draw', 'single_wait', 'all_chows', 'all_pongs', 'half_flush', 'full_flush', 'all_honors',
        'small_three_dragons', 'big_three_dragons', 'small_four_winds', 'big_four_winds', 'three_concealed', 'four_concealed', 'five_concealed',
        'dragon_31', 'dragon_32', 'dragon_33', 'seat_wind', 'round_wind', 'seat_flower', 'seat_season', 'four_flowers', 'four_seasons',
        'full_begging', 'half_begging', 'no_flowers', 'ligu', 'dealer', 'dealer_streak',
      ];
      expect(ordinary.filter((key) => (t.items.get(key) ?? 0) < 200)).toEqual([]);
      expect(t.capped).toBeGreaterThan(1000);
      expect(ms).toBeLessThan(timeBound(20_000));
    },
    timeBound(30_000),
  );

  it(
    'agrees on 16,000 win situations, flower wins and dealer-streak settlements, alone and with ordinary items and the cap',
    () => {
      const situations: Situation[] = ['afterKong', 'afterFlower', 'robKong', 'lastDraw', 'lastDiscard', 'tianhu', 'dihu', 'renhu', 'eight', 'sevenRob'];
      const started = Date.now();
      const t = run(1117, 16_000, situations);
      const ms = Date.now() - started;
      expect(t.failures).toEqual([]);
      expect(situations.filter((s) => (t.situations.get(s) ?? 0) < 1000)).toEqual([]);
      const items = ['after_kong', 'after_flower', 'rob_kong', 'last_tile_draw', 'last_tile_discard', 'tianhu', 'dihu', 'renhu', 'eight_flowers', 'seven_rob', 'dealer', 'dealer_streak'];
      expect(items.filter((key) => (t.items.get(key) ?? 0) < 300)).toEqual([]);
      // The cap is hit with a dealer streak on top, so 連莊 台 outside the cap are exercised.
      expect(t.cappedDealerStreak).toBeGreaterThan(300);
      expect(ms).toBeLessThan(timeBound(15_000));
    },
    timeBound(30_000),
  );

  it(
    'agrees with 2,000 wins played through the game, payments and score changes included',
    () => {
      const r = rng(4242);
      let played = 0;
      const failures: string[] = [];
      while (played < 2_000) {
        const c = generate(r, 'none');
        if (!c) continue;
        const o = c.oracle;
        // The self-drawn winner is seat 0; a discard win is on seat 0's discard.
        if (o.selfDrawn) o.seat = c.engine.seat = 0;
        else if (o.seat === 0) continue;
        else o.fromSeat = c.engine.fromSeat = 0;
        const s = playThrough(c);
        const want = oracleScore(o);
        const win = s.result?.type === 'win' ? s.result.wins : [];
        const payments = oraclePayments(o, want.handTai);
        const delta = [0, 0, 0, 0];
        for (const p of payments) {
          delta[p.from] -= p.points;
          delta[p.to] += p.points;
        }
        const got = win.length === 1 ? engineLine(win[0].score) : 'no win';
        const ok =
          win.length === 1 &&
          want.readings.some((rd) => line([...rd.items, ...want.dealerItems]) === got) &&
          JSON.stringify(win[0].payments) === JSON.stringify(payments) &&
          s.result?.type === 'win' &&
          s.result.scoreDelta.every((d, i) => d === delta[i]);
        if (!ok && failures.length < 5) failures.push(`${kindsToString(o.concealed)} + ${o.win} melds ${JSON.stringify(o.melds)} seat ${o.seat} dealer ${o.dealer}: engine ${got} ${JSON.stringify(win[0]?.payments)}`);
        played++;
      }
      expect(failures).toEqual([]);
    },
    timeBound(30_000),
  );
});
