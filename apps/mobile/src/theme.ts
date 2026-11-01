/**
 * Design tokens — "Tycoon Parlour" (see docs/DESIGN.md).
 * Saturated, chunky, friendly: cream panels with dark-navy outlines and hard
 * bottom shelves, two-tone buttons, white display type with a navy stroke.
 * Every fill has a shelf (~18% darker) and sits inside an ink outline.
 */
import type { TextStyle } from 'react-native';

export const colors = {
  // Ink (outlines, body text on cream)
  ink: '#10142F',
  inkSoft: '#2A3160',
  inkDim: '#4A5180',
  // Lobby world
  sky: '#3DB9F5',
  skyTop: '#2FA8F0',
  skyLight: '#8FE3FA',
  aqua: '#A8F2E6',
  cloud: '#FFFFFF',
  cloudShade: '#D3F0FF',
  cream: '#FFF6E5',
  creamLight: '#FFFBF2',
  creamEdge: '#E9C997',
  creamDeep: '#F6E3C0',
  creamShelf: '#E2B878',
  // Table world (defaults; themes override felt colours)
  felt: '#2F9E6A',
  feltDark: '#1E7A4F',
  feltLight: '#3DB57D',
  rail: '#B5722F',
  railLight: '#D99A55',
  railEdge: '#6E3F12',
  railDeep: '#4A2A0C',
  // Action colours: fill / light (top tone) / shelf / outline
  cta: '#52C41A',
  ctaLight: '#7DE03F',
  ctaShelf: '#3A9A0E',
  ctaOutline: '#2B6E0C',
  info: '#2F8CFF',
  infoLight: '#63AEFF',
  infoShelf: '#1C5FCC',
  gold: '#FFC53D',
  goldLight: '#FFDD75',
  goldShelf: '#E09A00',
  goldDim: '#8A5A00',
  premium: '#B35CFF',
  premiumLight: '#CC8CFF',
  premiumShelf: '#7E3AE0',
  danger: '#FF5A5F',
  dangerLight: '#FF8A8D',
  dangerShelf: '#C73A40',
  ok: '#52C41A',
  okText: '#2E8A0A',
  dangerText: '#D32F35',
  // Gems
  gem: '#38D6FF',
  gemLight: '#A6F0FF',
  gemShade: '#1A93D9',
  // Tiles
  ivory: '#FFF9EE',
  ivoryDark: '#D9C7A6',
  red: '#E0312F',
  blue: '#1F63C6',
  green: '#189A52',
  pink: '#D6336C',
  // Text on dark surfaces (table) and translucent panels
  text: '#FFFFFF',
  textDim: '#CFE7DA',
  panel: 'rgba(0,0,0,0.28)',
  panelStrong: 'rgba(16,20,47,0.78)',
};

export const radius = { sm: 10, md: 16, lg: 24, xl: 28 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
/** Outline weights: panels 3, buttons 3, small chips 2. */
export const stroke = { panel: 3, button: 3, chip: 2 };

/**
 * Font families registered in App.tsx with expo-font. Latin only: Chinese text
 * leaves fontFamily unset so the system CJK face (PingFang TC on iOS) renders it.
 */
export const fonts = {
  display: 'Lilita',
  logo: 'Luckiest',
  ui: 'Fredoka-SemiBold',
  uiBold: 'Fredoka-Bold',
  uiMedium: 'Fredoka-Medium',
  body: 'Nunito-SemiBold',
  bodyBold: 'Nunito-Bold',
  bodyHeavy: 'Nunito-ExtraBold',
};

export const type = {
  display: { fontFamily: fonts.display, color: '#FFFFFF' } as TextStyle,
  ui: { fontFamily: fonts.uiBold, color: colors.ink } as TextStyle,
  body: { fontFamily: fonts.body, color: colors.ink } as TextStyle,
  /** For Chinese strings: system CJK font, heavy weight. */
  zh: { fontWeight: '900', color: colors.ink } as TextStyle,
};

const CJK_G = /[　-〿㐀-鿿＀-￯]/g;
const LATIN_G = /[A-Za-z0-9]/g;
/**
 * True when a string is mainly Chinese, so it renders in the system CJK face
 * (fontFamily unset). Mostly-Latin strings with an odd CJK glyph keep the Latin
 * face; the platform falls back to the system CJK font for those glyphs.
 */
export function hasCJK(s: string | undefined | null): boolean {
  if (!s) return false;
  const cjk = (s.match(CJK_G) ?? []).length;
  if (cjk === 0) return false;
  const latin = (s.match(LATIN_G) ?? []).length;
  return cjk * 2 >= latin;
}
/** Font style for user-supplied text (names) that may be Latin or Chinese. */
export function nameFont(s: string | undefined | null, latin: string = fonts.uiBold): TextStyle {
  return hasCJK(s) ? { fontWeight: '900' } : { fontFamily: latin };
}

/** White display text with the dark stroke the style calls for (StrokeText draws the full stroke). */
export const displayText = {
  color: '#FFFFFF',
  fontFamily: fonts.display,
  textShadowColor: colors.ink,
  textShadowOffset: { width: 0, height: 2 },
  textShadowRadius: 1,
} as const;
