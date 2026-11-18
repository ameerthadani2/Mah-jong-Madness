/**
 * How the game detects win situations, checked end to end. `scoring_oracle.test.ts` hands the situation
 * flags to the scorer; here each situation is played through the game's public API from a constructed
 * wall or deal (`dealWall` through `helpers/state.ts`, then `applyAction`), no flag is ever set by hand,
 * and the win the game records (its 台 items, shown 台 and payments) must equal what the independent
 * oracle (`helpers/oracle.ts`, written from docs/RULES.md) gives for the hand with the situation the test
 * set up. Self-play produced only one 搶槓 and two 槓上開花 in 1,500 hands, so these cases are built.
 *
 * Each test fails when its detection in src/game.ts is broken; the mutations tried are listed in the
 * commit that added this file.
 */
import { describe, expect, it } from 'vitest';
import { applyAction, kindOf, type GameState, type ScoreResult } from '../src/index';
import { oraclePayments, oracleScore, type OMeld, type OWin } from './helpers/oracle';
import { dealt, discard, find, keysOf, respond, setup } from './helpers/state';

/** Hands that can never claim, win or form a pair. */
const D1 = 'ESWN CFB 147m 258p 369s';
const D2 = 'ESWN CFB 258m 369p 147s';
const D3 = 'ESWN CFB 369m 147p 258s';
/** Ready on 5 Bamboo alone. */
const WAITS_5S = '123456789m 123456p 5s';
const SEVEN = 'f1 f2 f3 f4 f5 f6 f7';

/** The situation as the test set it up (docs/RULES.md), never read from the engine. */
type Situation = Pick<OWin, 'afterKong' | 'afterFlower' | 'robKong' | 'lastTile' | 'tianhu' | 'dihu' | 'renhu' | 'flowerWin'>;

const line = (items: ReadonlyArray<[string, number]>) =>
  items
    .map(([k, t]) => `${k}:${t}`)
    .sort()
    .join(' ');
const engineLine = (score: ScoreResult) => line(score.items.map((i): [string, number] => [i.key, i.tai]));

/**
 * The one win the game recorded, checked against the oracle: the hand, melds, flowers, seats and rules
 * come from the game's record, the situation from the test.
 */
function recordedWin(s: GameState, situation: Situation) {
  expect(s.phase).toBe('ended');
  expect(s.result?.type).toBe('win');
  expect(s.result!.wins).toHaveLength(1);
  const w = s.result!.wins[0];
  const kinds = w.hand.map(kindOf);
  const win = kindOf(w.winningTile);
  const concealed = [...kinds];
  if (!situation.flowerWin) concealed.splice(concealed.indexOf(win), 1);
  const melds: OMeld[] = w.melds.map((m) => ({
    type: m.type,
    kind: Math.min(...m.tiles.map(kindOf)),
    concealed: m.concealed,
  }));
  const o: OWin = {
    rules: s.rules,
    seat: w.seat,
    dealer: s.dealerSeat,
    streak: s.dealerStreak,
    prevailing: s.prevailingWind,
    concealed,
    win,
    melds,
    flowers: w.flowers.map(kindOf),
    selfDrawn: w.selfDrawn,
    fromSeat: w.fromSeat,
    ...situation,
  };
  const want = oracleScore(o);
  expect(want.readings.map((rd) => line([...rd.items, ...want.dealerItems]))).toContain(engineLine(w.score));
  expect(w.score.tai).toBe(want.shown);
  expect(w.payments).toEqual(oraclePayments(o, want.handTai));
  return w;
}

describe('搶槓: a win on the tile added to a pong', () => {
  it('the robber wins with 搶槓, paid by the robbed seat alone, and the kong never completes', () => {
    let s = setup(
      { multipleWinners: false },
      [
        {
          hand: '5p 123m 456m 789m 123s 9s',
          melds: [{ type: 'pong', tiles: '555p', from: 2 }],
        },
        '46p 234m 567s 789s EEE 55m',
        D2,
        'SS WW NN CC FF BB 19m 19p',
      ],
      10,
    );
    s = applyAction(s, 0, { type: 'kong', tile: find(s, 0, '5p') });
    expect(s.pending?.kind).toBe('addedKong');
    s = respond(s, { 1: { type: 'hu' } });
    const w = recordedWin(s, { robKong: true });
    expect(w.seat).toBe(1);
    expect(keysOf(w.score)).toContain('rob_kong');
    expect(w.payments.map((p) => p.from)).toEqual([0]);
    expect(s.players[0].melds[0].type).toBe('pong');
  });
});

