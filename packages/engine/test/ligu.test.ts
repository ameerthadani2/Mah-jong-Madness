/**
 * 嚦咕嚦咕 (seven pairs and a triplet), the optional table rule `liguTai`: the shape, its scoring
 * and combinations, its waits, and whole hands played through `applyAction`.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  countsFromKinds,
  hintFor,
  DEFAULT_RULES,
  isLiguShape,
  isWinningHand,
  kindFromCode,
  kindOf,
  kindsFromString,
  scoreWin,
  waits,
  waitsFor,
  withRules,
  type GameState,
  type RuleSet,
  type WinContext,
} from '../src/index';
import { dealt, discard, keysOf, nonDiscard, offers, respond, setup, tileTotal } from './helpers/state';

const c = (s: string) => countsFromKinds(kindsFromString(s));
const kinds = (s: string) => kindsFromString(s).sort((a, b) => a - b);
const ON = withRules({ liguTai: 8 });

/** Eight pairs: waits on any of its eight kinds to make the triplet. */
const EIGHT_PAIRS = '11m 22m 33p 55p 77s 99s 44s EE';
/** Six pairs, a triplet and a single: waits on the single. */
const SINGLE = '11m 22m 33p 55p 77s 99s 444s E';

function ctx(over: Partial<WinContext> & { rules?: RuleSet } = {}): WinContext {
  return {
    rules: ON,
    seat: 1,
    dealerSeat: 0,
    dealerStreak: 0,
    prevailingWind: 0,
    concealed: kindsFromString(EIGHT_PAIRS),
    melds: [],
    flowers: [],
    winningTile: kindFromCode('4s'),
    selfDrawn: false,
    fromSeat: 0,
    ...over,
  };
}

describe('嚦咕嚦咕: the shape', () => {
  it('seven pairs and a triplet win with the rule on and never with it off', () => {
    const hand = c(`${EIGHT_PAIRS} 4s`);
    expect(isLiguShape(hand, 5)).toBe(true);
    expect(isWinningHand(hand, 5, true)).toBe(true);
    expect(isWinningHand(hand, 5, false)).toBe(false);
    // A normal hand still wins either way.
    expect(isWinningHand(c('123m 456m 789p 234s EEE CC'), 5, true)).toBe(true);
    expect(isWinningHand(c('123m 456m 789p 234s EEE CC'), 5, false)).toBe(true);
  });

  it('any chi, pong or kong (a concealed kong too) makes it impossible', () => {
    // Fourteen concealed tiles beside one meld: four sets and a pair are needed, never 嚦咕嚦咕.
    expect(isLiguShape(c('11m 22m 33p 55p 77s 99s EE'), 4)).toBe(false);
    expect(isWinningHand(c('11m 22m 33p 55p 77s 99s EE'), 4, true)).toBe(false);
    const melded = scoreWin(ctx({ concealed: kindsFromString('11m 22m 33p 55p 77s 99s E'), winningTile: kindFromCode('E'), melds: [{ type: 'kong', tiles: [100, 101, 102, 103], concealed: true }] }));
    expect(melded.items).toEqual([]);
  });

  it('four identical tiles are never two pairs', () => {
    // 1111m 22m 33p 55p 77s 999s EE would be seven pairs and a triplet if the four 1m were two pairs.
    const hand = c('1111m 22m 33p 55p 77s 999s EE');
    expect(isLiguShape(hand, 5)).toBe(false);
    expect(isWinningHand(hand, 5, true)).toBe(false);
    // Nor eight pairs with no triplet, nor two triplets.
    expect(isLiguShape(c('11m 22m 33p 55p 77s 99s 44s EE 6p'), 5)).toBe(false);
    expect(isLiguShape(c('11m 22m 33p 55p 77s 99s 444s EEE'), 5)).toBe(false);
  });
});

