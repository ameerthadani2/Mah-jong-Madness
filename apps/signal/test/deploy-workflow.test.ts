/**
 * The deploy workflow's decisions, run as the shell steps GitHub runs, against scratch git
 * repositories, a stand-in `gh` and a local HTTP server:
 * - after CI only the head of main is deployed, and whether it is deployed is decided by
 *   comparing it with the commit the last successful deploy shipped;
 * - a manual run deploys the head of its branch and a re-run of an older one is refused;
 * - a malformed address stops the run before the deploy, and the health check accepts only this
 *   server's own report on the expected storage.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, runStep, runStepAsync, workflowStepScript } from './workflow-steps.js';

const WORKFLOW = 'deploy-signal.yml';
const decide = workflowStepScript(WORKFLOW, 'id: changed');

interface Scratch {
  dir: string;
  bin: string;
  fake: string;
  /** Commits a change to `path` on the current branch, pushes it and returns the commit. */
  commit(path: string): string;
  git(...args: string[]): string;
  /** What `gh run list` answers: runs newest first, each with whether its deploy job succeeded. */
  runs(list: { sha: string; deployed: boolean }[]): void;
}

/** A clone of a bare "origin" with one commit on main, and a stand-in `gh` on the PATH. */
function scratch(): Scratch {
  const top = mkdtempSync(join(tmpdir(), 'mjm-deploy-'));
  const origin = join(top, 'origin.git');
  const dir = join(top, 'work');
  const bin = join(top, 'bin');
  const fake = join(top, 'gh');
  mkdirSync(bin);
  mkdirSync(fake);
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const run = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  run(top, 'init', '-q', '--bare', '-b', 'main', origin);
  run(top, 'clone', '-q', origin, dir);
  run(dir, 'checkout', '-q', '-b', 'main');
  // The stand-in answers what the real one prints after its --jq filter.
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/bash\nif [ -n "$GH_FAIL" ]; then echo "gh: HTTP 403" >&2; exit 1; fi\nif [ "$1 $2" = "run list" ]; then cat "$GH_FAKE/runs"; exit 0; fi\nif [ "$1 $2" = "run view" ]; then cat "$GH_FAKE/jobs-$3"; exit 0; fi\nexit 1\n',
  );
  chmodSync(join(bin, 'gh'), 0o755);
  writeFileSync(join(fake, 'runs'), '');
  let n = 0;
  const s: Scratch = {
    dir,
    bin,
    fake,
    git: (...args) => run(dir, ...args),
    commit(path) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), `change ${++n}\n`);
      run(dir, 'add', '-A');
      run(dir, 'commit', '-q', '-m', `change ${n}: ${path}`);
      run(dir, 'push', '-q', 'origin', 'HEAD');
      return run(dir, 'rev-parse', 'HEAD');
    },
    runs(list) {
      writeFileSync(join(fake, 'runs'), list.map((r, i) => `${100 - i} ${r.sha}\n`).join(''));
      list.forEach((r, i) => writeFileSync(join(fake, `jobs-${100 - i}`), r.deployed ? '1\n' : '0\n'));
    },
  };
  s.commit('README.md');
  return s;
}

function decideFor(s: Scratch, env: Record<string, string>) {
  return runStep(decide, { PATH: `${s.bin}:${process.env.PATH ?? ''}`, GH_FAKE: s.fake, GITHUB_REPOSITORY: 'owner/repo', GH_TOKEN: 'x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', EVENT: 'workflow_run', BRANCH: 'main', REF_TYPE: 'branch', ...env }, { cwd: s.dir });
}

