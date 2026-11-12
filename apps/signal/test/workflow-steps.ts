/**
 * Runs the shell steps of the GitHub workflows locally, the way the runner does, so their
 * decisions (deploy or not, build or stop) can be tested with stand-in values.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root. */
export const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The `run: |` script of the step that carries `marker` (its `- id:` or `- name:` line) in a workflow file. */
export function workflowStepScript(workflow: string, marker: string): string {
  const lines = readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8').split('\n');
  const start = lines.findIndex((l) => /^\s*- (id|name): /.test(l) && l.includes(marker));
  if (start < 0) throw new Error(`${workflow} has no step '${marker}'`);
  const stepIndent = lines[start].search(/\S/);
  let run = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && lines[i].search(/\S/) <= stepIndent) break;
    if (/^\s*run: \|\s*$/.test(lines[i])) { run = i; break; }
  }
  if (run < 0) throw new Error(`step '${marker}' of ${workflow} has no run block`);
  const runIndent = lines[run].search(/\S/);
  const body: string[] = [];
  for (let i = run + 1; i < lines.length; i++) {
    if (lines[i].trim() !== '' && lines[i].search(/\S/) <= runIndent) break;
    body.push(lines[i]);
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
  const script = body.map((l) => l.slice(indent)).join('\n');
  // An expression inside the script would be expanded by GitHub, not by this test.
  if (script.includes('${{')) throw new Error(`step '${marker}' of ${workflow} uses an expression inside its script`);
  return script;
}

/** Runs a workflow step as GitHub does (`bash -e`), with only the given environment. */
export function runStep(script: string, env: Record<string, string>, opts: { cwd?: string; pipefail?: boolean } = {}): { status: number; outputs: Record<string, string>; summary: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mjm-step-'));
  const files = { script: join(dir, 'step.sh'), output: join(dir, 'output'), summary: join(dir, 'summary'), envFile: join(dir, 'env') };
  writeFileSync(files.script, script);
  for (const f of [files.output, files.summary, files.envFile]) writeFileSync(f, '');
  const r = spawnSync('bash', ['--noprofile', '--norc', ...(opts.pipefail ? ['-eo', 'pipefail'] : ['-e']), files.script], {
    cwd: opts.cwd ?? dir,
    env: { PATH: process.env.PATH ?? '', HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: files.output, GITHUB_STEP_SUMMARY: files.summary, GITHUB_ENV: files.envFile, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const outputs = Object.fromEntries(readFileSync(files.output, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  return { status: r.status ?? -1, outputs, summary: readFileSync(files.summary, 'utf8'), stdout: `${r.stdout}${r.stderr}` };
}

/** The same, without blocking this process (for a step that talks to a server this test runs). */
export function runStepAsync(script: string, env: Record<string, string>, opts: { cwd?: string } = {}): Promise<{ status: number; outputs: Record<string, string>; summary: string; stdout: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'mjm-step-'));
  const files = { script: join(dir, 'step.sh'), output: join(dir, 'output'), summary: join(dir, 'summary') };
  writeFileSync(files.script, script);
  for (const f of [files.output, files.summary]) writeFileSync(f, '');
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-e', files.script], {
      cwd: opts.cwd ?? dir,
      env: { PATH: process.env.PATH ?? '', HOME: dir, RUNNER_TEMP: dir, GITHUB_OUTPUT: files.output, GITHUB_STEP_SUMMARY: files.summary, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stdout += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      const outputs = Object.fromEntries(readFileSync(files.output, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
      resolve({ status: code ?? -1, outputs, summary: readFileSync(files.summary, 'utf8'), stdout });
    });
  });
}
