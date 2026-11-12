/**
 * A screen that throws while rendering must not blank the whole app. The boundary catches the error, reports
 * it (crash reports, when the player allows them) and shows a plain card with a way back to Home. It clears
 * itself when `resetKey` changes, so moving to another screen tries again.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import { captureError } from '../telemetry';
import { colors } from '../theme';
import { Button } from './Ui';
import { staysFailed } from './ErrorBoundary.logic';

interface Props {
  /** Changes when the player moves to another screen. */
  resetKey: string;
  /** Leave the failed screen (the app goes Home). */
  onHome: () => void;
  children: React.ReactNode;
}

export class ErrorBoundary extends React.Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    captureError(error, 'caught', true);
  }

  componentDidUpdate(previous: Props): void {
    if (this.state.failed && !staysFailed(true, previous.resetKey, this.props.resetKey)) this.setState({ failed: false });
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={styles.wrap} testID="screen-error" accessibilityRole="alert">
        <View style={styles.card}>
          <Text style={styles.title}>{t('common.crash.title')}</Text>
          <Text style={styles.body}>{t('common.crash.body')}</Text>
          <Button
            testID="screen-error-home"
            title={t('common.crash.home')}
            onPress={() => {
              this.setState({ failed: false });
              this.props.onHome();
            }}
          />
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.cream, borderWidth: 3, borderColor: colors.ink, borderRadius: 24, borderBottomWidth: 8, padding: 20, gap: 12, maxWidth: 480, alignItems: 'center' },
  title: { color: colors.ink, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  body: { color: colors.ink, fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
