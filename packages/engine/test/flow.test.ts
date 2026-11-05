import { describe, expect, it } from 'vitest';
import { applyAction, hashState, legalActions, matchSnapshot, newGame, replayHand, type Action, type GameState } from '../src/index';
import { dealt, discard, keysOf, nonDiscard, offers, respond, setup, tileTotal } from './helpers/state';

/** Hands that can never claim, win or form a pair: seven honours and nine spaced suited tiles. */
const D1 = 'ESWN CFB 147m 258p 369s';
const D2 = 'ESWN CFB 258m 369p 147s';
const D3 = 'ESWN CFB 369m 147p 258s';

const win = (s: GameState, i = 0) => {
  expect(s.phase).toBe('ended');
  expect(s.result?.type).toBe('win');
  return s.result!.wins[i];
};

describe('河底 (the last discard)', () => {
  const hands = [
    '7p 123m 456m 789m 123s 456s 9s', // seat 0 discards 7p
    '56p 234m 567m 234s 68s ESW', // seat 1 could chi 7p
    '77p 345m 678m 345s 79s SNC', // seat 2 could pong 7p
    '68p 123p 444p NNN 999m WW', // seat 3 wins on 7p
  ];

  it('offers chi and pong on an ordinary discard', () => {
    const s = discard(setup({}, hands, 5), 0, '7p');
    expect(offers(s)).toEqual({
      1: { hu: false, pong: false, kong: false, chi: 1 },
      2: { hu: false, pong: true, kong: false, chi: 0 },
      3: { hu: true, pong: false, kong: false, chi: 0 },
    });
  });

  it('offers only 胡 on the 河底 discard and pays 河底撈魚 once (B1)', () => {
    let s = setup({}, hands, 0);
    s.lastTileDrawn = true; // seat 0 has just drawn the last live tile
    s = discard(s, 0, '7p');
    expect(offers(s)).toEqual({ 3: { hu: true, pong: false, kong: false, chi: 0 } });
    s = respond(s, { 3: { type: 'hu' } });
    const w = win(s);
    expect(w.seat).toBe(3);
    expect(keysOf(w.score)).toEqual(['concealed', 'last_tile_discard', 'seat_wind', 'single_wait', 'three_concealed']);
    expect(w.score.items.filter((i) => i.key === 'last_tile_discard')).toHaveLength(1);
    // Dealt in by the dealer: 6 台 + 莊家 1.
    expect(w.payments).toEqual([{ from: 0, to: 3, tai: 7, points: 100 + 7 * 20 }]);
  });

  it('ends the hand in a draw when the 河底 discard is passed', () => {
    let s = setup({}, hands, 0);
    s.lastTileDrawn = true;
    s = respond(discard(s, 0, '7p'), {});
    expect(s.phase).toBe('ended');
    expect(s.result?.type).toBe('draw');
  });

  it('a pong or chi clears lastTileDrawn so 河底撈魚 can never be paid twice', () => {
    for (const answer of [{ seat: 2, r: { type: 'pong' } as const }, { seat: 1, r: { type: 'chi' } as const }]) {
      let s = setup({}, hands, 5);
      s.lastTileDrawn = true; // forced: the guard on the claim paths is defensive
      s = discard(s, 0, '7p');
      const chi = s.pending!.offers.find((o) => o.seat === 1)!.chi[0];
      s = respond(s, { [answer.seat]: answer.r.type === 'chi' ? { type: 'chi', tiles: chi } : answer.r });
      expect(s.turn).toBe(answer.seat);
      expect(s.drawSource).toBe('claim');
      expect(s.lastTileDrawn).toBe(false);
    }
  });
});

