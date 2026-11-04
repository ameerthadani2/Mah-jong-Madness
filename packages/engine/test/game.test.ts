import { describe, expect, it } from 'vitest';
import {
  applyAction,
  chooseAction,
  hashState,
  IllegalAction,
  kindOf,
  legalActions,
  newGame,
  nextHand,
  replay,
  tilesRemaining,
  viewFor,
  withRules,
  type GameState,
  type LoggedAction,
  hintFor,
  KINDS,
} from '../src/index';

function tileTotal(s: GameState): number {
  return (
    s.players.reduce((n, p) => n + p.hand.length + p.melds.reduce((m, x) => m + x.tiles.length, 0) + p.flowers.length + p.discards.length, 0) +
    tilesRemaining(s)
  );
}

function playHand(s: GameState): GameState {
  let steps = 0;
  while (s.phase !== 'ended') {
    expect(tileTotal(s)).toBe(144);
    let acted = false;
    for (let seat = 0; seat < 4; seat++) {
      const a = chooseAction(s, seat, { seed: `t${seat}` });
      if (a) {
        s = applyAction(s, seat, a);
        acted = true;
        break;
      }
    }
    expect(acted).toBe(true);
    expect(++steps).toBeLessThan(2000);
  }
  return s;
}

describe('deal', () => {
  it('deals 16 tiles to each player and 17 to the dealer, flowers replaced', () => {
    const s = newGame('seed-1');
    for (let i = 0; i < 4; i++) {
      const p = s.players[i];
      expect(p.hand.every((t) => t < 136)).toBe(true);
      expect(p.hand.length).toBe(i === s.dealerSeat ? 17 : 16);
    }
    expect(s.phase).toBe('discard');
    expect(s.turn).toBe(s.dealerSeat);
    expect(tileTotal(s)).toBe(144);
  });
  it('is deterministic for the same seed', () => {
    expect(hashState(newGame('abc'))).toBe(hashState(newGame('abc')));
    expect(hashState(newGame('abc'))).not.toBe(hashState(newGame('abd')));
  });
});

describe('legal actions', () => {
  it('only the current player may act in the discard phase', () => {
    const s = newGame('seed-2');
    for (let i = 0; i < 4; i++) {
      const acts = legalActions(s, i);
      if (i === s.dealerSeat) expect(acts.some((a) => a.type === 'discard')).toBe(true);
      else expect(acts).toEqual([]);
    }
  });
  it('rejects illegal actions', () => {
    const s = newGame('seed-3');
    const other = (s.dealerSeat + 1) % 4;
    expect(() => applyAction(s, other, { type: 'discard', tile: s.players[other].hand[0] })).toThrow(IllegalAction);
    expect(() => applyAction(s, s.dealerSeat, { type: 'discard', tile: s.players[other].hand[0] })).toThrow(IllegalAction);
  });
  it('does not mutate the previous state', () => {
    const s = newGame('seed-4');
    const before = hashState(s);
    applyAction(s, s.dealerSeat, { type: 'discard', tile: s.players[s.dealerSeat].hand[0] });
    expect(hashState(s)).toBe(before);
  });
});

describe('full hands with bots', () => {
  it('plays many hands to completion with tile conservation', () => {
    for (let i = 0; i < 12; i++) {
      const s = playHand(newGame(`match-${i}`));
      expect(s.result).toBeDefined();
      expect(tileTotal(s)).toBe(144);
      if (s.result!.type === 'win') {
        const delta = s.result!.scoreDelta.reduce((a, b) => a + b, 0);
        expect(delta).toBe(0);
        for (const w of s.result!.wins) {
          // 八仙過海 / 七搶一 are won on bonus tiles alone: no hand shape to check.
          if (w.score.flowerWin) {
            expect(w.score.decomposition).toBeNull();
            expect(w.flowers).toHaveLength(8);
            continue;
          }
          expect(w.score.decomposition).not.toBeNull();
          expect(w.hand.length + w.melds.length * 3).toBe(17);
        }
      }
    }
  });
  it('plays a whole match and rotates dealer / wind correctly', () => {
    let s = newGame('full-match', withRules({ handsPerMatch: 4 }));
    let hands = 0;
    while (!s.matchOver) {
      s = playHand(s);
      const dealerBefore = s.dealerSeat;
      const continues = s.result!.dealerContinues;
      s = nextHand(s);
      hands++;
      if (!s.matchOver) {
        if (continues) expect(s.dealerSeat).toBe(dealerBefore);
        else expect(s.dealerSeat).toBe((dealerBefore + 1) % 4);
      }
      expect(hands).toBeLessThan(60);
    }
    expect(s.dealerRotations).toBe(4);
    expect(s.prevailingWind).toBe(1);
    expect(s.scores.reduce((a, b) => a + b, 0)).toBe(0);
  });
  it('replays an action log to the identical state', () => {
    let s = newGame('replay-me');
    const logs: LoggedAction[][] = [];
    for (let h = 0; h < 3; h++) {
      if (h > 0) s = nextHand(s);
      s = playHand(s);
      logs.push(s.actionLog);
    }
    const r = replay('replay-me', s.rules, 0, logs);
    expect(hashState(r)).toBe(hashState(s));
  });
});

describe('claims', () => {
  it('offers pong/chi only to eligible seats and resolves priority', () => {
    // Search seeds for a discard that creates a pending claim with ≥1 offer.
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      let s = newGame(`claim-${i}`);
      for (let step = 0; step < 200 && s.phase !== 'ended'; step++) {
        if (s.phase === 'claim') {
          const pending = s.pending!;
          for (const o of pending.offers) {
            expect(o.seat).not.toBe(pending.from);
            if (o.chi.length) expect(o.seat).toBe((pending.from + 1) % 4);
            const acts = legalActions(s, o.seat);
            expect(acts.some((a) => a.type === 'pass')).toBe(true);
            if (o.pong) expect(acts.some((a) => a.type === 'pong')).toBe(true);
          }
          // Seats without offers cannot act
          for (let seat = 0; seat < 4; seat++) {
            if (!pending.offers.some((o) => o.seat === seat)) expect(legalActions(s, seat)).toEqual([]);
          }
          found = true;
          break;
        }
        for (let seat = 0; seat < 4; seat++) {
          const a = chooseAction(s, seat);
          if (a) {
            s = applyAction(s, seat, a);
            break;
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});

describe('views and hints', () => {
  it('hides other hands and the wall from a seat view', () => {
    const s = newGame('view');
    const v = viewFor(s, 1);
    expect(v.players[1].hand).toBeDefined();
    expect(v.players[0].hand).toBeUndefined();
    expect(v.players[0].handCount).toBe(s.players[0].hand.length);
    expect((v as unknown as { wall?: unknown }).wall).toBeUndefined();
  });
  it('produces a discard recommendation with a reason', () => {
    const s = newGame('hint');
    const h = hintFor(s, s.dealerSeat);
    expect(h.bestDiscard).toBeDefined();
    expect(h.discardReason).toMatch(/Discard/);
    expect(h.discards.length).toBeGreaterThan(0);
    expect(KINDS[kindOf(h.bestDiscard!.tile)]).toBeDefined();
  });
});
