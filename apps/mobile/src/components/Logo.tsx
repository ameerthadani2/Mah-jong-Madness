import React from 'react';
import { StyleSheet, View } from 'react-native';
import { APP_NAME } from '../config';
import { useT } from '../i18n';
import { colors, fonts } from '../theme';
import { Tile } from './Tile';
import { StrokeText } from './Ui';

/** The wordmark's two lines: the configured name's first word, then the rest ("MAHJONG" / "MANIA"). */
export function wordmark(name: string): [string, string] {
  const words = name.trim().toUpperCase().split(/\s+/).filter(Boolean);
  return words.length > 1 ? [words[0], words.slice(1).join(' ')] : [words[0] ?? '', ''];
}

/**
 * The wordmark in the player's language: the configured name in two lines ("MAHJONG" / "MANIA"), or, where the
 * locale gives the app a name of its own (common.appName: 麻將狂熱 in Traditional Chinese), that name with the
 * configured one in small type beneath it.
 */
export function localWordmark(name: string, localName: string): { lines: [string, string]; local: boolean } {
  const local = localName.trim();
  if (!local || local.toUpperCase() === name.trim().toUpperCase()) return { lines: wordmark(name), local: false };
  return { lines: [local, name.trim().toUpperCase()], local: true };
}

/** Game logo: two tumbling tiles and the stroked wordmark of the app's name in the player's language. */
export function Logo({ size = 1, stacked }: { size?: number; stacked?: boolean }) {
  const { t } = useT();
  const tileW = Math.round(30 * size);
  const { lines, local } = localWordmark(APP_NAME, t('common.appName', { name: APP_NAME }));
  const [first, rest] = lines;
  return (
    <View style={[styles.row, stacked && { flexDirection: 'column', gap: 4 * size }]}>
      <View style={[styles.tiles, { width: tileW * 1.9, height: tileW * 1.5 }]}>
        <View style={{ position: 'absolute', left: 0, top: tileW * 0.08, transform: [{ rotate: '-12deg' }] }}>
          <Tile kind={31} size={tileW} />
        </View>
        <View style={{ position: 'absolute', left: tileW * 0.82, top: 0, transform: [{ rotate: '10deg' }] }}>
          <Tile kind={32} size={tileW} />
        </View>
      </View>
      <View style={{ alignItems: stacked ? 'center' : 'flex-start' }}>
        {local ? (
          <>
            {/* The Chinese name in the display face's bold fallback (the logo face has no CJK), the English name small and gold beneath. */}
            <StrokeText font={fonts.display} style={{ fontSize: 26 * size, lineHeight: 32 * size, letterSpacing: 2 }} strokeWidth={2.5 * Math.max(0.8, size)} drop={3 * size}>
              {first}
            </StrokeText>
            <StrokeText font={fonts.logo} color={colors.gold} style={{ fontSize: 12 * size, lineHeight: 15 * size, letterSpacing: 1 }} strokeWidth={1.5 * Math.max(0.8, size)} drop={2 * size}>
              {rest}
            </StrokeText>
          </>
        ) : (
          <>
            <StrokeText font={fonts.logo} style={{ fontSize: 26 * size, lineHeight: 30 * size, letterSpacing: 1 }} strokeWidth={2.5 * Math.max(0.8, size)} drop={3 * size}>
              {first}
            </StrokeText>
            {rest ? (
              <StrokeText font={fonts.logo} color={colors.gold} style={{ fontSize: 26 * size, lineHeight: 30 * size, letterSpacing: 1, marginTop: -4 * size }} strokeWidth={2.5 * Math.max(0.8, size)} drop={3 * size}>
                {rest}
              </StrokeText>
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  tiles: {},
});
