/**
 * The server's tests read only the server's workspace (apps/signal) and the packages it imports
 * (packages/engine and packages/net), so its suite runs from a copy of those three folders, the way
 * the Dockerfile and the deploy workflow install them. A check that needs more of the repository
 * (the workflows, the docs, the app) belongs in this folder instead.
 *
 * The check reads every string in the server's test folder as TypeScript parses it (comments do not
 * count) and works out where each path leads. An import, require, vi.mock or new URL(..., import.meta.url)
 * starts at the file that names it. Everything else starts in the folder the suite runs in, apps/signal
 * (npm test -w @mjm/signal and the copy both run there): process.cwd(), resolve() and a relative path
 * given to the file system. It refuses six kinds of path:
 * - a relative path that leads out of those folders from where it starts ('../../mobile/x' in an import,
 *   readFileSync('../mobile/app.json'));
 * - an absolute path into the repository (a copy sits somewhere else), and an absolute path anywhere
 *   that ends in a part named in the next rule ('/home/me/repo/docs/x.md');
 * - a path that starts at a part of the repository found only at its root ('docs/x.md',
 *   '.github/workflows', 'fly.toml', 'tests/x') or in another workspace ('apps/mobile/eas.json');
 * - a path built (join, resolve, a template, +) from a folder the file names by its own place,
 *   whatever it is called (const SIGNAL = fileURLToPath(new URL('..', import.meta.url)), __dirname,
 *   import.meta.dirname and paths built from those), or from the folder the suite runs in
 *   (process.cwd(), resolve('..', 'x')), that leads out of those folders once worked out
 *   (join(SIGNAL, '..', 'mobile'), `${__dirname}/../../mobile`, process.cwd() + '/../x');
 * - such a path with a part it cannot work out (join(SIGNAL, '..', name)), when the part before it
 *   already leaves those folders;
 * - for a path built from a folder it cannot work out, a run of '..' that climbs out of the workspace
 *   from the file's folder (join(here, '..', '..', 'x'), `${here}/../../x`).
 * Text kept in a constant (const up = '..') and '../'.repeat(3) count as written. A path made at run
 * time from something the check cannot read (the environment, what a function returns) is not judged.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKSPACE = 'apps/signal';
/** What the server's tests may read: its own folder and the packages it imports. */
const ALLOWED = ['apps/signal', 'packages/engine', 'packages/net'];
/** The folder the server's suite runs in: process.cwd(), resolve() and a relative path read by the file system start here. */
const CWD = join(ROOT, WORKSPACE);

const posix = (path: string) => path.split(sep).join('/');
const fromRoot = (path: string) => posix(relative(ROOT, path));
const allowed = (at: string) => ALLOWED.some((a) => at === a || at.startsWith(`${a}/`));
/** A folder on the way to the allowed ones (the root, 'apps', 'packages'): a copy of those folders has it too. */
const onTheWay = (at: string) => at === '' || ALLOWED.some((a) => a.startsWith(`${at}/`));
const looksRelative = (text: string) => /^\.\.?(\/|$)/.test(text);

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

/** Whether some end of a path, from its `from`-th step on, names something outside the allowed folders ('/x/y/docs/API.md'). */
function endNamesElsewhere(path: string, rootNames: string[], from: number): boolean {
  const steps = path.split('/').filter(Boolean);
  return steps.some((_, i) => i >= from && namesElsewhere(steps.slice(i).join('/'), rootNames));
}

/** The name a call is made by: `join` for join(...) and path.join(...). */
const calleeName = (e: ts.CallExpression | ts.NewExpression): string => (ts.isIdentifier(e.expression) ? e.expression.text : ts.isPropertyAccessExpression(e.expression) ? e.expression.name.text : '');
const isMeta = (e: ts.Expression, name: string): boolean => ts.isPropertyAccessExpression(e) && e.name.text === name && ts.isMetaProperty(e.expression);
const isMetaUrl = (e: ts.Expression): boolean => isMeta(e, 'url');
const isCwd = (e: ts.Expression): boolean =>
  ts.isCallExpression(e) && e.arguments.length === 0 && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'cwd' && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'process';
const isPlus = (e: ts.Node): e is ts.BinaryExpression => ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken;
const isPathCall = (e: ts.Node): e is ts.CallExpression => ts.isCallExpression(e) && ['join', 'resolve'].includes(calleeName(e));

