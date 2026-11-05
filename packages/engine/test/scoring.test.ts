import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, kindFromCode, kindsFromString, scoreWin, computePayments, withRules, type WinContext, type Meld } from '../src/index';

function ctx(partial: Omit<Partial<WinContext>, 'concealed'> & { concealed: string; win: string }): WinContext {
  const { concealed, win, ...rest } = partial;
  return {
    rules: DEFAULT_RULES,
    seat: 1,
    dealerSeat: 0,
    dealerStreak: 0,
    prevailingWind: 0,
    concealed: kindsFromString(concealed),
    melds: [],
    flowers: [],
    winningTile: kindFromCode(win),
    selfDrawn: false,
    fromSeat: 2,
    ...rest,
  };
}

const keys = (r: ReturnType<typeof scoreWin>) => r.items.map((i) => i.key).sort();

function pongMeld(code: string, concealed = false): Meld {
  const k = kindFromCode(code);
  return { type: 'pong', tiles: [k * 4, k * 4 + 1, k * 4 + 2], concealed, from: 2 };
}
function chowMeld(code: string): Meld {
  const k = kindFromCode(code);
  return { type: 'chow', tiles: [k * 4, (k + 1) * 4, (k + 2) * 4], concealed: false, from: 2 };
}
function kongMeld(code: string, concealed: boolean): Meld {
  const k = kindFromCode(code);
  return { type: 'kong', tiles: [k * 4, k * 4 + 1, k * 4 + 2, k * 4 + 3], concealed, from: concealed ? undefined : 2 };
}

