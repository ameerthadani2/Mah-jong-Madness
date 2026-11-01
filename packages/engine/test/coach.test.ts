import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, hintFor, kindOf, legalActions, newGame, NUM_PLAY_KINDS, reviewHand, matchSnapshot, shantenAfterClaim, unseenCounts, type GameState } from '../src/index';

function advanceToClaim(seed: string, pred: (s: GameState) => boolean): GameState | null {
  let s = newGame(seed);
  for (let i = 0; i < 400 && s.phase !== 'ended'; i++) {
    if (s.phase === 'claim' && pred(s)) return s;
    for (let seat = 0; seat < 4; seat++) {
      const a = chooseAction(s, seat, { seed: `c${seat}` });
      if (a) {
        s = applyAction(s, seat, a);
        break;
      }
    }
  }
  return null;
}

describe('coach accuracy', () => {
  it('counts a pending discard once when computing unseen tiles', () => {
    const s = advanceToClaim('unseen-1', (st) => st.pending!.kind === 'discard');
    expect(s).not.toBeNull();
    const seat = s!.pending!.offers[0].seat;
    const unseen = unseenCounts(s!, seat);
    // Total unseen = 136 - (own hand + all melds + all discards); the pending tile is inside the discards.
    const visible = s!.players[seat].hand.length + s!.players.reduce((n, p) => n + p.melds.reduce((m, x) => m + x.tiles.length, 0) + p.discards.length, 0);
    const playable = (t: number) => t < 136;
    const visiblePlayable = [...s!.players[seat].hand, ...s!.players.flatMap((p) => [...p.melds.flatMap((m) => m.tiles), ...p.discards])].filter(playable).length;
    expect(unseen.reduce((a, b) => a + b, 0)).toBe(NUM_PLAY_KINDS * 4 - visiblePlayable);
    expect(visible).toBeGreaterThan(0);
  });

  it('never says a claim fails to reduce shanten when it does', () => {
    let checked = 0;
    for (let i = 0; i < 40 && checked < 15; i++) {
      const s = advanceToClaim(`claimreason-${i}`, (st) => st.pending!.offers.some((o) => o.pong || o.chi.length > 0));
      if (!s) continue;
      for (const o of s.pending!.offers) {
        const h = hintFor(s, o.seat);
        for (const c of h.claims) {
          if (c.action.type !== 'pong' && c.action.type !== 'chi') continue;
          checked++;
          const after = shantenAfterClaim(s, o.seat, c.action);
          if (after < h.shanten) expect(c.reason).not.toMatch(/does not reduce/);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('marks at most one kong as recommended', () => {
    for (let i = 0; i < 60; i++) {
      let s = newGame(`kongs-${i}`);
      for (let step = 0; step < 300 && s.phase !== 'ended'; step++) {
        if (s.phase === 'discard') {
          const kongs = legalActions(s, s.turn).filter((a) => a.type === 'kong');
          if (kongs.length > 1) {
            const h = hintFor(s, s.turn);
            const rec = h.claims.filter((c) => c.action.type === 'kong' && c.recommended);
            expect(rec.length).toBeLessThanOrEqual(1);
            const pick = chooseAction(s, s.turn);
            if (rec.length === 1 && pick?.type === 'kong') expect(kindOf((rec[0].action as { tile: number }).tile)).toBe(kindOf(pick.tile));
          }
        }
        for (let seat = 0; seat < 4; seat++) {
          const a = chooseAction(s, seat, { seed: `k${seat}` });
          if (a) {
            s = applyAction(s, seat, a);
            break;
          }
        }
      }
    }
  });

  it('review explains a discard win as a win', () => {
    for (let i = 0; i < 80; i++) {
      const start = newGame(`ronreview-${i}`);
      let s = start;
      let guard = 0;
      while (s.phase !== 'ended' && guard++ < 3000) {
        for (let seat = 0; seat < 4; seat++) {
          const a = chooseAction(s, seat, { seed: `r${seat}` });
          if (a) {
            s = applyAction(s, seat, a);
            break;
          }
        }
      }
      const win = s.result?.wins.find((w) => !w.selfDrawn);
      if (!win) continue;
      const review = reviewHand(matchSnapshot(start), start.seed, start.rules, s.actionLog, win.seat);
      const huMove = review.moves.find((m) => m.actual.type === 'hu');
      expect(huMove).toBeDefined();
      expect(huMove!.explanation).toMatch(/win/i);
      return;
    }
  });
});
