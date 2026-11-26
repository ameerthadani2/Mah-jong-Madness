/**
 * The coach and the discard puzzles agree. The coach plays the Pro's policy, which can throw a tile that keeps
 * fewer improving tiles than the most efficient one: to go for a flush, to keep a value-honour pair, or because
 * an opponent may be close to ready. It may call its tile efficient (EFFICIENCY_REASON_KEYS) only when the
 * puzzle's judge would accept it; otherwise it says what it traded the tiles for, and against which tile.
 *
 * The eighth assessment found nine of the 365 dailies from 1 May 2027 and four of 200 hard puzzles where the
 * coach named a flush tile with an efficiency reason that the daily marked wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  applyAction,
  checkDiscardAnswer,
  chooseAction,
  dailyPuzzle,
  discardAnalysis,
  discardPuzzle,
  EFFICIENCY_REASON_KEYS,
  formatEngineReason,
  hintFor,
  kindInfo,
  kindsFromString,
  kindsToString,
  newGame,
  SUIT_EN,
  type DiscardPuzzle,
  type GameState,
  type Hint,
  type Suit,
} from '../src/index';
import { setup } from './helpers/state';

const TRADES = ['hint.discard.flush', 'hint.discard.keepValue', 'hint.discard.safer'];
const isTrade = (key: string) => TRADES.some((t) => key === t || key === `${t}Ready`);

/** The coach's hint for the puzzle's hand, as seat 0 at a table where nothing else is in sight. */
const coached = (hand: readonly number[]): Hint => hintFor(setup({}, [kindsToString(hand), '', '', ''], 40), 0);

/** The table after `steps` moves of Club bots from a fixed seed, as test/helpers/pin.ts plays it. */
function playedTo(seed: string, steps: number): GameState {
  let s = newGame(seed);
  for (let step = 0; step < steps; step++) {
    for (let seat = 0; seat < 4; seat++) {
      const a = chooseAction(s, seat, { skill: 'club', seed: `run${seat}` });
      if (a) {
        s = applyAction(s, seat, a);
        break;
      }
    }
  }
  return s;
}

const zh = (h: Hint) => formatEngineReason(h.discardReasonKey!, h.discardReasonParams!, 'zh-TW');

