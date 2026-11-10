/**
 * The name check, name by name: what it must refuse however it is spelled (accents, look-alike
 * letters of other scripts, digits and symbols for letters, a blanked-out letter, Simplified for
 * Traditional), and the real names it must let through.
 */
import { describe, expect, it } from 'vitest';
import { cleanText } from '@mjm/net';
import { nameAllowed } from '../src/moderation';

/** As the API sees a name: cleaned first, then checked. */
const allowed = (name: string) => nameAllowed(cleanText(name, 24));

const COMBINING_ACUTE = String.fromCodePoint(0x301);
const COMBINING_DIAERESIS = String.fromCodePoint(0x308);
const ZERO_WIDTH_SPACE = String.fromCodePoint(0x200b);

/** Each name with why it is here. */
const REFUSED: Array<[name: string, why: string]> = [
  ['Admin', 'staff word'],
  ['ADMIN', 'staff word, capitals'],
  ['admin123', 'staff word with digits'],
  ['Admin_Mei', 'staff word as one of the words'],
  ['AdminMei', 'staff word at the start of a camelCase name'],
  ['MeiAdmin', 'staff word at the end of a camelCase name'],
  ['mahjongofficial', 'staff word at the end of one word'],
  ['Moderator Mei', 'staff word'],
  ['Mod', 'staff word'],
  ['GM', 'staff word'],
  ['Gm Lee', 'staff title before a name'],
  ['Staff', 'staff word'],
  ['Support', 'staff word'],
  ['System', 'staff word'],
  ['Ad Min', 'staff word spelled across a space'],
  ['Of Fi Cial', 'staff word spelled across spaces'],
  ['A d m i n', 'staff word in single letters'],
  ['A.D.M.I.N', 'staff word in dotted letters'],
  ['Addmin', 'staff word with a doubled letter'],
  ['4dm1n', 'digits for letters'],
  ['@dmin', 'symbol for a letter'],
  ['Adm!n', 'symbol for a letter'],
  ['Officia1', 'the digit one for an L'],
  ['M0derator', 'zero for an O'],
  ['Аdmin', 'Cyrillic А'],
  ['Admіn', 'Cyrillic і'],
  ['Mοderator', 'Greek omicron'],
  ['Οfficial', 'Greek capital omicron'],
  ['ᴀᴅᴍɪɴ', 'small capitals'],
  ['ＡＤＭＩＮ', 'full-width letters'],
  ['Ádmin', 'precomposed accent'],
  [`A${COMBINING_ACUTE}dmin`, 'combining accent'],
  [`Ad${ZERO_WIDTH_SPACE}min`, 'invisible character between the letters'],
  ['fuck', 'profanity'],
  ['Fuck You', 'profanity'],
  ['Fuuuuck you', 'stretched'],
  ['f.u.c.k', 'dotted letters'],
  ['fu ck', 'spelled across a space'],
  ['Fück', 'accent'],
  [`Fu${COMBINING_DIAERESIS}ck`, 'combining accent'],
  ['Fцck', 'Cyrillic ц'],
  ['f*ck', 'blanked-out letter'],
  ['f**k', 'two blanked-out letters'],
  ['shit', 'profanity'],
  ['Shіt', 'Cyrillic і'],
  ['sh1t', 'digit for a letter'],
  ['$hit', 'symbol for a letter'],
  ['sh*t', 'blanked-out letter'],
  ['Shitt', 'doubled last letter'],
  ['shiiit', 'stretched'],
  ['bitch', 'profanity'],
  ['Bіtch', 'Cyrillic і'],
  ['a**hole', 'blanked-out letters'],
  ['whore', 'profanity'],
  ['Dick', 'on its own'],
  ['Big Dick', 'not a first name here'],
  ['Dick Head', 'a first name followed by a give-away'],
  ['niggger', 'slur, stretched'],
  ['ni66er', 'slur, digits for letters'],
  ['Hitler', 'listed'],
  ['官方', 'staff title'],
  ['官 方', 'staff title with a space'],
  ['官-方', 'staff title with a hyphen'],
  [`官${ZERO_WIDTH_SPACE}方`, 'staff title with an invisible character'],
  ['非官方小王', 'staff title inside a name'],
  ['管理員', 'staff title, Traditional'],
  ['管理员', 'staff title, Simplified'],
  ['管理者', 'staff title'],
  ['客服小美', 'staff title'],
  ['系統管理員', 'staff title'],
  ['幹你娘', 'profanity, Traditional'],
  ['干你娘', 'profanity, Simplified'],
  ['他媽的', 'profanity, Traditional'],
  ['他妈的', 'profanity, Simplified'],
  ['他马的', 'profanity, look-alike character'],
  ['雞掰', 'profanity, Traditional'],
  ['鸡掰', 'profanity, Simplified'],
  ['機掰', 'profanity, Traditional variant'],
  ['机掰', 'profanity, Simplified variant'],
  ['賤人', 'insult, Traditional'],
  ['贱人', 'insult, Simplified'],
  ['腦殘', 'insult, Traditional'],
  ['脑残', 'insult, Simplified'],
  ['靠北', 'profanity'],
  ['王八蛋', 'insult'],
  ['王去死', 'insult after a surname'],
  ['張白痴', 'insult after a surname'],
];

