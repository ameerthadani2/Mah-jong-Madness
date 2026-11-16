import { describe, expect, it } from 'vitest';
import { applyAction, BOT_WEIGHTS, chooseAction, countsFromKinds, newGame, kindFromCode, kindsFromString, NUM_PLAY_KINDS, rankDiscards, readOpponents, readyLookahead, readyWaitAfterDraw, shapeFactor, unseenCounts, waitChance, type Counts, type GameState } from '../src/index';
import { setup } from './helpers/state';

const k = kindFromCode;
const all = (n: number): Counts => new Array<number>(NUM_PLAY_KINDS).fill(n);

/** Run `body` with some BOT_WEIGHTS overridden, restoring them after. */
function withWeights(over: Partial<typeof BOT_WEIGHTS>, body: () => void): void {
  const saved = { ...BOT_WEIGHTS };
  try {
    Object.assign(BOT_WEIGHTS, over);
    body();
  } finally {
    Object.assign(BOT_WEIGHTS, saved);
  }
}

describe('look-ahead one from ready (proLookahead)', () => {
  // One set and a pair to make from 4m 5m 1p 9p: one from ready.
  const hand = countsFromKinds(kindsFromString('45m 1p 9p'));

  it('counts the live tiles of the best wait a ready-making draw leaves', () => {
    const unseen = all(3);
    // 1p pairs: throw 9p, two-sided wait on 3m and 6m.
    expect(readyWaitAfterDraw(hand, 1, unseen, k('1p'))).toBe(6);
    // 3m makes the set: a single wait on 1p or 9p.
    expect(readyWaitAfterDraw(hand, 1, unseen, k('3m'))).toBe(3);
    // The copy just drawn is no longer live: 9p pairs, and the wait is 3m and 6m, three each.
    expect(readyWaitAfterDraw(hand, 1, unseen, k('9p'))).toBe(6);
    // A draw that does not make the hand ready is worth nothing.
    expect(readyWaitAfterDraw(hand, 1, unseen, k('7s'))).toBe(0);
  });

  it('values a wait on tiles that are all in sight at nothing', () => {
    const unseen = all(3);
    unseen[k('3m')] = 0;
    unseen[k('6m')] = 0;
    expect(readyWaitAfterDraw(hand, 1, unseen, k('1p'))).toBe(0);
    // Drawing 3m is impossible here, but the single wait it would leave on 1p is still live.
    expect(readyWaitAfterDraw(hand, 1, unseen, k('6m'))).toBe(3);
  });

  it('sums each ready-making draw by its unseen copies times the wait it leaves', () => {
    const unseen = all(3);
    const accepts = kindsFromString('3m 6m 1p 9p');
    expect(readyLookahead(hand, 1, unseen, accepts)).toBe(3 * 3 + 3 * 3 + 3 * 6 + 3 * 6);
  });

  it('is off by default and changes no ranking then; switched on, it can prefer the shape with the better wait', () => {
    expect(BOT_WEIGHTS.proLookahead).toBe(0);
    const s = setup({}, ['123m 456m 789m 789m 2p 3s 7s 99s', '', '', ''], 48);
    const plain = rankDiscards(s, 0, 'pro');
    withWeights({ proLookahead: 0 }, () => expect(rankDiscards(s, 0, 'pro')).toEqual(plain));
    withWeights({ proLookahead: 1 }, () => {
      const on = rankDiscards(s, 0, 'pro');
      // Same shanten and acceptance reported (the hint shows them), only the score moves.
      for (const r of on) {
        const p = plain.find((x) => x.kind === r.kind)!;
        expect([r.shanten, r.acceptance]).toEqual([p.shanten, p.acceptance]);
      }
      expect(on[0].shanten).toBe(1);
      // The top choice under the look-ahead has the best wait-weighted acceptance of the one-from-ready discards.
      const counts = countsFromKinds(s.players[0].hand.map((t) => Math.floor(t / 4)));
      const unseen = unseenCounts(s, 0);
      const look = (kind: number) => {
        counts[kind]--;
        const v = readyLookahead(counts, 5, unseen, on.find((r) => r.kind === kind)!.accepts);
        counts[kind]++;
        return v;
      };
      const best = Math.max(...on.filter((r) => r.shanten === 1).map((r) => look(r.kind)));
      expect(look(on[0].kind)).toBe(best);
      expect(on[0].kind).not.toBe(plain[0].kind);
    });
  });
});

