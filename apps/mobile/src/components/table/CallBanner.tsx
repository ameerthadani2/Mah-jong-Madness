/**
 * Centre-table call-out: a large, brief 吃 / 碰 / 槓 / 胡 / 自摸 with the caller's name, popped in over the
 * felt as the voice line plays (or on its own when voice is off or not recorded). During the hold after a
 * win, the winner's hand is laid out face up underneath, the tiles flipping over one by one.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';
import type { WinRecord } from '@mjm/engine';
import type { CallKind } from '../../audio/cues';
import { colors, nameFont } from '../../theme';
import { useT } from '../../i18n';
import { MeldView } from '../TableParts';
import { Tile } from '../Tile';
import { StrokeText } from '../Ui';
import { calloutMs, FLIP_STAGGER_MS } from './feel';
import { Flip, NATIVE } from './Motion';
import { useReducedMotion } from '../../display/reducedMotion';
import { announce } from './announce';

export interface Callout {
  call: CallKind;
  seat: number;
  key: number;
}

const TONE: Record<CallKind, string> = { chi: colors.info, pong: colors.cta, kong: colors.premium, hu: colors.gold, selfdraw: colors.danger };

export function CallBanner({ callout, name, onDone, small }: { callout: Callout; name: string; onDone: () => void; /** Short screens: a smaller banner that covers less of the felt. */ small?: boolean }) {
  const { t } = useT();
  const reduced = useReducedMotion();
  const p = useRef(new Animated.Value(reduced ? 1 : 0)).current;
  const done = useRef(onDone);
  done.current = onDone;
  const word = t(`table.callout.${callout.call}`);
  const label = t('table.a11y.callout', { name, call: word });
  const spoken = useRef(label);
  spoken.current = label;
  useEffect(() => {
    // VoiceOver ignores the live region below: say it on iOS.
    announce(spoken.current);
    const total = calloutMs(callout.call);
    if (reduced) {
      // Reduce motion: the banner simply shows for its time, then goes.
      p.setValue(1);
      const id = setTimeout(() => done.current(), total);
      return () => clearTimeout(id);
    }
    p.setValue(0);
    const anim = Animated.sequence([
      Animated.spring(p, { toValue: 1, friction: 5, tension: 140, useNativeDriver: NATIVE }),
      Animated.delay(Math.max(0, total - 520)),
      Animated.timing(p, { toValue: 2, duration: 220, easing: Easing.in(Easing.quad), useNativeDriver: NATIVE }),
    ]);
    anim.start(({ finished }) => finished && done.current());
    return () => anim.stop();
  }, [callout.key, callout.call, p, reduced]);
  const scale = p.interpolate({ inputRange: [0, 1, 2], outputRange: [0.4, 1, 1.15] });
  const opacity = p.interpolate({ inputRange: [0, 0.3, 1, 2], outputRange: [0, 1, 1, 0] });
  return (
    <Animated.View
      pointerEvents="none"
      testID="call-banner"
      accessibilityLiveRegion="assertive"
      accessibilityLabel={label}
      style={[styles.banner, small && styles.bannerSmall, { backgroundColor: TONE[callout.call], opacity, transform: [{ scale }] }]}
    >
      <StrokeText style={small ? styles.wordSmall : styles.word} strokeWidth={small ? 2.5 : 3} drop={small ? 2 : 2.5}>
        {word}
      </StrokeText>
      <Text numberOfLines={1} style={[styles.name, nameFont(name)]}>
        {name}
      </Text>
    </Animated.View>
  );
}

/** The winner's tiles, face up, during the result hold (concealed hand flips over tile by tile). */
export function WinReveal({ win, tileSize }: { win: WinRecord; tileSize: number }) {
  return (
    <View pointerEvents="none" style={styles.reveal} testID="win-reveal">
      {win.melds.map((m, i) => (
        <MeldView key={`m${i}`} meld={m} size={Math.round(tileSize * 0.85)} />
      ))}
      {win.hand.map((tile, i) => (
        <Flip key={tile} delay={i * FLIP_STAGGER_MS} back={<Tile faceDown size={tileSize} />} face={<Tile tile={tile} size={tileSize} highlight={tile === win.winningTile ? 'wait' : undefined} />} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: { alignSelf: 'center', alignItems: 'center', borderWidth: 3, borderColor: colors.ink, borderBottomWidth: 7, borderRadius: 26, paddingHorizontal: 30, paddingTop: 4, paddingBottom: 6, minWidth: 140 },
  bannerSmall: { paddingHorizontal: 20, borderRadius: 20, borderBottomWidth: 5, minWidth: 110 },
  word: { fontSize: 58, lineHeight: 70 },
  wordSmall: { fontSize: 42, lineHeight: 52 },
  name: { color: colors.ink, fontSize: 15, maxWidth: 220, backgroundColor: 'rgba(255,255,255,0.75)', borderRadius: 999, paddingHorizontal: 10, overflow: 'hidden' },
  reveal: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'flex-end', gap: 2, rowGap: 4, backgroundColor: 'rgba(16,20,47,0.82)', borderWidth: 3, borderColor: colors.ink, borderRadius: 18, padding: 8, maxWidth: '96%', alignSelf: 'center' },
});