describe('replacement tiles', () => {
  it('a flower drawn as a kong replacement still scores 槓上開花, not 花上自摸', () => {
    let s = setup(
      {},
      [
        { hand: '5p 123m 456m 789m 234s 9s', melds: [{ type: 'pong', tiles: '555p', from: 2 }] },
        'ESWN CFB 147m 369p 258s',
        'ESWN CFB 258m 147p 369s',
        'SWNCFB 369m 28p 1478s E',
      ],
      10,
      { back: ['f1', '9s'] },
    );
    const before = tileTotal(s);
    s = applyAction(s, 0, { type: 'kong', tile: s.players[0].hand.find((t) => t >> 2 === 13)! });
    expect(s.phase).toBe('discard');
    expect(s.players[0].melds[0].type).toBe('kong');
    expect(s.players[0].flowers).toEqual([136]);
    expect(s.drawSource).toBe('kong');
    expect(nonDiscard(s, 0)).toContainEqual({ type: 'hu' });
    s = applyAction(s, 0, { type: 'hu' });
    const keys = keysOf(win(s).score);
    expect(keys).toContain('after_kong');
    expect(keys).not.toContain('after_flower');
    expect(tileTotal(s)).toBe(before);
  });

  it('a flower drawn from the wall scores 花上自摸', () => {
    let s = setup({}, [`${D1} C`, '123m 456m 789p 234s 678s 9s', D2, D3], 10, {
      front: ['f2'],
      back: ['9s'],
    });
    s = discard(s, 0, 'C');
    expect(s.turn).toBe(1);
    expect(s.players[1].flowers).toEqual([137]);
    expect(s.drawSource).toBe('flower');
    s = applyAction(s, 1, { type: 'hu' });
    const keys = keysOf(win(s).score);
    expect(keys).toContain('after_flower');
    expect(keys).toContain('seat_flower'); // 蘭 is South's flower
    expect(keys).not.toContain('after_kong');
  });
});