describe('槓上開花: a win on a kong replacement', () => {
  it('on the replacement of a 暗槓', () => {
    let s = setup({}, ['9999s 123m 456m 789m 123p 5s', D2, D2, D3], 10, {
      back: ['5s'],
    });
    s = applyAction(s, 0, { type: 'kong', tile: find(s, 0, '9s') });
    s = applyAction(s, 0, { type: 'hu' });
    expect(keysOf(recordedWin(s, { afterKong: true }).score)).toContain('after_kong');
  });

  it('on the replacement of a 明槓 claimed from a discard', () => {
    let s = setup({}, ['9s 147m 258p 367s ESW CFB N', '999s 123m 456m 789m 123p 5s', D2, D3], 10, { back: ['5s'] });
    s = discard(s, 0, '9s');
    s = respond(s, { 1: { type: 'kong' } });
    expect(s.drawSource).toBe('kong');
    s = applyAction(s, 1, { type: 'hu' });
    const w = recordedWin(s, { afterKong: true });
    expect(w.seat).toBe(1);
    expect(keysOf(w.score)).toContain('after_kong');
  });

  it('on the replacement of a 加槓 nobody robs', () => {
    let s = setup(
      {},
      [
        {
          hand: '5p 123m 456m 789m 123s 9s',
          melds: [{ type: 'pong', tiles: '555p', from: 2 }],
        },
        D2,
        D2,
        D3,
      ],
      10,
      { back: ['9s'] },
    );
    s = applyAction(s, 0, { type: 'kong', tile: find(s, 0, '5p') });
    expect(s.pending).toBeUndefined();
    s = applyAction(s, 0, { type: 'hu' });
    expect(keysOf(recordedWin(s, { afterKong: true }).score)).toContain('after_kong');
  });

  it('when a flower is drawn as the replacement, the win on the next one is still 槓上開花, not 花上自摸', () => {
    let s = setup({}, ['9999s 123m 456m 789m 123p 5s', D2, D2, D3], 10, {
      back: ['f1', '5s'],
    });
    s = applyAction(s, 0, { type: 'kong', tile: find(s, 0, '9s') });
    expect(s.players[0].flowers).toHaveLength(1);
    s = applyAction(s, 0, { type: 'hu' });
    const keys = keysOf(recordedWin(s, { afterKong: true }).score);
    expect(keys).toContain('after_kong');
    expect(keys).not.toContain('after_flower');
  });
});

describe('花上自摸: a win on a flower replacement', () => {
  it('a flower drawn from the wall, and the replacement wins', () => {
    let s = setup({}, [`${D1} C`, '123m 456m 789p 234s 678s 9s', D2, D3], 10, {
      front: ['f2'],
      back: ['9s'],
    });
    s = discard(s, 0, 'C');
    expect(s.drawSource).toBe('flower');
    s = applyAction(s, 1, { type: 'hu' });
    const keys = keysOf(recordedWin(s, { afterFlower: true }).score);
    expect(keys).toContain('after_flower');
    expect(keys).not.toContain('after_kong');
  });
});