describe('台 scoring', () => {
  it('門清 + 平胡 on a two-sided wait by discard', () => {
    const r = scoreWin(ctx({ concealed: '123m 456m 789p 45s 678s 22p', win: '3s' }));
    expect(keys(r)).toEqual(['all_chows', 'concealed']);
    expect(r.tai).toBe(3);
  });
  it('平胡 is denied on a single wait, which scores 獨聽 instead', () => {
    const r = scoreWin(ctx({ concealed: '123m 456m 789p 234s 678s 2p', win: '2p' }));
    expect(keys(r)).toEqual(['concealed', 'single_wait']);
  });
  it('a two-sided shape whose other side is dead counts 獨聽, not 平胡 as well', () => {
    // From the engine review probe (score2): 45m waits on 3m or 6m, but the player's own tiles hold
    // all four 3m (three in exposed chows, one concealed), so only 6m is live.
    const chow = (code: string, copy: number): Meld => {
      const k = kindFromCode(code);
      return { type: 'chow', tiles: [k * 4 + copy, (k + 1) * 4 + copy, (k + 2) * 4 + copy], concealed: false, from: 2 };
    };
    const dead = scoreWin(ctx({ concealed: '34545m 22p', win: '6m', melds: [chow('1m', 0), chow('2m', 1), chow('3m', 2)] }));
    expect(keys(dead)).toEqual(['single_wait']);
    expect(dead.tai).toBe(1);
    // The same shape with 3m live is a plain two-sided wait: 平胡 and no 獨聽.
    const live = scoreWin(ctx({ concealed: '34545m 22p', win: '6m', melds: [chow('1p', 0), chow('2s', 1), chow('3s', 2)] }));
    expect(keys(live)).toEqual(['all_chows']);
  });
  it('門清自摸 is 3 台 and excludes 平胡', () => {
    const r = scoreWin(ctx({ concealed: '123m 456m 789p 45s 678s 22p', win: '3s', selfDrawn: true, fromSeat: undefined }));
    expect(keys(r)).toEqual(['concealed_self_draw']);
    expect(r.tai).toBe(3);
  });
  it('碰碰胡 with concealed pongs', () => {
    const r = scoreWin(ctx({ concealed: '111m 444p 777s 999s EEE 5m', win: '5m', selfDrawn: true, fromSeat: undefined }));
    // 5 concealed pongs: 碰碰胡 4 + 五暗刻 8 + 門清自摸 3 + 獨聽 1
    expect(keys(r)).toEqual(['all_pongs', 'concealed_self_draw', 'five_concealed', 'round_wind', 'single_wait']);
    expect(r.tai).toBe(17);
  });
  it('a pong completed by discard is not a concealed pong', () => {
    const r = scoreWin(ctx({ concealed: '111m 444p 777s 999s 55m NN', win: 'N' }));
    expect(keys(r)).toContain('four_concealed');
    expect(keys(r)).not.toContain('five_concealed');
  });
  it('清一色', () => {
    const r = scoreWin(ctx({ concealed: '123m 456m 789m 234m 567m 9m', win: '9m' }));
    expect(keys(r)).toContain('full_flush');
    expect(r.tai).toBeGreaterThanOrEqual(8 + 1 + 1);
  });
  it('混一色 with an exposed pong', () => {
    const r = scoreWin(ctx({ concealed: '123m 456m 789m EEE 9m', win: '9m', melds: [pongMeld('C')] }));
    expect(keys(r)).toContain('half_flush');
    expect(keys(r)).toContain('dragon_31');
    expect(keys(r)).not.toContain('concealed');
  });
  it('大三元 absorbs individual dragon pongs', () => {
    const r = scoreWin(ctx({ concealed: 'CCC FFF BBB 123m 5m', win: '5m', melds: [chowMeld('4p')] }));
    expect(keys(r)).toContain('big_three_dragons');
    expect(keys(r).filter((k) => k.startsWith('dragon_'))).toHaveLength(0);
  });
  it('小三元 keeps the two dragon pongs', () => {
    const r = scoreWin(ctx({ concealed: 'CCC FFF 123m 456p B', win: 'B', melds: [chowMeld('4s')] }));
    expect(keys(r)).toContain('small_three_dragons');
    expect(keys(r).filter((k) => k.startsWith('dragon_'))).toHaveLength(2);
  });
  it('字一色 + 大四喜; 字一色 absorbs 碰碰胡', () => {
    const r = scoreWin(ctx({ concealed: 'EEE SSS WWW NNN CCC F', win: 'F', selfDrawn: true, fromSeat: undefined }));
    expect(keys(r)).toContain('all_honors');
    expect(keys(r)).toContain('big_four_winds');
    expect(keys(r)).not.toContain('all_pongs');
    // 四暗刻/五暗刻 still stack with it.
    expect(keys(r)).toContain('five_concealed');
  });
  it('碰碰胡 still scores on an all-pong hand with suited tiles', () => {
    const r = scoreWin(ctx({ concealed: '111m 444p 777s 99s 55m', win: '5m', melds: [pongMeld('E')] }));
    expect(keys(r)).toContain('all_pongs');
  });
  it('seat wind, prevailing wind, dealer and streak', () => {
    const r = scoreWin(ctx({ concealed: 'EEE 123m 456p 789s 234m 5s', win: '5s', seat: 0, dealerSeat: 0, dealerStreak: 2, prevailingWind: 0 }));
    expect(keys(r)).toEqual(expect.arrayContaining(['seat_wind', 'round_wind', 'dealer', 'dealer_streak']));
    const streak = r.items.find((i) => i.key === 'dealer_streak')!;
    expect(streak.tai).toBe(4);
  });
  it('flowers: seat flower, season, four flowers', () => {
    const base = { concealed: '123m 456m 789p 45s 678s 22p', win: '3s' };
    // seat 1 = South → flower index 1 (蘭 f2) and season index 1 (夏 f6)
    expect(keys(scoreWin(ctx({ ...base, flowers: kindsFromString('f2') })))).toContain('seat_flower');
    expect(keys(scoreWin(ctx({ ...base, flowers: kindsFromString('f1') })))).not.toContain('seat_flower');
    expect(keys(scoreWin(ctx({ ...base, flowers: kindsFromString('f6') })))).toContain('seat_season');
    expect(keys(scoreWin(ctx({ ...base, flowers: kindsFromString('f1 f2 f3 f4') })))).toContain('four_flowers');
    // 八仙過海 is an instant win (flowerWin), never an item on an ordinary hand.
    const all = scoreWin(ctx({ ...base, flowers: kindsFromString('f1 f2 f3 f4 f5 f6 f7 f8') }));
    expect(keys(all)).not.toContain('eight_flowers');
  });
  it('flower wins: 八仙過海 and 七搶一 are 8 台 plus dealer items with no decomposition', () => {
    // The concealed tiles are not a winning shape and are ignored.
    const junk = '13m 46m 79p 25s 8s ESW CF B';
    const eight = scoreWin(ctx({ concealed: junk, win: 'f8', flowerWin: 'eight', selfDrawn: true, fromSeat: undefined }));
    expect(keys(eight)).toEqual(['eight_flowers']);
    expect(eight.tai).toBe(8);
    expect(eight.decomposition).toBeNull();
    expect(eight.flowerWin).toBe('eight');
    const rob = scoreWin(ctx({ concealed: junk, win: 'f3', flowerWin: 'sevenRob', seat: 0, dealerSeat: 0, dealerStreak: 1, fromSeat: 2 }));
    expect(keys(rob)).toEqual(['dealer', 'dealer_streak', 'seven_rob']);
    expect(rob.tai).toBe(8 + 1 + 2);
    expect(rob.flowerWin).toBe('sevenRob');
  });
  it('situational: 槓上開花, 搶槓, 海底, 天胡', () => {
    const base = { concealed: '123m 456m 789p 45s 678s 22p', win: '3s' };
    expect(keys(scoreWin(ctx({ ...base, selfDrawn: true, afterKong: true })))).toContain('after_kong');
    expect(keys(scoreWin(ctx({ ...base, robbingKong: true })))).toContain('rob_kong');
    expect(keys(scoreWin(ctx({ ...base, lastTile: true })))).toContain('last_tile_discard');
    expect(keys(scoreWin(ctx({ ...base, selfDrawn: true, lastTile: true })))).toContain('last_tile_draw');
    expect(keys(scoreWin(ctx({ ...base, selfDrawn: true, heavenlyHand: true, seat: 0 })))).toContain('tianhu');
  });
  it('全求人 and 半求人', () => {
    const melds = [pongMeld('E'), pongMeld('C'), chowMeld('1m'), chowMeld('4p'), chowMeld('7s')];
    expect(keys(scoreWin(ctx({ concealed: '5s', win: '5s', melds })))).toContain('full_begging');
    expect(keys(scoreWin(ctx({ concealed: '5s', win: '5s', melds, selfDrawn: true })))).toContain('half_begging');
  });
});