/** Calls that read a path from the file that names it, not from the folder the suite runs in. */
const FROM_FILE = new Set(['require', 'mock', 'doMock', 'unmock', 'doUnmock', 'importActual', 'importMock']);
/** Whether a path is read from the file that names it: an import, require, vi.mock, new URL(...). */
function readFromFile(node: ts.Node): boolean {
  const p = node.parent;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p) || ts.isExternalModuleReference(p)) return true;
  if (ts.isLiteralTypeNode(p) && ts.isImportTypeNode(p.parent)) return true;
  if (!(ts.isCallExpression(p) || ts.isNewExpression(p)) || p.arguments?.[0] !== node) return false;
  if (p.expression.kind === ts.SyntaxKind.ImportKeyword) return true;
  const name = calleeName(p);
  // A URL is read from import.meta.url or from a web address, never from the folder the suite runs in.
  if (name === 'URL') return true;
  if (name === 'resolve' && ts.isPropertyAccessExpression(p.expression)) {
    const on = p.expression.expression;
    return (ts.isIdentifier(on) && on.text === 'require') || ts.isMetaProperty(on);
  }
  return FROM_FILE.has(name) || (ts.isCallExpression(p.expression) && calleeName(p.expression) === 'createRequire');
}

/** A built path: where it starts and the parts that follow (null for what cannot be told), and whether it is put together as resolve() does. */
type Built = { start: string | null; parts: (string | null)[]; resolves: boolean };

/** Whether a string is a later part of a path being built (join(base, 'x'), base + 'x'): the whole path is worked out instead. */
const laterPart = (node: ts.Node): boolean => (isPlus(node.parent) && node.parent.right === node) || (isPathCall(node.parent) && node.parent.arguments.indexOf(node as ts.Expression) > 0);

