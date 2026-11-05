import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, hintFor, isLegal, kindOf, kindsFromString, newGame, rankDiscards, threats, unseenCounts, type BotSkill, type GameState } from '../src/index';
import { coachAction, currentShanten } from '../src/bot';
import { discard, offers, setup, tileTotal } from './helpers/state';

interface Tally {
  seatHands: number;
  wins: number;
  points: number;
}

/** Play one hand with a skill per seat, failing on any illegal bot action or broken tile count. */
function playHand(s: GameState, skills: readonly BotSkill[]): GameState {
  let guard = 0;
  while (s.phase !== 'ended') {
    expect(guard++).toBeLessThan(2000);
    let acted = false;
    for (let seat = 0; seat < 4; seat++) {
      const a = chooseAction(s, seat, { seed: `t${seat}`, skill: skills[seat] });
      if (!a) continue;
      if (!isLegal(s, seat, a)) throw new Error(`illegal ${skills[seat]} action ${JSON.stringify(a)} by seat ${seat} at step ${s.turnCounter}`);
      s = applyAction(s, seat, a);
      acted = true;
      break;
    }
    expect(acted).toBe(true);
  }
  return s;
}

/** One `skill` bot in a rotating seat against three Club bots, on fixed seeds (as `simulate.ts --ladder`). */
function ladder(skill: BotSkill, hands: number): { test: Tally; club: Tally } {
  const test: Tally = { seatHands: 0, wins: 0, points: 0 };
  const club: Tally = { seatHands: 0, wins: 0, points: 0 };
  for (let h = 0; h < hands; h++) {
    const testSeat = h % 4;
    const r = playHand(newGame(`ladder-${h}`), [0, 1, 2, 3].map((seat): BotSkill => (seat === testSeat ? skill : 'club'))).result!;
    for (let seat = 0; seat < 4; seat++) {
      const t = seat === testSeat ? test : club;
      t.seatHands++;
      t.points += r.scoreDelta[seat];
      if (r.wins.some((w) => w.seat === seat)) t.wins++;
    }
  }
  return { test, club };
}

/**
 * Paired (common random numbers) comparison, as `simulate.ts --ladder`: each seed is played twice,
 * once with `skill` in the rotating test seat and once with Club there, and the test seat's
 * score difference is taken hand by hand.
 */
function pairedLadder(skill: BotSkill, hands: number, prefix: string): { mean: number; se: number } {
  const diffs: number[] = [];
  for (let h = 0; h < hands; h++) {
    const testSeat = h % 4;
    const withSkill = playHand(newGame(`${prefix}-${h}`), [0, 1, 2, 3].map((seat): BotSkill => (seat === testSeat ? skill : 'club'))).result!;
    const baseline = playHand(newGame(`${prefix}-${h}`), ['club', 'club', 'club', 'club']).result!;
    diffs.push(withSkill.scoreDelta[testSeat] - baseline.scoreDelta[testSeat]);
  }
  const mean = diffs.reduce((a, b) => a + b, 0) / hands;
  const variance = diffs.reduce((a, b) => a + (b - mean) ** 2, 0) / (hands - 1);
  return { mean, se: Math.sqrt(variance / hands) };
}

const winRate = (t: Tally) => t.wins / t.seatHands;

/**
 * Seat 0 (dealer, East; East round) to discard. Seat 1 has four exposed pongs, so it looks ready,
 * and has thrown `safe`.
 */
function threatened(hand: string, safe: string): GameState {
  const s = setup({}, [hand, { hand: '2s 3s 4s E', melds: [{ type: 'pong', tiles: 'WWW' }, { type: 'pong', tiles: 'CCC' }, { type: 'pong', tiles: 'FFF' }, { type: 'pong', tiles: '999s' }] }, '', ''], 30);
  // Copy 3 of the kind is never handed out by `setup` for these hands.
  s.players[1].discards = kindsFromString(safe).map((k) => k * 4 + 3);
  return s;
}

const pick = (s: GameState, skill: BotSkill) => {
  const a = chooseAction(s, 0, { skill, seed: 'x' });
  if (a?.type !== 'discard') throw new Error('expected a discard');
  return rankDiscards(s, 0, skill).find((r) => r.kind === kindOf(a.tile))!;
};

