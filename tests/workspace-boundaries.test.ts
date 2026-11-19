/**
 * The server's tests read only the server's workspace (apps/signal) and the packages it imports
 * (packages/engine and packages/net), so its suite runs from a copy of those three folders, the way
 * the Dockerfile and the deploy workflow install them. A check that needs more of the repository
 * (the workflows, the docs, the app) belongs in this folder instead.
 *
 * The check reads every string in the server's test folder as TypeScript parses it (comments do not
 * count) and refuses three kinds of path:
 * - a relative path that leads out of those folders from the file that names it ('../../mobile/x');
 * - a path that starts at a part of the repository found only at its root ('docs/x.md',
 *   '.github/workflows', 'fly.toml', 'tests/x') or in another workspace ('apps/mobile/eas.json');
 * - a run of '..' arguments that climbs out of the workspace from the file's folder
 *   (join(here, '..', '..', 'x')).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = 'apps/signal';
/** What the server's tests may read: its own folder and the packages it imports. */
const ALLOWED = ['apps/signal', 'packages/engine', 'packages/net'];

const posix = (path: string) => path.split(sep).join('/');
const allowed = (fromRoot: string) => ALLOWED.some((a) => fromRoot === a || fromRoot.startsWith(`${a}/`));

/** Entries at the top of the repository that the workspace has none of its own of (docs, .github, fly.toml, tests and so on). */
function rootOnly(): string[] {
  const own = new Set(readdirSync(join(ROOT, WORKSPACE)));
  return readdirSync(ROOT).filter((name) => !['.git', 'node_modules', 'apps', 'packages'].includes(name) && !own.has(name));
}

/** Whether a path written from the repository root names something outside the allowed folders. */
function namesElsewhere(path: string, rootNames: string[]): boolean {
  if (rootNames.some((name) => path === name || path.startsWith(`${name}/`))) return true;
  const workspace = /^(apps|packages)\/[^/]+/.exec(path)?.[0];
  return workspace !== undefined && !allowed(workspace);
}

/** The paths in one source file that lead out of the allowed folders, each as "line: why 'text'". */
function pathsOutside(file: string, text: string, rootNames: string[]): string[] {
  const dir = dirname(file);
  // How many '..' steps from the file's folder stay inside the workspace (1 for a file in apps/signal/test).
  const depth = posix(relative(join(ROOT, WORKSPACE), dir)).split('/').filter(Boolean).length;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const flag = (node: ts.Node, why: string, value: string) => found.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${why} '${value}'`);
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const value = node.text;
      if (/^\.\.?(\/|$)/.test(value) && !allowed(posix(relative(ROOT, resolve(dir, value))))) flag(node, 'leads out', value);
      else if (namesElsewhere(value, rootNames)) flag(node, 'names', value);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // `${ROOT}/docs/API.md`: the text after a substitution, read from the root.
      if (namesElsewhere(node.text.replace(/^\/+/, ''), rootNames)) flag(node, 'names', node.text);
    } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      let run = 0;
      for (const arg of node.arguments) {
        run = ts.isStringLiteral(arg) && arg.text === '..' ? run + 1 : 0;
        if (run === depth + 1) flag(arg, 'climbs out with', Array(run).fill('..').join(', '));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.[cm]?[jt]sx?$/.test(name) ? [path] : [];
  });
}

describe("the server's tests stay inside the server's workspace", () => {
  const rootNames = rootOnly();
  const scan = (text: string) => pathsOutside(join(ROOT, WORKSPACE, 'test', 'a.test.ts'), text, rootNames);

  it('finds each kind of path that leads out of it', () => {
    expect(rootNames).toEqual(expect.arrayContaining(['.github', 'docs', 'fly.toml', 'tests']));
    expect(scan("await import(fileURLToPath(new URL('../../mobile/src/monetisation/catalog.ts', import.meta.url)));")).toEqual(["1: leads out '../../mobile/src/monetisation/catalog.ts'"]);
    expect(scan("export const ROOT = fileURLToPath(new URL('../../..', import.meta.url));")).toEqual(["1: leads out '../../..'"]);
    expect(scan("readFileSync(join(ROOT, '.github/workflows', 'ci.yml'));")).toEqual(["1: names '.github/workflows'"]);
    expect(scan("readFileSync(join(ROOT, 'apps/mobile/eas.json'));")).toEqual(["1: names 'apps/mobile/eas.json'"]);
    expect(scan('readFileSync(`${ROOT}/docs/API.md`);')).toEqual(["1: names '/docs/API.md'"]);
    expect(scan("readFileSync(join(here, '..', '..', 'mobile', 'app.json'));")).toEqual(["1: climbs out with '.., ..'"]);
    expect(scan("readFileSync(join(here, '..', '..', '..', 'fly.toml'));")).toEqual(["1: climbs out with '.., ..'", "1: names 'fly.toml'"]);
  });

  it('lets it name its own files, the packages it imports, and anything in a comment', () => {
    const text = [
      "import { serverProduct } from '../src/catalog';",
      "import { newGame } from '@mjm/engine';",
      "const SIGNAL = fileURLToPath(new URL('..', import.meta.url));",
      "readFileSync(join(SIGNAL, '.env.example'));",
      "readFileSync(join(here, '..', 'README.md'));",
      "readFileSync(new URL('../../../packages/engine/src/index.ts', import.meta.url));",
      "// docs/API.md says so, and '../../mobile/x' is the app",
      "expect(r.stdout).toContain('docs and tests');",
    ].join('\n');
    expect(scan(text)).toEqual([]);
  });

  it('holds for every file in apps/signal/test', () => {
    const all = files(join(ROOT, WORKSPACE, 'test'));
    expect(all.length).toBeGreaterThan(50);
    const out = all.flatMap((file) => pathsOutside(file, readFileSync(file, 'utf8'), rootNames).map((hit) => `${posix(relative(ROOT, file))}:${hit}`));
    // A check that needs the rest of the repository goes in tests/ at the root (tests/vitest.config.mts).
    expect(out).toEqual([]);
  });
});
