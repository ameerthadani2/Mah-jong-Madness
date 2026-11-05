import { describe, expect, it } from 'vitest';
import type { HandResult, Meld, TableView } from '@mjm/engine';
import { isVoicePreference, shouldTick, tableEvents, voiceCueId, type CueState } from './cues';

type P = { discards: number[]; melds: Meld[] };
const meld = (type: Meld['type'], concealed = false): Meld => ({ type, tiles: [0, 1, 2], concealed }) as unknown as Meld;
function st(players: P[], extra: Partial<TableView> = {}, result: HandResult | null = null, hand = 0): CueState {
  const view = {
    handNumber: hand,
    phase: 'discard',
    turn: 1,
    lastDrawn: undefined,
    players: players.map((p) => ({ handCount: 16, melds: p.melds, flowers: [], discards: p.discards })),
    scores: [0, 0, 0, 0],
    ...extra,
  } as unknown as TableView;
  return { view, lastResult: result, lastAudit: result ? ({ matchId: 'm', handNumber: hand } as never) : null, seat: 0 };
}
const empty = (): P[] => [0, 1, 2, 3].map(() => ({ discards: [], melds: [] }));

describe('tableEvents', () => {
  it('says nothing on the first state (a remount never replays calls)', () => {
    expect(tableEvents(null, st(empty()))).toEqual([]);
  });

  it('clacks when any pond grows', () => {
    const a = empty();
    const b = empty();
    b[2].discards = [5];
    expect(tableEvents(st(a), st(b))).toEqual([{ type: 'sfx', cue: 'discard' }]);
  });

  it('calls 吃, 碰 and 槓 for the seat whose melds grew', () => {
    for (const [type, call] of [['chow', 'chi'], ['pong', 'pong'], ['kong', 'kong']] as const) {
      const b = empty();
      b[3].melds = [meld(type)];
      expect(tableEvents(st(empty()), st(b))).toEqual([{ type: 'call', call, seat: 3 }]);
    }
  });

  it('calls 槓 when a pong is promoted (meld count unchanged)', () => {
    const a = empty();
    a[1].melds = [meld('pong')];
    const b = empty();
    b[1].melds = [meld('kong')];
    expect(tableEvents(st(a), st(b))).toEqual([{ type: 'call', call: 'kong', seat: 1 }]);
  });

  it('plays the draw only for my own draw', () => {
    expect(tableEvents(st(empty(), { turn: 0 }), st(empty(), { turn: 0, lastDrawn: 40 } as never))).toEqual([{ type: 'sfx', cue: 'draw' }]);
    expect(tableEvents(st(empty(), { turn: 2 }), st(empty(), { turn: 2, lastDrawn: 40 } as never))).toEqual([]);
  });

  it('ignores differences across a new hand', () => {
    const b = empty();
    b[0].discards = [1, 2, 3];
    expect(tableEvents(st(empty(), {}, null, 0), st(b, {}, null, 1))).toEqual([]);
  });

  it('calls 胡 or 自摸 for each winner, with a fanfare when I won, once per result', () => {
    const win = { type: 'win', wins: [{ seat: 0, selfDrawn: true }, { seat: 2, selfDrawn: false }], scoreDelta: [0, 0, 0, 0] } as unknown as HandResult;
    const before = st(empty());
    const after = st(empty(), {}, win);
    expect(tableEvents(before, after)).toEqual([
      { type: 'call', call: 'selfdraw', seat: 0 },
      { type: 'call', call: 'hu', seat: 2 },
      { type: 'sfx', cue: 'fanfare' },
    ]);
    expect(tableEvents(after, st(empty(), {}, win))).toEqual([]);
  });

  it('plays 流局 for a drawn hand, without a fanfare', () => {
    const draw = { type: 'draw', wins: [], scoreDelta: [0, 0, 0, 0] } as unknown as HandResult;
    expect(tableEvents(st(empty()), st(empty(), {}, draw))).toEqual([{ type: 'sfx', cue: 'drawGame' }]);
  });
});

describe('shouldTick', () => {
  it('ticks each new second from 5 down to 1 on my move only', () => {
    expect(shouldTick(7, 6, true)).toBe(false);
    expect(shouldTick(6, 5, true)).toBe(true);
    expect(shouldTick(5, 5, true)).toBe(false);
    expect(shouldTick(2, 1, true)).toBe(true);
    expect(shouldTick(1, 0, true)).toBe(false);
    expect(shouldTick(6, 5, false)).toBe(false);
    expect(shouldTick(null, null, true)).toBe(false);
  });
});

describe('voice preference', () => {
  it('maps calls to manifest ids and turns off cleanly', () => {
    expect(voiceCueId('pong', 'mandarin')).toBe('voice.mandarin.pong');
    expect(voiceCueId('selfdraw', 'taiwanese')).toBe('voice.taiwanese.selfdraw');
    expect(voiceCueId('hu', 'off')).toBeNull();
    expect(isVoicePreference('taiwanese')).toBe(true);
    expect(isVoicePreference('cantonese')).toBe(false);
    expect(isVoicePreference(null)).toBe(false);
  });
});