describe('shape read of a wait (proShapeRead)', () => {
  it('is 1 with three unseen copies around a tile and for an honour', () => {
    expect(shapeFactor(k('5m'), all(3))).toBeCloseTo(1, 10);
    expect(shapeFactor(k('1p'), all(3))).toBeCloseTo(1, 10);
    expect(shapeFactor(k('E'), all(0))).toBe(1);
  });

  it('leaves only a pair wait when every shape around the tile is in sight (壁)', () => {
    const unseen = all(3);
    unseen[k('4m')] = 0;
    unseen[k('6m')] = 0;
    // Every shape that waits on 5m needs a 4m or a 6m.
    expect(shapeFactor(k('5m'), unseen)).toBeCloseTo(0.3 / 1.3, 10);
    // 1m waits only on 2m 3m: with 2m gone, so is that shape.
    const edge = all(3);
    edge[k('2m')] = 0;
    expect(shapeFactor(k('1m'), edge)).toBeCloseTo(0.3 / 1.3, 10);
    // More unseen copies around a tile make it more likely to be a wait.
    expect(shapeFactor(k('5m'), all(4))).toBeGreaterThan(1);
  });

  it('is off by default: waitChance and Pro ranking read as before unless switched on', () => {
    expect(BOT_WEIGHTS.proShapeRead).toBe(0);
    const s = setup({}, ['123m 456m 789m 123p 55p 7s E N', '', '', ''], 20);
    // Seat 1 has thrown twelve tiles: it may well be ready.
    s.players[1].discards = kindsFromString('1m 9p W S 2s 3s 8p 9s 1s 2p 3p F').map((kind) => kind * 4 + 3);
    const unseen = unseenCounts(s, 0);
    const read = readOpponents(s, 0)[1];
    for (let kind = 0; kind < NUM_PLAY_KINDS; kind++) expect(waitChance(read, kind, unseen, false)).toBe(waitChance(read, kind, unseen));
    const plain = rankDiscards(s, 0, 'pro');
    withWeights({ proShapeRead: 0 }, () => expect(rankDiscards(s, 0, 'pro')).toEqual(plain));
    withWeights({ proShapeRead: 1 }, () => {
      const on = rankDiscards(s, 0, 'pro');
      for (const r of on) {
        const p = plain.find((x) => x.kind === r.kind)!;
        const f = shapeFactor(r.kind, unseen);
        expect(r.danger).toBeCloseTo(p.danger * f, 10);
      }
    });
    // Club never reads shapes.
    const club = rankDiscards(s, 0, 'club');
    withWeights({ proShapeRead: 1 }, () => expect(rankDiscards(s, 0, 'club')).toEqual(club));
    expect(plain.some((r) => r.danger > 0)).toBe(true);
  });
});

/** Every discard decision of a few Club tables (seeded), as states to rank. */
function discardStates(seeds: number): GameState[] {
  const out: GameState[] = [];
  for (let h = 0; h < seeds; h++) {
    let s = newGame(`model-${h}`);
    while (s.phase !== 'ended') {
      for (let q = 0; q < 4; q++) {
        const a = chooseAction(s, q, { seed: `m${q}`, skill: 'club' });
        if (!a) continue;
        if (s.phase === 'discard') out.push(s);
        s = applyAction(s, q, a);
        break;
      }
    }
  }
  return out;
}

describe('push when close to ready (proPushShanten)', () => {
  const states = discardStates(6);

  it('is off by default', () => {
    expect(BOT_WEIGHTS.proPushShanten).toBe(-1);
  });

  it('one from ready and closer, Pro never gives up a tile of acceptance for its lean or 台 terms; further away it ranks as before', () => {
    let close = 0;
    let gaveUp = 0;
    for (const s of states) {
      const plain = rankDiscards(s, s.turn, 'pro');
      withWeights({ proPushShanten: 1 }, () => {
        const on = rankDiscards(s, s.turn, 'pro');
        const best = Math.min(...on.map((r) => r.shanten));
        if (best > 1) {
          expect(on).toEqual(plain);
          return;
        }
        close++;
        const top = Math.max(...on.filter((r) => r.shanten === best).map((r) => r.acceptance));
        expect(on[0].shanten).toBe(best);
        expect(on[0].acceptance).toBe(top);
        if (plain[0].shanten === best && plain[0].acceptance < top) gaveUp++;
      });
    }
    expect(close).toBeGreaterThan(50);
    // Today's Pro does give up acceptance there now and then: that is what the switch changes.
    expect(gaveUp).toBeGreaterThan(0);
  });
});
