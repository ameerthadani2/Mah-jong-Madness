import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, coachAction, hintFor, kindOf, legalActions, newGame, NUM_PLAY_KINDS, reviewHand, matchSnapshot, shantenAfterClaim, unseenCounts, type Action, type GameState } from '../src/index';

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

/** What a player who always follows the coach's hint would do, or null if it is not their move. */
function followHint(s: GameState, seat: number): Action | null {
  const legal = legalActions(s, seat);
  if (legal.length === 0) return null;
  if (legal.some((a) => a.type === 'hu')) return { type: 'hu' };
  const h = hintFor(s, seat);
  const claim = h.claims.find((c) => c.recommended);
  if (claim) return claim.action;
  if (s.phase === 'discard') return { type: 'discard', tile: h.bestDiscard!.tile };
  return { type: 'pass' };
}

describe('coach accuracy', () => {
  it('counts a pending discard once when computing unseen tiles', () => {
    const s = advanceToClaim('unseen-1', (st) => st.pending!.kind === 'discard');
    expect(s).not.toBeNull();
    const seat = s!.pending!.offers[0].seat;
    const unseen = unseenCounts(s!, seat);
    // Total unseen = 136 - (own hand + own melds + others' exposed melds + all discards); the pending tile is inside the discards.
    const seen = (i: number) => s!.players[i].melds.filter((m) => i === seat || !m.concealed).flatMap((m) => m.tiles);
    const visiblePlayable = [...s!.players[seat].hand, ...s!.players.flatMap((p, i) => [...seen(i), ...p.discards])].filter((t) => t < 136).length;
    expect(visiblePlayable).toBeGreaterThan(s!.players[seat].hand.length);
    expect(unseen.reduce((a, b) => a + b, 0)).toBe(NUM_PLAY_KINDS * 4 - visiblePlayable);
  });

  it('never says a claim fails to reduce shanten when it does', () => {
    let checked = 0;
    let improving = 0;
    for (let i = 0; i < 40 && checked < 15; i++) {
      const s = advanceToClaim(`claimreason-${i}`, (st) => st.pending!.offers.some((o) => o.pong || o.chi.length > 0));
      if (!s) continue;
      for (const o of s.pending!.offers) {
        const h = hintFor(s, o.seat);
        for (const c of h.claims) {
          if (c.action.type !== 'pong' && c.action.type !== 'chi') continue;
          checked++;
          const after = shantenAfterClaim(s, o.seat, c.action);
          if (after < h.shanten) {
            improving++;
            expect(c.reason).not.toMatch(/does not reduce/);
            expect(c.reasonKey).not.toMatch(/noGain/);
          } else {
            expect(c.reason).toMatch(/does not reduce|already ready/);
            expect(c.reasonKey).toMatch(/^hint\.claim\.(noGain|alreadyReady)/);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(improving).toBeGreaterThan(0);
  });

  it('marks at most one kong as recommended', () => {
    let cases = 0;
    for (let i = 0; i < 60; i++) {
      let s = newGame(`kongs-${i}`);
      for (let step = 0; step < 300 && s.phase !== 'ended'; step++) {
        if (s.phase === 'discard') {
          const kongs = legalActions(s, s.turn).filter((a) => a.type === 'kong');
          if (kongs.length > 0) {
            cases++;
            const h = hintFor(s, s.turn);
            const rec = h.claims.filter((c) => c.action.type === 'kong' && c.recommended);
            expect(rec.length).toBeLessThanOrEqual(1);
            // The hint recommends exactly the kong the coach would make, and none when it would not.
            const pick = coachAction(s, s.turn);
            if (rec.length === 1) expect(pick?.type === 'kong' && kindOf(pick.tile)).toBe(kindOf((rec[0].action as { tile: number }).tile));
            else expect(pick?.type).not.toBe('kong');
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
    expect(cases).toBeGreaterThan(0);
  });

  it('review explains a discard win as a win', () => {
    let found = false;
    for (let i = 0; i < 80 && !found; i++) {
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
      found = true;
      const review = reviewHand(matchSnapshot(start), start.seed, start.rules, s.actionLog, win.seat);
      const huMove = review.moves.find((m) => m.actual.type === 'hu');
      expect(huMove).toBeDefined();
      expect(huMove!.explanation).toMatch(/win/i);
      expect(huMove!.reasonKey).toMatch(/^review\.(call\.tookWin|turn\.win)$/);
    }
    expect(found).toBe(true);
  });

  it('a player who follows every hint, claims included, reviews as best on every move', () => {
    let claimsFollowed = 0;
    let callsFollowed = 0;
    for (let i = 0; i < 12; i++) {
      const start = newGame(`follow-${i}`);
      const follower = i % 4;
      let s = start;
      for (let step = 0; step < 400 && s.phase !== 'ended'; step++) {
        for (let seat = 0; seat < 4; seat++) {
          const a = seat === follower ? followHint(s, seat) : chooseAction(s, seat, { seed: `f${seat}` });
          if (!a) continue;
          if (seat === follower && s.phase === 'claim' && a.type !== 'hu') {
            claimsFollowed++;
            if (a.type !== 'pass') callsFollowed++;
          }
          s = applyAction(s, seat, a);
          break;
        }
      }
      expect(s.phase).toBe('ended');
      const review = reviewHand(matchSnapshot(start), start.seed, start.rules, s.actionLog, follower);
      expect(review.moves.length).toBeGreaterThan(0);
      for (const m of review.moves) expect({ n: m.n, phase: m.phase, grade: m.grade }).toEqual({ n: m.n, phase: m.phase, grade: 'best' });
    }
    expect(claimsFollowed).toBeGreaterThan(0);
    expect(callsFollowed).toBeGreaterThan(0);
  });
});