const ALLOWED: Array<[name: string, why: string]> = [
  ['Brad Min', 'a first name ending in "ad" and the surname Min'],
  ['Chad Min', 'the same'],
  ['Vlad Min', 'the same'],
  ['Ahmad Min', 'the same'],
  ['Muhammad Min', 'the same'],
  ['Conrad Min', 'the same'],
  ['Mohammad Mintz', 'the same, longer surname'],
  ['G. M. Lee', 'two initials'],
  ['G M Chan', 'two initials'],
  ['J. R. R. Tolkien', 'three initials that spell nothing'],
  ['I M Pei', 'initials'],
  ['Rappe', 'surname with a doubled letter'],
  ['Jean Rappe', 'the same'],
  ['Nazzi', 'surname with a doubled letter'],
  ['Twatt', 'surname'],
  ['Aass', 'surname'],
  ['Dick Wong', 'Dick as a first name'],
  ['Dick Van Dyke', 'Dick as a first name'],
  ['Dickens', 'contains a listed word'],
  ['Dickinson', 'contains a listed word'],
  ['Hancock', 'contains a listed word'],
  ['Cockburn', 'contains a listed word'],
  ['Cass', 'contains a listed word'],
  ['Cassandra', 'contains a listed word'],
  ['Assunta', 'contains a listed word'],
  ['Shitao', 'contains a listed word'],
  ['Shitake Lover', 'contains a listed word'],
  ['Harshit', 'a given name that ends in a listed word'],
  ['Dikshit', 'a surname that ends in a listed word'],
  ['Scunthorpe', 'a town'],
  ['Niger Fan', 'a country'],
  ['Nigar', 'a given name'],
  ['Lee Fuk Wing', 'a Cantonese name'],
  ['Phuc Dat Bich', 'a Vietnamese name'],
  ['Bích Ngọc', 'a Vietnamese name with its accents'],
  ['Wan Kei', 'a Cantonese name'],
  ['Na Zi Ming', 'a romanised name'],
  ['José', 'accented'],
  ['Jürgen', 'accented'],
  ['Саша', 'a Russian name'],
  ['Никита', 'a Russian name'],
  ['Νίκος', 'a Greek name'],
  ['Stafford', 'contains a staff word'],
  ['Badminton Bob', 'contains a staff word in the middle'],
  ['Modesty', 'contains a staff word'],
  ['Gmail Fan', 'contains a staff word'],
  ['Systema', 'contains a staff word'],
  ['Supportive Sam', 'contains a staff word'],
  ['Officer Lee', 'near a staff word'],
  ['Therapist', 'contains a listed word'],
  ['Grape', 'contains a listed word'],
  ['Spicy Noodle', 'contains a listed word'],
  ['Bob 455', 'a number that would read as a word'],
  ['Mei88', 'digits'],
  ['Player 4', 'the default seat name'],
  ['Mei', 'short'],
  ['阿明', 'ordinary Chinese'],
  ['台北小美', 'ordinary Chinese'],
  ['麻將達人', 'ordinary Chinese'],
  ['操作員小王', 'shares a character with a listed phrase'],
  ['體操選手', 'shares a character with a listed phrase'],
  ['幹部', 'shares a character with a listed phrase'],
  ['干部小李', 'the same, Simplified'],
  ['官兵', 'shares a character with a staff title'],
  ['田中太郎', 'Japanese'],
  ['김민준', 'Korean'],
];

describe('the name check, name by name', () => {
  it('has enough names on both sides to mean something', () => {
    expect(REFUSED.length).toBeGreaterThanOrEqual(40);
    expect(ALLOWED.length).toBeGreaterThanOrEqual(40);
    expect(new Set([...REFUSED, ...ALLOWED].map(([n]) => n)).size).toBe(REFUSED.length + ALLOWED.length);
  });

  it.each(REFUSED)('refuses %j (%s)', (name) => {
    expect(allowed(name)).toBe(false);
  });

  it.each(ALLOWED)('allows %j (%s)', (name) => {
    expect(allowed(name)).toBe(true);
  });

  it('reads the same name the same way however it is normalised', () => {
    for (const [name] of [...REFUSED, ...ALLOWED]) {
      const clean = cleanText(name, 24);
      expect(nameAllowed(clean.normalize('NFD')), name).toBe(nameAllowed(clean.normalize('NFC')));
    }
  });

  it('an empty name is not its business', () => {
    expect(nameAllowed('')).toBe(true);
  });
});
