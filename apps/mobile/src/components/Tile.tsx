import React, { useContext } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { kindInfo, kindOf, type Kind, type TileId } from '@mjm/engine';
import { colors } from '../theme';
import { TableThemeContext } from '../themes';

export type TileSize = 'xs' | 'sm' | 'md' | 'lg';

const DIMS: Record<TileSize, { w: number; h: number; big: number; small: number }> = {
  xs: { w: 20, h: 28, big: 11, small: 8 },
  sm: { w: 28, h: 38, big: 15, small: 10 },
  md: { w: 40, h: 56, big: 22, small: 13 },
  lg: { w: 50, h: 70, big: 28, small: 15 },
};

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];

export interface TileProps {
  tile?: TileId;
  kind?: Kind;
  /** Named size, or an explicit width in pixels (height and fonts scale with it). */
  size?: TileSize | number;
  faceDown?: boolean;
  selected?: boolean;
  dimmed?: boolean;
  highlight?: 'good' | 'bad' | 'wait';
  onPress?: () => void;
  onLongPress?: () => void;
  style?: ViewStyle;
  /** Rotate 90° to show a claimed tile in a meld. */
  rotated?: boolean;
}

function suitColor(suit: string): string {
  switch (suit) {
    case 'm':
      return colors.red;
    case 'p':
      return colors.blue;
    case 's':
      return colors.green;
    case 'w':
      return colors.ink;
    case 'd':
      return colors.red;
    default:
      return colors.pink;
  }
}

export const Tile = React.memo(function Tile({ tile, kind, size = 'md', faceDown, selected, dimmed, highlight, onPress, onLongPress, style, rotated }: TileProps) {
  const d = typeof size === 'number' ? { w: size, h: Math.round(size * 1.4), big: Math.round(size * 0.55), small: Math.round(size * 0.32) } : DIMS[size];
  const theme = useContext(TableThemeContext);
  const k = kind ?? (tile !== undefined ? kindOf(tile) : undefined);
  const info = k !== undefined ? kindInfo(k) : undefined;
  const body = (
    <View
      testID={faceDown ? 'tile-back' : `tile-${info?.code ?? 'x'}`}
      style={[
        styles.tile,
        { width: rotated ? d.h : d.w, height: rotated ? d.w : d.h, borderRadius: d.w * 0.16, backgroundColor: theme.tileFace, borderColor: theme.tileEdge },
        faceDown && { backgroundColor: theme.tileBack, borderColor: theme.feltDark },
        selected && [styles.selected, { borderColor: theme.accent }],
        dimmed && styles.dimmed,
        highlight === 'good' && styles.good,
        highlight === 'bad' && styles.bad,
        highlight === 'wait' && styles.wait,
        style,
      ]}
    >
      {!faceDown && info && (
        <View style={[styles.face, rotated && { transform: [{ rotate: '90deg' }] }]}>
          {info.suit === 'm' || info.suit === 'p' || info.suit === 's' ? (
            <>
              <Text style={[styles.big, { fontSize: d.big, color: info.suit === 'm' ? colors.ink : suitColor(info.suit) }]}>{info.suit === 'm' ? CN_NUM[info.rank - 1] : String(info.rank)}</Text>
              <Text style={[styles.small, { fontSize: d.small, color: suitColor(info.suit) }]}>{info.suit === 'm' ? '萬' : info.suit === 'p' ? '筒' : '條'}</Text>
            </>
          ) : (
            <Text style={[styles.big, { fontSize: d.big + 2, color: info.suit === 'd' && info.rank === 2 ? colors.green : info.suit === 'd' && info.rank === 3 ? colors.blue : suitColor(info.suit) }]}>{info.nameZh}</Text>
          )}
        </View>
      )}
    </View>
  );
  if (!onPress && !onLongPress) return body;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} hitSlop={2} style={({ pressed }) => pressed && { opacity: 0.8 }}>
      {body}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  tile: {
    backgroundColor: colors.ivory,
    borderWidth: 1,
    borderColor: colors.ivoryDark,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  face: { alignItems: 'center', justifyContent: 'center' },
  faceDown: { backgroundColor: '#2f6b55', borderColor: '#1f4d3c' },
  selected: { transform: [{ translateY: -10 }], borderColor: colors.gold, borderWidth: 2 },
  dimmed: { opacity: 0.45 },
  good: { borderColor: colors.ok, borderWidth: 2 },
  bad: { borderColor: colors.danger, borderWidth: 2 },
  wait: { borderColor: colors.gold, borderWidth: 2 },
  big: { fontWeight: '800', lineHeight: undefined },
  small: { fontWeight: '700', marginTop: -2 },
});
