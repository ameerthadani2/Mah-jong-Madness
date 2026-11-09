import { describe, expect, it } from 'vitest';
import { cleanText, isCleanText } from '../src/index';

/** A string is well-formed UTF-16 (no lone surrogate) exactly when encodeURIComponent accepts it. */
function wellFormed(s: string): boolean {
  try {
    encodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
}

const MAHJONG = '\u{1F004}';
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';

describe('cleanText', () => {
  it('removes NUL and other control characters, which Postgres refuses in text columns', () => {
    expect(cleanText('Tea\u0000 House', 40)).toBe('Tea House');
    // U+0085 is a line break, so it becomes a space; the other controls vanish.
    expect(cleanText('a\u0001b\u007Fc\u0085d\u009Fe', 40)).toBe('abc de');
  });

  it('never leaves half of an emoji when the cap falls inside it', () => {
    const label = 'x'.repeat(39) + MAHJONG;
    expect(cleanText(label, 40)).toBe(label);
    const longer = 'x'.repeat(40) + MAHJONG;
    // The old String.slice cap split the surrogate pair in two.
    expect(wellFormed(longer.slice(0, 41))).toBe(false);
    expect(cleanText(longer, 40)).toBe('x'.repeat(40));
  });

  it('drops unpaired surrogate halves and keeps valid pairs', () => {
    expect(cleanText('ab\uD83Ccd', 40)).toBe('abcd');
    expect(cleanText('ab\uDC04cd', 40)).toBe('abcd');
    expect(cleanText(MAHJONG + ' hu', 40)).toBe(MAHJONG + ' hu');
  });

  it('strips bidi overrides, isolates and marks', () => {
    expect(cleanText('\u202Eevil\u202C name', 40)).toBe('evil name');
    expect(cleanText('a\u2066b\u2069c\u200Fd', 40)).toBe('abcd');
  });

  it('strips invisible characters, so a name made only of fillers is empty', () => {
    expect(cleanText('\u3164\u3164', 24)).toBe('');
    expect(cleanText('\u200B\uFEFF\u2060', 24)).toBe('');
    expect(cleanText('Al\u00ADice', 24)).toBe('Alice');
  });

  it('keeps zero-width joiners inside emoji sequences and drops stray ones', () => {
    expect(cleanText(FAMILY, 10)).toBe(FAMILY);
    expect(cleanText('\u200Dname\u200D', 10)).toBe('name');
    expect(cleanText('a \u200D b', 10)).toBe('a b');
  });

  it('counts characters, not UTF-16 units, and does not split an emoji sequence', () => {
    expect(cleanText('ab' + FAMILY + 'cd', 3)).toBe('ab' + FAMILY);
    expect(cleanText('台灣麻將十六張', 4)).toBe('台灣麻將');
  });

  it('normalises to NFC', () => {
    expect(cleanText('Café', 10)).toBe('Café');
  });

  it('folds every kind of space and collapses runs', () => {
    expect(cleanText('  big\u3000\u00A0 \tgame  ', 40)).toBe('big game');
    expect(cleanText('one\ntwo\r\nthree', 40)).toBe('one two three');
  });

  it('keeps line breaks in multiline mode, at most one blank line in a row', () => {
    expect(cleanText('line one  \r\n\n\n\nline\u2028two', 100, { multiline: true })).toBe('line one\n\nline\ntwo');
  });

  it('gives an empty string for non-strings or a non-positive cap', () => {
    expect(cleanText(undefined, 10)).toBe('');
    expect(cleanText(42, 10)).toBe('');
    expect(cleanText({ toString: () => 'x' }, 10)).toBe('');
    expect(cleanText('abc', 0)).toBe('');
    expect(cleanText('abc', Number.NaN)).toBe('');
  });

  it('always returns well-formed, trimmed, idempotent text for random input', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
    const pool = ['a', 'Z', ' ', '\u0000', '\u202E', '\u200D', '\uD83C', '\uDC04', MAHJONG, '台', '\u3164', '\n', 'é', FAMILY];
    for (let n = 0; n < 2000; n++) {
      let s = '';
      const len = Math.floor(rand() * 30);
      for (let i = 0; i < len; i++) s += pool[Math.floor(rand() * pool.length)];
      const max = 1 + Math.floor(rand() * 12);
      const out = cleanText(s, max);
      expect(wellFormed(out)).toBe(true);
      expect(out).not.toMatch(/[\u0000-\u001F\u202A-\u202E\u2066-\u2069\u3164]/);
      expect(out).toBe(out.trim());
      expect(cleanText(out, max)).toBe(out);
    }
  });

  it('isCleanText accepts clean text and rejects anything cleaning would change', () => {
    expect(isCleanText('Tea House', 40)).toBe(true);
    expect(isCleanText('Tea\u0000House', 40)).toBe(false);
    expect(isCleanText(' padded', 40)).toBe(false);
    expect(isCleanText('', 40)).toBe(false);
  });
});
