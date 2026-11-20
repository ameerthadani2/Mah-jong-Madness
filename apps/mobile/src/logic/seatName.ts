/**
 * Bot seats as a player reads them. The table host names its bots "阿明 (Bot)" in every language
 * (packages/net/src/host.ts; older clients show the name as it comes). Here the host's English label is taken
 * off and the app's own word put on in the reader's language (`common.botName`: "阿明 (Bot)", "阿明（電腦）"),
 * once, for every place a seat's name is shown: the plates, the status line, the result and match-over
 * sheets and the lobby.
 */
const HOST_BOT_LABEL = /\s*[(（]\s*bot\s*[)）]\s*$/i;

/** A bot's own name, without the host's "(Bot)". */
export function botBaseName(name: string): string {
  return name.replace(HOST_BOT_LABEL, '');
}

/** The name to show for a seat: a bot's with the label in the reader's language, a player's as it is. */
export function seatDisplayName(seat: { name: string; isBot?: boolean }, botName: (name: string) => string): string {
  if (!seat.isBot) return seat.name;
  const base = botBaseName(seat.name);
  return base ? botName(base) : seat.name;
}

/** `state` with its bot seats named for the reader; the same object when there is nothing to change. */
export function withBotLabels<S extends { seats: ReadonlyArray<{ name: string; isBot?: boolean }> }>(state: S, botName: (name: string) => string): S {
  let changed = false;
  const seats = state.seats.map((s) => {
    const name = seatDisplayName(s, botName);
    if (name === s.name) return s;
    changed = true;
    return { ...s, name };
  });
  return changed ? { ...state, seats } : state;
}

/** Stands for the bot's name in the `common.botName` sentence, so a screen can translate it once per language. */
export const BOT_NAME_SLOT = '\u0000';

/** Names bots with a translated `common.botName` sentence in which BOT_NAME_SLOT stands for the name. */
export function botNamer(sentence: string): (name: string) => string {
  return (name) => sentence.split(BOT_NAME_SLOT).join(name);
}

/** A seat's name tag text: its border and side padding take this much of the tag's width (TableParts' `tag` style). */
export const SEAT_TAG_CHROME = 18;

/** Rough width of `s` at `fontSize`: a CJK or full-width character is one em, anything else about 0.62 em. */
export function estimateTextWidth(s: string, fontSize: number): number {
  let w = 0;
  for (const ch of s) w += /[⺀-鿿豈-﫿＀-｠￠-￦]/.test(ch) ? fontSize : fontSize * 0.62;
  return w;
}

const LABEL_SUFFIX = /^(.*?\S)\s*([(（][^()（）]*[)）])$/;

/**
 * The text of a seat's name tag, which may take two lines. A name that fits `width` stays on one line. One that
 * does not and ends in a label ("小美（電腦）", "Mei (Bot)") breaks before the label, so the name stays whole
 * on the first line rather than splitting mid-word; any other long name wraps where the text allows.
 */
export function seatTagText(name: string, width: number, fontSize = 12): string {
  if (estimateTextWidth(name, fontSize) <= width) return name;
  const m = LABEL_SUFFIX.exec(name);
  return m ? `${m[1]}\n${m[2]}` : name;
}

/** Heavy (900) type runs wider than estimateTextWidth's average: the relation label is measured with this margin. */
const BOLD_WIDTH = 1.1;

/**
 * The seat's relation label on its name tag ("Right 下家"). It is drawn on one line and never broken inside a
 * word: when the whole label does not fit the tag's `width` at `fontSize`, the shorter form is shown instead
 * ("Right"; in Chinese the two are the same, 下家). The score after it wraps to the next line when it must.
 */
export function relTagLabel(full: string, short: string, width: number, fontSize = 11): string {
  return estimateTextWidth(full, fontSize) * BOLD_WIDTH <= width ? full : short;
}

/** Smallest a side seat's name is drawn (px, after the text size) to keep it on one line. */
export const SIDE_NAME_MIN_SIZE = 9;

/**
 * A side seat's name tag must take at most two lines (the name, then the relation and score), so its name is drawn
 * on one line: at `fontSize` when it fits `width`, else at the size that fits (with a small margin, since the width
 * is an estimate), down to SIDE_NAME_MIN_SIZE. Returns that size, or null when even the smallest size does
 * not fit (a long typed name); such a name keeps two lines rather than being cut.
 */
export function sideNameSize(name: string, width: number, fontSize = 12): number | null {
  const w = estimateTextWidth(name, fontSize);
  if (w <= width) return fontSize;
  const size = Math.floor(((fontSize * width * 0.94) / w) * 10) / 10;
  return size >= Math.min(fontSize, SIDE_NAME_MIN_SIZE) ? size : null;
}

/** Width the score (and an "offline" word) take on the relation line, so the label chosen beside them still fits it. */
export function relLineExtra(score: number, offline: string | null, fontSize = 11): number {
  const gap = 5;
  const scoreW = estimateTextWidth(`${score >= 0 ? '+' : ''}${score}`, fontSize + 1) * BOLD_WIDTH + gap;
  return scoreW + (offline ? estimateTextWidth(offline, fontSize) * BOLD_WIDTH + gap : 0);
}

/**
 * Portrait: whether the across seat's plate keeps its tag beside its avatar (its usual form), as SeatBadge draws it: a tag
 * as wide as its name (or the wider line of a name broken before its label) or its relation line, whichever is wider, up
 * to `maxTag`. Beside the avatar and its 8 px gap it may run past the centre column by 4 px a side, into the cross's gaps;
 * any further and it runs under a side seat's plate (a 320 pt phone, whose centre column is 80 px). Where it would, the
 * plate takes a side seat's form instead: its avatar over a two-line tag as wide as the column.
 */
export function acrossTagBeside(name: string, relFull: string, relShort: string, score: number, plate: number, columnW: number, maxTag = 110): boolean {
  const room = maxTag - SEAT_TAG_CHROME;
  const nameW = Math.max(...seatTagText(name, room).split('\n').map((line) => estimateTextWidth(line, 12)));
  const relW = estimateTextWidth(relTagLabel(relFull, relShort, room), 11) * BOLD_WIDTH;
  // The score shares the relation's line where it fits, and wraps under it where it does not.
  const relLine = relW + relLineExtra(score, null) <= room ? relW + relLineExtra(score, null) : relW;
  const tag = Math.min(maxTag, SEAT_TAG_CHROME + Math.max(nameW, relLine));
  return plate + 8 + tag <= columnW + 8;
}

