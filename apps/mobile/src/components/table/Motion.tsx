/**
 * Small motion pieces for the table, built on React Native's Animated (no extra animation library):
 * a discard sliding into its pond, a tile flipping face up, and a number rolling up to its value.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Platform, Text, type StyleProp, type TextStyle } from 'react-native';
import { DISCARD_SLIDE_MS, FLIP_HALF_MS, rollUp, rollUpMs } from './feel';

/** The native driver is not available on web; there Animated runs on the JS thread. */
export const NATIVE = Platform.OS !== 'web';

/** Slides its child in from (x, y) and fades it up, once, when it mounts. */
export function SlideIn({ from, children }: { from: { x: number; y: number }; children: React.ReactNode }) {
  const p = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(p, { toValue: 1, duration: DISCARD_SLIDE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }).start();
  }, [p]);
  const tx = p.interpolate({ inputRange: [0, 1], outputRange: [from.x, 0] });
  const ty = p.interpolate({ inputRange: [0, 1], outputRange: [from.y, 0] });
  const opacity = p.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0, 1, 1] });
  return <Animated.View style={{ opacity, transform: [{ translateX: tx }, { translateY: ty }] }}>{children}</Animated.View>;
}

/**
 * Shows `back` first, then after `delay` turns over (squash to nothing, swap, open) to show `face`.
 * Used for the winner's hand during the result hold.
 */
export function Flip({ delay, back, face }: { delay: number; back: React.ReactNode; face: React.ReactNode }) {
  const s = useRef(new Animated.Value(1)).current;
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const half = (to: number) => Animated.timing(s, { toValue: to, duration: FLIP_HALF_MS, easing: Easing.inOut(Easing.quad), useNativeDriver: NATIVE });
    const anim = Animated.sequence([Animated.delay(delay), half(0)]);
    anim.start(({ finished }) => {
      if (!finished) return;
      setShown(true);
      half(1).start();
    });
    return () => anim.stop();
  }, [delay, s]);
  return <Animated.View style={{ transform: [{ scaleX: s }] }}>{shown ? face : back}</Animated.View>;
}

/** Counts from 0 up to `value` when it first appears (台 and score changes on the result sheet). */
export function useRollUp(value: number): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const duration = rollUpMs(value);
    let id: ReturnType<typeof setTimeout> | null = null;
    const step = () => {
      const elapsed = Date.now() - start;
      setShown(rollUp(value, elapsed, duration));
      if (elapsed < duration) id = setTimeout(step, 32);
    };
    step();
    return () => {
      if (id) clearTimeout(id);
    };
  }, [value]);
  return shown;
}

export function RollUpText({ value, style, format = String }: { value: number; style?: StyleProp<TextStyle>; format?: (n: number) => string }) {
  return <Text style={style}>{format(useRollUp(value))}</Text>;
}
