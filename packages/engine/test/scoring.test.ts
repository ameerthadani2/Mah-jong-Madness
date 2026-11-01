import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, kindFromCode, kindsFromString, scoreWin, computePayments, type WinContext, type Meld } from '../src/index';

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
  it('字一色 + 大四喜', () => {
    const r = scoreWin(ctx({ concealed: 'EEE SSS WWW NNN CCC F', win: 'F', selfDrawn: true, fromSeat: undefined }));
    expect(keys(r)).toContain('all_honors');
    expect(keys(r)).toContain('big_four_winds');
    expect(keys(r)).toContain('all_pongs');
  });
  it('seat wind, prevailing wind, dealer and streak', () => {
    const r = scoreWin(ctx({ concealed: 'EEE 123m 456p 789s 234m 5s', win: '5s', seat: 0, dealerSeat: 0, dealerStreak: 2, prevailingWind: 0 }));
    expect(keys(r)).toEqual(expect.arrayContaining(['seat_wind', 'round_wind', 'dealer', 'dealer_streak']));
    const streak = r.items.find((i) => i.key === 'dealer_streak')!;
    expect(streak.tai).toBe(4);
  });
  it('flowers: seat flower, four flowers, eight immortals', () => {
    const base = { concealed: '123m 456m 789p 45s 678s 22p', win: '3s' };
    // seat 1 = South → flower index 1 (蘭 f2) and season index 1 (夏 f6)
    expect(keys(scoreWin(ctx({ ...base, flowers: kindsFromString('f2') })))).toContain('seat_flower');
    expect(keys(scoreWin(ctx({ ...base, flowers: kindsFromString('f1') })))).not.toContain('seat_flower');
    expect(keys(scoreWin(ctx({ ...base, flowers: kindsFromString('f6') })))).toContain('seat_season');
    expect(keys(scoreWin(ctx({ ...base, flowers: kindsFromString('f1 f2 f3 f4') })))).toContain('four_flowers');
    const all = scoreWin(ctx({ ...base, flowers: kindsFromString('f1 f2 f3 f4 f5 f6 f7 f8') }));
    expect(keys(all)).toContain('eight_flowers');
    expect(keys(all)).not.toContain('four_flowers');
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
});
