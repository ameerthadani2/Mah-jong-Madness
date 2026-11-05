/**
 * Headless simulation.
 *
 *   tsx scripts/simulate.ts [matches]                 four Club bots play N matches; prints win rates,
 *                                                     average 台 and draw frequency, and asserts tile
 *                                                     conservation every step.
 *   tsx scripts/simulate.ts --ladder <skill> <hands>  one bot of <skill> (rotating seats) against three
 *                                                     Club bots; prints win %, points per hand and
 *                                                     deal-in % for the test skill and for Club.
 */
import { applyAction, chooseAction, hashState, newGame, nextHand, tilesRemaining, type BotSkill, type GameState } from '../src/index';

function checkInvariants(s: GameState): void {
  const total = s.players.reduce((n, p) => n + p.hand.length + p.melds.reduce((m, x) => m + x.tiles.length, 0) + p.flowers.length + p.discards.length, 0) + tilesRemaining(s);
  if (total !== 144) throw new Error(`Tile conservation broken: ${total}`);
}

/** Play one hand to the end with the given skill per seat, checking invariants every step. */
function playHand(s: GameState, skills: readonly BotSkill[]): GameState {
  let steps = 0;
  while (s.phase !== 'ended') {
    checkInvariants(s);
    let acted = false;
    for (let seat = 0; seat < 4; seat++) {
      const a = chooseAction(s, seat, { seed: `bot${seat}`, skill: skills[seat] });
      if (a) {
        s = applyAction(s, seat, a);
        acted = true;
        break;
      }
    }
    if (!acted) throw new Error(`No actor in phase ${s.phase} hash=${hashState(s)}`);
    if (++steps > 2000) throw new Error('Hand did not terminate');
  }
  return s;
}

interface Tally {
  seatHands: number;
  wins: number;
  dealIns: number;
  points: number;
}

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
const perHand = (t: Tally): number => t.points / Math.max(1, t.seatHands);

function runLadder(skill: BotSkill, hands: number): void {
  const test: Tally = { seatHands: 0, wins: 0, dealIns: 0, points: 0 };
  const club: Tally = { seatHands: 0, wins: 0, dealIns: 0, points: 0 };
  let draws = 0;
  const started = Date.now();
  for (let h = 0; h < hands; h++) {
    const testSeat = h % 4;
    const skills = [0, 1, 2, 3].map((seat): BotSkill => (seat === testSeat ? skill : 'club'));
    const r = playHand(newGame(`ladder-${h}`), skills).result!;
    if (r.type !== 'win') draws++;
    for (let seat = 0; seat < 4; seat++) {
      const t = seat === testSeat ? test : club;
      t.seatHands++;
      t.points += r.scoreDelta[seat];
      if (r.wins.some((w) => w.seat === seat)) t.wins++;
      if (r.wins.some((w) => !w.selfDrawn && w.fromSeat === seat)) t.dealIns++;
    }
  }
  const ms = Date.now() - started;
  const line = (label: string, t: Tally) => `${label.padEnd(9)} win ${pct(t.wins, t.seatHands).padStart(6)}  pts/hand ${perHand(t).toFixed(2).padStart(8)}  deal-in ${pct(t.dealIns, t.seatHands).padStart(6)}`;
  console.log(`ladder ${skill} vs 3 club: hands=${hands} draws=${draws} (${pct(draws, hands)})`);
  console.log(line(skill, test));
  console.log(line('club', club));
  console.log(`${skill} minus club: ${(perHand(test) - perHand(club)).toFixed(2)} pts/hand; ${(ms / hands).toFixed(1)} ms per hand`);
}

function runMatches(matches: number): void {
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
      s = playHand(s, ['club', 'club', 'club', 'club']);
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
  console.log(`matches=${matches} hands=${hands} wins=${wins} draws=${draws} (${pct(draws, hands)})`);
  console.log(`avg tai=${(taiSum / Math.max(1, wins)).toFixed(2)} self-draw=${pct(selfDraws, wins)} seatWins=${seatWins.join('/')}`);
  console.log(`${(ms / hands).toFixed(1)} ms per hand`);
}

const args = process.argv.slice(2);
if (args[0] === '--ladder') {
  const skill = args[1];
  if (skill !== 'beginner' && skill !== 'club' && skill !== 'pro') throw new Error(`Unknown skill "${String(skill)}" (beginner | club | pro)`);
  const hands = Number(args[2] ?? 500);
  if (!Number.isInteger(hands) || hands <= 0) throw new Error(`Invalid hand count "${String(args[2])}"`);
  runLadder(skill, hands);
} else {
  runMatches(Number(args[0] ?? 20));
}