describe('嚦咕嚦咕: scoring', () => {
  it('scores liguTai, which includes 門清, with no 門清, wait or shape items; nothing with the rule off', () => {
    const r = scoreWin(ctx());
    expect(keysOf(r)).toEqual(['ligu']);
    expect(r.items[0]).toMatchObject({ key: 'ligu', nameZh: '嚦咕嚦咕', nameEn: 'Seven Pairs and a Triplet', tai: 8 });
    expect(r.tai).toBe(8);
    expect(r.ligu).toBe(true);
    expect(r.decomposition).toBeNull();
    const off = scoreWin(ctx({ rules: DEFAULT_RULES }));
    expect([off.tai, off.items]).toEqual([0, []]);
  });

  it('a self-draw adds the ordinary 自摸 1 台, never 門清自摸', () => {
    const r = scoreWin(ctx({ selfDrawn: true, fromSeat: undefined }));
    expect(keysOf(r)).toEqual(['ligu', 'self_draw']);
    expect(r.tai).toBe(9);
  });

  it('takes no 單吊 / 獨聽 on a single wait', () => {
    const r = scoreWin(ctx({ concealed: kindsFromString(SINGLE), winningTile: kindFromCode('E') }));
    expect(keysOf(r)).toEqual(['ligu']);
  });

  it('combines with 混一色 and 清一色', () => {
    const half = scoreWin(ctx({ concealed: kindsFromString('11m 22m 33m 55m 77m 99m 44m EE'), winningTile: kindFromCode('4m') }));
    expect(keysOf(half)).toEqual(['half_flush', 'ligu']);
    expect(half.tai).toBe(12);
    const full = scoreWin(ctx({ concealed: kindsFromString('11m 22m 33m 55m 66m 99m 44m 88m'), winningTile: kindFromCode('4m') }));
    expect(keysOf(full)).toContain('full_flush');
    expect(full.ligu).toBe(true);
  });

  it('adds its triplet\'s 台 when it is a dragon or a value wind, and nothing for another wind', () => {
    const dragon = scoreWin(ctx({ concealed: kindsFromString('11m 22m 33p 55p 77s 99s EE CC'), winningTile: kindFromCode('C') }));
    expect(dragon.tai).toBe(9);
    expect(dragon.items.map((i) => i.nameZh)).toContain('中');
    // Seat 1 is South; in the South round a South triplet is both 門風 and 圈風.
    const south = ctx({ concealed: kindsFromString('11m 22m 33p 55p 77s 99s EE SS'), winningTile: kindFromCode('S') });
    expect(keysOf(scoreWin({ ...south, prevailingWind: 1 }))).toEqual(['ligu', 'round_wind', 'seat_wind']);
    expect(keysOf(scoreWin(south))).toEqual(['ligu', 'seat_wind']);
    const north = scoreWin(ctx({ concealed: kindsFromString('11m 22m 33p 55p 77s 99s EE NN'), winningTile: kindFromCode('N') }));
    expect(keysOf(north)).toEqual(['ligu']);
  });

  it('adds 莊家 and the dealer streak, flowers, 海底撈月 / 河底撈魚 and 搶槓', () => {
    const dealer = scoreWin(ctx({ seat: 0, dealerStreak: 2, fromSeat: 1 }));
    expect(keysOf(dealer)).toEqual(['dealer', 'dealer_streak', 'ligu']);
    expect(dealer.tai).toBe(8 + 1 + 4);
    const flowers = scoreWin(ctx({ flowers: kindsFromString('f2 f6') }));
    expect(keysOf(flowers)).toEqual(['ligu', 'seat_flower', 'seat_season']);
    expect(keysOf(scoreWin(ctx({ lastTile: true })))).toEqual(['last_tile_discard', 'ligu']);
    expect(keysOf(scoreWin(ctx({ lastTile: true, selfDrawn: true, fromSeat: undefined })))).toEqual(['last_tile_draw', 'ligu', 'self_draw']);
    expect(keysOf(scoreWin(ctx({ robbingKong: true })))).toEqual(['ligu', 'rob_kong']);
    expect(keysOf(scoreWin(ctx({ rules: withRules({ liguTai: 8, noFlowerTai: true }) })))).toEqual(['ligu', 'no_flowers']);
  });

  it('天胡 / 地胡 / 人胡 add to it and absorb the 自摸 and 海底, as they do for any hand', () => {
    const heavenly = scoreWin(ctx({ seat: 0, selfDrawn: true, fromSeat: undefined, heavenlyHand: true, lastTile: true }));
    expect(keysOf(heavenly)).toEqual(['dealer', 'ligu', 'tianhu']);
    expect(heavenly.tai).toBe(24 + 8 + 1);
    const earthly = scoreWin(ctx({ selfDrawn: true, fromSeat: undefined, earthlyHand: true }));
    expect(keysOf(earthly)).toEqual(['dihu', 'ligu']);
    const humanly = scoreWin(ctx({ humanlyHand: true }));
    expect(keysOf(humanly)).toEqual(['ligu', 'renhu']);
    expect(humanly.tai).toBe(16 + 8);
  });

  it('maxTai caps it like any hand, with the dealer items outside the cap', () => {
    const rules = withRules({ liguTai: 16, maxTai: 10 });
    const r = scoreWin(ctx({ rules, seat: 0, fromSeat: 1, concealed: kindsFromString('11m 22m 33m 55m 77m 99m 44m EE'), winningTile: kindFromCode('4m') }));
    expect(keysOf(r)).toEqual(['dealer', 'half_flush', 'ligu']);
    expect(r.taiUncapped).toBe(16 + 4 + 1);
    expect(r.tai).toBe(10 + 1);
  });

  it('a hand that is also five sets and a pair scores the better reading (a tie keeps five sets)', () => {
    // 11 22 33 444 55 77 88 99m: 123 123 444 789 789 + 55, or seven pairs and the 444 triplet.
    const both = ctx({ concealed: kindsFromString('11m 22m 33m 44m 55m 77m 88m 99m'), winningTile: kindFromCode('4m') });
    const normalOnly = scoreWin({ ...both, rules: DEFAULT_RULES });
    expect(normalOnly.decomposition).not.toBeNull();
    const big = scoreWin({ ...both, rules: withRules({ liguTai: 16 }) });
    expect(big.ligu).toBe(true);
    expect(big.tai).toBe(16 + 8);
    expect(big.tai).toBeGreaterThan(normalOnly.tai);
    // With liguTai 1 the 嚦咕嚦咕 reading (1 + 清一色 8) does not beat the five-set reading.
    const small = scoreWin({ ...both, rules: withRules({ liguTai: 1 }) });
    expect(small.ligu).toBeUndefined();
    expect(small.decomposition).not.toBeNull();
    expect(small.tai).toBeGreaterThanOrEqual(9);
  });
});

