import { describe, expect, it } from 'vitest';
import { applyAction, chooseAction, IllegalAction, isLegal, kindOf, legalActions, newGame, PLACEHOLDER_TILE, viewFor, viewToState, type Action, type GameState, type TableView } from '../src/index';

function playUntil(s: GameState, pred: (s: GameState) => boolean, max = 3000): GameState | null {
  let guard = 0;
  while (!pred(s) && s.phase !== 'ended' && guard++ < max) {
    for (let seat = 0; seat < 4; seat++) {
      const a = chooseAction(s, seat, { seed: `x${seat}` });
      if (a) {
        s = applyAction(s, seat, a);
        break;
      }
    }
  }
  return pred(s) ? s : null;
}

describe('hardening', () => {
  it('seat views never contain the seed or the wall', () => {
    const s = newGame('leak');
    const v = viewFor(s, 0) as unknown as Record<string, unknown>;
    expect(v.seed).toBeUndefined();
    expect(v.wall).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(s.seed);
  });

  it('no self-draw hu is offered right after a pong/chi (no drawn tile)', () => {
    let found = 0;
    for (let i = 0; i < 30; i++) {
      const s = playUntil(newGame(`claimhu-${i}`), (st) => st.phase === 'discard' && st.drawSource === 'claim');
      if (!s) continue;
      found++;
      const acts = legalActions(s, s.turn);
      expect(acts.some((a) => a.type === 'hu')).toBe(false);
    }
    expect(found).toBeGreaterThan(0);
  });

  it('rejects kong/discard/chi actions whose tile ids are not in hand', () => {
    const s = newGame('ids');
    const seat = s.turn;
    const other = (seat + 1) % 4;
    const foreign = s.players[other].hand[0];
    expect(isLegal(s, seat, { type: 'discard', tile: foreign })).toBe(false);
    expect(isLegal(s, seat, { type: 'kong', tile: foreign })).toBe(false);
    expect(() => applyAction(s, seat, { type: 'discard', tile: 'abc' as unknown as number })).toThrow(IllegalAction);
    expect(() => applyAction(s, seat, { type: 'chi', tiles: [1] as unknown as [number, number] })).toThrow(IllegalAction);
    expect(() => applyAction(s, 7, { type: 'pass' })).toThrow(IllegalAction);
    expect(() => applyAction(s, seat, null as unknown as Action)).toThrow(IllegalAction);
  });

  it('an added kong uses a tile from the hand and keeps tile conservation', () => {
    // Find a state where an added kong is legal.
    for (let i = 0; i < 60; i++) {
      const s = playUntil(newGame(`addkong-${i}`), (st) => st.phase === 'discard' && legalActions(st, st.turn).some((a) => a.type === 'kong' && st.players[st.turn].melds.some((m) => m.type === 'pong' && kindOf(m.tiles[0]) === kindOf((a as { tile: number }).tile))));
      if (!s) continue;
      const seat = s.turn;
      const kong = legalActions(s, seat).find((a) => a.type === 'kong')!;
      // Try to cheat with the id of a tile already inside the pong meld
      const meld = s.players[seat].melds.find((m) => m.type === 'pong' && kindOf(m.tiles[0]) === kindOf((kong as { tile: number }).tile))!;
      expect(() => applyAction(s, seat, { type: 'kong', tile: meld.tiles[0] })).toThrow(IllegalAction);
      const next = applyAction(s, seat, kong);
      const total = next.players.reduce((n, p) => n + p.hand.length + p.melds.reduce((m, x) => m + x.tiles.length, 0) + p.flowers.length + p.discards.length, 0) + (next.backIndex - next.drawIndex);
      expect(total).toBe(144);
      const ids = next.players.flatMap((p) => [...p.hand, ...p.melds.flatMap((m) => m.tiles), ...p.flowers, ...p.discards]);
      expect(new Set(ids).size).toBe(ids.length);
      return;
    }
    expect.fail('no seed produced a legal added kong');
  });

  it('strips junk fields from logged actions', () => {
    const s = newGame('junk');
    const tile = s.players[s.turn].hand[0];
    const next = applyAction(s, s.turn, { type: 'discard', tile, evil: 'x'.repeat(1000) } as unknown as Action);
    expect(JSON.stringify(next.actionLog[0].action)).toBe(JSON.stringify({ type: 'discard', tile }));
  });
});

/** Numeric fields of a view that are counters or seat numbers, never tile ids. */
const NON_TILE_KEYS = new Set(['rules', 'result', 'scores', 'handNumber', 'dealerRotations', 'dealerSeat', 'dealerStreak', 'prevailingWind', 'turn', 'viewerSeat', 'tilesRemaining', 'drawsLeft', 'handCount', 'draws', 'seat', 'from', 'n', 'turnCounter', 'dealerDiscards', 'awaiting']);

/** Every number in the view that could be a tile id (anything outside the counter fields above). */
function tileIdsIn(value: unknown, key = '', out: number[] = []): number[] {
  if (NON_TILE_KEYS.has(key)) return out;
  if (typeof value === 'number') out.push(value);
  else if (Array.isArray(value)) for (const v of value) tileIdsIn(v, key, out);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) tileIdsIn(v, k, out);
  return out;
}

