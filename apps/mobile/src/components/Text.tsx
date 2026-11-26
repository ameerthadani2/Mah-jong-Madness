/**
 * The app's Text: React Native's, with two things done for Chinese wherever text is drawn. Every screen and component
 * imports it in place of React Native's own.
 *
 * 1. A heavy face for Chinese. The display and UI faces (Lilita, Fredoka, Nunito, Luckiest) have no Chinese glyphs, and
 *    the face a platform falls back to for a missing glyph is its regular weight: Chinese titles came out thin beside the
 *    heavy English ones (the showcase review of 20 November: the Learn cards, the lesson titles, Home's tiles, the coach).
 *    So text set in one of those faces that is mainly Chinese takes the system's Chinese face instead, heavy
 *    (theme.ts CJK_FACES and CJK_WEIGHT), and a Chinese word inside mainly English text takes it run by run. Text nested
 *    in a Text inherits the face it was given, as React Native's does.
 * 2. Whole words. Its strings pass through keepWhole (../logic/keepWhole.ts), so no line breaks inside a scoring term, a
 *    tile name, or between a number and its unit.
 */
import React, { createContext, useContext } from 'react';
import { Platform, StyleSheet, Text as NativeText, type TextProps, type TextStyle } from 'react-native';
import { keepWhole, WORD_JOINER } from '../logic/keepWhole';
import { CJK_FACES, CJK_WEIGHT, hasCJK } from '../theme';

/** This platform's Chinese face (theme.ts CJK_FACES). */
export const CJK_FACE: string = Platform.OS === 'ios' ? CJK_FACES.ios : Platform.OS === 'android' ? CJK_FACES.android : CJK_FACES.web;

/** Chinese in place of the Latin face `latin`: the system's Chinese face, at the weight that face's Chinese takes. */
export function cjkStyle(latin: string | undefined, weight?: TextStyle['fontWeight']): TextStyle {
  return { fontFamily: CJK_FACE, fontWeight: weight ?? (latin ? CJK_WEIGHT[latin] : undefined) ?? '900' };
}

/** Whether `face` is one of the app's Latin faces, whose Chinese falls back thin. */
export function isLatinFace(face: string | undefined): face is string {
  return face !== undefined && Object.prototype.hasOwnProperty.call(CJK_WEIGHT, face);
}

/** The face a Text sets, for the Text nested in it (React Native passes a parent's style on to nested Text). */
const Face = createContext<string | undefined>(undefined);

const HAN = /[㐀-鿿]/;
/** A run of Chinese: characters, Chinese punctuation and full-width forms, and the joins keepWhole puts between them. */
const HAN_RUNS = new RegExp(`([${WORD_JOINER}\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef]+)`);

/** The strings and numbers among `children`, joined (nested Text elements are their own business). */
function textOf(children: React.ReactNode): string {
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(textOf).join('');
  return '';
}

/** `children` with each string passed through `fn`. */
function mapStrings(children: React.ReactNode, fn: (s: string, key: string) => React.ReactNode, key = 's'): React.ReactNode {
  if (typeof children === 'string') return fn(children, key);
  if (Array.isArray(children)) return children.map((c, i) => mapStrings(c, fn, `${key}.${i}`));
  return children;
}

function hasElement(children: React.ReactNode): boolean {
  return Array.isArray(children) ? children.some(hasElement) : React.isValidElement(children);
}

export function Text({ style, children, ...rest }: TextProps) {
  const inherited = useContext(Face);
  const own = (StyleSheet.flatten(style) as TextStyle | undefined)?.fontFamily;
  const face = own ?? inherited;
  const kept = mapStrings(children, (s) => keepWhole(s));
  const text = isLatinFace(face) ? textOf(children) : '';
  let drawn: React.ReactNode;
  let passed = face;
  if (!isLatinFace(face) || !HAN.test(text)) {
    drawn = (
      <NativeText {...rest} style={style}>
        {kept}
      </NativeText>
    );
  } else if (hasCJK(text)) {
    // Mainly Chinese: the whole Text in the Chinese face, and what it holds after it.
    passed = CJK_FACE;
    drawn = (
      <NativeText {...rest} style={[style, cjkStyle(face)]}>
        {kept}
      </NativeText>
    );
  } else {
    // Mainly English with Chinese words in it: each Chinese run in the Chinese face, the rest in the Latin one.
    const cjk = cjkStyle(face);
    drawn = (
      <NativeText {...rest} style={style}>
        {mapStrings(kept, (s, key) =>
          s.split(HAN_RUNS).map((part, i) =>
            i % 2 === 1 ? (
              <NativeText key={`${key}.${i}`} style={cjk}>
                {part}
              </NativeText>
            ) : (
              part
            ),
          ),
        )}
      </NativeText>
    );
  }
  return hasElement(children) ? <Face.Provider value={passed}>{drawn}</Face.Provider> : drawn;
}
