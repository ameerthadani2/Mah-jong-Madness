/**
 * Headless simulation: four bots play N matches. Prints win rates, average 台,
 * draw frequency, and asserts tile conservation every step.
 */
import { applyAction, chooseAction, hashState, newGame, nextHand, tilesRemaining, type GameState } from '../src/index';

function checkInvariants(s: GameState): void {
  const total = s.players.reduce((n, p) => n + p.hand.length + p.melds.reduce((m, x) => m + x.tiles.length, 0) + p.flowers.length + p.discards.length, 0) + tilesRemaining(s);
  if (total !== 144) throw new Error(`Tile conservation broken: ${total}`);
}

const matches = Number(process.argv[2] ?? 20);
let hands = 0;
let wins = 0;
let draws = 0;
let taiSum = 0;
let selfDraws = 0;
const seatWins = [0, 0, 0, 0];
const started = Date.now();
for (let m = 0; m < matches; m++) {
  let s = newGame(`sim-${m}`);
  while (!s.matchOver) {
    let steps = 0;
    while (s.phase !== 'ended') {
      checkInvariants(s);
      let acted = false;
      for (let seat = 0; seat < 4; seat++) {
        const a = chooseAction(s, seat, { seed: `bot${seat}` });
        if (a) {
          s = applyAction(s, seat, a);
          acted = true;
          break;
        }
      }
      if (!acted) throw new Error(`No actor in phase ${s.phase} hash=${hashState(s)}`);
      if (++steps > 2000) throw new Error('Hand did not terminate');
    }
    hands++;
    if (s.result!.type === 'win') {
      wins++;
      for (const w of s.result!.wins) {
        taiSum += w.score.tai;
        seatWins[w.seat]++;
        if (w.selfDrawn) selfDraws++;
      }
    } else draws++;
    s = nextHand(s);
  }
}
const ms = Date.now() - started;
console.log(`matches=${matches} hands=${hands} wins=${wins} draws=${draws} (${((draws / hands) * 100).toFixed(1)}%)`);
console.log(`avg tai=${(taiSum / Math.max(1, wins)).toFixed(2)} self-draw=${((selfDraws / Math.max(1, wins)) * 100).toFixed(1)}% seatWins=${seatWins.join('/')}`);
console.log(`${(ms / hands).toFixed(1)} ms per hand`);
