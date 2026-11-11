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
 *   tsx scripts/simulate.ts --gate
 *       The CI strength gate, on GATE_HANDS fixed seeds (prefix `gate`) with the per-hand reference
 *       stored in test/fixtures/bot-gate.json. Each seed is played three times with three Club bots
 *       around a rotating test seat: Pro in the seat, Club in the seat, and Pro without its deal-in
 *       and 台 terms in the seat. The same seeds give the same scores on every run, so the gate
 *       compares hand by hand and fails (exit 1) when
 *         - Pro minus Club, or Pro minus Pro-without-the-terms, is more than GATE_MAX_DROP (1 point
 *           a hand) below its reference;
 *         - Pro is behind Club at 95%;
 *         - the terms cost points at 95%, or change no hand at all.
 *       It also prints what the terms are worth in results. That they show no measurable gain is
 *       reported, not failed (rules and reasons: test/helpers/gate.ts).
 *       `--record` stores the current result as the new reference.
 *
 *   tsx scripts/simulate.ts --record-reference
 *       Records the Pro decision reference that test/bots.test.ts replays (test/fixtures/pro-reference.json).
 *
 *   --weights '<json>' (any mode) overrides BOT_WEIGHTS first, e.g. '{"proConcealedShanten":2}' to
 *   check that the gate catches the old Pro regression.
 *
 * From the repository root: `npm run sim -- --ladder pro 600 --seed report`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { applyAction, BOT_WEIGHTS, chooseAction, hashState, isLegal, newGame, nextHand, tilesRemaining, type Action, type BotSkill, type GameState } from '../src/index';
import { againstReference, GATE_HANDS, GATE_MAX_DROP, gateFailures, PRO_TERMS_OFF, summarise, termsVerdict, type GateReference, type SeatStats } from '../test/helpers/gate';
import { recordHand, type ReferenceFile } from '../test/helpers/reference';

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
  const p = summarise(paired);
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

const fixture = (name: string): string => fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url));

/** One series of the gate file on a line of its own, so a re-recorded reference stays a readable diff. */
function gateJson(ref: GateReference): string {
  const series = (x: GateReference['proVsClub']): string => `{ "mean": ${x.mean}, "se": ${x.se}, "perHand": ${JSON.stringify(x.perHand)} }`;
  return [
    '{',
    `  "note": ${JSON.stringify(ref.note)},`,
    `  "prefix": ${JSON.stringify(ref.prefix)},`,
    `  "hands": ${ref.hands},`,
    `  "proVsClub": ${series(ref.proVsClub)},`,
    `  "termsVsBare": ${series(ref.termsVsBare)},`,
    `  "handsChangedByTerms": ${ref.handsChangedByTerms},`,
    `  "seat": ${JSON.stringify(ref.seat)}`,
    '}',
    '',
  ].join('\n');
}