describe('嚦咕嚦咕: waits', () => {
  it('eight pairs wait on all eight kinds to become the triplet', () => {
    expect(waits(c(EIGHT_PAIRS), 5, undefined, true).sort((a, b) => a - b)).toEqual(kinds('1m 2m 3p 5p 7s 9s 4s E'));
    expect(waits(c(EIGHT_PAIRS), 5)).toEqual([]);
  });

  it('six pairs, a triplet and a single wait on the single', () => {
    expect(waits(c(SINGLE), 5, undefined, true)).toEqual(kinds('E'));
    expect(waits(c(SINGLE), 5)).toEqual([]);
  });

  it('adds 嚦咕嚦咕 waits to a normal hand\'s waits only with the rule on', () => {
    // 11 22 33 44 55 66 77 88m waits on six kinds as five sets and a pair, and on all eight as eight pairs.
    const hand = c('11m 22m 33m 44m 55m 66m 77m 88m');
    expect(waits(hand, 5)).toEqual(kinds('1m 2m 4m 5m 7m 8m'));
    expect(waits(hand, 5, undefined, true)).toEqual(kinds('1m 2m 3m 4m 5m 6m 7m 8m'));
    // A normal ready hand gains nothing.
    expect(waits(c('123m 456m 789p 234s EEE C'), 5, undefined, true)).toEqual(kinds('C'));
  });
});

