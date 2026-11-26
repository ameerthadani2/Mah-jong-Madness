/**
 * Bots at a table that plays 嚦咕嚦咕 (`liguTai` above 0): every tier weighs seven pairs and a triplet
 * beside five sets and a pair while its hand has no melds (Beginner only when it is more than three steps
 * nearer), and does not call a chow, pong or kong out of a 嚦咕嚦咕 that is nearer than the standard hand. At a table that does not play it nothing changes:
 * the decisions recorded before the bots knew the hand still come out, state for state.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BOT_WEIGHTS,
  chooseAction,
  currentShanten,
  followsLigu,
  formatEngineReason,
  hintFor,
  kindOf,
  liguMarginOf,
  rankDiscards,
  type Action,
  type GameState,
} from '../src/index';
import { pinnedDecisions, PIN_STATES } from './helpers/pin';
import { discard, setup } from './helpers/state';

const ON = { liguTai: 4 };
const count = (s: GameState, seat: number, kind: number): number => s.players[seat].hand.filter((t) => kindOf(t) === kind).length;

/** Runs `f` with the bots blind to 嚦咕嚦咕, as they were before they knew it. */
function blind<T>(f: () => T): T {
  BOT_WEIGHTS.ligu = 0;
  try {
    return f();
  } finally {
    BOT_WEIGHTS.ligu = 1;
  }
}

afterEach(() => {
  BOT_WEIGHTS.ligu = 1;
});

/**
 * Seven pairs and three singles (17 tiles): one from ready for 嚦咕嚦咕, four for five sets and a pair,
 * so the bots follow 嚦咕嚦咕 (it must be more than `BOT_WEIGHTS.liguMargin`, 1, steps nearer). From the
 * aware-versus-blind search (seed prefix `ldiff`).
 */
const PAIRS_HAND = '11m 2m 44m 22p 44p 88p 6s 8s SS BB';
/** The same less its 2m (16 tiles), waiting for a claim. */
const CLAIM_HAND = '11m 44m 22p 44p 88p 6s 8s SS BB';

/** Seat 1 holds `hand` (16 tiles) and seat 0 has just thrown `thrown`: seat 1 may claim it. */
function offered(hand: string, thrown: string, rules = ON): GameState {
  const s = setup(rules, [`789m 123p 789s 123s NN WW ${thrown}`, hand, '', ''], 40);
  return discard(s, 0, thrown);
}

