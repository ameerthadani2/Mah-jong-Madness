/** A yes/no sheet at the bottom of the screen (ReportPlayerSheet's modal pattern): a scrim that answers no, and a card. */
import React from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { space } from '../../theme';
import { Button, Card, H2, P } from '../Ui';

export function ConfirmSheet({ visible, title, body, yes, no, onYes, onNo, testID }: { visible: boolean; title: string; body: string; yes: string; no: string; onYes: () => void; onNo: () => void; testID?: string }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onNo} supportedOrientations={['portrait', 'landscape']}>
      <Pressable style={styles.scrim} onPress={onNo} accessibilityRole="button" accessibilityLabel={no} />
      <View style={styles.wrap} pointerEvents="box-none">
        <Card style={styles.sheet} testID={testID}>
          <H2>{title}</H2>
          <P dim style={{ fontSize: 14, lineHeight: 19 }}>
            {body}
          </P>
          <View style={styles.buttons}>
            <Button testID="confirm-no" title={no} onPress={onNo} />
            <Button testID="confirm-yes" kind="danger" title={yes} onPress={onYes} />
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
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, rowGap: space.sm },
});
