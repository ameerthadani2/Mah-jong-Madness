/**
 * The parts of the table that change every second, each counting the turn clock down on its own so only it
 * re-renders (`useTurnCountdown`: my own move by the table client's own clock): the HUD clock chip, what a screen
 * reader is told about the clock, and the clock-tick sound (the seat timer ring is TableParts' SeatPlate).
 */
import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useClockTick, useCountdown, useTurnCountdown } from '../../game/useTable';
import { colors, fonts } from '../../theme';
import { useT } from '../../i18n';
import { Icon } from '../Icons';
import { useAnnounce } from './announce';
import { clockNoticeMessage, clockUrgent, nextClockNotice, type ClockNotice, type TurnClock } from './turnClock';
import { nextHandAnnouncement, nextHandNote } from './nextHand';

/**
 * My clock in the HUD: seconds left on my move, red when urgent. The chip is not a live region: a reader
 * that asks for it hears the time left, and `ClockAnnouncer` says the two things worth interrupting for.
 */
export function HudClock({ clock }: { clock: TurnClock }) {
  const { t } = useT();
  const { left, bank, total, period } = useTurnCountdown(clock);
  if (left === null) return null;
  const urgent = clockUrgent(left, { deadline: period, total, bank });
  const text = bank ? t('table.timeBank', { s: left }) : t('table.seconds', { s: left });
  return (
    <View style={[styles.chip, urgent && { backgroundColor: colors.danger }]} accessible accessibilityLabel={t(bank ? 'table.a11y.clockBankNow' : 'table.a11y.clockNow', { s: left })} testID="hud-clock">
      <Icon name={bank ? 'hourglass' : 'clock'} size={18} />
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
  const { left, bank, total, period } = useTurnCountdown(clock);
  const [notice, setNotice] = useState<ClockNotice | null>(null);
  useEffect(() => {
    // The period is the clock's own (my move: its turn, then its bank), so the bank is announced when it starts.
    setNotice((prev) => nextClockNotice(prev, myMove ? left : null, { deadline: period, total, bank }));
  }, [left, myMove, period, total, bank]);
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
  useClockTick(useTurnCountdown(clock).left, myMove, onTick);
  return null;
}

/**
 * Online, under the hand result: "Next hand in N s", counting down to the host's next deal (or the general
 * sentence when the host did not say when). The visible line is not a live region; a screen reader is told
 * once per hand, through the hidden polite region (Android, web) and `useAnnounce` (iOS).
 */
export function NextHandCountdown({ deadline, style }: { deadline: number | null; style: object }) {
  const { t } = useT();
  const left = useCountdown(deadline);
  const [spoken, setSpoken] = useState<{ deadline: number | null; text: string }>({ deadline: null, text: '' });
  useEffect(() => {
    setSpoken((prev) => {
      const text = nextHandAnnouncement(t, deadline, left, prev.deadline);
      return text === null ? prev : { deadline, text };
    });
  }, [t, deadline, left]);
  useAnnounce(spoken.text || null, spoken.deadline);
  return (
    <>
      <Text testID="result-auto-next" style={style}>
        {nextHandNote(t, left)}
      </Text>
      <View style={styles.hiddenLive} accessibilityLiveRegion="polite" testID="next-hand-notice" pointerEvents="none">
        <Text style={styles.hiddenText}>{spoken.text}</Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(16,20,47,0.7)', borderWidth: 2.5, borderColor: colors.ink, borderRadius: 999, paddingLeft: 5, paddingRight: 10, height: 30 },
  text: { color: '#FFFFFF', fontFamily: fonts.display, fontSize: 15 },
  // In the accessibility tree but not on screen: one pixel, clipped, with see-through text. (Opacity 0 or no
  // size would take it out of the tree on Android.)
  hiddenLive: { position: 'absolute', top: 0, left: 0, width: 1, height: 1, overflow: 'hidden' },
  hiddenText: { color: 'transparent' },
});
