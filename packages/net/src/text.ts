/**
 * One cleaner for every piece of free text a player can type: display names, seat names, club
 * names and descriptions, table labels, chat and report notes.
 *
 * It removes what makes text unsafe to store or show, never what a player meant to write:
 * - control characters (U+0000 included: Postgres refuses it in text columns, and one NUL made
 *   every later write for a club fail), C1 controls and DEL;
 * - bidi embeddings, overrides, isolates and marks (they can reverse how a name reads);
 * - invisible characters (zero-width space, word joiner, BOM, soft hyphen, Hangul fillers often
 *   used for "blank" names), and zero-width joiners that do not sit between two visible
 *   characters (inside an emoji sequence they stay);
 * - unpaired surrogate halves (invalid UTF-8; Postgres refuses them too).
 * Then it normalises to NFC, folds every kind of space to a plain space, collapses runs, trims,
 * and cuts to `max` whole characters (grapheme clusters where the runtime can segment them,
 * otherwise code points), so a cut never splits a surrogate pair or leaves a dangling joiner.
 *
 * The result may be empty: callers decide whether empty is allowed.
 */

export interface CleanTextOptions {
  /** Keep line breaks (at most one blank line in a row). Default false: newlines become spaces. */
  multiline?: boolean;
}

// C0 controls except \t \n \r (handled as whitespace), DEL, C1 controls (U+0085 is a line break).
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u0084\u0086-\u009F]/g;
// Bidi marks, embeddings, overrides and isolates.
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
// Invisible characters with no legitimate use in a name or a short message.
const INVISIBLE = /[\u00AD\u034F\u115F\u1160\u17B4\u17B5\u180E\u200B\u2060-\u2064\u3164\uFEFF\uFFA0\uFFF9-\uFFFB\uFFFE\uFFFF]/g;
// Every space character folds to a plain space (line breaks are handled separately).
const SPACES = /[\t\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const LINE_BREAKS = /\r\n?|[\u0085\u2028\u2029]/g;
const JOINERS = /[\u200C\u200D]+/g;

/** Drop unpaired surrogate halves, keep valid pairs. */
function dropLoneSurrogates(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += s[i];
  }
  return out;
}

/** Keep one ZWJ/ZWNJ only between two characters that are not whitespace. */
function tidyJoiners(s: string): string {
  return s.replace(JOINERS, (run: string, offset: number, whole: string) => {
    const before = whole[offset - 1];
    const after = whole[offset + run.length];
    const visible = (ch: string | undefined) => ch !== undefined && !/\s/.test(ch);
    return visible(before) && visible(after) ? run[0] : '';
  });
}

function nfc(s: string): string {
  try {
    return typeof s.normalize === 'function' ? s.normalize('NFC') : s;
  } catch {
    return s;
  }
}

type Segmenter = { segment(input: string): Iterable<{ segment: string }> };
type SegmenterCtor = new (locale?: string, opts?: { granularity: string }) => Segmenter;

let segmenterCache: Segmenter | null | undefined;
function segmenter(): Segmenter | null {
  if (segmenterCache !== undefined) return segmenterCache;
  const ctor = (globalThis as { Intl?: { Segmenter?: SegmenterCtor } }).Intl?.Segmenter;
  try {
    segmenterCache = ctor ? new ctor(undefined, { granularity: 'grapheme' }) : null;
  } catch {
    segmenterCache = null;
  }
  return segmenterCache;
}

/** The first `max` user-perceived characters of `s`. */
function cut(s: string, max: number): string {
  const seg = segmenter();
  const parts = seg ? Array.from(seg.segment(s), (x) => x.segment) : Array.from(s);
  return parts.length <= max ? s : parts.slice(0, max).join('');
}

/** Clean free text from a player; `max` counts characters, not UTF-16 units. Non-strings give ''. */
export function cleanText(value: unknown, max: number, opts: CleanTextOptions = {}): string {
  if (typeof value !== 'string' || !(max > 0)) return '';
  let s = nfc(dropLoneSurrogates(value));
  s = s.replace(LINE_BREAKS, '\n');
  s = s.replace(CONTROLS, '').replace(BIDI, '').replace(INVISIBLE, '');
  s = tidy(tidyJoiners(s.replace(SPACES, ' ')), !!opts.multiline);
  // A cut can end on a joiner or a space: tidy once more.
  return tidy(tidyJoiners(cut(s, max)), !!opts.multiline);
}

/** Collapse runs of spaces, limit blank lines (or flatten lines), trim. */
function tidy(s: string, multiline: boolean): string {
  if (!multiline) return s.replace(/\n/g, ' ').replace(/ {2,}/g, ' ').trim();
  return s
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** True when `value` is non-empty and already clean (cleaning would not change it). */
export function isCleanText(value: unknown, max: number, opts: CleanTextOptions = {}): boolean {
  return typeof value === 'string' && value.length > 0 && cleanText(value, max, opts) === value;
}
