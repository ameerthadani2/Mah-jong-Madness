import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_CAVEATS, AUDIT_FAILURES, auditFailure, failureKey, type AuditFailure } from '../src';

/**
 * The table client explains a failed hand in English sentences written where each check is made.
 * The app shows them in the player's language by key, so every sentence the client can produce
 * must be found by `failureKey`. These tests read the client's source: a sentence added to a
 * check without a key (or a key whose sentence is gone) fails here, not in front of a player.
 */

interface Literal {
  /** The text between the quotes, with each `${…}` of a template left in place. */
  text: string;
  /** The source line the literal starts on (1-based) and that line's text. */
  line: number;
  lineText: string;
}

/** Every string and template literal of a TypeScript source, comments left out. */
function literals(source: string): Literal[] {
  const out: Literal[] = [];
  const lines = source.split('\n');
  let line = 1;
  let i = 0;
  const push = (text: string, at: number) => out.push({ text, line: at, lineText: lines[at - 1] });
  while (i < source.length) {
    const c = source[i];
    const two = source.slice(i, i + 2);
    if (c === '\n') {
      line++;
      i++;
    } else if (two === '//') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      line += source.slice(i, stop).split('\n').length - 1;
      i = stop;
    } else if (c === "'" || c === '"') {
      const start = line;
      let j = i + 1;
      let text = '';
      while (j < source.length && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\') {
          text += source[j + 1];
          j += 2;
        } else text += source[j++];
      }
      push(text, start);
      i = j + 1;
    } else if (c === '`') {
      const start = line;
      let j = i + 1;
      let depth = 0;
      let text = '';
      while (j < source.length && (source[j] !== '`' || depth > 0)) {
        if (depth === 0 && source.slice(j, j + 2) === '${') {
          depth = 1;
          text += '${';
          j += 2;
          continue;
        }
        if (depth > 0 && source[j] === '{') depth++;
        if (depth > 0 && source[j] === '}') depth--;
        if (source[j] === '\n') line++;
        text += source[j++];
      }
      push(text, start);
      i = j + 1;
    } else if (c === '/' && /[(,=:[!&|?{};]\s*$/.test(source.slice(Math.max(0, i - 12), i))) {
      // A regular expression (the failure patterns are written as these): skip to its end.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n' && (source[j] !== '/' || inClass)) {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        j++;
      }
      i = j + 1;
    } else i++;
  }
  return out;
}

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const clientSource = read('../src/client.ts');

/** Lines `from`…`to` (1-based) of the object literal that starts with `opening`. */
function block(opening: string): { from: number; to: number } {
  const lines = clientSource.split('\n');
  const from = lines.findIndex((l) => l.startsWith(opening)) + 1;
  expect(from, opening).toBeGreaterThan(0);
  const to = lines.findIndex((l, n) => n >= from && l.startsWith('}')) + 1;
  return { from, to };
}

/** A sentence, as opposed to a message tag, a field name or a storage key: at least three words. */
const isSentence = (text: string) => text.replace(/\$\{[^]*?\}/g, 'x').trim().split(/\s+/).length >= 3;

