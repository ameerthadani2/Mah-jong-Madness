import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, isLegal, kindOf, kindsFromString, newGame, rankDiscards, threats, unseenCounts, type BotSkill, type GameState } from '../src/index';
import { setup, tileTotal } from './helpers/state';

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

const winRate = (t: Tally) => t.wins / t.seatHands;
const perHand = (t: Tally) => t.points / t.seatHands;

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

  it('Pro scores at least as well as Club, within a small margin', () => {
    const { test: pro, club } = ladder('pro', 120);
    expect(perHand(pro)).toBeGreaterThanOrEqual(perHand(club) - 2);
  }, 120_000);

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