/** Cases from the rules audit (A1–A13), each asserting the corrected breakdown. */
describe('台 scoring: audit cases', () => {
  const open = () => [pongMeld('1m'), pongMeld('9s'), chowMeld('2p'), chowMeld('6s')];
  it('A1: a concealed kong among the sets is not 全求人 (the 單騎 still scores 獨聽)', () => {
    const r = scoreWin(ctx({ concealed: '5p', win: '5p', melds: [...open(), kongMeld('C', true)] }));
    expect(keys(r)).toEqual(['dragon_31', 'single_wait']);
    expect(r.tai).toBe(2);
  });
  it('A1b: an exposed kong still allows 全求人', () => {
    const r = scoreWin(ctx({ concealed: '5p', win: '5p', melds: [...open(), kongMeld('C', false)] }));
    expect(keys(r)).toEqual(['dragon_31', 'full_begging']);
  });
  it('A2: 全求人 absorbs 獨聽', () => {
    const r = scoreWin(ctx({ concealed: '5p', win: '5p', melds: [...open(), chowMeld('3m')] }));
    expect(keys(r)).toEqual(['full_begging']);
    expect(r.tai).toBe(2);
  });
  it('A3: 半求人 absorbs 獨聽 and stacks with 自摸 (1 + 1)', () => {
    const r = scoreWin(ctx({ concealed: '5p', win: '5p', melds: [...open(), chowMeld('3m')], selfDrawn: true, fromSeat: undefined }));
    expect(keys(r)).toEqual(['half_begging', 'self_draw']);
    expect(r.tai).toBe(2);
  });
  it('A4: no 平胡 on a 嵌張 win even when the hand has two waits', () => {
    const r = scoreWin(ctx({ concealed: '123m 456m 789m 123p 2444s', win: '3s' }));
    expect(keys(r)).toEqual(['concealed']);
    expect(r.tai).toBe(1);
  });
  it('A4b: no 平胡 on an edge (邊張) win; 平胡 on a two-sided win', () => {
    // 12s waiting on 3s is the only wait: 獨聽, not 平胡.
    expect(keys(scoreWin(ctx({ concealed: '123m 456m 789p 12s 678s 22p', win: '3s' })))).toEqual(['concealed', 'single_wait']);
    // 23s waiting on 1s or 4s, won on 1s: 平胡.
    expect(keys(scoreWin(ctx({ concealed: '123m 456m 789m 123p 23s 55p', win: '1s' })))).toEqual(['all_chows', 'concealed']);
  });
  it('A9: 天胡 uses heavenlyTai and absorbs 門清自摸, 獨聽 and 花上自摸; 正花 and 莊家 still add', () => {
    const base = {
      seat: 0,
      concealed: '123m 456m 789m 123p 456p 5s',
      win: '5s',
      selfDrawn: true,
      fromSeat: undefined,
      heavenlyHand: true,
      afterFlower: true,
      flowers: kindsFromString('f1'),
    };
    const r = scoreWin(ctx(base));
    expect(keys(r)).toEqual(['dealer', 'seat_flower', 'tianhu']);
    expect(r.items.find((i) => i.key === 'tianhu')!.tai).toBe(24);
    expect(r.tai).toBe(24 + 1 + 1);
    expect(scoreWin(ctx({ ...base, rules: withRules({ heavenlyTai: 16 }) })).tai).toBe(16 + 1 + 1);
    // A configured 0 turns the limit hand off and the hand scores normally.
    const off = scoreWin(ctx({ ...base, rules: withRules({ heavenlyTai: 0 }) }));
    expect(keys(off)).toEqual(['after_flower', 'concealed_self_draw', 'dealer', 'seat_flower', 'single_wait']);
  });
  it('地胡 and 人胡 use their configured values and absorb 門清, 平胡 and 海底; pattern hands still add', () => {
    const rules = withRules({ earthlyTai: 12, humanlyTai: 8 });
    const di = scoreWin(ctx({ rules, concealed: '123m 456m 789m 234m 567m 9m', win: '9m', selfDrawn: true, fromSeat: undefined, earthlyHand: true, lastTile: true }));
    expect(keys(di)).toEqual(['dihu', 'full_flush']);
    expect(di.tai).toBe(12 + 8);
    const ren = scoreWin(ctx({ rules, concealed: '123m 456m 789p 45s 678s 22p', win: '3s', fromSeat: 0, humanlyHand: true }));
    expect(keys(ren)).toEqual(['renhu']);
    expect(ren.tai).toBe(8);
  });
  it("A13: 獨聽 when the other wait is dead in the player's own concealed kong", () => {
    const r = scoreWin(ctx({ concealed: '123p 456p 789s 78m 55s', win: '6m', melds: [kongMeld('9m', true)] }));
    expect(keys(r)).toEqual(['concealed', 'single_wait']);
    expect(r.tai).toBe(2);
    // With only three 9m out of play the second wait is live: no 獨聽.
    const live = scoreWin(ctx({ concealed: '123p 456p 789s 78m 55s', win: '6m', melds: [pongMeld('9m')] }));
    expect(keys(live)).not.toContain('single_wait');
  });
  it('maxTai caps the non-dealer 台 only; the dealer items are added after the cap', () => {
    const rules = withRules({ maxTai: 8 });
    // 78m + 99m waits on 6m/9m: 清一色 8 + 門清 1 + 平胡 2 = 11, capped to 8, then 莊家 1 + 連3拉3 6.
    const r = scoreWin(ctx({ rules, seat: 0, dealerStreak: 3, concealed: '123m 456m 789m 234m 567m 9m', win: '9m' }));
    expect(keys(r)).toEqual(['all_chows', 'concealed', 'dealer', 'dealer_streak', 'full_flush']);
    expect(r.taiUncapped).toBe(11 + 1 + 6);
    expect(r.tai).toBe(8 + 1 + 6);
    const free = scoreWin(ctx({ seat: 0, dealerStreak: 3, concealed: '123m 456m 789m 234m 567m 9m', win: '9m' }));
    expect(free.tai).toBe(free.taiUncapped);
  });
  it('picks the highest-scoring decomposition', () => {
    // 111222333m: as pongs → 碰碰胡 + 三暗刻 ; as chows → nothing special. Scorer must pick pongs.
    const r = scoreWin(ctx({ concealed: '111222333m 999p EEE 5s', win: '5s', selfDrawn: true, fromSeat: undefined }));
    expect(keys(r)).toContain('all_pongs');
  });
});