describe('搶槓 (robbing an added kong)', () => {
  const hands = [
    { hand: '5p 123m 456m 789m 123s 9s', melds: [{ type: 'pong' as const, tiles: '555p', from: 2 }] },
    '46p 234m 567s 789s EEE 55m', // waits on 5p
    '46p 234m 567s 789s SSS 88m', // waits on 5p
    '11p 22p 33p 44s 55s 66s N', // waits on N
  ];
  const kong = (s: GameState) => applyAction(s, 0, { type: 'kong', tile: s.players[0].hand.find((t) => t >> 2 === 13)! });

  it('opens a 胡-only window; with one winner the nearest robber takes it and the kong never completes', () => {
    let s = kong(setup({ multipleWinners: false }, hands, 10));
    expect(s.pending?.kind).toBe('addedKong');
    expect(offers(s)).toEqual({ 1: { hu: true, pong: false, kong: false, chi: 0 }, 2: { hu: true, pong: false, kong: false, chi: 0 } });
    s = respond(s, { 1: { type: 'hu' }, 2: { type: 'hu' } });
    expect(s.result!.wins.map((w) => w.seat)).toEqual([1]);
    const w = win(s);
    expect(keysOf(w.score)).toContain('rob_kong');
    expect(w.payments.map((p) => p.from)).toEqual([0]);
    expect(s.players[0].melds[0].type).toBe('pong');
  });

  it('with 一炮多響 on, every robber wins and the robbed seat pays each', () => {
    const s = respond(kong(setup({ multipleWinners: true }, hands, 10)), { 1: { type: 'hu' }, 2: { type: 'hu' } });
    expect(s.result!.wins.map((w) => w.seat)).toEqual([1, 2]);
    for (const w of s.result!.wins) {
      expect(keysOf(w.score)).toContain('rob_kong');
      expect(w.payments.map((p) => p.from)).toEqual([0]);
    }
    expect(s.result!.scoreDelta.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it('when every robber passes the kong completes and the replacement is drawn', () => {
    const s = respond(kong(setup({}, hands, 10, { back: ['E'] })), {});
    expect(s.players[0].melds[0].type).toBe('kong');
    expect(s.players[0].melds[0].tiles).toHaveLength(4);
    expect(s.turn).toBe(0);
    expect(s.drawSource).toBe('kong');
  });
});

describe('一炮多響 (one discard, several winners)', () => {
  const hands = [
    '3m 69m 789p 139s SSS WWW N F', // the dealer discards 3m
    '12m 55m 123p 456p 789s 234s',
    '12m 456p 456s 789s EEE CC',
    '45m 333p 456s 567s 789m 22s',
  ];

  it('on: all three win and the discarder pays each; the dealer loses the deal', () => {
    let s = discard(setup({ multipleWinners: true }, hands, 10), 0, '3m');
    expect(Object.keys(offers(s)).map(Number)).toEqual([1, 2, 3]);
    s = respond(s, { 1: { type: 'hu' }, 2: { type: 'hu' }, 3: { type: 'hu' } });
    expect(s.result!.wins.map((w) => w.seat)).toEqual([1, 2, 3]);
    for (const w of s.result!.wins) expect(w.payments.map((p) => p.from)).toEqual([0]);
    const paid = s.result!.wins.reduce((n, w) => n + w.payments[0].points, 0);
    expect(s.result!.scoreDelta[0]).toBe(-paid);
    expect(s.result!.scoreDelta.reduce((a, b) => a + b, 0)).toBe(0);
    expect(s.result!.dealerContinues).toBe(false);
  });

  it('off: only the nearest winner in turn order takes the discard', () => {
    let s = discard(setup({ multipleWinners: false }, hands, 10), 0, '3m');
    s = respond(s, { 1: { type: 'hu' }, 2: { type: 'hu' }, 3: { type: 'hu' } });
    expect(s.result!.wins.map((w) => w.seat)).toEqual([1]);
  });

  it('off: a farther seat wins when the nearer ones pass', () => {
    let s = discard(setup({ multipleWinners: false }, hands, 10), 0, '3m');
    s = respond(s, { 3: { type: 'hu' } });
    expect(s.result!.wins.map((w) => w.seat)).toEqual([3]);
  });
});

describe('過水 (passing a win)', () => {
  const hands = [
    '3m 589m 3p 69p 159s ESWNCFB', // the dealer discards 3m
    '37m 1479p 258s ESWNCFB',
    '12m 456p 789p 567s 234s EE', // waits on 3m; can pong E or chi 3m
    '369m 258p 1478s SWNCFB',
  ];
  /** Seat 2 passes a win on the dealer's 3m; seat 1 then draws F. */
  const passed = () => {
    let s = discard(setup({ passRule: true }, hands, 10, { front: ['F', 'B', 'N'] }), 0, '3m');
    expect(offers(s)).toEqual({ 2: { hu: true, pong: false, kong: false, chi: 0 } });
    s = respond(s, {});
    expect(s.players[2].passedWin).toBe(true);
    expect(s.turn).toBe(1);
    return s;
  };

  it('blocks a win by discard until the next draw', () => {
    const s = discard(passed(), 1, '3m');
    expect(offers(s)).toEqual({ 2: { hu: false, pong: false, kong: false, chi: 1 } });
  });

  it('is reset by the next draw', () => {
    let s = respond(discard(passed(), 1, '3m'), {});
    expect(s.turn).toBe(2);
    expect(s.players[2].passedWin).toBe(false);
    s = discard(s, 2, 'B');
    expect(s.turn).toBe(3);
    s = discard(s, 3, '3m');
    expect(offers(s)[2]).toEqual({ hu: true, pong: false, kong: false, chi: 0 });
  });

  it('is reset by a chi', () => {
    let s = discard(passed(), 1, '3m');
    s = respond(s, { 2: { type: 'chi', tiles: s.pending!.offers[0].chi[0] } });
    expect(s.turn).toBe(2);
    expect(s.players[2].passedWin).toBe(false);
  });

  it('is reset by a pong', () => {
    let s = discard(passed(), 1, 'E');
    expect(offers(s)).toEqual({ 2: { hu: false, pong: true, kong: false, chi: 0 } });
    s = respond(s, { 2: { type: 'pong' } });
    expect(s.turn).toBe(2);
    expect(s.players[2].passedWin).toBe(false);
  });

  it('does not apply when the rule is off', () => {
    let s = discard(setup({ passRule: false }, hands, 10, { front: ['F'] }), 0, '3m');
    s = respond(s, {});
    s = discard(s, 1, '3m');
    expect(offers(s)[2].hu).toBe(true);
  });
});

describe('海底撈月 (winning on the last tile)', () => {
  const hands = ['3m 69m 789p 139s SSS WWW N F', '12m 55m 123p 456p 789s 234s', '12m 456p 456s 789s EEE CC', '45m 333p 456s 567s 789m 22s'];

  it('scores the self-draw on the last live tile', () => {
    let s = discard(setup({}, hands, 1, { front: ['3m'] }), 0, 'N');
    expect(s.turn).toBe(1);
    expect(s.lastTileDrawn).toBe(true);
    expect(legalActions(s, 1).some((a) => a.type === 'kong')).toBe(false);
    s = applyAction(s, 1, { type: 'hu' });
    const keys = keysOf(win(s).score);
    expect(keys).toContain('last_tile_draw');
    expect(keys).not.toContain('last_tile_discard');
    expect(win(s).payments).toHaveLength(3);
  });
});

describe('天胡 / 地胡 / 人胡 from a real deal', () => {
  it('天胡: the configured 台 absorbs 門清自摸, 獨聽 and 平胡; 莊家 still adds', () => {
    let s = dealt({ heavenlyTai: 16 }, ['123m 456m 789m 123p 456p 5s', D1, D2, D3], { front: ['5s'] });
    expect(s.players[0].hand).toHaveLength(17);
    expect(nonDiscard(s, 0)).toContainEqual({ type: 'hu' });
    s = applyAction(s, 0, { type: 'hu' });
    const w = win(s);
    expect(keysOf(w.score)).toEqual(['dealer', 'tianhu']);
    expect(w.score.tai).toBe(16 + 1);
    expect(w.payments.map((p) => p.tai)).toEqual([17, 17, 17]);
    expect(tileTotal(s)).toBe(144);
  });

  it('地胡: a non-dealer self-draw on the first draw with no claims', () => {
    let s = dealt({ earthlyTai: 12 }, [D1, '123m 456m 789m 123p 456p 5s', D2, D3], { front: ['9p', '5s'] });
    s = discard(s, 0, '9p');
    expect(s.turn).toBe(1);
    s = applyAction(s, 1, { type: 'hu' });
    const w = win(s);
    expect(keysOf(w.score)).toEqual(['dihu']);
    expect(w.score.tai).toBe(12);
    expect(w.payments.map((p) => [p.from, p.tai])).toEqual([
      [0, 13],
      [2, 12],
      [3, 12],
    ]);
  });

  it('人胡: a win on the dealer\'s first discard absorbs 門清 and 平胡', () => {
    let s = dealt({ humanlyTai: 8 }, [D1, D2, '123m 456m 789p 45s 678s 22p', D3], { front: ['3s'] });
    s = discard(s, 0, '3s');
    expect(offers(s)).toEqual({ 2: { hu: true, pong: false, kong: false, chi: 0 } });
    s = respond(s, { 2: { type: 'hu' } });
    const w = win(s);
    expect(keysOf(w.score)).toEqual(['renhu']);
    expect(w.payments).toEqual([{ from: 0, to: 2, tai: 9, points: 100 + 9 * 20 }]);
  });

  it('after any claim the same shapes score normally', () => {
    let s = dealt({}, [D1, D2, '123m 456m 789p 45s 678s 22p', D3], { front: ['3s'] });
    s.anyClaimThisHand = true;
    s = respond(discard(s, 0, '3s'), { 2: { type: 'hu' } });
    expect(keysOf(win(s).score)).toEqual(['all_chows', 'concealed']);
  });
});

describe('八仙過海 / 七搶一 (instant flower wins)', () => {
  const SEVEN = 'f1 f2 f3 f4 f5 f6 f7';
  /** Assert a finished flower win and return it. */
  const flowerWin = (s: GameState, kind: 'eight' | 'sevenRob') => {
    const w = win(s);
    expect(s.result!.wins).toHaveLength(1);
    expect(w.score.flowerWin).toBe(kind);
    expect(w.score.decomposition).toBeNull();
    expect(keysOf(w.score).filter((k) => k !== 'dealer' && k !== 'dealer_streak')).toEqual([kind === 'eight' ? 'eight_flowers' : 'seven_rob']);
    expect(w.flowers).toHaveLength(8);
    expect(isBonus(w.winningTile)).toBe(true);
    expect(w.hand.every((t) => !isBonus(t))).toBe(true);
    for (let seat = 0; seat < 4; seat++) expect(legalActions(s, seat)).toEqual([]);
    expect(s.result!.scoreDelta.reduce((a, b) => a + b, 0)).toBe(0);
    return w;
  };
  const isBonus = (t: number) => t >= 136;

  it('八仙過海 at the deal: the hand ends before the dealer draws and all three pay', () => {
    const s = dealt({}, [D1, D2, `123m 456m 78m ${SEVEN} f8`, D3], { back: ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p'] });
    const w = flowerWin(s, 'eight');
    expect(w.seat).toBe(2);
    expect(w.selfDrawn).toBe(true);
    expect(w.hand).toHaveLength(16);
    expect(s.players[0].hand).toHaveLength(16);
    expect(w.payments.map((p) => [p.from, p.tai])).toEqual([
      [0, 9],
      [1, 8],
      [3, 8],
    ]);
    expect(s.result!.dealerContinues).toBe(false);
    expect(tileTotal(s)).toBe(144);
  });

  it('七搶一 at the deal: the seat with seven takes the eighth and only its holder pays', () => {
    const s = dealt({}, [D1, `123m 456m 789m ${SEVEN}`, D2, 'ESWN CFB 369m 147p 25s f8'], {
      back: ['1p', '2p', '3p', '4p', '5p', '6p', '7p', '8s'],
    });
    const w = flowerWin(s, 'sevenRob');
    expect(w.seat).toBe(1);
    expect(w.selfDrawn).toBe(false);
    expect(w.fromSeat).toBe(3);
    expect(w.winningTile).toBe(143);
    expect(s.players[1].flowers).toContain(143);
    expect(s.players[3].flowers).toEqual([]);
    expect(w.payments).toEqual([{ from: 3, to: 1, tai: 8, points: 100 + 8 * 20 }]);
    expect(tileTotal(s)).toBe(144);
  });

  it('七搶一 on the dealer\'s 17th tile: the deal leaves seven in one seat and the dealer draws the eighth', () => {
    const s = dealt({}, [D1, D2, `123m 456m 789m ${SEVEN}`, D3], { front: ['f8'], back: ['1p', '2p', '3p', '4p', '5p', '6p', '7p'] });
    const w = flowerWin(s, 'sevenRob');
    expect(w.seat).toBe(2);
    expect(w.fromSeat).toBe(0);
    // The dealer pays 8 + 莊家 1.
    expect(w.payments).toEqual([{ from: 0, to: 2, tai: 9, points: 100 + 9 * 20 }]);
    expect(tileTotal(s)).toBe(144);
  });

  /** Seat 0 discards C; nobody can claim it, so seat 1 draws the next front tile. */
  const midHand = (seats: { s0?: string; s1?: string }) =>
    setup(
      {},
      [
        { hand: `${D1} C`, flowers: seats.s0 },
        { hand: D2, flowers: seats.s1 },
        D3,
        '147m 258m 147p 258p 147s 2s',
      ],
      10,
      { front: ['f8'] },
    );

  it('八仙過海 mid-hand: drawing the eighth bonus tile wins as a self-draw paid by all three', () => {
    let s = midHand({ s1: SEVEN });
    const before = tileTotal(s);
    s = discard(s, 0, 'C');
    const w = flowerWin(s, 'eight');
    expect(w.seat).toBe(1);
    expect(w.selfDrawn).toBe(true);
    expect(w.winningTile).toBe(143);
    expect(w.payments.map((p) => [p.from, p.tai])).toEqual([
      [0, 9],
      [2, 8],
      [3, 8],
    ]);
    expect(tileTotal(s)).toBe(before);
  });

  it('七搶一 mid-hand: the seven-holder takes the drawn eighth and only the drawer pays', () => {
    let s = midHand({ s0: SEVEN });
    const before = tileTotal(s);
    s = discard(s, 0, 'C');
    const w = flowerWin(s, 'sevenRob');
    expect(w.seat).toBe(0);
    expect(w.fromSeat).toBe(1);
    expect(s.players[0].flowers).toHaveLength(8);
    expect(s.players[1].flowers).toEqual([]);
    expect(w.hand).toHaveLength(16);
    // The dealer wins: 8 + 莊家 1, from the drawer alone.
    expect(w.payments).toEqual([{ from: 1, to: 0, tai: 9, points: 100 + 9 * 20 }]);
    expect(s.result!.dealerContinues).toBe(true);
    expect(tileTotal(s)).toBe(before);
  });

  it('a seat with seven flowers and the eighth still in the wall plays on', () => {
    const s = dealt({}, [D1, D2, `123m 456m 789m ${SEVEN}`, D3], { front: ['9p'], back: ['1p', '2p', '3p', '4p', '5p', '6p', '7p'] });
    expect(s.phase).toBe('discard');
    expect(s.players[2].flowers).toHaveLength(7);
    expect(s.players[0].hand).toHaveLength(17);
  });

  it('the action log of a mid-hand flower win reapplies to the same state hash', () => {
    for (const holder of ['s0', 's1'] as const) {
      const start = midHand({ [holder]: SEVEN });
      const end = discard(start, 0, 'C');
      flowerWin(end, holder === 's0' ? 'sevenRob' : 'eight');
      let again = midHand({ [holder]: SEVEN });
      for (const e of end.actionLog) again = applyAction(again, e.seat, e.action);
      expect(hashState(again)).toBe(hashState(end));
    }
  });

  /** Pass every claim, never declare, throw the drawn tile: the hand depends on the deal alone. */
  const drift = (s: GameState): GameState => {
    for (let steps = 0; s.phase !== 'ended'; steps++) {
      expect(steps).toBeLessThan(3000);
      const seat = [0, 1, 2, 3].find((i) => legalActions(s, i).length > 0)!;
      const acts = legalActions(s, seat);
      const pick: Action = acts.find((a) => a.type === 'pass') ?? acts.find((a) => a.type === 'discard' && a.tile === s.lastDrawn) ?? acts.find((a) => a.type === 'discard')!;
      s = applyAction(s, seat, pick);
    }
    return s;
  };

  it('replayHand reproduces the state hash of seeded hands that end in a flower win', () => {
    // fw60070 ends at the deal (七搶一); in fw46247 a seat holds seven bonus tiles after the deal and
    // takes the eighth when another seat draws it mid-hand.
    for (const [seed, atDeal] of [
      ['fw60070', true],
      ['fw46247', false],
    ] as const) {
      const start = newGame(seed);
      // The snapshot from before the deal: a hand won at the deal has already been settled into `scores`.
      const snap = { ...matchSnapshot(start), scores: [0, 0, 0, 0] };
      const end = drift(start);
      expect(end.result!.wins[0].score.flowerWin).toBe('sevenRob');
      expect(end.actionLog.length === 0).toBe(atDeal);
      expect(tileTotal(end)).toBe(144);
      const replayed = replayHand(snap, seed, start.rules, end.actionLog);
      expect(hashState(replayed)).toBe(hashState(end));
      expect(replayed.result).toEqual(end.result);
    }
  });
});