/** Tile ids `viewer` must not learn: the live wall, other hands and other seats' concealed kongs. */
function secretIds(s: GameState, viewer: number): Set<number> {
  const ids = new Set<number>(s.wall.slice(s.drawIndex, s.backIndex));
  s.players.forEach((p, i) => {
    if (i === viewer) return;
    p.hand.forEach((t) => ids.add(t));
    for (const m of p.melds) if (m.concealed) m.tiles.forEach((t) => ids.add(t));
  });
  // An added-kong tile is announced to the table while it is still in the kong-er's hand.
  if (s.pending?.kind === 'addedKong') ids.delete(s.pending.tile);
  return ids;
}

function nextAction(s: GameState): { seat: number; action: Action } | null {
  for (let seat = 0; seat < 4; seat++) {
    const action = chooseAction(s, seat, { seed: `x${seat}` });
    if (action) return { seat, action };
  }
  return null;
}

describe('seat views do not leak hidden information', () => {
  it('over 20 bot hands, no view exposes another seat’s draw, claim options, answers, 過水, log or concealed tiles', () => {
    const seen = { hiddenDraws: 0, claimsWithOthers: 0, otherConcealedKongs: 0, endedKongsRevealed: 0 };
    for (let i = 0; i < 20; i++) {
      let s = newGame(`leak-${i}`);
      for (let guard = 0; guard < 3000; guard++) {
        for (let seat = 0; seat < 4; seat++) {
          const v: TableView = viewFor(s, seat);
          expect(v.actionLog).toEqual([]);
          if (s.phase === 'ended') {
            for (const p of v.players) for (const m of p.melds) if (m.concealed && !m.tiles.includes(PLACEHOLDER_TILE)) seen.endedKongsRevealed++;
            continue;
          }
          if (seat === s.turn) expect(v.lastDrawn).toBe(s.lastDrawn);
          else {
            expect(v.lastDrawn).toBeUndefined();
            if (s.lastDrawn !== undefined) seen.hiddenDraws++;
          }
          if (s.pending) {
            const p = v.pending!;
            expect(p.tile).toBe(s.pending.tile);
            expect(p.from).toBe(s.pending.from);
            expect(p.kind).toBe(s.pending.kind);
            expect(p.offers.every((o) => o.seat === seat)).toBe(true);
            expect(Object.keys(p.responses).every((k) => Number(k) === seat)).toBe(true);
            const owed = s.pending.offers.filter((o) => s.pending!.responses[o.seat] === undefined).map((o) => o.seat);
            expect(p.awaiting).toEqual(owed.sort((a, b) => a - b));
            if (s.pending.offers.some((o) => o.seat !== seat)) seen.claimsWithOthers++;
          } else expect(v.pending).toBeUndefined();
          let placeholders = 0;
          v.players.forEach((p, i) => {
            if (i === seat) return;
            expect(p.hand).toBeUndefined();
            expect(p.passedWin).toBe(false);
            for (const m of p.melds) {
              if (!m.concealed) continue;
              seen.otherConcealedKongs++;
              placeholders += 4;
              expect(m.tiles).toEqual([PLACEHOLDER_TILE, PLACEHOLDER_TILE, PLACEHOLDER_TILE, PLACEHOLDER_TILE]);
            }
          });
          const secret = secretIds(s, seat);
          const ids = tileIdsIn(v);
          expect(
            ids.filter((t) => secret.has(t) && t !== PLACEHOLDER_TILE),
            `hand ${i} seat ${seat}`,
          ).toEqual([]);
          // The placeholder doubles as a real flower id: while that flower is hidden it may appear only as a placeholder.
          if (secret.has(PLACEHOLDER_TILE)) expect(ids.filter((t) => t === PLACEHOLDER_TILE)).toHaveLength(placeholders);
          // The client rebuilds an engine state from the view: it must offer exactly the real legal actions.
          expect(legalActions(viewToState(v), seat)).toEqual(legalActions(s, seat));
        }
        if (s.phase === 'ended') break;
        const next = nextAction(s);
        if (!next) break;
        s = applyAction(s, next.seat, next.action);
      }
      expect(s.phase).toBe('ended');
    }
    // No vacuous pass: each kind of hidden information actually came up.
    expect(seen.hiddenDraws).toBeGreaterThan(0);
    expect(seen.claimsWithOthers).toBeGreaterThan(0);
    expect(seen.otherConcealedKongs).toBeGreaterThan(0);
    expect(seen.endedKongsRevealed).toBeGreaterThan(0);
  });

  it('過水 is visible only to its own seat while the hand runs', () => {
    const s = newGame('passed');
    s.players[2].passedWin = true;
    expect(viewFor(s, 2).players[2].passedWin).toBe(true);
    for (const seat of [0, 1, 3]) expect(viewFor(s, seat).players[2].passedWin).toBe(false);
  });
});
