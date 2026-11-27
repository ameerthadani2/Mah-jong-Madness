// `npm run coverage`: runs every vitest workspace's tests with coverage (each workspace's vitest.config.ts holds its
// floors in coverage.thresholds, and vitest fails that workspace when a figure falls below one), then the app's render
// tests with coverage of its .tsx screens and components (`coverage:render`, floors in apps/mobile/jest.config.js), and
// prints one line each with its lines, branches and functions. Exits non-zero if any run failed its tests or a floor.
// Each run also writes its results as JSON (to the system's temporary folder), and the names of the tests that failed
// are listed after the table, so a CI log that shows only its end still says what failed.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACES = [
  ['@mjm/engine', 'packages/engine'],
  ['@mjm/net', 'packages/net'],
  ['@mjm/signal', 'apps/signal'],
  ['@mjm/mobile', 'apps/mobile'],
];

const rows = [];
let failed = false;
const resultsOf = (i) => join(tmpdir(), `mjm-coverage-${process.pid}-${i}.json`);
const firstLine = (s) => (String(s ?? '').split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 200);
/** The tests a run failed, from its JSON results (vitest and jest write the same shape). */
function failing(file) {
  let res;
  try {
    res = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return ['(no results: the run stopped before its reporter wrote them)'];
  }
  const out = [];
  for (const f of res.testResults ?? []) {
    const where = relative(root, f.name ?? '');
    const bad = (f.assertionResults ?? []).filter((a) => a.status === 'failed');
    for (const a of bad) out.push(`${where} > ${a.fullName}: ${firstLine(a.failureMessages?.[0])}`);
    if (bad.length === 0 && f.status === 'failed') out.push(`${where}: ${firstLine(f.message)}`);
  }
  return out.length > 0 ? out : ['(every test passed: a coverage floor)'];
}
for (const [i, [name, dir]] of WORKSPACES.entries()) {
  // COVERAGE=1 tells timing tests that instrumentation slows the code down (test/helpers/timing.ts).
  const args = ['run', 'coverage', '-w', name, '--', '--reporter=default', '--reporter=json', `--outputFile.json=${resultsOf(i)}`];
  const run = spawnSync('npm', args, { cwd: root, stdio: 'inherit', env: { ...process.env, COVERAGE: '1' } });
  const ok = run.status === 0;
  if (!ok) failed = true;
  let total = null;
  try {
    total = JSON.parse(readFileSync(join(root, dir, 'coverage', 'coverage-summary.json'), 'utf8')).total;
  } catch {
    // No summary: the run failed before vitest wrote one; the line below says so.
  }
  rows.push({ name, ok, total, results: resultsOf(i) });
}

// The app's .tsx screens, measured by the render tests (jest), on a line of their own.
{
  const results = resultsOf(WORKSPACES.length);
  const args = ['run', 'coverage:render', '-w', '@mjm/mobile', '--', '--json', `--outputFile=${results}`];
  const run = spawnSync('npm', args, { cwd: root, stdio: 'inherit', env: { ...process.env, COVERAGE: '1' } });
  const ok = run.status === 0;
  if (!ok) failed = true;
  let total = null;
  try {
    total = JSON.parse(readFileSync(join(root, 'apps/mobile', 'coverage-render', 'coverage-summary.json'), 'utf8')).total;
  } catch {
    // No summary: the run failed before jest wrote one.
  }
  rows.push({ name: '@mjm/mobile .tsx', ok, total, results });
}

const pct = (m) => (m ? `${m.pct.toFixed(2)}%`.padStart(8) : '       -');
console.log('\nCoverage by workspace (floors in each vitest.config.ts; the app\'s .tsx line in apps/mobile/jest.config.js)');
console.log(`${'workspace'.padEnd(17)} ${'lines'.padStart(8)} ${'branches'.padStart(8)} ${'functions'.padStart(9)}  result`);
for (const { name, ok, total } of rows) {
  const r = ok ? 'ok' : 'FAILED (tests or a floor)';
  console.log(`${name.padEnd(17)} ${pct(total?.lines)} ${pct(total?.branches)} ${pct(total?.functions).padStart(9)}  ${r}`);
}
for (const { name, ok, results } of rows) {
  if (!ok) {
    const list = failing(results);
    console.log(`\nFailed in ${name} (${list.length}):`);
    for (const line of list.slice(0, 20)) console.log(`  ${line}`);
    if (list.length > 20) console.log(`  … and ${list.length - 20} more`);
  }
  rmSync(results, { force: true });
}
process.exit(failed ? 1 : 0);
