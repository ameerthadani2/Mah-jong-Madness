/**
 * Bots at a table that plays 嚦咕嚦咕 (`liguTai` above 0): every tier weighs seven pairs and a triplet
 * beside five sets and a pair while its hand has no melds, and does not call a chow, pong or kong out
 * of a 嚦咕嚦咕 that is nearer than the standard hand. At a table that does not play it nothing changes:
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
  kindsFromString,
  rankDiscards,
  type Action,
  type BotSkill,
  type GameState,
} from '../src/index';
import { pinnedDecisions, PIN_STATES } from './helpers/pin';
import { discard, setup } from './helpers/state';

const ON = { liguTai: 4 };
const SKILLS: readonly BotSkill[] = ['beginner', 'club', 'pro'];
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

/** Six pairs and five singles (17 tiles): two from ready for 嚦咕嚦咕, further for five sets and a pair. */
const PAIRS_HAND = '11m 22m 4m 66m 1p 33p 7p 11s 2s 3s SS';

/** Seat 1 holds `hand` (16 tiles) and seat 0 has just thrown `thrown`: seat 1 may claim it. */
function offered(hand: string, thrown: string, rules = ON): GameState {
  const s = setup(rules, [`789m 123p 789s 123s NN WW ${thrown}`, hand, '', ''], 40);
  return discard(s, 0, thrown);
}

describe('bots at a 嚦咕嚦咕 table', () => {
  it('measure a concealed hand by the nearer of the two targets, and only while the table plays it', () => {
    const on = setup(ON, [PAIRS_HAND, '', '', ''], 40);
    const off = setup({}, [PAIRS_HAND, '', '', ''], 40);
    expect(currentShanten(on, 0)).toBe(2);
    expect(currentShanten(off, 0)).toBeGreaterThan(2);
    expect(followsLigu(on, 0)).toBe(true);
    expect(followsLigu(off, 0)).toBe(false);
    expect(blind(() => currentShanten(on, 0))).toBe(currentShanten(off, 0));
  });

  it('at every tier keep the pairs and throw a single, where the same bots blind to it break a pair', () => {
    // From the aware-versus-blind search: blind, every tier throws a 1s from the pair.
    const s = setup(ON, [PAIRS_HAND, '', '', ''], 40);
    for (const skill of SKILLS) {
      const top = rankDiscards(s, 0, skill)[0];
      expect(top.ligu, skill).toBe(true);
      expect(top.shanten, skill).toBe(2);
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
  });

  it('count the tiles that pair a single as useful while 嚦咕嚦咕 is the nearer path', () => {
    const s = setup(ON, [PAIRS_HAND, '', '', ''], 40);
    const top = rankDiscards(s, 0, 'pro')[0];
    // After the throw the hand is six pairs and four singles: a tile that pairs a single or makes a pair
    // the triplet brings it closer, so every kind still held is useful.
    const after = s.players[0].hand.map(kindOf);
    after.splice(after.indexOf(top.kind), 1);
    expect([...top.accepts].sort((a, b) => a - b)).toEqual([...new Set(after)].sort((a, b) => a - b));
  });

  it('do not pong or chow out of a 嚦咕嚦咕 that is nearer than five sets and a pair; blind, they call', () => {
    // Six pairs and four singles: two from ready for 嚦咕嚦咕, three for five sets and a pair. From the
    // aware-versus-blind search: blind, Club and Pro pong the 1m and chow 4m-5m-6m.
    const hand = '11m 22m 4m 66m 33p 7p 11s 2s 3s SS';
    for (const [thrown, claim] of [
      ['1m', 'pong'],
      ['5m', 'chi'],
    ] as const) {
      const s = offered(hand, thrown);
      expect(followsLigu(s, 1)).toBe(true);
      for (const skill of ['club', 'pro'] as const) {
        expect(chooseAction(s, 1, { skill, seed: 'c' }), `${skill} ${thrown}`).toEqual({ type: 'pass' });
        expect(blind(() => chooseAction(s, 1, { skill, seed: 'c' }))?.type, `${skill} blind ${thrown}`).toBe(claim);
      }
    }
  });

  it('still call as before when 嚦咕嚦咕 is not the nearer path', () => {
    // Two chows and scattered pairs: level on both paths, so the pong that gets closer is taken as it always was.
    const s = offered('11m 22m 33m 55p 77p 99s 4s 6s E W', '5p');
    expect(followsLigu(s, 1)).toBe(false);
    for (const skill of ['club', 'pro'] as const) {
      const a = chooseAction(s, 1, { skill, seed: 'c' });
      expect(a, skill).toEqual(blind(() => chooseAction(s, 1, { skill, seed: 'c' })));
      expect(a?.type, skill).toBe('pong');
    }
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
    expect(h.shanten).toBe(2);
    expect(count(s, 0, h.bestDiscard!.kind)).toBe(1);
    expect(h.statusKey).toBe('hint.status.twoAwayLigu');
    expect(h.discardReasonKey).toBe('hint.discard.efficiencyLigu');
    expect(h.status).toBe('Two tiles from ready for 嚦咕嚦咕 (seven pairs and a triplet).');
    expect(formatEngineReason(h.statusKey, h.statusParams, 'zh-TW')).toContain('嚦咕嚦咕');
    expect(h.discardReason).toContain('嚦咕嚦咕');
    expect(formatEngineReason(h.discardReasonKey!, h.discardReasonParams!, 'zh-TW')).toContain('嚦咕嚦咕');
    expect(h.discardReasonParams!.kinds).toBe(h.bestDiscard!.accepts.length);
  });

  it('says nothing of 嚦咕嚦咕 at a table that does not play it', () => {
    const h = hintFor(setup({}, [PAIRS_HAND, '', '', ''], 40), 0);
    expect(h.shanten).toBeGreaterThan(2);
    expect(h.statusKey).not.toMatch(/Ligu$/);
    expect(h.discardReasonKey).toBe('hint.discard.efficiency');
  });

  it('counts the 嚦咕嚦咕 distance while a claim is offered and does not recommend breaking it', () => {
    const s = offered('11m 22m 4m 66m 33p 7p 11s 2s 3s SS', '1m');
    const h = hintFor(s, 1);
    expect(h.shanten).toBe(2);
    expect(h.statusKey).toBe('hint.status.twoAwayLigu');
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
    expect(formatEngineReason(h.statusKey, h.statusParams, 'zh-TW')).toBe('差 4 張聽嚦咕嚦咕（七對子加一刻）：留住對子。');
  });
});
