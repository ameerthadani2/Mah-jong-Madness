/**
 * The soak runner: many generated scenarios, in parallel, judged by the oracle; or one scenario replayed.
 *
 *   npx tsx packages/net/test/adversary/soak.ts --from 1 --to 2000 --mode mixed --workers 2
 *   npx tsx packages/net/test/adversary/soak.ts --from 1 --to 2000 --mode honest --workers 2
 *   npx tsx packages/net/test/adversary/soak.ts --replay '<scenario JSON>' [--timeline]
 *   npx tsx packages/net/test/adversary/soak.ts --seed 1234 --mode mixed [--timeline]
 *
 * Options: `--mode honest|mixed|direct|both|all` (both: each seed once as honest and as mixed; all: of the three), `--workers N` (processes; default 1),
 * `--no-minimize` (print a failure as generated), `--budget N` (runs spent minimizing one failure; default 40),
 * `--out file.jsonl` (one line per failing scenario: seed, mode, violations, the minimized scenario), `--update` (honest
 * scenarios may hold an app update; needs ADVERSARY_OLD_TREE), `--quiet` (the summary only). ADVERSARY_TREE runs
 * another copy of the code (load.ts). The summary counts each failure class (`known:property`), with its seeds, and the
 * rate in scenarios a second. Exit status 1 when any scenario failed.
 */
import { fork } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { minimize, report, runScenario, toJson, type Outcome } from './fuzz';
import { generate, type Mode } from './generate';
import { codeName, oldCodeName } from './load';
import { classOf, type Violation } from './oracle';
import type { Scenario } from './scenario';

interface Args {
  from: number;
  to: number;
  modes: Mode[];
  workers: number;
  minimize: boolean;
  budget: number;
  out: string | null;
  update: boolean;
  quiet: boolean;
  replay: string | null;
  seed: number | null;
  timeline: boolean;
  /** This process is worker `k` of `n`. */
  worker: { k: number; n: number } | null;
}

function parse(argv: string[]): Args {
  const a: Args = { from: 1, to: 100, modes: ['mixed'], workers: 1, minimize: true, budget: 40, out: null, update: false, quiet: false, replay: null, seed: null, timeline: false, worker: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === '--from') a.from = Number(v());
    else if (k === '--to') a.to = Number(v());
    else if (k === '--mode') {
      const m = v();
      a.modes = m === 'both' ? ['honest', 'mixed'] : m === 'all' ? ['honest', 'mixed', 'direct'] : [m as Mode];
    } else if (k === '--workers') a.workers = Math.max(1, Number(v()));
    else if (k === '--no-minimize') a.minimize = false;
    else if (k === '--budget') a.budget = Number(v());
    else if (k === '--out') a.out = v();
    else if (k === '--update') a.update = true;
    else if (k === '--quiet') a.quiet = true;
    else if (k === '--replay') a.replay = v();
    else if (k === '--seed') a.seed = Number(v());
    else if (k === '--timeline') a.timeline = true;
    else if (k === '--worker') {
      const [x, n] = v().split('/').map(Number);
      a.worker = { k: x, n };
    } else throw new Error(`unknown option ${k}`);
  }
  return a;
}

/** What a worker tells the parent about one scenario. */
interface Row {
  seed: number;
  mode: Mode;
  ms: number;
  simSeconds: number;
  shown: string;
  classes: string[];
  /** The printed failures (with the minimized events), when it failed. */
  text: string[];
  scenario: Scenario | null;
  minimized: Scenario | null;
  threw: string | null;
}

/** A failure's class for the summary: `property:gap`, and for a gap not named yet the kinds of cheat it is made of. */
function label(v: Violation): string {
  return v.known === 'new' && v.cheats.length ? `${classOf(v)}[${[...new Set(v.cheats.map((c) => c.kind))].join('+')}]` : classOf(v);
}

function runOne(s: Scenario, mode: Mode, args: Args): Row {
  let o: Outcome;
  try {
    o = runScenario(s);
  } catch (e) {
    return { seed: s.seed, mode, ms: 0, simSeconds: 0, shown: '', classes: ['harness:throw'], text: [`THROW seed ${s.seed} (${mode}): ${(e as Error).stack?.split('\n').slice(0, 3).join(' | ')}`], scenario: s, minimized: null, threw: String((e as Error).message) };
  }
  const vs = o.judgement.violations;
  const classes = [...new Set(vs.map(label))];
  const text: string[] = [];
  let minimized: Scenario | null = null;
  if (vs.length) {
    // One report per class; the first violation of the class is the one minimized.
    for (const c of classes) {
      const v = vs.find((x) => label(x) === c)!;
      let m: Scenario | undefined;
      try {
        m = args.minimize ? minimize(s, v, args.budget) : undefined;
      } catch {
        m = undefined;
      }
      if (m && !minimized) minimized = m;
      text.push(report(o, v, m));
    }
  }
  return { seed: s.seed, mode, ms: o.ms, simSeconds: o.simSeconds, shown: o.shown, classes, text, scenario: vs.length ? s : null, minimized, threw: null };
}

