/**
 * The exit sheet the table's red exit icon opens (./exit.ts has the rules): keep playing, step away to Home
 * (the resume card brings the player back), or abandon the table for good. Modal pattern from
 * ReportPlayerSheet.tsx: a scrim that keeps playing on a tap, and a card at the bottom. The scrim is no control and
 * the page behind is inert on the web (../Scrim.tsx), so the keyboard and screen readers reach only the card's buttons.
 */
import React from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { useT } from '../../i18n';
import { space } from '../../theme';
import { Scrim, useInertPage } from '../Scrim';
import { Button, Card, H2, P } from '../Ui';
import { leaveSheetBody, type ExitChoice } from './exit';

export function LeaveSheet({ visible, online, quickMatch, onChoose }: { visible: boolean; /** Online: a bot plays the seat while away; offline: the table waits. */ online: boolean; /** A quick-match table closes two minutes after its last player went. */ quickMatch?: boolean; onChoose: (choice: ExitChoice) => void }) {
  const { t } = useT();
  useInertPage(visible);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => onChoose('stay')} supportedOrientations={['portrait', 'landscape']}>
      <Scrim onPress={() => onChoose('stay')} />
      <View style={styles.wrap} pointerEvents="box-none">
        <Card style={styles.sheet} testID="leave-sheet">
          <H2>{t('table.leaveSheet.title')}</H2>
          <P dim style={{ fontSize: 14, lineHeight: 19 }}>
            {t(leaveSheetBody({ online, quickMatch }))}
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
  wrap: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', padding: space.md },
  sheet: { width: '100%', maxWidth: 520, gap: space.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, alignItems: 'center', rowGap: space.sm },
});
