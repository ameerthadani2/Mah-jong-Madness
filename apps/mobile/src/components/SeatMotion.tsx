/**
 * Life for the seat portraits: idle breathing, a pulsing halo on the player to act,
 * a call-out bubble when a player claims (碰 吃 槓) or wins (胡牌 自摸), a bounce with a
 * gold sparkle burst for winners and a shake for the player who dealt in.
 *
 * Pure React Native Animated, so it works on iOS, Android, web and in Expo Go, and it
 * animates whatever is inside: the drawn portraits today or imported image art later.
 */
import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { colors } from '../theme';

export type SeatReactionKind = 'pong' | 'chow' | 'kong' | 'win' | 'selfdraw' | 'dealin';

export interface SeatReaction {
  kind: SeatReactionKind;
  /** Changes on every new event so the same kind can fire twice in a row. */
  key: number;
}

const NATIVE = Platform.OS !== 'web';

// Win call-outs avoid the exact text "胡!" used by the claim button (and the e2e test).
const CALLOUT: Record<SeatReactionKind, { text: string; fill: string; edge: string; ink: string }> = {
  pong: { text: '碰!', fill: colors.cta, edge: colors.ctaOutline, ink: '#FFFFFF' },
  chow: { text: '吃!', fill: colors.info, edge: colors.infoShelf, ink: '#FFFFFF' },
  kong: { text: '槓!', fill: colors.premium, edge: colors.premiumShelf, ink: '#FFFFFF' },
  win: { text: '胡牌!', fill: colors.gold, edge: colors.goldDim, ink: colors.ink },
  selfdraw: { text: '自摸!', fill: colors.gold, edge: colors.goldDim, ink: colors.ink },
  dealin: { text: '放槍…', fill: colors.danger, edge: colors.dangerShelf, ink: '#FFFFFF' },
};

const SPARKS = 8;

