/**
 * The table as the table screen draws it. A view the table client took in holds every set, tile list and hand as the
 * engine keeps them: its intake refuses any other (packages/net `isPlayerView`). Should one get through anyway, the
 * screen draws it with the sets that are not sets left out and the lists that are not lists of tiles read as empty, so
 * the table stands rather than stop. The client's own view, and every check of it, are left as they are. Pure.
 */
import type { TableView } from '@mjm/engine';

type Player = TableView['players'][number];
type Win = { hand: unknown; melds: unknown; flowers: unknown };

const isTiles = (x: unknown): x is number[] => Array.isArray(x) && x.every((t) => typeof t === 'number' && Number.isFinite(t));
/** A set the screen can draw: an object with a list of tiles. */
const isSet = (m: unknown): boolean => typeof m === 'object' && m !== null && isTiles((m as { tiles?: unknown }).tiles);
const sets = <T>(x: T[]): T[] => (Array.isArray(x) ? (x.every(isSet) ? x : x.filter(isSet)) : []);
const tiles = <T>(x: T[]): T[] => (isTiles(x) ? x : []);

function shownPlayer(p: Player): Player {
  const melds = sets(p.melds);
  const flowers = tiles(p.flowers);
  const discards = tiles(p.discards);
  const hand = p.hand === undefined ? undefined : tiles(p.hand);
  return melds === p.melds && flowers === p.flowers && discards === p.discards && hand === p.hand ? p : { ...p, melds, flowers, discards, ...(p.hand === undefined ? {} : { hand }) };
}

function shownWins<R extends { wins?: unknown }>(r: R): R {
  if (!r || !Array.isArray(r.wins)) return r;
  const wins = (r.wins as Win[]).map((w) => {
    if (typeof w !== 'object' || w === null) return w;
    const melds = sets(w.melds as unknown[]);
    const hand = tiles(w.hand as unknown[]);
    const flowers = tiles(w.flowers as unknown[]);
    return melds === w.melds && hand === w.hand && flowers === w.flowers ? w : { ...w, melds, hand, flowers };
  });
  return wins.every((w, i) => w === (r.wins as Win[])[i]) ? r : { ...r, wins };
}

/** `state` with its view (and the result it shows) as the screen draws them; the same object when nothing needs leaving out. */
export function withShownSets<S extends { view: TableView | null; lastResult: unknown }>(state: S): S {
  const v = state.view;
  let view = v;
  if (v && Array.isArray(v.players)) {
    const players = v.players.map(shownPlayer);
    const result = v.result ? shownWins(v.result) : v.result;
    if (players.some((p, i) => p !== v.players[i]) || result !== v.result) view = { ...v, players, ...(v.result ? { result } : {}) };
  }
  const lastResult = state.lastResult && typeof state.lastResult === 'object' ? shownWins(state.lastResult as { wins?: unknown }) : state.lastResult;
  return view === v && lastResult === state.lastResult ? state : { ...state, view, lastResult };
}