describe('bots at a 嚦咕嚦咕 table', () => {
  it('measure a concealed hand by the nearer of the two targets, and only while the table plays it', () => {
    const on = setup(ON, [PAIRS_HAND, '', '', ''], 40);
    const off = setup({}, [PAIRS_HAND, '', '', ''], 40);
    expect(currentShanten(on, 0)).toBe(1);
    expect(currentShanten(off, 0)).toBe(4);
    expect(followsLigu(on, 0)).toBe(true);
    expect(followsLigu(off, 0)).toBe(false);
    expect(blind(() => currentShanten(on, 0))).toBe(currentShanten(off, 0));
    // Only one step nearer (two against three) is not enough: five sets and a pair can use the discards.
    const close = setup(ON, ['11m 22m 4m 66m 1p 33p 7p 11s 2s 3s SS', '', '', ''], 40);
    expect(followsLigu(close, 0)).toBe(false);
    expect(currentShanten(close, 0)).toBe(3);
    expect(hintFor(close, 0).statusKey).toBe('hint.status.manyAway');
  });

  it('keep the pairs and throw a single, where the same bots blind to it break a pair (Beginner only when 嚦咕嚦咕 is nearer still)', () => {
    // Blind, every tier throws a 4m from its pair.
    const s = setup(ON, [PAIRS_HAND, '', '', ''], 40);
    for (const skill of ['club', 'pro'] as const) {
      const top = rankDiscards(s, 0, skill)[0];
      expect(top.ligu, skill).toBe(true);
      expect(top.shanten, skill).toBe(1);
      expect(count(s, 0, top.kind), skill).toBe(1);
      expect(top.accepts.length, skill).toBeGreaterThan(0);
      const blindTop = blind(() => rankDiscards(s, 0, skill)[0]);
      expect(blindTop.ligu, skill).toBeUndefined();
      expect(count(s, 0, blindTop.kind), skill).toBe(2);
    }
    // Club and Pro play the top of that ranking (Club within its small random band of singles).
    for (const skill of ['club', 'pro'] as const) {
      const a = chooseAction(s, 0, { skill, seed: 'ligu' }) as Extract<Action, { type: 'discard' }>;
      expect(count(s, 0, kindOf(a.tile)), skill).toBe(1);
    }
    // One step from ready against four is three steps nearer: not enough for Beginner (`liguMarginBeginner`).
    expect(followsLigu(s, 0, 'beginner')).toBe(false);
    expect(rankDiscards(s, 0, 'beginner').some((d) => d.ligu)).toBe(false);
  });

  it('count the tiles that pair a single as useful while 嚦咕嚦咕 is the nearer path', () => {
    const s = setup(ON, [PAIRS_HAND, '', '', ''], 40);
    const top = rankDiscards(s, 0, 'pro')[0];
    // After the throw the hand is seven pairs and two singles: a tile that pairs a single or makes a
    // pair the triplet makes it ready, so every kind still held is useful.
    const after = s.players[0].hand.map(kindOf);
    after.splice(after.indexOf(top.kind), 1);
    expect([...top.accepts].sort((a, b) => a - b)).toEqual([...new Set(after)].sort((a, b) => a - b));
  });

  it('do not pong or chow out of a 嚦咕嚦咕 that is nearer than five sets and a pair; blind, they call', () => {
    // One from ready for 嚦咕嚦咕, four for five sets and a pair: blind, Club and Pro call these.
    for (const [thrown, claim] of [
      ['2p', 'pong'],
      ['4m', 'pong'],
      ['7s', 'chi'],
    ] as const) {
      const s = offered(CLAIM_HAND, thrown);
      expect(followsLigu(s, 1)).toBe(true);
      for (const skill of ['club', 'pro'] as const) {
        expect(chooseAction(s, 1, { skill, seed: 'c' }), `${skill} ${thrown}`).toEqual({ type: 'pass' });
        expect(blind(() => chooseAction(s, 1, { skill, seed: 'c' }))?.type, `${skill} blind ${thrown}`).toBe(claim);
      }
    }
  });

  it('still call as before when 嚦咕嚦咕 is not nearer by more than the margin', () => {
    // Two chows and scattered pairs: level on both paths, so the pong that gets closer is taken as it always was.
    const s = offered('11m 22m 33m 55p 77p 99s 4s 6s E W', '5p');
    expect(followsLigu(s, 1)).toBe(false);
    for (const skill of ['club', 'pro'] as const) {
      const a = chooseAction(s, 1, { skill, seed: 'c' });
      expect(a, skill).toEqual(blind(() => chooseAction(s, 1, { skill, seed: 'c' })));
      expect(a?.type, skill).toBe('pong');
    }
  });

  it('Beginner follows 嚦咕嚦咕 only when it is more than three steps nearer; Club, Pro and the coach at more than one', () => {
    // Two from ready for 嚦咕嚦咕, four for five sets and a pair: two steps nearer.
    const s = setup(ON, ['1m 44m 55m 9m 11p 9p 22s 44s 7s 9s EE', '', '', ''], 40);
    expect(BOT_WEIGHTS.liguMarginBeginner).toBe(3);
    expect(liguMarginOf('beginner')).toBe(3);
    expect(liguMarginOf('club')).toBe(BOT_WEIGHTS.liguMargin);
    for (const skill of ['club', 'pro'] as const) {
      expect(followsLigu(s, 0, skill), skill).toBe(true);
      expect(currentShanten(s, 0, skill), skill).toBe(2);
      expect(rankDiscards(s, 0, skill)[0].ligu, skill).toBe(true);
    }
    expect(followsLigu(s, 0)).toBe(true);
    expect(hintFor(s, 0).statusKey).toBe('hint.status.twoAwayLigu');
    expect(followsLigu(s, 0, 'beginner')).toBe(false);
    expect(currentShanten(s, 0, 'beginner')).toBe(4);
    expect(rankDiscards(s, 0, 'beginner').some((d) => d.ligu)).toBe(false);
    // Three steps nearer (one against four) is still not enough for Beginner.
    const nearer = setup(ON, [PAIRS_HAND, '', '', ''], 40);
    expect(followsLigu(nearer, 0, 'club')).toBe(true);
    expect(followsLigu(nearer, 0, 'beginner')).toBe(false);
    expect(currentShanten(nearer, 0, 'beginner')).toBe(4);
  });

  it('change no decision at a table that does not play 嚦咕嚦咕: the recorded decisions on 300 states still come out', () => {
    const file = JSON.parse(readFileSync(new URL('./fixtures/ligu-off-decisions.json', import.meta.url), 'utf8')) as { decisions: string[] };
    expect(file.decisions).toHaveLength(PIN_STATES);
    expect(pinnedDecisions()).toEqual(file.decisions);
  }, 120_000);
});