describe('bot decisions', () => {
  it('reads only what the table shows: another seat’s concealed kong stays unseen', () => {
    const s = setup({}, ['123m 456m 789m 123p 55p 7s E N', { hand: '1s 2s 3s 4s', melds: [{ type: 'kong', tiles: '9999p', concealed: true }, { type: 'pong', tiles: 'SSS' }] }, '', ''], 30);
    const unseen = unseenCounts(s, 0);
    expect(unseen[kindsFromString('9p')[0]]).toBe(4);
    expect(unseen[kindsFromString('S')[0]]).toBe(1);
    // The kong's owner does know their own tiles.
    expect(unseenCounts(s, 1)[kindsFromString('9p')[0]]).toBe(0);
  });

  it('throws a lone non-value honour before a lone value honour (Club and Pro)', () => {
    // Dealer in the East round: 東 is both seat and round wind, 北 scores nothing.
    const s = setup({}, ['123m 456m 789m 123p 55p 7s E N', '', '', ''], 30);
    const [east, north] = kindsFromString('E N');
    for (const skill of ['club', 'pro'] as const) {
      const ranked = rankDiscards(s, 0, skill);
      const score = (k: number) => ranked.find((r) => r.kind === k)!.score;
      expect(score(north)).toBeGreaterThan(score(east));
    }
  });

  it('scores the threat of each opponent from their exposed melds and discards', () => {
    const s = threatened('24677m 3568p 24578s 2m 5p 3s', '6p');
    expect(threats(s, 0)).toEqual([0, 1, 0, 0]);
    s.players[1].melds.pop();
    expect(threats(s, 0)[1]).toBe(0);
    s.players[1].discards = Array.from({ length: 8 }, (_, i) => (18 + i) * 4 + 3);
    expect(threats(s, 0)[1]).toBe(0.6);
  });

  it('Pro folds against a ready-looking opponent when far from ready; Club pushes; with no threat Pro plays for speed', () => {
    // Three from ready: the only tile seat 1 has thrown (4s) costs a step of shanten.
    const s = threatened('24677m 3568p 24578s 2m 5p 3s', '4s');
    const best = Math.min(...rankDiscards(s, 0, 'club').map((r) => r.shanten));
    const pro = pick(s, 'pro');
    expect(pro.kind).toBe(kindsFromString('4s')[0]);
    expect(pro.danger).toBe(0);
    expect(pro.shanten).toBe(best + 1);
    const club = pick(s, 'club');
    expect(club.shanten).toBe(best);
    expect(club.danger).toBeGreaterThan(0);
    expect(pick(s, 'beginner').danger).toBe(0); // Beginners never measure danger.
    // Same hand, nobody threatening: Pro takes the efficient discard.
    s.players[1].melds = [];
    expect(pick(s, 'pro').shanten).toBe(best);
  });

  it('a ready concealed hand passes on a claimed kong rather than lose 門清 (Club, Pro and the coach)', () => {
    // From the bots review probe (kongclaim): seat 2 is ready and concealed with 555p; seat 0 throws 5p.
    const s = discard(setup({}, ['5p 456s 789s 123p 78p NN SS W', '', '123m 456m 789m 555p 23s EE', ''], 30), 0, '5p');
    expect(offers(s)[2]).toMatchObject({ pong: true, kong: true, hu: false });
    expect(currentShanten(s, 2)).toBe(0);
    for (const skill of ['club', 'pro'] as const) expect(chooseAction(s, 2, { skill, seed: 'k' })).toEqual({ type: 'pass' });
    expect(coachAction(s, 2)).toEqual({ type: 'pass' });
    // Once the hand is open there is no 門清 to keep, and the kong is taken.
    const open = discard(setup({}, ['5p 456s 789s 123p 78p NN SS W', '', { hand: '123m 456m 555p 23s EE', melds: [{ type: 'pong', tiles: '999m' }] }, ''], 30), 0, '5p');
    expect(currentShanten(open, 2)).toBe(0);
    for (const skill of ['club', 'pro'] as const) expect(chooseAction(open, 2, { skill, seed: 'k' })?.type).toBe('kong');
  });

  it('a fully dead honour carries no deal-in risk', () => {
    // Seat 0 holds the last 北: the other three are in seat 2's discards.
    const s = threatened('24677m 3568p 24578s 2m 5p N', '6p');
    const north = kindsFromString('N')[0];
    s.players[2].discards = [north * 4 + 1, north * 4 + 2, north * 4 + 3];
    expect(unseenCounts(s, 0)[north]).toBe(0);
    for (const skill of ['club', 'pro'] as const) expect(rankDiscards(s, 0, skill).find((r) => r.kind === north)!.danger).toBe(0);
    // With one copy still unseen it is nearly, not completely, safe.
    s.players[2].discards.pop();
    expect(rankDiscards(s, 0, 'pro').find((r) => r.kind === north)!.danger).toBeGreaterThan(0);
  });

  it('Pro and the coach always throw the top-ranked tile, so the hint and the coach agree', () => {
    // From the bots review probe (diff): ties used to be broken by the RNG on about 8% of turns.
    let turns = 0;
    for (let g = 0; turns < 100; g++) {
      let s = newGame(`det-${g}`);
      for (let step = 0; step < 3000 && s.phase !== 'ended' && turns < 100; step++) {
        if (s.phase === 'discard') {
          const seat = s.turn;
          const coach = coachAction(s, seat)!;
          if (coach.type === 'discard') {
            turns++;
            const top = rankDiscards(s, seat, 'pro')[0];
            expect(coach.tile).toBe(top.tile);
            expect(kindOf(coach.tile)).toBe(hintFor(s, seat).bestDiscard!.kind);
            expect(chooseAction(s, seat, { skill: 'pro', seed: 'another' })).toEqual(coach);
          }
        }
        for (let seat = 0; seat < 4; seat++) {
          const a = chooseAction(s, seat, { seed: `p${seat}`, skill: 'pro' });
          if (a) {
            s = applyAction(s, seat, a);
            break;
          }
        }
      }
    }
    expect(turns).toBe(100);
  });

  it('Pro keeps pushing when one from ready', () => {
    const s = threatened('234m 567m 3568p 24578s 5p 3s', '5m');
    const best = Math.min(...rankDiscards(s, 0, 'pro').map((r) => r.shanten));
    expect(best).toBe(1);
    const pro = pick(s, 'pro');
    expect(pro.shanten).toBe(1);
    expect(pro.danger).toBeGreaterThan(0);
  });
});