export function SeatMotion({ children, size, seat, active, reaction }: { children: React.ReactNode; size: number; seat: number; active?: boolean; reaction?: SeatReaction }) {
  const breathe = useRef(new Animated.Value(0)).current;
  const halo = useRef(new Animated.Value(0)).current;
  const bounce = useRef(new Animated.Value(0)).current;
  const shake = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  const burst = useRef(new Animated.Value(0)).current;

  // Idle breathing, offset per seat so the table never pulses in sync.
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(seat * 350),
        Animated.timing(breathe, { toValue: 1, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: NATIVE }),
        Animated.timing(breathe, { toValue: 0, duration: 1700, easing: Easing.inOut(Easing.sin), useNativeDriver: NATIVE }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breathe, seat]);

  // Halo pulse while it is this seat's move.
  useEffect(() => {
    if (!active) {
      halo.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, { toValue: 1, duration: 750, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }),
        Animated.timing(halo, { toValue: 0, duration: 750, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, halo]);

  // One-shot reactions.
  useEffect(() => {
    if (!reaction) return;
    pop.setValue(0);
    const anims: Animated.CompositeAnimation[] = [
      Animated.sequence([
        Animated.spring(pop, { toValue: 1, friction: 5, tension: 140, useNativeDriver: NATIVE }),
        Animated.delay(reaction.kind === 'win' || reaction.kind === 'selfdraw' ? 1500 : 1000),
        Animated.timing(pop, { toValue: 2, duration: 280, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE }),
      ]),
    ];
    if (reaction.kind === 'win' || reaction.kind === 'selfdraw') {
      bounce.setValue(0);
      burst.setValue(0);
      anims.push(
        Animated.sequence([
          Animated.timing(bounce, { toValue: -1, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }),
          Animated.spring(bounce, { toValue: 0, friction: 3, tension: 160, useNativeDriver: NATIVE }),
          Animated.timing(bounce, { toValue: -0.5, duration: 140, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }),
          Animated.spring(bounce, { toValue: 0, friction: 3, tension: 160, useNativeDriver: NATIVE }),
        ]),
        Animated.timing(burst, { toValue: 1, duration: 950, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE }),
      );
    } else if (reaction.kind === 'dealin') {
      shake.setValue(0);
      anims.push(
        Animated.sequence(
          [1, -1, 0.8, -0.8, 0.5, -0.5, 0].map((v) => Animated.timing(shake, { toValue: v, duration: 70, easing: Easing.linear, useNativeDriver: NATIVE })),
        ),
      );
    } else {
      bounce.setValue(0);
      anims.push(
        Animated.sequence([
          Animated.timing(bounce, { toValue: -0.35, duration: 120, easing: Easing.out(Easing.quad), useNativeDriver: NATIVE }),
          Animated.spring(bounce, { toValue: 0, friction: 4, tension: 170, useNativeDriver: NATIVE }),
        ]),
      );
    }
    const all = Animated.parallel(anims);
    all.start();
    return () => all.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reaction?.key]);

  const scale = breathe.interpolate({ inputRange: [0, 1], outputRange: [1, 1.035] });
  const lift = bounce.interpolate({ inputRange: [-1, 0], outputRange: [-size * 0.28, 0] });
  const sway = shake.interpolate({ inputRange: [-1, 1], outputRange: [-size * 0.09, size * 0.09] });
  const haloOpacity = halo.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.55] });
  const haloScale = halo.interpolate({ inputRange: [0, 1], outputRange: [1.08, 1.28] });
  const call = reaction ? CALLOUT[reaction.kind] : null;
  const popScale = pop.interpolate({ inputRange: [0, 1, 2], outputRange: [0.2, 1, 0.85] });
  const popOpacity = pop.interpolate({ inputRange: [0, 0.15, 1, 2], outputRange: [0, 1, 1, 0] });
  const popLift = pop.interpolate({ inputRange: [0, 1, 2], outputRange: [size * 0.25, 0, -size * 0.12] });
  const sparks = useMemo(() => Array.from({ length: SPARKS }, (_, i) => (i / SPARKS) * Math.PI * 2 + Math.PI / SPARKS), []);
  const callSize = Math.max(13, Math.round(size * 0.36));

  return (
    <View style={{ width: size, height: size }}>
      {active && (
        <Animated.View
          pointerEvents="none"
          style={[styles.halo, { width: size, height: size, borderRadius: size / 2, opacity: haloOpacity, transform: [{ scale: haloScale }] }]}
        />
      )}
      <Animated.View style={{ transform: [{ translateY: lift }, { translateX: sway }, { scale }] }}>{children}</Animated.View>
      {reaction && (reaction.kind === 'win' || reaction.kind === 'selfdraw') && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          {sparks.map((a, i) => {
            const r = size * (i % 2 ? 0.95 : 1.15);
            const tx = burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.cos(a) * r] });
            const ty = burst.interpolate({ inputRange: [0, 1], outputRange: [0, Math.sin(a) * r] });
            const op = burst.interpolate({ inputRange: [0, 0.15, 0.7, 1], outputRange: [0, 1, 1, 0] });
            const sc = burst.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.3, 1.1, 0.6] });
            const s = Math.max(10, size * 0.26);
            return (
              <Animated.View key={i} style={{ position: 'absolute', opacity: op, transform: [{ translateX: tx }, { translateY: ty }, { scale: sc }] }}>
                <Svg width={s} height={s} viewBox="0 0 20 20">
                  <Path d="M10 0 L12.4 7.6 L20 10 L12.4 12.4 L10 20 L7.6 12.4 L0 10 L7.6 7.6 Z" fill={i % 3 === 0 ? '#FFFFFF' : colors.gold} stroke={colors.ink} strokeWidth={1.2} />
                </Svg>
              </Animated.View>
            );
          })}
        </View>
      )}
      {call && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.callWrap,
            // Sits on the lower edge of the portrait: seats along the top of the felt have no room above.
            { top: size - callSize * 1.05, left: size / 2 - 60, opacity: popOpacity, transform: [{ translateY: popLift }, { scale: popScale }] },
          ]}
        >
          <View style={[styles.call, { backgroundColor: call.fill, borderColor: colors.ink, borderBottomColor: colors.ink, shadowColor: call.edge }]}>
            <Text style={[styles.callText, { color: call.ink, fontSize: callSize }]}>{call.text}</Text>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  halo: { position: 'absolute', left: 0, top: 0, backgroundColor: colors.gold },
  callWrap: { position: 'absolute', width: 120, alignItems: 'center', zIndex: 30 },
  call: {
    borderWidth: 3,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 2,
    shadowOpacity: 1,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  // No fontFamily: the Latin display fonts have no CJK glyphs, so the system CJK face renders these.
  callText: { fontWeight: '900', textAlign: 'center' },
});