describe('海底撈月 and 河底撈魚: the last live tile and its discard', () => {
  const S0 = '8s 147m 258p 369s EESSWW N';
  /** Seat 3 here holds a pair of 5 Bamboo, so it may pong a 5 Bamboo that is not the last live tile. */
  const D3_PAIR = 'ESWN CFB 369m 147p 255s';

  it('海底撈月: a self-draw on the last live tile', () => {
    let s = setup({}, [S0, WAITS_5S, D2, D3], 1, { front: ['5s'] });
    s = discard(s, 0, '8s');
    s = applyAction(s, 1, { type: 'hu' });
    const keys = keysOf(recordedWin(s, { lastTile: true }).score);
    expect(keys).toContain('last_tile_draw');
    expect(keys).not.toContain('last_tile_discard');
  });

  it('河底撈魚: a win on the discard of the last live tile, which nobody may call', () => {
    let s = setup({}, [S0, D2, WAITS_5S, D3_PAIR], 1, { front: ['5s'] });
    s = discard(s, 0, '8s');
    expect(s.turn).toBe(1);
    s = discard(s, 1, '5s');
    // 3 holds a pair of 5 Bamboo and could pong it with live tiles left (next test), but the last discard can only be won on.
    expect(s.pending?.offers.map((o) => [o.seat, o.hu, o.pong])).toEqual([[2, true, false]]);
    s = respond(s, { 2: { type: 'hu' } });
    const w = recordedWin(s, { lastTile: true });
    expect(w.fromSeat).toBe(1);
    expect(keysOf(w.score)).toContain('last_tile_discard');
    expect(keysOf(w.score)).not.toContain('last_tile_draw');
  });

  it('a discard with live tiles left is neither, and may be called', () => {
    let s = setup({}, [S0, D2, WAITS_5S, D3_PAIR], 3, { front: ['5s'] });
    s = discard(s, 0, '8s');
    s = discard(s, 1, '5s');
    expect(s.pending?.offers.map((o) => [o.seat, o.hu, o.pong])).toEqual([
      [2, true, false],
      [3, false, true],
    ]);
    s = respond(s, { 2: { type: 'hu' } });
    const keys = keysOf(recordedWin(s, {}).score);
    expect(keys).not.toContain('last_tile_discard');
  });
});

describe('天胡, 地胡 and 人胡 from a real deal, and the call that voids them', () => {
  it('天胡: the dealer wins on the deal itself', () => {
    let s = dealt({}, ['123m 456m 789m 123p 456p 5s', D1, D2, D3], {
      front: ['5s'],
    });
    s = applyAction(s, 0, { type: 'hu' });
    expect(keysOf(recordedWin(s, { tianhu: true }).score)).toContain('tianhu');
  });

  it('地胡: a non-dealer self-draws on their first draw', () => {
    let s = dealt({}, [D1, '123m 456m 789m 123p 456p 5s', D2, D3], {
      front: ['9p', '5s'],
    });
    s = discard(s, 0, '9p');
    s = applyAction(s, 1, { type: 'hu' });
    expect(keysOf(recordedWin(s, { dihu: true }).score)).toContain('dihu');
  });

  it("人胡: a non-dealer who has not drawn wins on the dealer's first discard", () => {
    let s = dealt({}, [D1, D2, '123m 456m 789p 45s 678s 22p', D3], {
      front: ['3s'],
    });
    s = respond(discard(s, 0, '3s'), { 2: { type: 'hu' } });
    expect(keysOf(recordedWin(s, { renhu: true }).score)).toContain('renhu');
  });

  it("the dealer's 暗槓 voids 人胡: a win on the dealer's first discard after it, by a seat that has not drawn, is an ordinary win", () => {
    const idle = ['SWN CFB 258m 369p 147s 9m', 'SWN CFB 369m 147p 258s 6p'];
    let s = dealt({}, ['EEE CFB 147m 258p 369s S', idle[0], '123m 456m 789p 45s 678s 22p', idle[1]], {
      front: ['E'],
      back: ['3s'],
    });
    s = applyAction(s, 0, { type: 'kong', tile: find(s, 0, 'E') });
    s = discard(s, 0, '3s');
    expect(s.players[2].draws).toBe(0);
    s = respond(s, { 2: { type: 'hu' } });
    const w = recordedWin(s, {});
    expect([w.seat, w.fromSeat]).toEqual([2, 0]);
    expect(keysOf(w.score)).not.toContain('renhu');
  });

  it("the dealer's 暗槓 voids 天胡: the win on its replacement is 槓上開花", () => {
    const idle = ['SWN CFB 258m 369p 147s 9m', 'SWN CFB 147m 258p 369s 4s', 'SWN CFB 369m 147p 258s 6p'];
    let s = dealt({}, ['EEE 123m 456m 789m 123p 5s', ...idle], {
      front: ['E'],
      back: ['5s'],
    });
    s = applyAction(s, 0, { type: 'kong', tile: find(s, 0, 'E') });
    s = applyAction(s, 0, { type: 'hu' });
    const keys = keysOf(recordedWin(s, { afterKong: true }).score);
    expect(keys).toContain('after_kong');
    expect(keys).not.toContain('tianhu');
  });

  it('and 地胡: a first-draw self-draw after it is an ordinary win', () => {
    const dealer = 'EEE CFB 147m 258p 369s S';
    let s = dealt({}, [dealer, '123m 456m 789m 123p 456p 5s', 'SWN CFB 258m 369p 147s 9m', 'SWN CFB 369m 147p 258s 6p'], { front: ['E', '5s'], back: ['9p'] });
    s = applyAction(s, 0, { type: 'kong', tile: find(s, 0, 'E') });
    s = discard(s, 0, '9p');
    s = applyAction(s, 1, { type: 'hu' });
    expect(keysOf(recordedWin(s, {}).score)).not.toContain('dihu');
  });

  it("a pong voids 地胡: a self-draw on a player's first draw after it is an ordinary win", () => {
    // Seat 2 pongs the dealer's 9 Dots and throws 2 Bamboo; seat 3 then draws for the first time and wins.
    const dealer = 'ESWN CFB 147m 258p 139s';
    let s = dealt({}, [dealer, D2, 'SWN CFB 369m 147p 99p 28s', '123m 456m 789m 45s 678s 22p'], { front: ['9p', '3s'] });
    s = discard(s, 0, '9p');
    s = respond(s, { 2: { type: 'pong' } });
    s = discard(s, 2, '2s');
    expect(s.turn).toBe(3);
    expect(s.players[3].draws).toBe(1);
    s = applyAction(s, 3, { type: 'hu' });
    expect(keysOf(recordedWin(s, {}).score)).not.toContain('dihu');
  });
});