describe('the coach and the discard puzzles', () => {
  const dailies = Array.from({ length: 365 }, (_, i) => dailyPuzzle(new Date(Date.UTC(2027, 4, 1 + i, 12))));
  const hard = Array.from({ length: 200 }, (_, i) => discardPuzzle(`a8c-h-${i}`, 3));

  it('call a tile efficient only when the puzzle accepts it, and otherwise name the trade against an accepted tile, over a year of dailies and 200 hard puzzles', () => {
    let traded = 0;
    const check = (p: DiscardPuzzle) => {
      const h = coached(p.hand);
      const k = h.bestDiscard!.kind;
      const key = h.discardReasonKey!;
      if (EFFICIENCY_REASON_KEYS.includes(key as (typeof EFFICIENCY_REASON_KEYS)[number])) {
        expect(checkDiscardAnswer(p, k), `${p.seed}: ${key} for ${kindInfo(k).code}`).toBe(true);
        return;
      }
      traded++;
      expect(isTrade(key), `${p.seed}: ${key}`).toBe(true);
      const params = h.discardReasonParams!;
      const other = kindsFromString(String(params.other))[0];
      const acceptance = (kind: number) => p.options.find((o) => o.kind === kind)!.acceptance;
      // The tile it names instead is right by the puzzle, and keeps exactly the tiles the line says.
      expect(checkDiscardAnswer(p, other), p.seed).toBe(true);
      expect(checkDiscardAnswer(p, k), p.seed).toBe(false);
      expect(params.more, p.seed).toBe(acceptance(other) - acceptance(k));
      if (key.startsWith('hint.discard.flush')) {
        // The flush suit holds most of the hand, and the coach's tile is not of it.
        const suits = (['m', 'p', 's'] as Suit[]).map((x) => p.hand.filter((t) => kindInfo(t).suit === x).length);
        const named = (['m', 'p', 's'] as Suit[]).find((x) => SUIT_EN[x] === params.suit)!;
        expect(suits[['m', 'p', 's'].indexOf(named)], p.seed).toBe(Math.max(...suits));
        expect(kindInfo(k).suit, p.seed).not.toBe(named);
      }
    };
    for (const p of [...dailies, ...hard]) check(p);
    // The set holds trades (nine flush hands among the dailies and four among the hard puzzles when this test was written), so the check is not empty.
    expect(traded).toBeGreaterThan(0);
  }, 60_000);

  it('names the flush it goes for, in both languages (the hand of the challenger\'s example, the daily of 6 May 2027 as it was)', () => {
    const p = discardAnalysis(kindsFromString('66p 789p 123s 3s 56s 99s CC FF'));
    expect(p.answers.map((k) => kindInfo(k).code)).toEqual(['3s']);
    const h = coached(p.hand);
    expect(kindInfo(h.bestDiscard!.kind).code).toBe('9p');
    expect(h.discardReasonKey).toBe('hint.discard.flush');
    expect(h.discardReason).toBe('Discard 九筒 (9 Dot): you are going for a flush in Bamboo. Throwing 三條 (3 Bamboo) instead would keep more tiles that improve your hand (2 more).');
    expect(zh(h)).toBe('打 九筒：你在做條子的清一色或混一色。打 三條 會多 2 張進張。');
  });

  it('names the value-honour pair it keeps', () => {
    const h = coached(kindsFromString('333m 45m 56p 222s 344s 56s CC'));
    expect(h.discardReasonKey).toBe('hint.discard.keepValue');
    expect(h.discardReason).toBe('Discard 二條 (2 Bamboo) and keep your pair of 中 (Red Dragon): a pong of it is worth 1 台. Throwing 中 (Red Dragon) instead would keep more tiles that improve your hand (2 more).');
    expect(zh(h)).toBe('打 二條，留著 中 這一對：碰成刻子有 1 台。打 中 會多 2 張進張。');
  });

  it('says the tile is the safer one when an opponent may be close to ready, and counts winning tiles when both leave the hand ready', () => {
    const s = playedTo('ligu-pin-2', 39);
    const h = hintFor(s, 1);
    expect(h.discardReasonKey).toBe('hint.discard.safer');
    expect(h.discardReason).toBe('Discard 一筒 (1 Dot): an opponent may be close to ready, and it is the safer tile. Throwing 五條 (5 Bamboo) instead would keep more tiles that improve your hand (3 more).');
    expect(zh(h)).toBe('打 一筒：有對手可能快聽牌了，這張比較安全。打 五條 會多 3 張進張。');
    const best = h.discards.find((d) => kindInfo(d.kind).code === '5s')!;
    expect(best.danger).toBeGreaterThan(h.bestDiscard!.danger);
    const ready = hintFor(playedTo('ligu-pin-10', 48), 1);
    expect(ready.discardReasonKey).toBe('hint.discard.saferReady');
    expect(ready.discardReason).toBe('Discard 五條 (5 Bamboo): an opponent may be close to ready, and it is the safer tile. Throwing 三萬 (3 Character) instead would leave you more winning tiles (1 more).');
    expect(zh(ready)).toBe('打 五條：有對手可能快聽牌了，這張比較安全。打 三萬 會多聽 1 張。');
  });

  it('says it folds when it gives up a step for safety, and never counts a trade it did not make', () => {
    const distance = (d: Hint['discards'][number]) => d.rank ?? d.shanten;
    const s = playedTo('fold-pin-28', 39);
    const h = hintFor(s, 3);
    expect(h.discardReasonKey).toBe('hint.discard.fold');
    expect(h.discardReason).toBe('An opponent looks ready. Discard 一萬 (1 Character), a safer tile, rather than pushing a dangerous one: losing this hand costs less than paying for theirs.');
    expect(zh(h)).toBe('有對手看起來已經聽牌。打 一萬 這張較安全的牌，不要硬打危險牌：放棄這手牌，比付對方的台便宜。');
    expect(distance(h.bestDiscard!)).toBeGreaterThan(Math.min(...h.discards.map(distance)));
    // Over whole hands: the line says fold exactly when the tile is further from ready than the best one, and a
    // trade always names a positive number of tiles given up (dropping the fold rule printed "(-29 more)").
    let decisions = 0;
    let folds = 0;
    for (const seed of ['fold-pin-13', 'fold-pin-28', 'fold-pin-49', 'fold-pin-72', 'fold-pin-96', 'fold-pin-114']) {
      let g = newGame(seed);
      for (let step = 0; step < 400 && g.phase !== 'ended'; step++) {
        if (g.phase === 'discard') {
          const x = hintFor(g, g.turn);
          const gaveUpStep = distance(x.bestDiscard!) > Math.min(...x.discards.map(distance));
          expect(x.discardReasonKey === 'hint.discard.fold', `${seed} step ${step}: ${x.discardReason}`).toBe(gaveUpStep);
          const more = x.discardReasonParams?.more;
          if (typeof more === 'number') expect(more, `${seed} step ${step}`).toBeGreaterThan(0);
          decisions++;
          if (gaveUpStep) folds++;
        }
        let acted = false;
        for (let seat = 0; seat < 4 && !acted; seat++) {
          const a = chooseAction(g, seat, { skill: 'club', seed: `run${seat}` });
          if (a) {
            g = applyAction(g, seat, a);
            acted = true;
          }
        }
        if (!acted) break;
      }
    }
    expect(decisions).toBeGreaterThan(250);
    expect(folds).toBeGreaterThan(0);
  });
});