/** Where a literal is written decides what it is for. */
function role(l: Literal, caveats: { from: number; to: number }, failures: { from: number; to: number }): 'caveat' | 'map' | 'status' | 'failure' | 'other' {
  if (l.line >= caveats.from && l.line <= caveats.to) return 'caveat';
  if (l.line >= failures.from && l.line <= failures.to) return 'map';
  if (/\blastError:/.test(l.lineText)) return 'status';
  if (/\b(flag|failNow)\(|\bfailures\.push\(|\bproblems\.add\(|\bproblem = |\bfailures: \[|\breturn \[/.test(l.lineText)) return 'failure';
  return 'other';
}

/** A value such as the check would put into the sentence, chosen by the expression in the template. */
function sample(expression: string): string {
  if (/changed\.join/.test(expression)) return 'scores, dealerSeat';
  if (/badSeats\.join/.test(expression)) return '0, 2';
  if (/\.message/.test(expression)) return 'Not your turn (seat 2): discard';
  return '3';
}

const fill = (template: string) => template.replace(/\$\{([^]*?)\}(?=[^}]|$)/g, (_all, expression: string) => sample(expression));

function failureSentences(): Literal[] {
  const caveats = block('export const AUDIT_CAVEATS = {');
  const failures = block('export const AUDIT_FAILURES = {');
  return literals(clientSource).filter((l) => isSentence(l.text) && role(l, caveats, failures) === 'failure');
}

describe('audit failure texts', () => {
  it('every sentence in the client is a failure, a caveat or a status line', () => {
    const caveats = block('export const AUDIT_CAVEATS = {');
    const failures = block('export const AUDIT_FAILURES = {');
    const all = literals(clientSource).filter((l) => isSentence(l.text));
    const stray = all.filter((l) => role(l, caveats, failures) === 'other').map((l) => `${l.line}: ${l.text}`);
    expect(stray).toEqual([]);
    // The caveat sentences are read from the caveat map and from nowhere else.
    expect(all.filter((l) => role(l, caveats, failures) === 'caveat').map((l) => l.text).sort()).toEqual(Object.values(AUDIT_CAVEATS).slice().sort());
  });

  it('every failure sentence the client can produce has a key', () => {
    const found = failureSentences();
    // The checks hold some seventy sentences: far fewer means this test no longer reads the source properly.
    expect(new Set(found.map((l) => l.text)).size).toBeGreaterThanOrEqual(60);
    const missing = found.filter((l) => failureKey(fill(l.text)) === null).map((l) => `${l.line}: ${l.text}`);
    expect(missing).toEqual([]);
  });

  it('a sentence belongs to one key only, and a plain sentence is matched letter for letter', () => {
    for (const l of failureSentences()) {
      const text = fill(l.text);
      const matching = (Object.entries(AUDIT_FAILURES) as Array<[AuditFailure, string | RegExp]>).filter(([, v]) => (typeof v === 'string' ? v === text : v.test(text))).map(([k]) => k);
      expect(matching, text).toHaveLength(1);
      const entry: string | RegExp = AUDIT_FAILURES[matching[0]];
      // A sentence with a value in it needs a pattern; one without is listed as it is written.
      expect(typeof entry === 'string', text).toBe(!l.text.includes('${'));
    }
  });

  it('there is no key for a sentence the client no longer writes', () => {
    const produced = new Set(failureSentences().map((l) => failureKey(fill(l.text))));
    for (const key of Object.keys(AUDIT_FAILURES)) expect(produced.has(key as AuditFailure), key).toBe(true);
  });

  it('every pattern covers the whole sentence and names the values it carries', () => {
    for (const [key, entry] of Object.entries(AUDIT_FAILURES) as Array<[AuditFailure, string | RegExp]>) {
      if (typeof entry === 'string') continue;
      expect(entry.source.startsWith('^') && entry.source.endsWith('$'), key).toBe(true);
      expect(entry.flags, key).toBe('');
      // Every group is named: the app passes the values to its translation by name.
      expect(entry.source.replace(/\\\(/g, '').match(/\((?!\?<[a-z]+>)/gi) ?? [], key).toEqual([]);
    }
  });

  it('the failures the other tests of this package expect from the client all have keys', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const expected: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.ts') && f !== 'failure-text.test.ts')) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      for (const m of source.matchAll(/[fF]ailures\)(?:\.not)?\.toContain\((['"`])((?:\\.|(?!\1).)*)\1\)/g)) expected.push(m[2].replace(/\\(.)/g, '$1'));
    }
    expect(expected.length).toBeGreaterThanOrEqual(20);
    expect(expected.filter((text) => failureKey(text) === null)).toEqual([]);
  });

  it('hands the values of a sentence to the caller by name', () => {
    expect(auditFailure('Restart 2 blames seat 1 again after the host had stood it in')).toEqual({ key: 'restartBlamesAgain', params: { n: '2', seat: '1' } });
    expect(auditFailure('4 ceremony attempts is more than 2, the most an honest table with 1 human seats needs')).toEqual({ key: 'tooManyAttempts', params: { attempts: '4', most: '2', humans: '1' } });
    expect(auditFailure('Hand started with dealerSeat, dealerStreak different from where the previous hand left them')).toEqual({ key: 'handStartChanged', params: { fields: 'dealerSeat, dealerStreak' } });
    expect(auditFailure('The table played for this seat and passed up its win (turn 17)')).toEqual({ key: 'passedUpWin', params: { turn: '17' } });
    expect(auditFailure('Replay failed: Not your turn')).toEqual({ key: 'replayFailed', params: { detail: 'Not your turn' } });
    expect(auditFailure('Host altered my secret')).toEqual({ key: 'mySecretAltered', params: {} });
  });

  it('tells the two "never asked to commit" sentences and the two attempt counts apart', () => {
    expect(failureKey('Host never asked this seat to commit')).toBe('neverAskedToCommit');
    expect(failureKey('Host never asked this seat to commit to attempt 2 of this hand')).toBe('skippedAttempt');
    expect(failureKey('Host never asked this seat to commit to attempts 1–2 of this hand')).toBe('skippedFirstAttempts');
    expect(failureKey('Audit reports 1 ceremony attempts but this seat was asked to commit 2 times')).toBe('attemptsNotSeen');
    expect(failureKey('Audit reports 1 ceremony attempts but this seat was asked to commit in attempt 2')).toBe('attemptsBelowSeen');
  });

  it('gives no key to a text the client did not write', () => {
    for (const text of ['', 'Host altered my secret.', ' Host altered my secret', 'host altered my secret', 'Restart x is malformed', 'Something else went wrong', AUDIT_CAVEATS.appRestart, 'constructor', 'toString']) {
      expect(failureKey(text), text).toBeNull();
      expect(auditFailure(text), text).toBeNull();
    }
  });
});
