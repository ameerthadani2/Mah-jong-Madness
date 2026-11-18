/**
 * A yes/no sheet at the bottom of the screen (ReportPlayerSheet's modal pattern): a scrim that answers no on a tap,
 * and a card. The scrim is no control and the page behind is inert on the web (../Scrim.tsx), so the keyboard and
 * screen readers reach only the card's two buttons.
 */
import React from 'react';
import { Modal, Platform, StyleSheet, View } from 'react-native';
import { space } from '../../theme';
import { Scrim, useInertPage } from '../Scrim';
import { Button, Card, H2, P } from '../Ui';

export function ConfirmSheet({ visible, title, body, yes, no, onYes, onNo, testID }: { visible: boolean; title: string; body: string; yes: string; no: string; onYes: () => void; onNo: () => void; testID?: string }) {
  useInertPage(visible);
  // As LookPreview: on the web the Modal itself is the dialog (react-native-web makes it one), so it takes the question as its name.
  const modalA11y = (Platform.OS === 'web' ? { 'aria-label': title } : {}) as object;
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onNo} supportedOrientations={['portrait', 'landscape']} {...modalA11y}>
      <Scrim onPress={onNo} />
      <View style={styles.wrap} pointerEvents="box-none">
        <Card style={styles.sheet} testID={testID}>
          <H2 heading>{title}</H2>
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
  wrap: { flex: 1, justifyContent: 'flex-end', alignItems: 'center', padding: space.md },
  sheet: { width: '100%', maxWidth: 520, gap: space.sm },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, rowGap: space.sm },
});