describe('payments', () => {
  it('self-draw: all three pay, dealer pays extra when the dealer is a loser', () => {
    const p = computePayments(DEFAULT_RULES, 1, 0, 1, 3, true, undefined);
    expect(p).toHaveLength(3);
    const fromDealer = p.find((x) => x.from === 0)!;
    const fromOther = p.find((x) => x.from === 2)!;
    expect(fromDealer.tai).toBe(3 + 1 + 2);
    expect(fromOther.tai).toBe(3);
    expect(fromOther.points).toBe(100 + 3 * 20);
  });
  it('discard: only the discarder pays; dealer winner adds dealer 台', () => {
    const p = computePayments(DEFAULT_RULES, 0, 0, 0, 2, false, 3);
    expect(p).toEqual([{ from: 3, to: 0, tai: 3, points: 160 }]);
  });
  it('A11: maxTai 8, a 7 台 hand dealt in by the dealer on a streak of 3 pays min(7, 8) + 1 + 6', () => {
    const p = computePayments(withRules({ maxTai: 8 }), 1, 0, 3, 7, false, 0);
    expect(p).toEqual([{ from: 0, to: 1, tai: 7 + 1 + 6, points: 100 + 14 * 20 }]);
  });
  it('maxTai caps the hand before the dealer 台 on every transaction', () => {
    const p = computePayments(withRules({ maxTai: 8 }), 1, 0, 3, 12, true, undefined);
    expect(p.find((x) => x.from === 0)!.tai).toBe(8 + 1 + 6);
    expect(p.find((x) => x.from === 2)!.tai).toBe(8);
    expect(p.find((x) => x.from === 3)!.tai).toBe(8);
  });
});
