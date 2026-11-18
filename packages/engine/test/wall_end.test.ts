import { describe, expect, it } from 'vitest';
import { applyAction, isBonusTile, legalActions, tilesRemaining, type GameState } from '../src/index';
import { discard, keysOf, respond, setup } from './helpers/state';

// docs/RULES.md, "Basics": a replacement for a flower or a kong is drawn only while a live tile is
// left (the dead wall is never touched), so a flower drawn as the last live tile ends the hand.

/** Hands that can never claim, win or form a pair. */
const D2 = 'ESWN CFB 258m 369p 147s';
const D3 = 'ESWN CFB 369m 147p 258s';
/** Seat 1 is ready on 5 Bamboo (and only on it). */
const WAITS_5S = '123456789m 123456p 5s';

/** Seat 0 discards 8 Bamboo, nobody calls, and seat 1 draws the next live tile. */
function seatOneDraws(s: GameState): GameState {
  s = discard(s, 0, '8s');
  return s.phase === 'claim' ? respond(s) : s;
}

describe('the end of the wall', () => {
  it('a flower drawn as the last live tile is set aside and the hand ends as a 流局, with no replacement', () => {
    // One live tile: the flower 梅. The 5 Bamboo seat 1 waits on is next at the back, but the back is past the last live tile.
    let s = setup({}, ['8s 147m 258p 369s EESSWW N', WAITS_5S, D2, D3], 1, {
      front: ['f1'],
      back: ['5s'],
    });
    const back = s.backIndex;
    s = seatOneDraws(s);
    expect(s.phase).toBe('ended');
    expect(s.result?.type).toBe('draw');
    expect(s.result?.wins).toEqual([]);
    expect(s.result?.scoreDelta).toEqual([0, 0, 0, 0]);
    // The flower is banked; nothing was drawn to replace it and the dead wall is whole.
    expect(s.players[1].flowers.filter(isBonusTile)).toHaveLength(1);
    expect(s.players[1].hand).toHaveLength(16);
    expect(s.backIndex).toBe(back);
    expect(tilesRemaining(s)).toBe(s.rules.deadWallSize);
    // A 流局 keeps the deal (drawKeepsDealer, on by default).
    expect(s.result?.dealerContinues).toBe(true);
  });

  it('one tile earlier the flower is replaced, and the replacement is the last live tile: 花上自摸 and 海底撈月', () => {
    let s = setup({}, ['8s 147m 258p 369s EESSWW N', WAITS_5S, D2, D3], 2, {
      front: ['f2'],
      back: ['5s'],
    });
    s = seatOneDraws(s);
    expect(s.phase).toBe('discard');
    expect(s.drawSource).toBe('flower');
    expect(s.lastTileDrawn).toBe(true);
    expect(tilesRemaining(s)).toBe(s.rules.deadWallSize);
    s = applyAction(s, 1, { type: 'hu' });
    expect(s.result?.type).toBe('win');
    const keys = keysOf(s.result!.wins[0].score);
    expect(keys).toContain('after_flower');
    expect(keys).toContain('last_tile_draw');
  });

  it('a kong replacement can be the last live tile too: 槓上開花 and 海底撈月', () => {
    let s = setup({}, ['9999s 123m 456m 789m 123p 5s', D2, D2, D3], 1, {
      back: ['5s'],
    });
    s = applyAction(s, 0, legalActions(s, 0).find((a) => a.type === 'kong')!);
    expect(s.drawSource).toBe('kong');
    expect(s.lastTileDrawn).toBe(true);
    s = applyAction(s, 0, { type: 'hu' });
    const keys = keysOf(s.result!.wins[0].score);
    expect(keys).toContain('after_kong');
    expect(keys).toContain('last_tile_draw');
  });

  it('a flower drawn as the last live tile still completes 八仙過海', () => {
    let s = setup({}, ['8s 147m 258p 369s EESSWW N', { hand: WAITS_5S, flowers: 'f1 f2 f3 f4 f5 f6 f7' }, D2, D3], 1, { front: ['f8'], back: ['5s'] });
    s = seatOneDraws(s);
    expect(s.result?.type).toBe('win');
    const w = s.result!.wins[0];
    expect(w.seat).toBe(1);
    expect(w.score.flowerWin).toBe('eight');
    expect(keysOf(w.score)).toContain('eight_flowers');
  });

  it('and a seat holding seven flowers takes it for 七搶一, paid by the seat that drew it', () => {
    let s = setup({}, ['8s 147m 258p 369s EESSWW N', WAITS_5S, { hand: D2, flowers: 'f1 f2 f3 f4 f5 f6 f7' }, D3], 1, { front: ['f8'], back: ['5s'] });
    s = seatOneDraws(s);
    expect(s.result?.type).toBe('win');
    const w = s.result!.wins[0];
    expect(w.seat).toBe(2);
    expect(w.score.flowerWin).toBe('sevenRob');
    expect(w.payments.map((p) => p.from)).toEqual([1]);
  });

  it('a kong is offered while a live tile is left to replace it, and not after the last one is drawn', () => {
    // Seat 0 holds four 9 Bamboo and has just drawn.
    const hand = '9999s 147m 258p 1367s ESW';
    expect(legalActions(setup({}, [hand, D2, D2, D3], 1), 0).some((a) => a.type === 'kong')).toBe(true);
    const last = setup({}, [hand, D2, D2, D3], 0);
    expect(legalActions(last, 0).some((a) => a.type === 'kong')).toBe(false);
  });

  it('a kong whose replacement is a flower with no live tile after it is made, and the hand ends as a 流局', () => {
    let s = setup({}, ['9999s 147m 258p 1367s ESW', D2, D2, D3], 1, {
      back: ['f3', '5s'],
    });
    const kong = legalActions(s, 0).find((a) => a.type === 'kong')!;
    s = applyAction(s, 0, kong);
    expect(s.players[0].melds.map((m) => m.type)).toEqual(['kong']);
    expect(s.players[0].flowers.filter(isBonusTile)).toHaveLength(1);
    expect(s.phase).toBe('ended');
    expect(s.result?.type).toBe('draw');
    expect(tilesRemaining(s)).toBe(s.rules.deadWallSize);
  });
});
