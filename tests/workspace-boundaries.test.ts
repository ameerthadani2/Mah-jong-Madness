/**
 * The server's tests read only the server's workspace (apps/signal) and the packages it imports
 * (packages/engine and packages/net), so its suite runs from a copy of those three folders, the way
 * the Dockerfile and the deploy workflow install them. A check that needs more of the repository
 * (the workflows, the docs, the app) belongs in this folder instead.
 *
 * The check reads every string in the server's test folder as TypeScript parses it (comments do not
 * count) and refuses four kinds of path:
 * - a relative path that leads out of those folders from the file that names it ('../../mobile/x');
 * - a path that starts at a part of the repository found only at its root ('docs/x.md',
 *   '.github/workflows', 'fly.toml', 'tests/x') or in another workspace ('apps/mobile/eas.json');
 * - a path joined (join, resolve) from a folder the file names by its own place, whatever it is
 *   called (const SIGNAL = fileURLToPath(new URL('..', import.meta.url)), __dirname, and paths joined
 *   from those), that leads out of those folders once worked out (join(SIGNAL, '..', 'mobile'));
 * - for a join from any other folder, a run of '..' arguments that climbs out of the workspace from
 *   the file's folder (join(here, '..', '..', 'x')).
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
/** A folder on the way to the allowed ones (the root, 'apps', 'packages'): a copy of those folders has it too. */
const onTheWay = (fromRoot: string) => fromRoot === '' || ALLOWED.some((a) => a.startsWith(`${fromRoot}/`));

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

/** The name a call is made by: `join` for join(...) and path.join(...). */
const calleeName = (e: ts.CallExpression | ts.NewExpression): string => (ts.isIdentifier(e.expression) ? e.expression.text : ts.isPropertyAccessExpression(e.expression) ? e.expression.name.text : '');
const isMetaUrl = (e: ts.Expression): boolean => ts.isPropertyAccessExpression(e) && e.name.text === 'url' && ts.isMetaProperty(e.expression);
const isText = (e: ts.Expression): e is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral => ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e);

/** The paths in one source file that lead out of the allowed folders, each as "line: why 'text'". */
function pathsOutside(file: string, text: string, rootNames: string[]): string[] {
  const dir = dirname(file);
  // How many '..' steps from the file's folder stay inside the workspace (1 for a file in apps/signal/test).
  const depth = posix(relative(join(ROOT, WORKSPACE), dir)).split('/').filter(Boolean).length;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const flag = (node: ts.Node, why: string, value: string) => found.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${why} '${value}'`);
  /** Folders and files the file names by its own place, by the constant that holds them. */
  const known = new Map<string, string>();
  /** Where a path expression leads, when it starts from the file's own place: null when that cannot be told. */
  const where = (e: ts.Expression): string | null => {
    if (ts.isParenthesizedExpression(e)) return where(e.expression);
    if (ts.isIdentifier(e)) return e.text === '__dirname' ? dir : e.text === '__filename' ? file : (known.get(e.text) ?? null);
    if (!ts.isCallExpression(e) && !ts.isNewExpression(e)) return null;
    const name = calleeName(e);
    const args = [...(e.arguments ?? [])];
    if (name === 'URL' && args.length === 2 && isText(args[0]) && isMetaUrl(args[1])) return resolve(dir, args[0].text);
    if (name === 'fileURLToPath' && args.length === 1) return isMetaUrl(args[0]) ? file : where(args[0]);
    if (name === 'dirname' && args.length === 1) {
      const p = where(args[0]);
      return p === null ? null : dirname(p);
    }
    if ((name === 'join' || name === 'resolve') && args.length > 0 && args.slice(1).every(isText)) {
      const base = where(args[0]);
      return base === null ? null : resolve(base, ...args.slice(1).map((a) => (a as ts.StringLiteral).text));
    }
    return null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const p = where(node.initializer);
      if (p !== null) known.set(node.name.text, p);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const value = node.text;
      if (/^\.\.?(\/|$)/.test(value) && !allowed(posix(relative(ROOT, resolve(dir, value))))) flag(node, 'leads out', value);
      else if (namesElsewhere(value, rootNames)) flag(node, 'names', value);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // `${ROOT}/docs/API.md`: the text after a substitution, read from the root.
      if (namesElsewhere(node.text.replace(/^\/+/, ''), rootNames)) flag(node, 'names', node.text);
    } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      const name = calleeName(node);
      const base = (name === 'join' || name === 'resolve') && node.arguments.length > 0 ? where(node.arguments[0]) : null;
      const to = base === null ? null : where(node);
      if (to !== null) {
        // Joined from the file's own place: where it leads is known.
        const at = posix(relative(ROOT, to));
        if (!allowed(at) && !onTheWay(at)) flag(node, 'leads out to', at);
      } else {
        let run = 0;
        for (const arg of node.arguments) {
          run = ts.isStringLiteral(arg) && arg.text === '..' ? run + 1 : 0;
          if (run === depth + 1) flag(arg, 'climbs out with', Array(run).fill('..').join(', '));
        }
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
    // From a folder the file names by its own place, whatever it is called: where the path leads, worked out.
    const signal = "const SIGNAL = fileURLToPath(new URL('..', import.meta.url));";
    expect(scan(`${signal}\nreadFileSync(join(SIGNAL, '..', 'mobile', 'app.json'));`)).toEqual(["2: leads out to 'apps/mobile/app.json'"]);
    expect(scan(`${signal}\nconst APPS = join(SIGNAL, '..');\nreadFileSync(resolve(APPS, 'mobile', 'app.json'));`)).toEqual(["3: leads out to 'apps/mobile/app.json'"]);
    expect(scan("const here = dirname(fileURLToPath(import.meta.url));\nreadFileSync(join(here, '..', '..', 'mobile', 'app.json'));")).toEqual(["2: leads out to 'apps/mobile/app.json'"]);
    expect(scan("readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'API.md'));")).toEqual(["1: leads out to 'docs/API.md'", "1: names 'docs'"]);
    // A folder on the way to the allowed ones is no way out by itself.
    expect(scan(`${signal}\nconst APPS = join(SIGNAL, '..');\nreaddirSync(join(APPS, 'signal'));`)).toEqual([]);
  });

  it('lets it name its own files, the packages it imports, and anything in a comment', () => {
    const text = [
      "import { serverProduct } from '../src/catalog';",
      "import { newGame } from '@mjm/engine';",
      "const SIGNAL = fileURLToPath(new URL('..', import.meta.url));",
      "readFileSync(join(SIGNAL, '.env.example'));",
      "readFileSync(join(here, '..', 'README.md'));",
      "readFileSync(join(SIGNAL, 'src', 'main.ts'));",
      "readFileSync(join(SIGNAL, '..', '..', 'packages', 'net', 'src', 'index.ts'));",
      "const ROOT = join(__dirname, '..');",
      "spawn(process.execPath, ['src/main.ts'], { cwd: join(ROOT, 'src') });",
      "readFileSync(join(SIGNAL, name));",
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
