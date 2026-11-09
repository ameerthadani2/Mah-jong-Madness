/**
 * Headless simulation.
 *
 *   tsx scripts/simulate.ts [matches]
 *       Four Club bots play N full matches; prints win rates, average 台 and draw frequency, and
 *       asserts tile conservation every step.
 *
 *   tsx scripts/simulate.ts --ladder <skill> <n> [--seed <prefix>] [--matches] [--vs <skill>]
 *       One bot of <skill> (rotating seats) against three <vs> bots (Club by default). Prints, for
 *       the test seat and for the others: win %, points per hand, deal-in %, average 台 per win and
 *       how many wins were flushes (混一色 / 清一色), plus illegal moves and the average decision
 *       time of the test skill.
 *       Each seed is also played with <vs> in the test seat (common random numbers), and the paired
 *       difference is printed with its standard error and a 95% interval.
 *       --seed     seed prefix (default `ladder`). Tune on one prefix and report on another, so the
 *                  reported numbers are out of sample.
 *       --matches  <n> counts full matches (16 dealer rotations, streaks and prevailing winds included)
 *                  instead of first hands of fresh matches; the paired difference is per match, also
 *                  shown per hand.
 *
 * From the repository root: `npm run sim -- --ladder pro 600 --seed report`.
 */
import { applyAction, chooseAction, hashState, isLegal, newGame, nextHand, tilesRemaining, type Action, type BotSkill, type GameState } from '../src/index';

function checkInvariants(s: GameState): void {
  const total = s.players.reduce((n, p) => n + p.hand.length + p.melds.reduce((m, x) => m + x.tiles.length, 0) + p.flowers.length + p.discards.length, 0) + tilesRemaining(s);
  if (total !== 144) throw new Error(`Tile conservation broken: ${total}`);
}

/** Decision-time and legality counters, per skill. */
interface Timing {
  decisions: number;
  ns: bigint;
  illegal: number;
}
const timing = new Map<BotSkill, Timing>();
function timed(s: GameState, seat: number, skill: BotSkill): Action | null {
  const t0 = process.hrtime.bigint();
  const a = chooseAction(s, seat, { seed: `bot${seat}`, skill });
  const dt = process.hrtime.bigint() - t0;
  const t = timing.get(skill) ?? { decisions: 0, ns: 0n, illegal: 0 };
  if (a) {
    t.decisions++;
    t.ns += dt;
    if (!isLegal(s, seat, a)) t.illegal++;
  }
  timing.set(skill, t);
  return a;
}

