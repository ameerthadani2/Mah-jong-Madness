/**
 * The parts of the table that change every second, each counting the turn clock down on its own so only it
 * re-renders: the HUD clock chip, what a screen reader is told about the clock, and the clock-tick sound (the
 * seat timer ring is TableParts' SeatTimer).
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useClockTick, useCountdown } from '../../game/useTable';
import { colors, fonts } from '../../theme';
import { useT } from '../../i18n';
import { Icon } from '../Icons';
import { useAnnounce } from './announce';
import { clockNoticeMessage, clockUrgent, nextClockNotice, type ClockNotice, type TurnClock } from './turnClock';

/**
 * My clock in the HUD: seconds left on my move, red when urgent. The chip is not a live region: a reader
 * that asks for it hears the time left, and `ClockAnnouncer` says the two things worth interrupting for.
 */
export function HudClock({ clock }: { clock: TurnClock }) {
  const { t } = useT();
  const left = useCountdown(clock.deadline);
  if (left === null) return null;
  const urgent = clockUrgent(left, clock);
  const text = clock.bank ? t('table.timeBank', { s: left }) : t('table.seconds', { s: left });
  return (
    <View style={[styles.chip, urgent && { backgroundColor: colors.danger }]} accessible accessibilityLabel={t(clock.bank ? 'table.a11y.clockBankNow' : 'table.a11y.clockNow', { s: left })} testID="hud-clock">
      <Icon name={clock.bank ? 'hourglass' : 'clock'} size={18} />
      <Text style={styles.text}>{text}</Text>
    </View>
  );
}

/**
 * Tells a screen reader, once each, that five seconds are left on my move and that my time bank has started
 * (./turnClock.ts `nextClockNotice`). Android and the web read the hidden polite region, whose text changes
 * only at those two moments; iOS ignores live regions and is told through `useAnnounce`.
 */
export function ClockAnnouncer({ clock, myMove }: { clock: TurnClock; myMove: boolean }) {
  const { t } = useT();
  const left = useCountdown(clock.deadline);
  const [notice, setNotice] = useState<ClockNotice | null>(null);
  useEffect(() => {
    setNotice((prev) => nextClockNotice(prev, myMove ? left : null, clock));
  }, [left, myMove, clock]);
  const message = notice ? clockNoticeMessage(notice) : null;
  const text = message ? t(message.key, message.params) : '';
  useAnnounce(text || null, notice);
  return (
    <View style={styles.hiddenLive} accessibilityLiveRegion="polite" testID="clock-notice" pointerEvents="none">
      <Text style={styles.hiddenText}>{text}</Text>
    </View>
  );
}

/** Plays `onTick` once a second for the last five seconds of my move. Renders nothing. */
export function ClockTicker({ clock, myMove, onTick }: { clock: TurnClock; myMove: boolean; onTick: () => void }) {
  useClockTick(useCountdown(clock.deadline), myMove, onTick);
  return null;
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(16,20,47,0.7)', borderWidth: 2.5, borderColor: colors.ink, borderRadius: 999, paddingLeft: 5, paddingRight: 10, height: 30 },
  text: { color: '#FFFFFF', fontFamily: fonts.display, fontSize: 15 },
  // In the accessibility tree but not on screen: one pixel, clipped, with see-through text. (Opacity 0 or no
  // size would take it out of the tree on Android.)
  hiddenLive: { position: 'absolute', top: 0, left: 0, width: 1, height: 1, overflow: 'hidden' },
  hiddenText: { color: 'transparent' },
});
