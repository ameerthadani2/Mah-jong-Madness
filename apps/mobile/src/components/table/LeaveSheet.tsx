/**
 * The exit sheet the table's red exit icon opens (./exit.ts has the rules): keep playing, step away to Home
 * (the resume card brings the player back), or abandon the table for good. Modal pattern from
 * ReportPlayerSheet.tsx: a scrim that cancels, and a card at the bottom.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useT } from '../../i18n';
import { space } from '../../theme';
import { Button, Card, H2, P } from '../Ui';
import type { ExitChoice } from './exit';

export function LeaveSheet({ visible, online, onChoose }: { visible: boolean; /** Online: a bot plays the seat while away; offline: the table waits. */ online: boolean; onChoose: (choice: ExitChoice) => void }) {
  const { t } = useT();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => onChoose('stay')} supportedOrientations={['portrait', 'landscape']}>
      <Pressable style={styles.scrim} onPress={() => onChoose('stay')} accessibilityRole="button" accessibilityLabel={t('table.leaveSheet.stay')} />
      <View style={styles.wrap} pointerEvents="box-none">
        <Card style={styles.sheet} testID="leave-sheet">
          <H2>{t('table.leaveSheet.title')}</H2>
          <P dim style={{ fontSize: 14, lineHeight: 19 }}>
            {t(online ? 'table.leaveSheet.bodyOnline' : 'table.leaveSheet.bodyLocal')}
          </P>
          <View style={styles.buttons}>
            <Button testID="leave-stay" title={t('table.leaveSheet.stay')} onPress={() => onChoose('stay')} />
            <Button testID="leave-away" kind="secondary" icon="back"title={t('table.leaveSheet.away')} onPress={() => onChoose('away')} />
            <Button testID="leave-confirm" kind="danger" small title={t('table.leaveSheet.abandon')} onPress={() => onChoose('abandon')} />
          </View>
        </Card>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(16,20,47,0.55)' },
  wrap: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', padding: space.md },
  sheet: { width: '100%', maxWidth: 520, gap: space.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center', rowGap: space.sm },
});
