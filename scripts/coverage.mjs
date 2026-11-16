// `npm run coverage`: runs every vitest workspace's tests with coverage (each workspace's vitest.config.ts holds its
// floors in coverage.thresholds, and vitest fails that workspace when a figure falls below one), then prints one line
// a workspace with its lines, branches and functions. Exits non-zero if any workspace failed its tests or a floor.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
for (const [name, dir] of WORKSPACES) {
  const run = spawnSync('npm', ['run', 'coverage', '-w', name], { cwd: root, stdio: 'inherit' });
  const ok = run.status === 0;
  if (!ok) failed = true;
  let total = null;
  try {
    total = JSON.parse(readFileSync(join(root, dir, 'coverage', 'coverage-summary.json'), 'utf8')).total;
  } catch {
    // No summary: the run failed before vitest wrote one; the line below says so.
  }
  rows.push({ name, ok, total });
}

const pct = (m) => (m ? `${m.pct.toFixed(2)}%`.padStart(8) : '       -');
console.log('\nCoverage by workspace (floors in each vitest.config.ts)');
console.log(`${'workspace'.padEnd(14)} ${'lines'.padStart(8)} ${'branches'.padStart(8)} ${'functions'.padStart(9)}  result`);
for (const { name, ok, total } of rows) {
  const r = ok ? 'ok' : 'FAILED (tests or a floor)';
  console.log(`${name.padEnd(14)} ${pct(total?.lines)} ${pct(total?.branches)} ${pct(total?.functions).padStart(9)}  ${r}`);
}
process.exit(failed ? 1 : 0);
