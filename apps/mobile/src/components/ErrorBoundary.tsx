/**
 * A screen that throws while rendering must not blank the whole app. The boundary catches the error, reports
 * it (crash reports, when the player allows them) and shows a plain card with a way back to Home and a second way that clears the saved table first. It clears
 * itself when `resetKey` changes, so moving to another screen tries again.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import { captureError } from '../telemetry';
import { colors } from '../theme';
import { Button } from './Ui';
import { ERROR_SCREEN_ACTIONS, staysFailed } from './ErrorBoundary.logic';

interface Props {
  /** Changes when the player moves to another screen. */
  resetKey: string;
  /** Leave the failed screen (the app goes Home). */
  onHome: () => void;
  /** Delete the saved table (it may be what broke the screen), then go Home. */
  onClearTable: () => void;
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
          <Text style={styles.hint}>{t('common.crash.clearHint')}</Text>
          {ERROR_SCREEN_ACTIONS.map((action) => (
            <Button
              key={action.id}
              testID={action.testID}
              kind={action.clearsSavedTable ? 'ghost' : undefined}
              small={action.clearsSavedTable}
              title={t(action.label)}
              onPress={() => {
                this.setState({ failed: false });
                if (action.clearsSavedTable) this.props.onClearTable();
                else this.props.onHome();
              }}
            />
          ))}
        </View>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  card: { backgroundColor: colors.cream, borderWidth: 3, borderColor: colors.ink, borderRadius: 24, borderBottomWidth: 8, padding: 20, gap: 12, maxWidth: 480, alignItems: 'center' },
  title: { color: colors.ink, fontSize: 22, fontWeight: '800', textAlign: 'center' },
  hint: { color: colors.ink, fontSize: 13, lineHeight: 18, textAlign: 'center', opacity: 0.8 },
  body: { color: colors.ink, fontSize: 15, lineHeight: 21, textAlign: 'center' },
});
