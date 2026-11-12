/**
 * The one-time question about usage statistics and crash reports, shown after the age gate
 * (src/telemetry/consent.ts `shouldAskConsent`). Both are off until the player says yes here or in Settings.
 * The question is neutral and its two buttons are the same size and style; either answer is remembered and
 * the question is not shown again. Only the services this build has keys for are listed.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { httpBase } from '../api/http';
import { useApp } from '../app-state';
import { useAuth } from '../auth/AuthProvider';
import { useT } from '../i18n';
import { storeServer } from '../monetisation/server';
import { consent, telemetryAvailable } from '../telemetry';
import { colors, fonts, space } from '../theme';
import { Button, Card, fontFor, P } from './Ui';
import { LegalLinks } from './LegalLinks';
import { Logo } from './Logo';

export function ConsentQuestion() {
  const { t } = useT();
  const app = useApp();
  const auth = useAuth();
  const answer = (agree: boolean) => {
    // A yes covers what was listed above, no more.
    const next = consent.dispatch({ type: 'answer', agree, about: telemetryAvailable });
    // The server keeps the choice too (its own events follow it). With no session yet, it is sent when one is made.
    if (auth.client.snapshot().hasSession) void storeServer.sendAnalyticsConsent({ base: httpBase(app.signalUrl), auth: auth.client }, next.analytics === true).catch(() => undefined);
  };
  const item = (label: string, help: string) => (
    <View style={styles.item}>
      <Text style={[styles.itemTitle, fontFor(label, fonts.uiBold)]}>{label}</Text>
      <P dim style={{ fontSize: 13, lineHeight: 18 }}>
        {help}
      </P>
    </View>
  );
  return (
    <ScrollView contentContainerStyle={styles.wrap} testID="consent-question">
      <Logo size={1.1} />
      <Card style={styles.card}>
        <Text accessibilityRole="header" style={[styles.title, fontFor(t('privacy.ask.title'), fonts.display)]}>
          {t('privacy.ask.title')}
        </Text>
        <P style={{ fontSize: 15, lineHeight: 21 }}>{t('privacy.ask.body')}</P>
        {telemetryAvailable.analytics && item(t('privacy.ask.analytics'), t('privacy.analyticsHelp'))}
        {telemetryAvailable.crash && item(t('privacy.ask.crash'), t('privacy.crashHelp'))}
        {/* Two equal buttons: the same kind and the same width, No first as often as Yes would be. */}
        <View style={styles.buttons}>
          <Button testID="consent-no" kind="secondary" title={t('privacy.ask.no')} onPress={() => answer(false)} style={styles.button} />
          <Button testID="consent-yes" kind="secondary" title={t('privacy.ask.yes')} onPress={() => answer(true)} style={styles.button} />
        </View>
        <P dim style={{ fontSize: 12, lineHeight: 17 }}>
          {t('privacy.ask.note')}
        </P>
        <P dim style={{ fontSize: 12, lineHeight: 17 }}>
          {t('privacy.never')}
        </P>
        <LegalLinks />
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexGrow: 1, padding: space.lg, gap: space.lg, alignItems: 'center', justifyContent: 'center' },
  card: { width: '100%', maxWidth: 460, gap: space.md },
  title: { color: colors.ink, fontSize: 24 },
  item: { gap: 2, padding: 10, borderRadius: 12, backgroundColor: colors.creamLight, borderWidth: 2, borderColor: colors.ink },
  itemTitle: { color: colors.ink, fontSize: 15 },
  buttons: { flexDirection: 'row', gap: space.md },
  button: { flex: 1 },
});
