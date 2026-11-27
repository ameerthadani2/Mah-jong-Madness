/**
 * Words a line must not split. A line may break between any two Chinese characters, so a scoring term or a tile name could
 * come apart (門 / 清自摸, 五 / 筒) and a number could part from its unit (15 / 秒, 槓上開花（1 / 台）); in English a tile
 * name could too (discarded 9 / Dot). The showcase review of 20 November saw each of these. keepWhole joins such a unit:
 * a word joiner (U+2060: no width, no break) between the characters of a Chinese term, and a no-break space inside a
 * number and its Chinese unit or inside an English tile name. A line still breaks before and after the unit, and a screen
 * reader reads it as before. The app's Text applies it to every string it draws (../components/Text.tsx).
 *
 * Unit 21's check found more: 四 / 圈 and 一將四 / 圈 (a count in Chinese numerals), 放 / 槍, 底 / 300, 六萬 / ×3, 第 / 3 / 局,
 * 140 / 點, and a lone last character (它 / 們。, 中斷 / ！ → 中 / 斷！). So a number joins any Chinese unit after it,
 * with or without a space; a count in Chinese numerals joins its unit; 底 and 台 join the number after them; a tile joins
 * its ×count; and the last two characters of a line stay together.
 */
import { kindInfo, NUM_KINDS, NUM_PLAY_KINDS } from '@mjm/engine';

export const WORD_JOINER = '⁠';
export const NO_BREAK_SPACE = ' ';

/** The scoring items' names (the engine's scoreWin) and the other terms the coach and the lessons name in a sentence. */
const SCORING_TERMS = [
  '門清自摸',
  '槓上開花',
  '花上自摸',
  '海底撈月',
  '河底撈魚',
  '八仙過海',
  '嚦咕嚦咕',
  '七搶一',
  '碰碰胡',
  '全求人',
  '半求人',
  '三暗刻',
  '四暗刻',
  '五暗刻',
  '混一色',
  '清一色',
  '字一色',
  '小三元',
  '大三元',
  '小四喜',
  '大四喜',
  '搶槓',
  '平胡',
  '獨聽',
  '門清',
  '自摸',
  '莊家',
  '連莊',
  '門風',
  '圈風',
  '正花',
  '正季',
  '無花',
  '花槓',
  '天胡',
  '地胡',
  '人胡',
  '單騎',
  '嵌張',
  '邊張',
  '放槍',
  '胡牌',
  '聽牌',
];

/** Words the app's own screens name in a sentence. */
const APP_TERMS = ['覆盤', '表情貼圖', '俱樂部', '么九牌', '么九', '字牌', '花牌', '會員', '會長', '鑽石'];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kinds = (n: number) => Array.from({ length: n }, (_, k) => kindInfo(k));
/** Longest first, so 門清自摸 is joined whole before 門清 or 自摸 could match inside it. */
const ZH_TERMS = [...new Set([...SCORING_TERMS, ...APP_TERMS, ...kinds(NUM_PLAY_KINDS).map((i) => i.nameZh)])].filter((w) => [...w].length > 1).sort((a, b) => b.length - a.length);
const ZH_RE = new RegExp(ZH_TERMS.map(escape).join('|'), 'g');
const ZH_TERM_SET: ReadonlySet<string> = new Set(ZH_TERMS);
/** A number and the English word it counts (16 rotations, 3 tiles), which the rules line could part. */
const EN_UNIT_RE = /\b(\d+) (?=(?:rotations?|rounds?|hands?|tiles?|points?|diamonds?|days?|lessons?|members?|seconds?|minutes?)\b)/g;
/** English tile names of more than one word: 9 Dot, East Wind, Red Dragon. */
const EN_RE = new RegExp(`\\b(?:${kinds(NUM_KINDS).map((i) => i.nameEn).filter((n) => n.includes(' ')).map(escape).join('|')})\\b`, 'g');
/** A Chinese unit or counting word after a number. */
const UNITS = '(?:鑽石|小時|分鐘|[台秒張分天局次位題顆種圈莊堂點組步場勝個手課季號歲年月週將家輪])';
/** A number and the Chinese unit after it, with a space between (15 秒, 1 台) or none (15秒, 2.3台): a no-break space or a word joiner. */
const UNIT_RE = new RegExp(`(\\d)( ?)(?=${UNITS})`, 'g');
/** A count in Chinese numerals and its unit (四圈, 一將, 十六圈, 兩組). */
const ZH_COUNT_RE = new RegExp(`[一二兩三四五六七八九十百]+${UNITS}`, 'g');
/** Tokens kept whole as one word: the stakes (底100/台20, 底100 / 台20, 底50 台10) and a dealer's streak (連2拉2). */
const TOKEN_RE = /底 ?\d+(?: ?\/ ?| )台 ?\d+|連 ?\d+ ?拉 ?\d+/g;
/** Words that lead a number: 第 3 局, 底100, 每台20. */
const LEAD_RE = /(第|底)( ?)(?=\d)|(台)()(?=\d)/g;
/** A tile with its count (六萬×3). */
const TIMES_RE = /(?<=[㐀-鿿])×(?=\d)/g;
/** The last two characters of a line, before any closing punctuation. */
const LAST_PAIR_RE = /([㐀-鿿])([㐀-鿿][^㐀-鿿\w\n]*)$/gm;
const CJK = /[㐀-鿿]/;

/** A word kept whole: its spaces become no-break spaces and a word joiner goes between its other characters (not inside a number). */
function glue(word: string): string {
  const cs = [...word.replace(/ /g, NO_BREAK_SPACE)];
  return cs.map((c, i) => (i === 0 || c === NO_BREAK_SPACE || cs[i - 1] === NO_BREAK_SPACE || (/\d/.test(c) && /\d/.test(cs[i - 1])) ? c : WORD_JOINER + c)).join('');
}

/** `text` with its scoring terms, tile names and numbers with units joined so no line breaks inside them. */
export function keepWhole(text: string): string {
  let out = text;
  // A term that is the whole text is a label on its own: nothing to keep together inside a sentence.
  if (CJK.test(out) && !ZH_TERM_SET.has(text)) {
    out = out
      .replace(TOKEN_RE, glue)
      .replace(UNIT_RE, (_, digit: string, space: string) => digit + (space ? NO_BREAK_SPACE : WORD_JOINER))
      .replace(LEAD_RE, (_, lead: string | undefined, space: string | undefined, tai: string | undefined) => (lead ?? tai) + (space ? NO_BREAK_SPACE : WORD_JOINER))
      .replace(TIMES_RE, `${WORD_JOINER}×${WORD_JOINER}`)
      .replace(ZH_COUNT_RE, glue)
      .replace(ZH_RE, glue)
      .replace(LAST_PAIR_RE, `$1${WORD_JOINER}$2`);
  }
  return out.replace(EN_RE, (w) => w.replace(/ /g, NO_BREAK_SPACE)).replace(EN_UNIT_RE, `$1${NO_BREAK_SPACE}`);
}

/** `text` with the joins keepWhole adds taken out again (for comparing what is drawn with what was written). */
export function unjoined(text: string): string {
  return text.split(WORD_JOINER).join('').split(NO_BREAK_SPACE).join(' ');
}