/** Play one hand to the end with the given skill per seat, checking invariants every step. */
function playHand(s: GameState, skills: readonly BotSkill[]): GameState {
  let steps = 0;
  while (s.phase !== 'ended') {
    checkInvariants(s);
    let acted = false;
    for (let seat = 0; seat < 4; seat++) {
      const a = timed(s, seat, skills[seat]);
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
  tai: number;
  flushes: number;
}
const tally = (): Tally => ({ seatHands: 0, wins: 0, dealIns: 0, points: 0, tai: 0, flushes: 0 });

const pct = (n: number, d: number): string => `${((n / Math.max(1, d)) * 100).toFixed(1)}%`;
const perHand = (t: Tally): number => t.points / Math.max(1, t.seatHands);

/** Mean, standard error and normal 95% interval of a sample. */
function meanInterval(xs: readonly number[]): { mean: number; se: number; low: number; high: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / Math.max(1, n));
  return { mean, se, low: mean - 1.96 * se, high: mean + 1.96 * se };
}

/** Add one finished hand to the per-seat tallies (`pick(seat)` says which tally a seat feeds). */
function record(s: GameState, pick: (seat: number) => Tally): void {
  const r = s.result!;
  for (let seat = 0; seat < 4; seat++) {
    const t = pick(seat);
    t.seatHands++;
    t.points += r.scoreDelta[seat];
    for (const w of r.wins) {
      if (w.seat === seat) {
        t.wins++;
        t.tai += w.score.tai;
        if (w.score.items.some((i) => i.key === 'half_flush' || i.key === 'full_flush')) t.flushes++;
      }
      if (!w.selfDrawn && w.fromSeat === seat) t.dealIns++;
    }
  }
}

/** Play a full match, feeding every hand into the tallies; returns the final state and the hand count. */
function playMatch(seed: string, skills: readonly BotSkill[], pick: ((seat: number) => Tally) | null): { s: GameState; hands: number } {
  let s = newGame(seed);
  let hands = 0;
  // `nextHand` returns a state with `matchOver` set (and no deal) once the last rotation is done.
  while (!s.matchOver) {
    s = playHand(s, skills);
    hands++;
    if (pick) record(s, pick);
    s = nextHand(s);
  }
  return { s, hands };
}

interface LadderOptions {
  skill: BotSkill;
  vs: BotSkill;
  n: number;
  prefix: string;
  matches: boolean;
}

function runLadder(o: LadderOptions): void {
  const test = tally();
  const others = tally();
  // Paired: the test seat's score with `skill` there minus its score on the same seed with `vs` there.
  const paired: number[] = [];
  let hands = 0;
  let draws = 0;
  const started = Date.now();
  for (let i = 0; i < o.n; i++) {
    const testSeat = i % 4;
    const skills = [0, 1, 2, 3].map((seat): BotSkill => (seat === testSeat ? o.skill : o.vs));
    const pick = (seat: number) => (seat === testSeat ? test : others);
    const seed = `${o.prefix}-${i}`;
    if (o.matches) {
      const a = playMatch(seed, skills, pick);
      hands += a.hands;
      const b = o.skill === o.vs ? a : playMatch(seed, [o.vs, o.vs, o.vs, o.vs], null);
      paired.push(a.s.scores[testSeat] - b.s.scores[testSeat]);
    } else {
      const a = playHand(newGame(seed), skills);
      hands++;
      if (a.result!.type !== 'win') draws++;
      record(a, pick);
      const b = o.skill === o.vs ? a : playHand(newGame(seed), [o.vs, o.vs, o.vs, o.vs]);
      paired.push(a.result!.scoreDelta[testSeat] - b.result!.scoreDelta[testSeat]);
    }
  }
  const ms = Date.now() - started;
  const line = (label: string, t: Tally) =>
    `${label.padEnd(9)} win ${pct(t.wins, t.seatHands).padStart(6)}  pts/hand ${perHand(t).toFixed(2).padStart(8)}  deal-in ${pct(t.dealIns, t.seatHands).padStart(6)}  台/win ${(t.tai / Math.max(1, t.wins)).toFixed(2)}  flushes ${t.flushes}`;
  const unit = o.matches ? 'matches' : 'hands';
  console.log(`ladder ${o.skill} vs 3 ${o.vs}: ${unit}=${o.n} seed=${o.prefix}${o.matches ? ` hands=${hands}` : ` draws=${draws} (${pct(draws, hands)})`}`);
  console.log(line(o.skill, test));
  console.log(line(o.vs, others));
  console.log(`${o.skill} minus ${o.vs} (unpaired): ${(perHand(test) - perHand(others)).toFixed(2)} pts/hand; ${(ms / hands).toFixed(1)} ms per hand played`);
  for (const [skill, t] of timing) console.log(`${skill.padEnd(9)} decisions ${t.decisions}  avg ${(Number(t.ns) / Math.max(1, t.decisions) / 1e6).toFixed(3)} ms  illegal ${t.illegal}`);
  const p = meanInterval(paired);
  const scale = o.matches ? hands / o.n : 1;
  const per = (x: number) => (o.matches ? `${x.toFixed(1)} pts/match (${(x / scale).toFixed(2)} pts/hand)` : `${x.toFixed(2)} pts/hand`);
  console.log(`${o.skill} minus ${o.vs} (paired, same seeds and seat): ${per(p.mean)}, se ${p.se.toFixed(2)}, 95% interval [${p.low.toFixed(2)}, ${p.high.toFixed(2)}]`);
  if (o.skill !== o.vs) console.log(p.low > 0 ? `${o.skill} is ahead of ${o.vs} at 95%` : p.high < 0 ? `${o.skill} is behind ${o.vs} at 95%` : `no clear difference from ${o.vs} at 95%`);
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
  const club = timing.get('club');
  console.log(`matches=${matches} hands=${hands} wins=${wins} draws=${draws} (${pct(draws, hands)})`);
  console.log(`avg tai=${(taiSum / Math.max(1, wins)).toFixed(2)} self-draw=${pct(selfDraws, wins)} seatWins=${seatWins.join('/')}`);
  console.log(`${(ms / hands).toFixed(1)} ms per hand; illegal moves ${club?.illegal ?? 0}`);
}

const SKILLS: readonly BotSkill[] = ['beginner', 'club', 'pro'];
function skillArg(v: string | undefined): BotSkill {
  if (!SKILLS.includes(v as BotSkill)) throw new Error(`Unknown skill "${String(v)}" (beginner | club | pro)`);
  return v as BotSkill;
}
function countArg(v: string | undefined, fallback: number): number {
  const n = Number(v ?? fallback);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid count "${String(v)}"`);
  return n;
}

const args = process.argv.slice(2);
const flag = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const [, v] = args.splice(i, 2);
  if (v === undefined) throw new Error(`${name} needs a value`);
  return v;
};
if (flag('--ladder')) {
  const matches = flag('--matches');
  const prefix = option('--seed') ?? 'ladder';
  const vs = skillArg(option('--vs') ?? 'club');
  const skill = skillArg(args[0]);
  runLadder({ skill, vs, n: countArg(args[1], 500), prefix, matches });
} else {
  runMatches(countArg(args[0], 20));
}
