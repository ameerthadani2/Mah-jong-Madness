/**
 * The parts of the table that change every second, each counting the turn clock down on its own so only it
 * re-renders: the HUD clock chip and the clock-tick sound (the seat timer ring is TableParts' SeatTimer).
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useClockTick, useCountdown } from '../../game/useTable';
import { colors, fonts } from '../../theme';
import { useT } from '../../i18n';
import { Icon } from '../Icons';
import { clockUrgent, type TurnClock } from './turnClock';

/** My clock in the HUD: seconds left on my move, red when urgent. */
export function HudClock({ clock }: { clock: TurnClock }) {
  const { t } = useT();
  const left = useCountdown(clock.deadline);
  if (left === null) return null;
  const urgent = clockUrgent(left, clock);
  const text = clock.bank ? t('table.timeBank', { s: left }) : t('table.seconds', { s: left });
  return (
    <View style={[styles.chip, urgent && { backgroundColor: colors.danger }]} accessibilityLiveRegion={urgent ? 'polite' : 'none'} testID="hud-clock">
      <Icon name={clock.bank ? 'hourglass' : 'clock'} size={18} />
      <Text style={styles.text}>{text}</Text>
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
});
