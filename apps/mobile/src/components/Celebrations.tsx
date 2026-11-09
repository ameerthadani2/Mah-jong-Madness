/**
 * Win celebrations bought in the Shop (monetisation/cosmetics.ts `CELEBRATIONS`): a short
 * overlay played over the table when the player wins a hand. Drawn in SVG and moved with
 * Animated on the native driver (layers rise, fall, burst or cross the table once, about 2.6 s).
 * `still` draws a single frame, for the Shop preview and for players who reduce motion.
 * Fireworks, lanterns, a dragon and petals only: no coins, chips or money.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';
import type { CelebrationId } from '../monetisation/cosmetics';
import { colors } from '../theme';

const INK = colors.ink;
export const CELEBRATION_MS = 2600;

function burst(cx: number, cy: number, r: number, c: string, key: string) {
  return (
    <G key={key}>
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * Math.PI) / 6;
        return <Path key={i} d={`M${cx + Math.cos(a) * r * 0.35} ${cy + Math.sin(a) * r * 0.35} L${cx + Math.cos(a) * r} ${cy + Math.sin(a) * r}`} stroke={c} strokeWidth={3} strokeLinecap="round" />;
      })}
      <Circle cx={cx} cy={cy} r={r * 0.18} fill="#FFFFFF" />
    </G>
  );
}

function skyLantern(x: number, y: number, s: number, key: string) {
  return (
    <G key={key} transform={`translate(${x} ${y}) scale(${s})`}>
      <Ellipse cx={0} cy={2} rx={16} ry={20} fill="#FFD34D" opacity={0.25} />
      <Path d="M-9 -12 H9 L12 12 H-12 Z" fill="#FF9A1A" stroke={INK} strokeWidth={2.4} strokeLinejoin="round" />
      <Path d="M-6 -6 H6 L8 8 H-8 Z" fill="#FFE08A" />
      <Rect x={-4} y={12} width={8} height={3} rx={1} fill="#8A1A12" />
    </G>
  );
}

function petal(x: number, y: number, rot: number, key: string) {
  return <Path key={key} d="M0 -7 C5 -4 5 4 0 7 C-5 4 -5 -4 0 -7 Z" fill="#FFB3CF" stroke="#C94F86" strokeWidth={1.2} transform={`translate(${x} ${y}) rotate(${rot})`} />;
}

function dragon(w: number, h: number) {
  const y = h * 0.42;
  const seg = Math.max(14, w / 16);
  const body = Array.from({ length: 9 }, (_, i) => ({ x: w * 0.12 + i * seg, y: y + Math.sin(i * 0.9) * seg * 0.6 }));
  return (
    <G>
      {body
        .slice()
        .reverse()
        .map((b, i) => (
          <G key={i}>
            <Circle cx={b.x} cy={b.y} r={seg * 0.62} fill={i % 2 ? '#35A85A' : '#2E8C4C'} stroke={INK} strokeWidth={2.4} />
            <Path d={`M${b.x - seg * 0.3} ${b.y - seg * 0.55} L${b.x} ${b.y - seg * 0.95} L${b.x + seg * 0.3} ${b.y - seg * 0.55}`} fill={colors.gold} stroke={INK} strokeWidth={1.6} />
          </G>
        ))}
      {(() => {
        const head = body[body.length - 1];
        const hx = head.x + seg * 0.9;
        return (
          <G>
            <Ellipse cx={hx} cy={head.y} rx={seg * 0.95} ry={seg * 0.75} fill={colors.danger} stroke={INK} strokeWidth={2.6} />
            <Circle cx={hx + seg * 0.25} cy={head.y - seg * 0.2} r={seg * 0.16} fill="#FFFFFF" stroke={INK} strokeWidth={1.6} />
            <Path d={`M${hx - seg * 0.4} ${head.y - seg * 0.7} L${hx - seg * 0.7} ${head.y - seg * 1.3} M${hx + seg * 0.1} ${head.y - seg * 0.75} L${hx + seg * 0.1} ${head.y - seg * 1.35}`} stroke={colors.gold} strokeWidth={3} strokeLinecap="round" />
            <Path d={`M${hx + seg * 0.9} ${head.y + seg * 0.2} Q${hx + seg * 1.6} ${head.y + seg * 0.6} ${hx + seg * 1.9} ${head.y}`} stroke={colors.gold} strokeWidth={2.4} fill="none" />
          </G>
        );
      })()}
    </G>
  );
}

/** The drawing of each celebration, in a w×h box. */
function scene(id: CelebrationId, w: number, h: number): React.ReactNode {
  switch (id) {
    case 'win.fireworks':
      return (
        <G>
          {burst(w * 0.25, h * 0.3, Math.min(w, h) * 0.2, colors.gold, 'a')}
          {burst(w * 0.7, h * 0.22, Math.min(w, h) * 0.16, colors.danger, 'b')}
          {burst(w * 0.55, h * 0.55, Math.min(w, h) * 0.13, '#7FE3FF', 'c')}
        </G>
      );
    case 'win.lanterns':
      return <G>{[0.15, 0.38, 0.62, 0.85].map((x, i) => skyLantern(w * x, h * (0.35 + (i % 2) * 0.25), Math.min(w, h) / 140 + 0.4, `l${i}`))}</G>;
    case 'win.dragon':
      return dragon(w, h);
    case 'win.petals':
      return <G>{Array.from({ length: 14 }, (_, i) => petal(((i * 37) % 100) * w * 0.01, ((i * 53) % 90) * h * 0.01 + 6, i * 47, `p${i}`))}</G>;
  }
}

/**
 * The celebration overlay. Mount it over the table when the player wins, with `onDone` to unmount
 * it; it ignores touches.
 */
export function WinCelebration({ id, width, height, still, onDone }: { id: CelebrationId; width: number; height: number; still?: boolean; onDone?: () => void }) {
  const t = useRef(new Animated.Value(still ? 0.5 : 0)).current;
  useEffect(() => {
    if (still) return;
    const run = Animated.timing(t, { toValue: 1, duration: CELEBRATION_MS, easing: Easing.out(Easing.quad), useNativeDriver: true });
    run.start(({ finished }) => finished && onDone?.());
    return () => run.stop();
  }, [still, t, onDone]);

  const motion =
    id === 'win.lanterns'
      ? { transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [height * 0.45, -height * 0.25] }) }], opacity: t.interpolate({ inputRange: [0, 0.15, 0.8, 1], outputRange: [0, 1, 1, 0] }) }
      : id === 'win.petals'
        ? { transform: [{ translateY: t.interpolate({ inputRange: [0, 1], outputRange: [-height * 0.4, height * 0.35] }) }], opacity: t.interpolate({ inputRange: [0, 0.1, 0.85, 1], outputRange: [0, 1, 1, 0] }) }
        : id === 'win.dragon'
          ? { transform: [{ translateX: t.interpolate({ inputRange: [0, 1], outputRange: [-width * 0.9, width * 0.6] }) }] }
          : { transform: [{ scale: t.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.3, 1, 1.15] }) }], opacity: t.interpolate({ inputRange: [0, 0.2, 0.75, 1], outputRange: [0, 1, 1, 0] }) };

  return (
    <View pointerEvents="none" style={[StyleSheet.absoluteFill, { overflow: 'hidden' }]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={[StyleSheet.absoluteFill, still ? null : motion]}>
        <Svg width={width} height={height}>
          {scene(id, width, height)}
        </Svg>
      </Animated.View>
    </View>
  );
}
