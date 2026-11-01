import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, IllegalAction, isLegal, kindOf, legalActions, newGame, viewFor, type Action, type GameState } from '../src/index';

function playUntil(s: GameState, pred: (s: GameState) => boolean, max = 3000): GameState | null {
  let guard = 0;
  while (!pred(s) && s.phase !== 'ended' && guard++ < max) {
    for (let seat = 0; seat < 4; seat++) {
      const a = chooseAction(s, seat, { seed: `x${seat}` });
      if (a) {
        s = applyAction(s, seat, a);
        break;
      }
    }
  }
  return pred(s) ? s : null;
}

describe('hardening', () => {
  it('seat views never contain the seed or the wall', () => {
    const s = newGame('leak');
    const v = viewFor(s, 0) as unknown as Record<string, unknown>;
    expect(v.seed).toBeUndefined();
    expect(v.wall).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(s.seed);
  });

  it('no self-draw hu is offered right after a pong/chi (no drawn tile)', () => {
    for (let i = 0; i < 30; i++) {
      const s = playUntil(newGame(`claimhu-${i}`), (st) => st.phase === 'discard' && st.drawSource === 'claim');
      if (!s) continue;
      const acts = legalActions(s, s.turn);
      expect(acts.some((a) => a.type === 'hu')).toBe(false);
    }
  });

  it('rejects kong/discard/chi actions whose tile ids are not in hand', () => {
    const s = newGame('ids');
    const seat = s.turn;
    const other = (seat + 1) % 4;
    const foreign = s.players[other].hand[0];
    expect(isLegal(s, seat, { type: 'discard', tile: foreign })).toBe(false);
    expect(isLegal(s, seat, { type: 'kong', tile: foreign })).toBe(false);
    expect(() => applyAction(s, seat, { type: 'discard', tile: 'abc' as unknown as number })).toThrow(IllegalAction);
    expect(() => applyAction(s, seat, { type: 'chi', tiles: [1] as unknown as [number, number] })).toThrow(IllegalAction);
    expect(() => applyAction(s, 7, { type: 'pass' })).toThrow(IllegalAction);
    expect(() => applyAction(s, seat, null as unknown as Action)).toThrow(IllegalAction);
  });

  it('an added kong uses a tile from the hand and keeps tile conservation', () => {
    // Find a state where an added kong is legal.
    for (let i = 0; i < 60; i++) {
      const s = playUntil(newGame(`addkong-${i}`), (st) => st.phase === 'discard' && legalActions(st, st.turn).some((a) => a.type === 'kong' && st.players[st.turn].melds.some((m) => m.type === 'pong' && kindOf(m.tiles[0]) === kindOf((a as { tile: number }).tile))));
      if (!s) continue;
      const seat = s.turn;
      const kong = legalActions(s, seat).find((a) => a.type === 'kong')!;
      // Try to cheat with the id of a tile already inside the pong meld
      const meld = s.players[seat].melds.find((m) => m.type === 'pong' && kindOf(m.tiles[0]) === kindOf((kong as { tile: number }).tile))!;
      expect(() => applyAction(s, seat, { type: 'kong', tile: meld.tiles[0] })).toThrow(IllegalAction);
      const next = applyAction(s, seat, kong);
      const total = next.players.reduce((n, p) => n + p.hand.length + p.melds.reduce((m, x) => m + x.tiles.length, 0) + p.flowers.length + p.discards.length, 0) + (next.backIndex - next.drawIndex);
      expect(total).toBe(144);
      const ids = next.players.flatMap((p) => [...p.hand, ...p.melds.flatMap((m) => m.tiles), ...p.flowers, ...p.discards]);
      expect(new Set(ids).size).toBe(ids.length);
      return;
    }
  });

  it('strips junk fields from logged actions', () => {
    const s = newGame('junk');
    const tile = s.players[s.turn].hand[0];
    const next = applyAction(s, s.turn, { type: 'discard', tile, evil: 'x'.repeat(1000) } as unknown as Action);
    expect(JSON.stringify(next.actionLog[0].action)).toBe(JSON.stringify({ type: 'discard', tile }));
  });
});