describe('八仙過海 and 七搶一', () => {
  /** Seat 0 discards the Red Dragon; nobody can claim it, so seat 1 draws the next tile, the eighth flower. */
  const midHand = (s0?: string, s1?: string) => setup({}, [{ hand: `${D1} C`, flowers: s0 }, { hand: D2, flowers: s1 }, D3, '147m 258m 147p 258p 147s 2s'], 10, { front: ['f8'] });

  it('八仙過海 mid-hand: drawing the eighth flower wins, paid as a self-draw', () => {
    const s = discard(midHand(undefined, SEVEN), 0, 'C');
    const w = recordedWin(s, { flowerWin: 'eight' });
    expect(w.seat).toBe(1);
    expect(keysOf(w.score)).toContain('eight_flowers');
  });

  it('七搶一 mid-hand: the seat holding seven takes the eighth, paid by the seat that drew it', () => {
    const s = discard(midHand(SEVEN, undefined), 0, 'C');
    const w = recordedWin(s, { flowerWin: 'sevenRob' });
    expect(w.seat).toBe(0);
    expect(w.fromSeat).toBe(1);
    expect(keysOf(w.score)).toContain('seven_rob');
  });

  it('八仙過海 at the deal', () => {
    const s = dealt({}, [D1, D2, `123m 456m 78m ${SEVEN} f8`, D3], {
      back: ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p'],
    });
    expect(recordedWin(s, { flowerWin: 'eight' }).seat).toBe(2);
  });

  it('七搶一 at the deal', () => {
    const s = dealt({}, [D1, `123m 456m 789m ${SEVEN}`, D2, 'ESWN CFB 369m 147p 25s f8'], { back: ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8s'] });
    const w = recordedWin(s, { flowerWin: 'sevenRob' });
    expect([w.seat, w.fromSeat]).toEqual([1, 3]);
  });
});