function runGate(record: boolean): void {
  const started = Date.now();
  // The weights under test (the shipped ones, or a --weights override) and the same with the terms off.
  const tested = { ...BOT_WEIGHTS };
  const bare = { ...tested, ...PRO_TERMS_OFF };
  const proVsClub: number[] = [];
  const termsVsBare: number[] = [];
  const stats = (): SeatStats => ({ wins: 0, dealIns: 0, tai: 0 });
  const seat = { pro: stats(), bare: stats(), club: stats() };
  const note = (t: SeatStats, s: GameState, testSeat: number): number => {
    for (const w of s.result!.wins) {
      if (w.seat === testSeat) {
        t.wins++;
        t.tai += w.score.tai;
      }
      if (!w.selfDrawn && w.fromSeat === testSeat) t.dealIns++;
    }
    return s.result!.scoreDelta[testSeat];
  };
  for (let h = 0; h < GATE_HANDS; h++) {
    const testSeat = h % 4;
    const withPro = [0, 1, 2, 3].map((x): BotSkill => (x === testSeat ? 'pro' : 'club'));
    const pro = note(seat.pro, playHand(newGame(`gate-${h}`), withPro), testSeat);
    const club = note(seat.club, playHand(newGame(`gate-${h}`), ['club', 'club', 'club', 'club']), testSeat);
    Object.assign(BOT_WEIGHTS, bare);
    const proBare = note(seat.bare, playHand(newGame(`gate-${h}`), withPro), testSeat);
    Object.assign(BOT_WEIGHTS, tested);
    proVsClub.push(pro - club);
    termsVsBare.push(pro - proBare);
  }
  const c = summarise(proVsClub);
  const t = summarise(termsVsBare);
  const handsChangedByTerms = termsVsBare.filter((x) => x !== 0).length;
  const interval = (x: { low: number; high: number }): string => `95% interval [${x.low.toFixed(2)}, ${x.high.toFixed(2)}]`;
  const seatLine = (label: string, x: SeatStats): string => `  ${label.padEnd(22)} win ${pct(x.wins, GATE_HANDS).padStart(6)}  deal-in ${pct(x.dealIns, GATE_HANDS).padStart(6)}  台/win ${(x.tai / Math.max(1, x.wins)).toFixed(2)}`;
  console.log(`gate: ${GATE_HANDS} paired hands, seed prefix gate (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  console.log(`1. pro minus club: ${c.mean.toFixed(2)} pts/hand, se ${c.se.toFixed(2)}, ${interval(c)}: ${c.low > 0 ? 'pro is ahead of club at 95%' : c.high < 0 ? 'pro is behind club at 95%' : 'no clear difference from club at 95%'}`);
  console.log(`2. pro minus pro without its deal-in and 台 terms: ${t.mean.toFixed(2)} pts/hand, se ${t.se.toFixed(2)}, ${interval(t)}: ${termsVerdict(termsVsBare)}`);
  console.log(`   the terms change the test seat's score in ${handsChangedByTerms} of ${GATE_HANDS} hands`);
  console.log(seatLine('pro', seat.pro));
  console.log(seatLine('pro without the terms', seat.bare));
  console.log(seatLine('club', seat.club));
  if (record) {
    const round = (x: number): number => Number(x.toFixed(3));
    const ref: GateReference = {
      note: 'Per-hand paired scores of the bot strength gate (rules: test/helpers/gate.ts). Regenerate after an intentional change to Pro or Club: npm run sim -- --gate --record',
      prefix: 'gate',
      hands: GATE_HANDS,
      proVsClub: { mean: round(c.mean), se: round(c.se), perHand: proVsClub },
      termsVsBare: { mean: round(t.mean), se: round(t.se), perHand: termsVsBare },
      handsChangedByTerms,
      seat,
    };
    writeFileSync(fixture('bot-gate.json'), gateJson(ref));
    console.log('reference recorded');
    return;
  }
  const ref = JSON.parse(readFileSync(fixture('bot-gate.json'), 'utf8')) as GateReference;
  const refLine = (label: string, now: readonly number[], then: GateReference['proVsClub']): void => {
    const d = againstReference(now, then.perHand);
    console.log(`reference ${label}: ${then.mean.toFixed(2)}; this run ${d.change >= 0 ? '+' : ''}${d.change.toFixed(2)} pts/hand, ${d.differing} of ${GATE_HANDS} hands differ (fails below -${GATE_MAX_DROP.toFixed(2)})`);
    if (d.change > GATE_MAX_DROP) console.log(`  more than ${GATE_MAX_DROP.toFixed(2)} above the reference: record it (--gate --record) so that the gain is protected`);
  };
  refLine('1', proVsClub, ref.proVsClub);
  refLine('2', termsVsBare, ref.termsVsBare);
  const failures = gateFailures({ proVsClub, termsVsBare }, ref);
  if (failures.length > 0) {
    for (const f of failures) console.log(`GATE FAILED: ${f}`);
    process.exitCode = 1;
  } else console.log('gate passed');
}

function recordReference(): void {
  const hands = Array.from({ length: 120 }, (_, i) => recordHand(`ref-${i}`, i % 4));
  const file: ReferenceFile = {
    note: 'Pro decisions replayed by test/bots.test.ts. Regenerate after an intentional change to Pro: npm run sim -- --record-reference',
    hands,
  };
  writeFileSync(fixture('pro-reference.json'), `${JSON.stringify(file)}\n`);
  console.log(`recorded ${hands.length} hands, ${hands.reduce((n, h) => n + h.points.length, 0)} decisions`);
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
const weights = option('--weights');
if (weights) Object.assign(BOT_WEIGHTS, JSON.parse(weights) as Partial<typeof BOT_WEIGHTS>);
if (flag('--gate')) runGate(flag('--record'));
else if (flag('--record-reference')) recordReference();
else if (flag('--ladder')) {
  const matches = flag('--matches');
  const prefix = option('--seed') ?? 'ladder';
  const vs = skillArg(option('--vs') ?? 'club');
  const skill = skillArg(args[0]);
  runLadder({ skill, vs, n: countArg(args[1], 500), prefix, matches });
} else {
  runMatches(countArg(args[0], 20));
}