describe('bot strength ladder (fixed seeds)', () => {
  it('Club wins clearly more often than Beginner', () => {
    const { test: beginner, club } = ladder('beginner', 80);
    expect(winRate(club)).toBeGreaterThan(winRate(beginner) + 0.1);
    expect(beginner.wins).toBeGreaterThan(0);
  }, 120_000);

  it('four Beginners still finish most hands with a win', () => {
    const hands = 60;
    let draws = 0;
    for (let h = 0; h < hands; h++) if (playHand(newGame(`beg4-${h}`), ['beginner', 'beginner', 'beginner', 'beginner']).result!.type !== 'win') draws++;
    expect(draws / hands).toBeLessThan(0.5);
  }, 120_000);

  it('Pro is not measurably worse than Club in a paired comparison on the same seeds', () => {
    // A hand's score swings by about 180 points, so 60 paired hands cannot show a small edge either
    // way. What they can show is that Pro is not clearly worse: the 95% interval for Pro minus Club
    // must reach -1 pt/hand. A Pro regression of tens of points a hand fails this.
    const { mean, se } = pairedLadder('pro', 60, 'paired');
    expect(se).toBeGreaterThan(0);
    expect(mean + 1.96 * se).toBeGreaterThanOrEqual(-1);
  }, 30_000);

  it('no skill ever makes an illegal move or loses a tile', () => {
    const lineups: BotSkill[][] = [
      ['beginner', 'club', 'pro', 'club'],
      ['pro', 'beginner', 'club', 'pro'],
      ['club', 'pro', 'beginner', 'beginner'],
      ['pro', 'pro', 'pro', 'beginner'],
    ];
    let wins = 0;
    for (let h = 0; h < 200; h++) {
      let s = newGame(`legal-${h}`);
      expect(tileTotal(s)).toBe(144);
      s = playHand(s, lineups[h % 4]);
      expect(tileTotal(s)).toBe(144);
      if (s.result!.type === 'win') wins++;
    }
    expect(wins).toBeGreaterThan(100);
  }, 120_000);
});