/** The seeds of a worker: every n-th from `from`. */
function* seedsOf(args: Args): Generator<number> {
  const w = args.worker ?? { k: 0, n: 1 };
  for (let s = args.from + w.k; s <= args.to; s += w.n) yield s;
}

function work(args: Args, emit: (r: Row) => void): void {
  for (const seed of seedsOf(args)) for (const mode of args.modes) emit(runOne(generate(seed, mode, { update: args.update }), mode, args));
}

function summary(rows: Row[], wallMs: number, args: Args): { text: string; failed: boolean } {
  const by = new Map<string, Row[]>();
  let failed = false;
  for (const r of rows) {
    for (const c of r.classes.length ? r.classes : ['clean']) by.set(`${r.mode} ${c}`, [...(by.get(`${r.mode} ${c}`) ?? []), r]);
    if (r.classes.length) failed = true;
  }
  const n = rows.length;
  const cpu = rows.reduce((s, r) => s + r.ms, 0);
  const sim = rows.reduce((s, r) => s + r.simSeconds, 0);
  const lines = [
    `code ${codeName}${oldCodeName ? ` (update from ${oldCodeName})` : ''}; seeds ${args.from}-${args.to}; modes ${args.modes.join(',')}; ${args.workers} worker(s)`,
    ...[...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, rs]) => `  ${k.padEnd(34)} ${String(rs.length).padStart(6)}${k.endsWith(' clean') ? '' : `  seeds ${rs.slice(0, 12).map((r) => r.seed).join(',')}${rs.length > 12 ? ',...' : ''}`}`),
    `  ${n} scenarios in ${(wallMs / 1000).toFixed(1)} s: ${(n / (wallMs / 1000)).toFixed(2)} a second (${(n / (cpu / 1000)).toFixed(2)} a second a worker; ${Math.round(cpu / Math.max(1, n))} ms and ${Math.round(sim / Math.max(1, n))} simulated seconds each)`,
  ];
  return { text: lines.join('\n'), failed };
}

function main(): void {
  const args = parse(process.argv.slice(2));
  if (args.replay || args.seed !== null) {
    const s: Scenario = args.replay ? (JSON.parse(args.replay) as Scenario) : generate(args.seed!, args.modes[0], { update: args.update });
    const o = runScenario(s);
    console.log(toJson(s));
    console.log(`shown: ${o.shown || 'nothing'}; end ${o.judgement.endVerified ? 'verified' : 'not verified'}${o.judgement.matchFailed ? ', match failed' : ''}`);
    for (const c of o.judgement.cheats) console.log(`  cheat ${c.kind} hand ${c.hand} turn ${c.turn}: ${c.what}${c.excuses.length ? ` [stated: ${c.excuses.join(', ')}]` : ''}`);
    for (const v of o.judgement.violations) console.log(report(o, v));
    if (args.timeline) console.log(o.timeline.join('\n'));
    process.exitCode = o.judgement.violations.length ? 1 : 0;
    return;
  }
  if (args.worker) {
    // A worker: one JSON line per scenario on stdout.
    work(args, (r) => process.stdout.write(`${JSON.stringify(r)}\n`));
    return;
  }
  const started = performance.now();
  const rows: Row[] = [];
  const take = (r: Row) => {
    rows.push(r);
    if (r.classes.length && !args.quiet) for (const t of r.text) console.log(`${t}\n`);
    if (r.classes.length && args.out) appendFileSync(args.out, `${JSON.stringify({ seed: r.seed, mode: r.mode, classes: r.classes, shown: r.shown, scenario: r.scenario, minimized: r.minimized })}\n`);
  };
  const done = () => {
    const s = summary(rows, performance.now() - started, args);
    console.log(s.text);
    process.exitCode = s.failed ? 1 : 0;
  };
  if (args.workers === 1) {
    work(args, take);
    return done();
  }
  const self = fileURLToPath(import.meta.url);
  let left = args.workers;
  for (let k = 0; k < args.workers; k++) {
    const rest = process.argv.slice(2).filter((_, i, all) => all[i] !== '--workers' && all[i - 1] !== '--workers');
    const child = fork(self, [...rest, '--worker', `${k}/${args.workers}`], { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
    let buf = '';
    child.stdout!.on('data', (d: Buffer) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.startsWith('{')) take(JSON.parse(line) as Row);
      }
    });
    child.on('exit', (code) => {
      if (code !== 0) console.log(`worker ${k} exited with ${code}`);
      if (--left === 0) done();
    });
  }
}

main();