describe('deploy workflow: what gets deployed after CI', () => {
  it('deploys a server change even when a later commit of the same push touched only documents', () => {
    const s = scratch();
    const deployed = s.commit('apps/signal/src/a.ts');
    s.runs([{ sha: deployed, deployed: true }]);
    s.commit('apps/signal/src/b.ts');
    const head = s.commit('docs/x.md');
    const r = decideFor(s, { SHA: head });
    expect(r).toMatchObject({ status: 0, outputs: { server: 'true' } });
    expect(r.stdout).toContain(`Changed since the deployed commit ${deployed.slice(0, 7)}: apps/signal/src/b.ts`);
  });

  it('deploys nothing when no server file differs from the deployed commit, and says so', () => {
    const s = scratch();
    const deployed = s.commit('packages/engine/src/a.ts');
    s.runs([{ sha: deployed, deployed: true }]);
    s.commit('docs/x.md');
    const head = s.commit('apps/mobile/src/App.tsx');
    const r = decideFor(s, { SHA: head });
    expect(r).toMatchObject({ status: 0, outputs: { server: 'false' } });
    expect(r.summary).toContain(`Nothing the server is built from changed between the deployed commit ${deployed.slice(0, 7)} and ${head.slice(0, 7)}`);
    // CI run again on the commit that is already live: nothing to do either.
    s.runs([{ sha: head, deployed: true }]);
    expect(decideFor(s, { SHA: head })).toMatchObject({ status: 0, outputs: { server: 'false' } });
  });

  it('counts every path the image is built from, the lockfile and fly.toml included', () => {
    for (const path of ['apps/signal/migrations/0099_x.sql', 'packages/net/src/a.ts', 'package-lock.json', 'package.json', 'tsconfig.base.json', 'fly.toml', '.github/workflows/deploy-signal.yml']) {
      const s = scratch();
      const deployed = s.git('rev-parse', 'HEAD');
      s.runs([{ sha: deployed, deployed: true }]);
      expect(decideFor(s, { SHA: s.commit(path) }).outputs.server, path).toBe('true');
    }
  });

  it('never deploys a commit that is not the head of main, such as a re-run of an old CI run', () => {
    const s = scratch();
    const old = s.commit('apps/signal/src/a.ts');
    const head = s.commit('apps/signal/src/b.ts');
    s.runs([{ sha: head, deployed: true }]);
    const r = decideFor(s, { SHA: old });
    expect(r).toMatchObject({ status: 0, outputs: { server: 'false' } });
    expect(r.summary).toContain(`CI passed for ${old.slice(0, 7)}, which is not the head of main (${head.slice(0, 7)})`);
    // The same holds with nothing deployed yet: the head's own run ships it.
    s.runs([]);
    expect(decideFor(s, { SHA: old }).outputs.server).toBe('false');
    expect(decideFor(s, { SHA: head }).outputs.server).toBe('true');
  });

  it('compares with the last run that really deployed, not with a later run that skipped', () => {
    const s = scratch();
    const deployed = s.git('rev-parse', 'HEAD');
    const skipped = s.commit('apps/signal/src/a.ts'); // its run ended green without deploying (say, no token yet)
    s.runs([
      { sha: skipped, deployed: false },
      { sha: deployed, deployed: true },
    ]);
    const head = s.commit('docs/x.md');
    const r = decideFor(s, { SHA: head });
    expect(r.outputs.server).toBe('true');
    expect(r.stdout).toContain(`Changed since the deployed commit ${deployed.slice(0, 7)}`);
  });

  it('deploys when the deployed commit is unknown, unreachable or not an ancestor', () => {
    const s = scratch();
    const head = s.commit('docs/x.md');
    expect(decideFor(s, { SHA: head }).stdout).toContain('No earlier successful deploy found');
    expect(decideFor(s, { SHA: head, GH_FAIL: '1' })).toMatchObject({ status: 0, outputs: { server: 'true' } });
    s.runs([{ sha: '0123456789abcdef0123456789abcdef01234567', deployed: true }]);
    expect(decideFor(s, { SHA: head }).stdout).toContain('is not an ancestor');
    // Deployed by hand from a working branch that main does not contain.
    s.git('checkout', '-q', '-b', 'work');
    const side = s.commit('apps/signal/src/side.ts');
    s.git('checkout', '-q', 'main');
    s.runs([{ sha: side, deployed: true }]);
    expect(decideFor(s, { SHA: head })).toMatchObject({ status: 0, outputs: { server: 'true' } });
  });
});

describe('deploy workflow: a manual run', () => {
  it('deploys the head of the branch it was started on, without looking at earlier deploys', () => {
    const s = scratch();
    s.git('checkout', '-q', '-b', 'work');
    const head = s.commit('docs/x.md');
    const r = decideFor(s, { EVENT: 'workflow_dispatch', BRANCH: 'work', SHA: head, GH_FAIL: '1' });
    expect(r).toMatchObject({ status: 0, outputs: { server: 'true' } });
    expect(r.stdout).toContain(`Manual run from the head of work: deploying ${head.slice(0, 7)}`);
  });

  it('refuses a re-run of an older run, whose commit is no longer the head of the branch', () => {
    const s = scratch();
    const old = s.commit('apps/signal/src/a.ts');
    const head = s.commit('apps/signal/src/b.ts');
    const r = decideFor(s, { EVENT: 'workflow_dispatch', BRANCH: 'main', SHA: old });
    expect(r.status).toBe(1);
    expect(r.outputs.server).toBeUndefined();
    expect(r.summary).toContain(`would deploy ${old.slice(0, 7)}, which is no longer the head of main (now ${head.slice(0, 7)})`);
    expect(decideFor(s, { EVENT: 'workflow_dispatch', BRANCH: 'v1.0', REF_TYPE: 'tag', SHA: head }).status).toBe(1);
  });
});

