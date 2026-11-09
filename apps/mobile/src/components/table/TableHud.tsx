/** The strip above the table: round, wall count, room code, my clock, the status line on short screens, and the emote / coach / leave buttons. */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { WINDS, type TableView } from '@mjm/engine';
import { colors, fonts } from '../../theme';
import { useT } from '../../i18n';
import { Icon } from '../Icons';
import { IconButton, Row } from '../Ui';
import { HudClock } from './ClockParts';
import type { TurnClock } from './turnClock';

export function TableHud({
  view,
  roomCode,
  portrait,
  clock,
  myMove,
  timeBank,
  status,
  emotesOpen,
  onEmotes,
  coachAllowed,
  coachOpen,
  onCoach,
  onLeave,
}: {
  view: TableView;
  roomCode: string;
  portrait: boolean;
  /** The turn clock (counted down by HudClock itself, so the table does not re-render every second). */
  clock: TurnClock;
  myMove: boolean;
  timeBank: number;
  /** "X discarded Y", shown here on short screens to free the felt. */
  status: string | null;
  emotesOpen: boolean;
  onEmotes: () => void;
  coachAllowed: boolean;
  coachOpen: boolean;
  onCoach: () => void;
  onLeave: () => void;
}) {
  const { t } = useT();
  return (
    <View style={styles.hud}>
      <Row gap={6} style={{ flexShrink: 1, flexWrap: 'wrap', rowGap: 4 }}>
        <View style={styles.roundChip} accessible accessibilityLabel={`${WINDS[view.prevailingWind]} ${t('table.roundChip', { hand: view.handNumber + 1 })}`}>
          <Text style={styles.roundWind}>{WINDS[view.prevailingWind]}</Text>
          <Text style={styles.roundText}>
            {t('table.roundChip', { hand: view.handNumber + 1 })}
            {view.dealerStreak ? t('table.dealerStreak', { n: view.dealerStreak }) : ''}
          </Text>
        </View>
        <View style={styles.hudChip} accessible accessibilityLabel={t('table.a11y.drawsLeft', { n: view.drawsLeft })}>
          <Icon name="wall" size={18} />
          <Text style={styles.hudChipText}>{view.drawsLeft}</Text>
        </View>
        {roomCode !== 'LOCAL' && !portrait && (
          <View style={styles.hudChip}>
            <Text style={styles.hudChipText}>{roomCode}</Text>
          </View>
        )}
        {myMove && <HudClock clock={clock} />}
        {!myMove && timeBank > 0 && !portrait && (
          <View style={styles.hudChip}>
            <Icon name="hourglass" size={18} />
            <Text style={styles.hudChipText}>{t('table.seconds', { s: timeBank })}</Text>
          </View>
        )}
      </Row>
      {status && (
        <View style={styles.status} testID="table-status">
          <Text numberOfLines={1} style={styles.statusText}>
            {status}
          </Text>
        </View>
      )}
      <Row gap={8}>
        <IconButton icon="smile" kind={emotesOpen ? 'gold' : 'ghost'} size={40} selected={emotesOpen} label={t('table.a11y.icon.smile')} onPress={onEmotes} />
        {coachAllowed && <IconButton icon="cap" kind={coachOpen ? 'primary' : 'ghost'} size={40} selected={coachOpen} label={t('table.a11y.icon.cap')} onPress={onCoach} />}
        <IconButton testID="leave-table" icon="exit" kind="danger" size={40} label={t('table.a11y.icon.exit')} onPress={onLeave} />
      </Row>
    </View>
  );
}

const styles = StyleSheet.create({
  hud: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 10, paddingTop: 4, paddingBottom: 6, gap: 8 },
  roundChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.gold, borderWidth: 2.5, borderColor: colors.ink, borderRadius: 999, paddingLeft: 4, paddingRight: 10, height: 30 },
  roundWind: { width: 22, height: 22, borderRadius: 11, backgroundColor: colors.ink, color: colors.gold, textAlign: 'center', fontWeight: '900', fontSize: 14, lineHeight: 22, overflow: 'hidden' },
  roundText: { color: colors.ink, fontWeight: '900', fontSize: 13 },
  hudChip: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(16,20,47,0.7)', borderWidth: 2.5, borderColor: colors.ink, borderRadius: 999, paddingLeft: 5, paddingRight: 10, height: 30 },
  hudChipText: { color: '#FFFFFF', fontFamily: fonts.display, fontSize: 15 },
  status: { backgroundColor: 'rgba(16,20,47,0.6)', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, flexShrink: 1, maxWidth: 260 },
  statusText: { color: '#FFFFFF', fontSize: 12, fontWeight: '900' },
});