/** The paths in one source file that lead out of the allowed folders, each as "line: why 'text'". */
function pathsOutside(file: string, text: string, rootNames: string[]): string[] {
  const dir = dirname(file);
  // How many '..' steps from the file's folder stay inside the workspace (1 for a file in apps/signal/test).
  const depth = posix(relative(join(ROOT, WORKSPACE), dir)).split('/').filter(Boolean).length;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const flag = (node: ts.Node, why: string, value: string) => found.push(`${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${why} '${value}'`);
  /** Text the file keeps in constants (const up = '..'). */
  const texts = new Map<string, string>();
  /** Folders and files the file names by its own place, or from the folder the suite runs in, by the constant that holds them. */
  const known = new Map<string, string>();

  /** The text an expression always has, when that can be told: a string, a constant, 'a' + 'b', `a${'b'}`, '../'.repeat(3). */
  const textOf = (e: ts.Expression): string | null => {
    if (ts.isParenthesizedExpression(e)) return textOf(e.expression);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (ts.isIdentifier(e)) return texts.get(e.text) ?? null;
    if (isPlus(e)) {
      const [a, b] = [textOf(e.left), textOf(e.right)];
      return a === null || b === null ? null : a + b;
    }
    if (ts.isTemplateExpression(e)) {
      let out = e.head.text;
      for (const span of e.templateSpans) {
        const part = textOf(span.expression);
        if (part === null) return null;
        out += part + span.literal.text;
      }
      return out;
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'repeat' && e.arguments.length === 1 && ts.isNumericLiteral(e.arguments[0])) {
      const once = textOf(e.expression.expression);
      return once === null ? null : once.repeat(Number(e.arguments[0].text));
    }
    return null;
  };

  /**
   * How a path is built by join(a, ...rest), resolve(a, ...rest), `${a}rest` or a + rest: where it starts and the
   * parts that follow. Null when the expression builds no path.
   */
  const built = (e: ts.Expression, from = CWD): Built | null => {
    if (ts.isParenthesizedExpression(e)) return built(e.expression, from);
    if (isPathCall(e) && e.arguments.length > 0) {
      return { start: where(e.arguments[0]), parts: e.arguments.slice(1).map(textOf), resolves: calleeName(e) === 'resolve' };
    }
    if (ts.isTemplateExpression(e)) {
      // `${a}/rest` starts at a; `../x/${a}` at the text before the first substitution, read from `from`.
      const [first, ...spans] = e.templateSpans;
      const start = e.head.text === '' ? where(first.expression) : looksRelative(e.head.text) ? resolve(from, e.head.text) : null;
      const parts = e.head.text === '' ? [first.literal.text] : [textOf(first.expression), first.literal.text];
      for (const span of spans) parts.push(textOf(span.expression), span.literal.text);
      return { start, parts, resolves: false };
    }
    if (isPlus(e) && textOf(e) === null) {
      const left = built(e.left, from);
      if (left) return { ...left, parts: [...left.parts, textOf(e.right)] };
      const text = textOf(e.left);
      return { start: text !== null && looksRelative(text) ? resolve(from, text) : where(e.left), parts: [textOf(e.right)], resolves: false };
    }
    return null;
  };

  /** Where a path expression leads, when that can be worked out: null otherwise. */
  const where = (e: ts.Expression): string | null => {
    if (ts.isParenthesizedExpression(e)) return where(e.expression);
    if (ts.isIdentifier(e) && (e.text === '__dirname' || e.text === '__filename' || known.has(e.text))) return e.text === '__dirname' ? dir : e.text === '__filename' ? file : known.get(e.text)!;
    if (isMeta(e, 'dirname')) return dir;
    if (isMeta(e, 'filename')) return file;
    if (isCwd(e)) return CWD;
    const value = textOf(e);
    if (value !== null) return looksRelative(value) ? resolve(CWD, value) : isAbsolute(value) && !fromRoot(value).startsWith('..') ? value : null;
    if (ts.isCallExpression(e) || ts.isNewExpression(e)) {
      const name = calleeName(e);
      const args = [...(e.arguments ?? [])];
      if (name === 'URL' && args.length === 2 && isMetaUrl(args[1])) {
        const to = textOf(args[0]);
        return to === null ? null : resolve(dir, to);
      }
      if (name === 'fileURLToPath' && args.length === 1) return isMetaUrl(args[0]) ? file : where(args[0]);
      if (name === 'dirname' && args.length === 1) {
        const p = where(args[0]);
        return p === null ? null : dirname(p);
      }
      if (name === 'resolve' && args.length === 0) return CWD;
    }
    const path = built(e);
    if (!path || path.start === null || path.parts.some((p) => p === null)) return null;
    const parts = path.parts as string[];
    return path.resolves ? resolve(path.start, ...parts) : join(path.start, ...parts);
  };

  /** Judges a built path: where it leads when it can be worked out; else the part before what cannot be, then any climb out. */
  const judge = (node: ts.Node, path: Built) => {
    let at = path.start;
    let run = 0;
    for (const part of path.parts) {
      if (at !== null) {
        if (part !== null) {
          at = path.resolves ? resolve(at, part) : join(at, part);
          continue;
        }
        // A part it cannot work out: what came before must not have left the allowed folders already.
        if (!allowed(fromRoot(at))) flag(node, 'leads out to', `${fromRoot(at) || '.'}/...`);
        at = null;
        continue;
      }
      if (part === null) {
        run = 0;
        continue;
      }
      // From a folder it cannot work out: count the '..' steps that follow.
      for (const step of part.split('/').filter((s) => s !== '' && s !== '.')) {
        const before = run;
        run = step === '..' ? run + 1 : 0;
        if (before <= depth && run > depth) flag(node, 'climbs out with', Array(run).fill('..').join(', '));
      }
    }
    if (at !== null && !allowed(fromRoot(at)) && !onTheWay(fromRoot(at))) flag(node, 'leads out to', fromRoot(at));
  };

  /** Judges one string: a relative path from where it is read, an absolute path, or a path from the root. */
  const judgeText = (node: ts.Node, value: string, fromFile: boolean) => {
    if (looksRelative(value)) {
      // A later part (join(base, '../x')) is worked out with the whole path.
      if (laterPart(node)) return;
      if (!allowed(fromRoot(resolve(dir, value)))) flag(node, 'leads out', value);
      else if (!fromFile) {
        const at = fromRoot(resolve(CWD, value));
        if (!allowed(at) && !onTheWay(at)) flag(node, `leads out of ${WORKSPACE}`, value);
      }
    } else if (isAbsolute(value)) {
      if (!fromRoot(value).startsWith('..')) flag(node, 'names the repository by its absolute path', value);
      else if (endNamesElsewhere(value, rootNames, 1)) flag(node, 'names', value);
    } else if (namesElsewhere(value, rootNames)) flag(node, 'names', value);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const value = textOf(node.initializer);
      if (value !== null) texts.set(node.name.text, value);
      const p = where(node.initializer);
      if (p !== null) known.set(node.name.text, p);
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      judgeText(node, node.text, readFromFile(node));
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      // `${ROOT}/docs/API.md` or `${HOME}/repo/docs/API.md`: the text after a substitution, read from the root or any folder.
      if (endNamesElsewhere(node.text, rootNames, 0)) flag(node, 'names', node.text);
    }
    if (ts.isTemplateExpression(node) || (isPlus(node) && !isPlus(node.parent))) {
      // A template or a + chain: as text when all of it is known; else a path built from its first part.
      const fromFile = readFromFile(node);
      const whole = textOf(node);
      const path = whole === null ? built(node, fromFile ? dir : CWD) : null;
      if (whole !== null) judgeText(node, whole, fromFile);
      else if (path) {
        // One that starts with a relative path is read like one: `../mobile/${name}`.
        if (ts.isTemplateExpression(node) && looksRelative(node.head.text)) judgeText(node, node.head.text.replace(/[^/]*$/, ''), fromFile);
        judge(node, path);
      }
    } else if (isPathCall(node) && node.arguments.length > 0) {
      judge(node, built(node)!);
    } else if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) {
      // Any other call: a run of '..' arguments climbs out as join's would.
      let run = 0;
      for (const arg of node.arguments) {
        run = textOf(arg) === '..' ? run + 1 : 0;
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
    // From a folder the file names by its own place, whatever it is called: where the path leads, worked out.
    const signal = "const SIGNAL = fileURLToPath(new URL('..', import.meta.url));";
    expect(scan(`${signal}\nreadFileSync(join(SIGNAL, '..', 'mobile', 'app.json'));`)).toEqual(["2: leads out to 'apps/mobile/app.json'"]);
    expect(scan(`${signal}\nconst APPS = join(SIGNAL, '..');\nreadFileSync(resolve(APPS, 'mobile', 'app.json'));`)).toEqual(["3: leads out to 'apps/mobile/app.json'"]);
    expect(scan("const here = dirname(fileURLToPath(import.meta.url));\nreadFileSync(join(here, '..', '..', 'mobile', 'app.json'));")).toEqual(["2: leads out to 'apps/mobile/app.json'"]);
    expect(scan("readFileSync(path.join(__dirname, '..', '..', '..', 'docs', 'API.md'));")).toEqual(["1: leads out to 'docs/API.md'", "1: names 'docs'"]);
    // A folder on the way to the allowed ones is no way out by itself.
    expect(scan(`${signal}\nconst APPS = join(SIGNAL, '..');\nreaddirSync(join(APPS, 'signal'));`)).toEqual([]);
  });

  it('finds paths read from the folder the suite runs in, templates, + and absolute paths (the eighth pass)', () => {
    // process.cwd(), resolve() and a relative path given to the file system start in apps/signal, not at the file.
    expect(scan("readFileSync(process.cwd() + '/../../docs/FAIRNESS.md');")).toEqual(["1: leads out to 'docs/FAIRNESS.md'", "1: names '/../../docs/FAIRNESS.md'"]);
    expect(scan("readFileSync(resolve(process.cwd(), '../mobile/app.json'));")).toEqual(["1: leads out to 'apps/mobile/app.json'"]);
    expect(scan("readFileSync('../mobile/app.json');")).toEqual(["1: leads out of apps/signal '../mobile/app.json'"]);
    expect(scan("spawnSync('npx', ['tsx', 'x.ts'], { cwd: '../mobile' });")).toEqual(["1: leads out of apps/signal '../mobile'"]);
    expect(scan("readFileSync(resolve('..', 'mobile', 'app.json'));")).toEqual(["1: leads out to 'apps/mobile/app.json'"]);
    expect(scan("readFileSync(join('..', 'mobile', 'app.json'));")).toEqual(["1: leads out to 'apps/mobile/app.json'"]);
    expect(scan("readFileSync(resolve('../../docs/FAIRNESS.md'));")).toEqual(["1: leads out to 'docs/FAIRNESS.md'", "1: leads out '../../docs/FAIRNESS.md'"]);
    // Templates and + from a known place, worked out like join.
    expect(scan('readFileSync(`${__dirname}/../../mobile/app.json`);')).toEqual(["1: leads out to 'apps/mobile/app.json'"]);
    expect(scan('readFileSync(`${process.cwd()}/../mobile/app.json`);')).toEqual(["1: leads out to 'apps/mobile/app.json'"]);
    expect(scan('readFileSync(`${__dirname}/../../../docs/FAIRNESS.md`);')).toEqual(["1: leads out to 'docs/FAIRNESS.md'", "1: names '/../../../docs/FAIRNESS.md'"]);
    expect(scan("readFileSync(import.meta.dirname + '/../../mobile/app.json');")).toEqual(["1: leads out to 'apps/mobile/app.json'"]);
    expect(scan('readFileSync(`../mobile/${name}`);')).toEqual(["1: leads out of apps/signal '../mobile/'", "1: leads out to 'apps/mobile/...'"]);
    // From a place it cannot work out, a run of '..' that climbs out of the workspace.
    expect(scan('readFileSync(`${here}/../../mobile/app.json`);')).toEqual(["1: climbs out with '.., ..'"]);
    expect(scan("readFileSync(here + '/../../mobile/app.json');")).toEqual(["1: climbs out with '.., ..'"]);
    expect(scan("readFileSync(join(here, '../..', 'mobile'));")).toEqual(["1: climbs out with '.., ..'"]);
    // Text in a constant, and '../'.repeat(n), count as written.
    expect(scan("const up = '..';\nreadFileSync(join(__dirname, up, up, 'mobile', 'app.json'));")).toEqual(["2: leads out to 'apps/mobile/app.json'"]);
    expect(scan("readFileSync(join(__dirname, '../'.repeat(2), 'mobile', 'app.json'));")).toEqual(["1: leads out to 'apps/mobile/app.json'"]);
    // A part it cannot work out after the path has left the allowed folders.
    expect(scan("readFileSync(join(__dirname, '..', '..', name));")).toEqual(["1: leads out to 'apps/...'"]);
    // An absolute path into this repository (a copy sits elsewhere), or one that ends in a part found only at the root.
    expect(scan(`readFileSync('${join(ROOT, 'docs', 'FAIRNESS.md')}');`)).toEqual([`1: names the repository by its absolute path '${join(ROOT, 'docs', 'FAIRNESS.md')}'`]);
    expect(scan(`readFileSync('${join(ROOT, WORKSPACE, 'README.md')}');`)).toEqual([`1: names the repository by its absolute path '${join(ROOT, WORKSPACE, 'README.md')}'`]);
    expect(scan("readFileSync('/srv/checkout/docs/FAIRNESS.md');")).toEqual(["1: names '/srv/checkout/docs/FAIRNESS.md'"]);
    expect(scan("readFileSync('/srv/checkout/apps/mobile/app.json');")).toEqual(["1: names '/srv/checkout/apps/mobile/app.json'"]);
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

  it('lets it start from the folder the suite runs in, build paths inside the allowed folders, and name web addresses', () => {
    const text = [
      // Modules are read from the file, whatever the folder the suite runs in.
      "const auth = await import('../src/auth');",
      "vi.mock('../src/push', () => ({}));",
      "const actual = await vi.importActual('../src/config');",
      "const require = createRequire(import.meta.url);",
      "require('../package.json');",
      // From the folder the suite runs in, staying inside the allowed folders.
      "readFileSync('./.env.example');",
      "readFileSync('README.md');",
      "readdirSync(resolve('migrations'));",
      "readFileSync(join(process.cwd(), 'migrations', '0001_init.sql'));",
      "readFileSync(resolve('..', '..', 'packages', 'engine', 'package.json'));",
      "readFileSync(process.cwd() + '/src/main.ts');",
      "readFileSync(`${process.cwd()}/src/${name}.ts`);",
      "readFileSync(__dirname + '/fixtures/a.json');",
      "readFileSync(`${__dirname}/../src/${name}`);",
      "readFileSync(join(import.meta.dirname, '..', 'README.md'));",
      // A later part is read from the path before it, not from the folder the suite runs in.
      "const SIGNAL = fileURLToPath(new URL('..', import.meta.url));",
      "readFileSync(join(SIGNAL, '..', '..', 'packages', 'net', '../engine/package.json'));",
      // A temporary folder, web addresses and joined lines.
      "const tmp = mkdtempSync(join(tmpdir(), 'mjm-'));",
      "writeFileSync('/tmp/mjm-probe.json', '{}');",
      "await call('/api/clubs');",
      "await call(`/api/clubs/${id}/tables`);",
      "const url = new URL('/api/me', 'http://localhost:8787');",
      "lines.join('\\n'); parts.join('/'); words.join('..');",
      "return new Promise((resolve) => resolve({ code, output }));",
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
