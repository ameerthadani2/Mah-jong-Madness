/**
 * Words a line must not split. A line may break between any two Chinese characters, so a scoring term or a tile name could
 * come apart (門 / 清自摸, 五 / 筒) and a number could part from its unit (15 / 秒, 槓上開花（1 / 台）); in English a tile
 * name could too (discarded 9 / Dot). The showcase review of 20 November saw each of these. keepWhole joins such a unit:
 * a word joiner (U+2060: no width, no break) between the characters of a Chinese term, and a no-break space inside a
 * number and its Chinese unit or inside an English tile name. A line still breaks before and after the unit, and a screen
 * reader reads it as before. The app's Text applies it to every string it draws (../components/Text.tsx).
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
];

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const kinds = (n: number) => Array.from({ length: n }, (_, k) => kindInfo(k));
/** Longest first, so 門清自摸 is joined whole before 門清 or 自摸 could match inside it. */
const ZH_TERMS = [...new Set([...SCORING_TERMS, ...kinds(NUM_PLAY_KINDS).map((i) => i.nameZh)])].filter((w) => [...w].length > 1).sort((a, b) => b.length - a.length);
const ZH_RE = new RegExp(ZH_TERMS.map(escape).join('|'), 'g');
/** English tile names of more than one word: 9 Dot, East Wind, Red Dragon. */
const EN_RE = new RegExp(`\\b(?:${kinds(NUM_KINDS).map((i) => i.nameEn).filter((n) => n.includes(' ')).map(escape).join('|')})\\b`, 'g');
/** A number and the Chinese unit after it, which the app writes with a space between (15 秒, 1 台, 3 張). */
const UNIT_RE = /(\d) (?=[台秒張分天局次位題顆種圈莊堂])/g;
const CJK = /[㐀-鿿]/;

/** `text` with its scoring terms, tile names and numbers with units joined so no line breaks inside them. */
export function keepWhole(text: string): string {
  let out = text;
  if (CJK.test(out)) {
    // A term that is the whole text is a label on its own: nothing to keep together inside a sentence.
    out = out.replace(UNIT_RE, `$1${NO_BREAK_SPACE}`).replace(ZH_RE, (w) => (w === text ? w : [...w].join(WORD_JOINER)));
  }
  return out.replace(EN_RE, (w) => w.replace(/ /g, NO_BREAK_SPACE));
}

/** `text` with the joins keepWhole adds taken out again (for comparing what is drawn with what was written). */
export function unjoined(text: string): string {
  return text.split(WORD_JOINER).join('').split(NO_BREAK_SPACE).join(' ');
}