describe('嚦咕嚦咕: the coach', () => {
  it('says ready and lists the waits for a hand ready only for 嚦咕嚦咕, and only with the rule on', () => {
    for (const liguTai of [8, 0]) {
      // Seat 1 holds eight pairs while the dealer is to discard.
      const s = setup({ liguTai }, ['123m 456m 789m 123p 56p 9p S W', EIGHT_PAIRS, '', ''], 20);
      const h = hintFor(s, 1);
      if (liguTai) {
        expect(h.shanten).toBe(0);
        expect(h.waits.map((w) => w.kind).sort((a, b) => a - b)).toEqual(kinds('1m 2m 3p 5p 7s 9s 4s E'));
        expect(h.statusKey).toBe('hint.status.readyWaits');
      } else {
        expect(h.shanten).toBeGreaterThan(0);
        expect(h.waits).toEqual([]);
        expect(h.statusKey).not.toBe('hint.status.readyWaits');
      }
    }
  });

  it('on its own turn, a discard that leaves 嚦咕嚦咕 ready reads as ready, with its waits', () => {
    // Seat 0 holds eight pairs and a stray North: throwing the North leaves eight pairs.
    for (const liguTai of [8, 0]) {
      const s = setup({ liguTai }, [`${EIGHT_PAIRS} N`, '', '', ''], 20);
      const h = hintFor(s, 0);
      expect(kindOf(h.bestDiscard!.tile)).toBe(kindFromCode('N'));
      if (liguTai) {
        expect(h.statusKey).toBe('hint.status.readyAfterDiscard');
        expect(h.waits).toHaveLength(8);
      } else {
        expect(h.statusKey).not.toBe('hint.status.readyAfterDiscard');
        expect(h.waits).toEqual([]);
      }
    }
  });
});

/** Fillers for the other seats that share no kind with the 嚦咕嚦咕 hands below. */
const F1 = '678m 678p 123s 568s SWN B';
const F2 = '678m 678p 123s 568s SWN B';
const DEALER = '345m 349p 6s 8s CFB 2p 6p 1p W N';

function onlyWin(s: GameState) {
  expect(s.phase).toBe('ended');
  expect(s.result?.type).toBe('win');
  return s.result!.wins[0];
}

describe('嚦咕嚦咕 through the game', () => {
  it('wins by self-draw: offered only with the rule on, scored and settled zero-sum', () => {
    for (const rules of [{ liguTai: 8 }, {}]) {
      let s = setup(rules, ['123m 456m 789m 123p 56p 9p S W', EIGHT_PAIRS, '', ''], 20, { front: ['4s'] });
      s = discard(s, 0, '9p');
      if (s.phase === 'claim') s = respond(s);
      expect(s.turn).toBe(1);
      const hu = nonDiscard(s, 1).some((a) => a.type === 'hu');
      expect(hu).toBe(rules.liguTai === 8);
      if (!hu) continue;
      s = applyAction(s, 1, { type: 'hu' });
      const w = onlyWin(s);
      expect(w.seat).toBe(1);
      expect(w.selfDrawn).toBe(true);
      expect(keysOf(w.score)).toEqual(['ligu', 'self_draw']);
      expect(w.payments.map((p) => [p.from, p.tai])).toEqual([
        [0, 9 + 1],
        [2, 9],
        [3, 9],
      ]);
      expect(s.result!.scoreDelta.reduce((a, b) => a + b, 0)).toBe(0);
    }
  });

  it('wins on a discard, and the waits are listed with the rule on', () => {
    for (const rules of [{ liguTai: 8 }, {}]) {
      let s = setup(rules, ['123m 456m 789m 123p 56p 9p S E', '', SINGLE, ''], 20);
      expect(waitsFor(s, 2)).toEqual(rules.liguTai ? kinds('E') : []);
      s = discard(s, 0, 'E');
      if (!rules.liguTai) {
        expect(offers(s)[2]?.hu ?? false).toBe(false);
        continue;
      }
      expect(offers(s)[2]).toMatchObject({ hu: true });
      s = respond(s, { 2: { type: 'hu' } });
      const w = onlyWin(s);
      expect([w.seat, w.selfDrawn, w.fromSeat]).toEqual([2, false, 0]);
      expect(keysOf(w.score)).toEqual(['ligu']);
      expect(w.payments).toEqual([{ from: 0, to: 2, tai: 8 + 1, points: 100 + 9 * 20 }]);
      expect(w.hand).toHaveLength(17);
    }
  });

  it('a first-round win (地胡) from a real deal adds to 嚦咕嚦咕', () => {
    let s = dealt({ liguTai: 8 }, [DEALER, EIGHT_PAIRS, F1, F2], { front: ['9m', '4s'] });
    s = discard(s, 0, '9m');
    if (s.phase === 'claim') s = respond(s);
    expect(s.turn).toBe(1);
    s = applyAction(s, 1, { type: 'hu' });
    const w = onlyWin(s);
    expect(keysOf(w.score)).toEqual(['dihu', 'ligu']);
    expect(w.score.tai).toBe(16 + 8);
    expect(tileTotal(s)).toBe(144);
  });
});
