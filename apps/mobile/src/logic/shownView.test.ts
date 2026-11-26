import { describe, expect, it } from 'vitest';
import type { TableView } from '@mjm/engine';
import { withShownSets } from './shownView';

const pong = { type: 'pong', tiles: [8, 9, 10], concealed: false, from: 1, claimed: 8 };
const player = (extra: Record<string, unknown> = {}) => ({ melds: [pong], flowers: [140], discards: [1, 2], handCount: 13, ...extra });
const view = (players: unknown[], result?: unknown) => ({ handNumber: 0, players, ...(result ? { result } : {}) }) as unknown as TableView;

describe('the table as the screen draws it', () => {
  it('leaves a well-formed view, and the state holding it, as they are', () => {
    const st = { view: view([player({ hand: [3, 4] }), player(), player(), player()]), lastResult: null };
    expect(withShownSets(st)).toBe(st);
    expect(withShownSets({ view: null, lastResult: null }).view).toBeNull();
  });

  it('draws a set that is not one as nothing, and a list that is not one of tiles as empty', () => {
    const st = { view: view([player({ melds: [pong, 0, { x: 1 }, { tiles: 'x' }, null], hand: [3, 0.5 as unknown as number, 'x'] }), player({ flowers: 'x', discards: [{}] }), player(), player()]), lastResult: { type: 'win', wins: [{ seat: 0, hand: 'x', melds: [7], flowers: [140] }] } };
    const out = withShownSets(st as never) as typeof st;
    expect(out).not.toBe(st);
    expect(out.view!.players[0].melds).toEqual([pong]);
    expect(out.view!.players[0].hand).toEqual([]);
    expect(out.view!.players[1]).toMatchObject({ flowers: [], discards: [] });
    expect(out.view!.players[2]).toBe(st.view!.players[2]);
    expect((out.lastResult as { wins: Array<{ hand: unknown; melds: unknown }> }).wins[0]).toMatchObject({ hand: [], melds: [] });
    // The client's own view is not touched.
    expect(st.view!.players[0].melds).toHaveLength(5);
  });
});