describe('deploy workflow: the address and the health check', () => {
  const address = workflowStepScript(WORKFLOW, 'name: Find the address to check');
  const health = workflowStepScript(WORKFLOW, 'name: Health check');
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  });

  async function serve(handler: (url: string) => { status: number; body: string; location?: string }): Promise<string> {
    const s = createServer((req, res) => {
      const a = handler(req.url ?? '/');
      res.writeHead(a.status, { 'content-type': 'application/json', ...(a.location ? { location: a.location } : {}) });
      res.end(a.body);
    });
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  }

  /** A PATH whose `sleep` returns at once, so the two-minute wait takes no time here. */
  function quick(): string {
    const bin = mkdtempSync(join(tmpdir(), 'mjm-bin-'));
    writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n');
    chmodSync(join(bin, 'sleep'), 0o755);
    return `${bin}:${process.env.PATH ?? ''}`;
  }

  it('turns SIGNAL_URL into the https origin, or uses the app named in fly.toml', () => {
    expect(runStep(address, { SIGNAL_URL: 'wss://mahjong.example.com/socket', EXPECT_STORAGE: 'pg' }, { cwd: ROOT }).outputs).toEqual({ base: 'https://mahjong.example.com', storage: 'pg' });
    expect(runStep(address, { SIGNAL_URL: ' https://mahjong.example.com:8443 \n', EXPECT_STORAGE: 'memory' }, { cwd: ROOT }).outputs).toEqual({ base: 'https://mahjong.example.com:8443', storage: 'memory' });
    const app = /^app *= *"([^"]+)"/m.exec(readFileSync(join(ROOT, 'fly.toml'), 'utf8'))![1];
    expect(runStep(address, { SIGNAL_URL: '', EXPECT_STORAGE: 'pg' }, { cwd: ROOT }).outputs).toEqual({ base: `https://${app}.fly.dev`, storage: 'pg' });
  });

  it('stops before the deploy on an address without a scheme, an upper-case scheme or an unknown storage', () => {
    for (const bad of ['my.fly.dev', 'WSS://my.fly.dev', 'wss://', 'ftp://my.fly.dev', 'wss://user@my.fly.dev']) {
      const r = runStep(address, { SIGNAL_URL: bad, EXPECT_STORAGE: 'pg' }, { cwd: ROOT });
      expect(r.status, bad).toBe(1);
      expect(r.outputs.base).toBeUndefined();
      expect(r.stdout).toContain('Nothing was deployed');
    }
    expect(runStep(address, { SIGNAL_URL: 'wss://my.fly.dev', EXPECT_STORAGE: 'sqlite' }, { cwd: ROOT }).status).toBe(1);
    // The address is settled before flyctl runs.
    const text = readFileSync(join(ROOT, '.github/workflows', WORKFLOW), 'utf8');
    expect(text.indexOf('name: Find the address to check')).toBeLessThan(text.indexOf('run: flyctl deploy'));
    expect(text).toMatch(/npm test --workspace @mjm\/engine/);
    expect(text).toMatch(/--expect-storage "\$EXPECT_STORAGE"/);
  });

  it("passes on this server's own health report on the expected storage", async () => {
    const base = await serve(() => ({ status: 200, body: JSON.stringify({ ok: true, tables: 0, storage: 'pg', db: 'ok' }) }));
    const r = await runStepAsync(health, { PATH: quick(), BASE: base, EXPECT_STORAGE: 'pg' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"storage":"pg"');
  });

  it('fails on a redirect to something else, on a page that is not the health report, and on the wrong storage', async () => {
    const redirect = await serve((url) => (url === '/health' ? { status: 301, body: '', location: '/welcome' } : { status: 200, body: '<html>Welcome</html>' }));
    const loop = await serve(() => ({ status: 301, body: '', location: '/health' }));
    const memory = await serve(() => ({ status: 200, body: JSON.stringify({ ok: true, storage: 'memory' }) }));
    const draining = await serve(() => ({ status: 503, body: JSON.stringify({ ok: false, draining: true, storage: 'pg' }) }));
    for (const [base, why] of [
      [redirect, "not this server's health report"],
      [loop, 'no 200 answer'],
      [memory, "not on storage 'pg'"],
      [draining, 'no 200 answer'],
    ]) {
      const r = await runStepAsync(health, { PATH: quick(), BASE: base, EXPECT_STORAGE: 'pg' });
      expect(r.status, why).toBe(1);
      expect(r.stdout).toContain('::error title=Health check failed::');
      expect(r.stdout).toContain(why);
    }
    // A deployment that is on memory on purpose says so with SMOKE_EXPECT_STORAGE=memory.
    expect((await runStepAsync(health, { PATH: quick(), BASE: memory, EXPECT_STORAGE: 'memory' })).status).toBe(0);
  }, 60_000);
});