describe('the coach at a 嚦咕嚦咕 table', () => {
  it('suggests the discard that keeps the pairs and counts the tiles from ready for 嚦咕嚦咕, in both languages', () => {
    const s = setup(ON, [PAIRS_HAND, '', '', ''], 40);
    const h = hintFor(s, 0);
    expect(h.shanten).toBe(1);
    expect(count(s, 0, h.bestDiscard!.kind)).toBe(1);
    expect(h.statusKey).toBe('hint.status.oneAwayLigu');
    expect(h.discardReasonKey).toBe('hint.discard.efficiencyLigu');
    expect(h.status).toBe('One tile from ready for 嚦咕嚦咕 (seven pairs and a triplet).');
    expect(formatEngineReason(h.statusKey, h.statusParams, 'zh-TW')).toContain('嚦咕嚦咕');
    expect(h.discardReason).toContain('嚦咕嚦咕');
    expect(formatEngineReason(h.discardReasonKey!, h.discardReasonParams!, 'zh-TW')).toContain('嚦咕嚦咕');
    expect(h.discardReasonParams!.kinds).toBe(h.bestDiscard!.accepts.length);
  });

  it('says nothing of 嚦咕嚦咕 at a table that does not play it', () => {
    const h = hintFor(setup({}, [PAIRS_HAND, '', '', ''], 40), 0);
    expect(h.shanten).toBe(4);
    expect(h.statusKey).not.toMatch(/Ligu$/);
    expect(h.discardReasonKey).toBe('hint.discard.efficiency');
  });

  it('counts the 嚦咕嚦咕 distance while a claim is offered and does not recommend breaking it', () => {
    const s = offered(CLAIM_HAND, '2p');
    const h = hintFor(s, 1);
    expect(h.shanten).toBe(1);
    expect(h.statusKey).toBe('hint.status.oneAwayLigu');
    expect(h.claims.length).toBeGreaterThan(0);
    for (const c of h.claims) expect(c.recommended).toBe(false);
  });

  it('names 嚦咕嚦咕 in the "tiles from ready" line further out too', () => {
    // Four pairs and nine scattered singles: four from ready for 嚦咕嚦咕, further for five sets and a pair.
    const s = setup(ON, ['11m 55m 99p 22s 4m 8m 1p 5p 4s 8s E S W', '', '', ''], 40);
    const h = hintFor(s, 0);
    expect(h.statusKey).toBe('hint.status.manyAwayLigu');
    expect(h.statusParams).toEqual({ shanten: 4 });
    expect(h.status).toBe('4 tiles from ready for 嚦咕嚦咕 (seven pairs and a triplet) — keep your pairs.');
    expect(formatEngineReason(h.statusKey, h.statusParams, 'zh-TW')).toBe('還差 4 張才聽嚦咕嚦咕（七對加一刻）：對子留著。');
  });
});
